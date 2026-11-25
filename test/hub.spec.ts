// The hub's interruption handling and reporting, driven end to end with a fake
// tmux and a fake Mattermost: API-error retries (quiet unless they matter),
// crash → resume → re-delivery, graceful restart after the current turn, a
// hand-stopped session staying stopped, worker reports going to the router, and
// provider fallback (a failing provider rests; the work moves to the next one).
// Each "process" here is a FakeTmux session plus a bridge connection the test
// opens, so a start takes ~1.5 s (the shepherd's polling).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { HubMsg } from '../src/shared/ipc'
import { paths } from '../src/shared/paths'
import { toolsFor } from '../src/bridge/tools'
import { loadConfig } from '../src/hub/config'
import { Hub, type BridgeConn } from '../src/hub/hub'
import { delegate, handleCall, ToolError } from '../src/hub/tools'
import { control } from '../src/hub/control'
import { addJob, runDueJobs } from '../src/hub/jobs'
import { otherAgentCheck } from '../src/hub/agents'
import { workspaceTitle } from '../src/hub/links'
import { addRepoTool } from '../src/hub/addrepo'
import { RETRY_DELAYS } from '../src/hub/lifecycle'
import type { Mattermost, MMPost } from '../src/hub/mattermost'
import { tmuxName, transcriptPath } from '../src/hub/spawn'
import type { Tmux } from '../src/hub/tmux'
import { bindChannel, createWorkspace, loadBindings, loadWorkspace, setWorkspaceProviders, setWorkspaceTrigger, type Workspace } from '../src/hub/workspaces'
import { saveProviders, secretFile, writeSecret } from '../src/hub/providers'
import { Store } from '../src/hub/store'
import { Database } from 'bun:sqlite'

const T = 30_000
let savedConfigDir: string | undefined
const savedTransient = [...RETRY_DELAYS.transient]

beforeAll(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'mmhub-cc-'))
  RETRY_DELAYS.transient[0] = 400
})
afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  RETRY_DELAYS.transient.splice(0, Infinity, ...savedTransient)
})

class FakeTmux {
  alive = new Set<string>()
  launches: { name: string; cwd: string; argv: string[]; env: Record<string, string> }[] = []
  async newSession(o: { name: string; cwd: string; argv: string[]; env: Record<string, string> }) {
    this.alive.add(o.name)
    // A login check runs its command, as tmux would (with only the env it was given).
    if (o.name.startsWith('mmhub-auth-')) {
      this.authChecks.push({ name: o.name, argv: o.argv, env: o.env })
      Bun.spawn(o.argv, { cwd: o.cwd, env: o.env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      return
    }
    this.launches.push({ name: o.name, cwd: o.cwd, argv: o.argv, env: o.env })
  }
  authChecks: { name: string; argv: string[]; env: Record<string, string> }[] = []
  async has(n: string) { return this.alive.has(n) }
  async kill(n: string) { return this.alive.delete(n) }
  /** What the pane shows (a startup banner, say); empty by default. */
  screen: (name: string) => string = () => ''
  async capture(n: string) { return this.screen(n) }
  async keys() {}
  async text(n: string, t: string) { if (t === '/exit') this.alive.delete(n) }
  async list() { return [...this.alive] }
  async clients() { return 0 }
  async panePid() { return 1 }
}

type Post = { id: string; root_id?: string; channel_id?: string; message: string }

function setup(config: Record<string, unknown> = {}, before?: (stateDir: string) => void, deps: { claudeBin?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mmhub-hub-'))
  const p = paths(join(dir, 'state'))
  mkdirSync(p.sessions, { recursive: true })
  writeFileSync(p.config, JSON.stringify({ workspacesDir: join(dir, 'ws'), ...config }))
  before?.(p.dir)
  const w = createWorkspace(loadConfig(p.config), 'demo')
  const tmux = new FakeTmux()
  const posts: Post[] = []
  /** Other people's posts in threads (getThread shows them with the bot's). */
  const others: MMPost[] = []
  const typing: string[] = []
  const reconnects: string[] = []
  let n = 0
  const mm = {
    baseUrl: 'http://mm',
    connected: true,
    reconnect: (why: string) => { reconnects.push(why) },
    stop: () => {},
    typingIn: typing,
    permalink: (id: string) => `http://mm/pl/${id}`,
    createPost: async (x: { root_id?: string; message: string }) => {
      const post = { id: `p${++n}`, ...x }
      posts.push(post)
      return { ...post, create_at: Date.now(), user_id: 'bot', channel_id: 'C1' }
    },
    patchPost: async (id: string) => ({ id }),
    typing: (channelId: string, parentId: string) => { typing.push(`${channelId}/${parentId}`) },
    addReaction: async () => ({}),
    username: async () => 'alice',
    user: async (id: string) => ({ id, username: id === 'UBOT' ? 'devbot' : id === 'U2' ? 'bob' : 'alice', is_bot: id === 'UBOT' }),
    userByName: async (name: string) => (name === 'dave' ? { id: 'U9', username: 'dave' } : undefined),
    channel: async (id: string) => ({ id, type: 'O', name: id, display_name: id }),
    directChannel: async () => ({ id: 'D1', type: 'D', name: 'BOT__U1', display_name: '' }),
    getPost: async (id: string) => {
      const x = others.find(o => o.id === id) ?? posts.find(o => o.id === id)
      if (!x) throw new Error(`404 ${id}`)
      return { root_id: '', channel_id: 'C1', user_id: 'bot', create_at: 0, ...x } as MMPost
    },
    getThread: async (root: string) => ({
      posts: Object.fromEntries([
        ...posts.filter(x => x.id === root || x.root_id === root).map((x, i) => [x.id, { ...x, user_id: 'bot', create_at: i, props: {} }] as const),
        ...others.filter(x => x.id === root || x.root_id === root).map(x => [x.id, x] as const),
      ]),
    }),
  }
  const hub = new Hub({
    paths: p, mm: mm as unknown as Mattermost, tmux: tmux as unknown as Tmux,
    claudeBin: '/bin/claude', bunBin: process.execPath, version: 'test', cliPath: '/cli.ts', ...deps,
  })
  hub.store.insertThread({ id: 'T1', channelId: 'C1', workspace: 'demo', routerKey: 'r-t1', label: 'thread one', cursor: 0, createdAt: 0 })
  return { hub, tmux, posts, others, w, typing, p, reconnects }
}

async function until(what: string, fn: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out: ${what}`)
}

/** The bridge of the session's current process: says hello and records what it receives. */
function bridge(hub: Hub, key: string) {
  const got: { content: string; meta: Record<string, string> }[] = []
  const conn: BridgeConn = {
    send: (m: HubMsg) => { if (m.t === 'inbound') got.push({ content: m.content, meta: m.meta }) },
    end: () => {},
    role: key.startsWith('r-') ? 'router' : 'worker',
    pid: 1,
  }
  hub.onBridgeHello(key, conn)
  return { conn, got }
}

/** Wait for a launch, connect its bridge, wait until it is ready. */
async function connect(hub: Hub, tmux: FakeTmux, key: string, launches: number) {
  await until(`launch #${launches} of ${key}`, () => tmux.launches.length >= launches && hub.liveOf(key).starting)
  const b = bridge(hub, key)
  await until(`${key} ready`, () => hub.liveOf(key).ready)
  return b
}

function worker(hub: Hub, w: Workspace) {
  const key = hub.createWorker({ workspace: w, title: 'Fixer', summary: 'fixes things' })
  hub.store.patchWorker(key, { threads: ['T1'] })
  const taskId = hub.store.insertTask({ workerKey: key, threadId: 'T1', channelId: 'C1', text: 'fix the login bug', state: 'queued', createdAt: Date.now() })
  return { key, taskId }
}

/** A turn-end hook, as if the turn had been running a while (not racing a delivery). */
async function hook(hub: Hub, key: string, event: 'Stop' | 'StopFailure' | 'SessionEnd', extra: { error?: string; spawn?: string } = {}) {
  hub.liveOf(key).lastDeliveredAt = 0
  await hub.enqueue(() => hub.applyHook({ t: 'hook', key, event, ...extra }))
}

describe('a workspace the hub can\'t read', () => {
  /** As on a disk macOS keeps the hub out of; returns a way to let it in again. */
  function lock(w: Workspace) {
    const file = join(w.dir, 'workspace.json')
    chmodSync(file, 0)
    return () => chmodSync(file, 0o644)
  }

  test('its sessions wait, their threads are told once, and they start once it can', async () => {
    const { hub, tmux, posts, w } = setup()
    const unlock = lock(w)
    const { key, taskId } = worker(hub, w)
    expect(await hub.enqueue(() => hub.ensureStarted(key))).toBe('failed')
    await hub.enqueue(() => hub.pump())
    await hub.enqueue(() => hub.pump())
    expect(tmux.launches.length).toBe(0)
    expect(posts.map(x => x.message)).toEqual([expect.stringContaining("can't start: the hub can't read workspace **demo**")])
    expect(hub.store.session(key)!.status).not.toBe('failed')
    expect(hub.store.task(taskId)!.state).toBe('queued')
    unlock()
    await hub.enqueue(() => hub.pump())
    const b = await connect(hub, tmux, key, 1)
    await until('the task', () => b.got.length === 1)
    expect(b.got[0]!.content).toContain('fix the login bug')
  })

  test('a running session is not closed for a restart, a cleanup or another session that can\'t start', async () => {
    const { hub, tmux, w } = setup({ maxLiveWorkers: 1, cleanupHours: 1 })
    const { key } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(key))
    await connect(hub, tmux, key, 1)
    await hook(hub, key, 'Stop')
    lock(w)
    const r = await hub.enqueue(() => hub.restart(key, true))
    expect(r).toMatchObject({ ok: false, state: 'failed' })
    expect(r.message).toContain("can't read")
    const other = worker(hub, w)
    expect(await hub.enqueue(() => hub.ensureStarted(other.key))).toBe('failed')
    hub.store.deleteWorker(other.key)
    await hub.enqueue(() => hub.cleanupDue(Date.now() + 100 * 3_600_000))
    expect(hub.queued(key) + hub.inFlight(key)).toBe(0)
    expect(hub.store.session(key)!.status).toBe('idle')
    expect(tmux.launches.length).toBe(1)
  })

  test('the status says so, also when the whole folder can\'t be read', () => {
    const { hub, w } = setup()
    const unlock = lock(w)
    expect(hub.snapshot().workspaces[0]!.unreadable).toContain("can't read")
    unlock()
    chmodSync(join(w.dir, '..'), 0o300)
    expect(hub.snapshot().workspaces).toEqual([])
    chmodSync(join(w.dir, '..'), 0o755)
    expect(hub.snapshot().workspaces[0]!.unreadable).toBeUndefined()
  })

  test('settings that can\'t be read stay as they were', () => {
    const { hub, p } = setup({ maxLiveWorkers: 2 })
    chmodSync(p.config, 0)
    expect(hub.reloadConfig()).toContain("can't read")
    expect(hub.cfg.maxLiveWorkers).toBe(2)
    chmodSync(p.config, 0o600)
    expect(hub.reloadConfig()).toBeUndefined()
  })
})

describe('interrupted work resumes', () => {
  test('an API error re-delivers the task after a backoff, with a note', async () => {
    const { hub, tmux, posts, w } = setup()
    const { key, taskId } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(key))
    const b = await connect(hub, tmux, key, 1)
    expect(b.got.map(m => m.meta.task_id)).toEqual([String(taskId)])
    expect(hub.store.session(key)!.status).toBe('busy')

    await hook(hub, key, 'StopFailure', { error: 'server_error — {"type":"overloaded_error"}' })
    expect(hub.store.task(taskId)!.state).toBe('interrupted')
    expect(hub.held(key)).toBe(true)
    expect(hub.store.session(key)!.status).toBe('idle')
    expect(posts).toEqual([]) // a blip that fixes itself isn't worth a post
    expect(b.got.length).toBe(1) // nothing goes in before the retry

    await until('retry delivers the task again', () => b.got.length === 2)
    expect(b.got[1]!.content).toContain('fix the login bug')
    expect(b.got[1]!.content).toContain('Re-delivered: your last turn on this stopped with an API error')
    expect(hub.store.task(taskId)!.state).toBe('delivered')

    // Still failing: the second try stays quiet, the third tells the thread once.
    await hook(hub, key, 'StopFailure', { error: 'overloaded' })
    expect(posts).toEqual([])
    await hub.enqueue(() => hub.wake(key))
    await hook(hub, key, 'StopFailure', { error: 'overloaded' })
    expect(posts.map(p => p.message)).toEqual([expect.stringMatching(/^⚠️ \*\*Fixer\*\* keeps hitting API errors \(overloaded\)\. Still retrying; next try in 3m/)])
    await hub.enqueue(() => hub.wake(key))
    expect(b.got.length).toBe(4)

    await hook(hub, key, 'Stop')
    expect(hub.store.task(taskId)!.state).toBe('ended')
    expect(hub.liveOf(key).failures).toBe(0)
  }, T)

  test('rate limits wait; wake retries now; fatal errors are not retried', async () => {
    const { hub, tmux, posts, w } = setup()
    const { key, taskId } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(key))
    const b = await connect(hub, tmux, key, 1)

    await hook(hub, key, 'StopFailure', { error: 'rate_limit — 429' })
    expect(posts.map(p => p.message)).toEqual([expect.stringMatching(/is rate-limited .*It carries on by itself; next try in 5m/)])
    expect(hub.retryAt(key)).toBeGreaterThan(Date.now() + 4 * 60_000)
    // While it waits, the snapshot shows it and the reaper doesn't restart it.
    const snap = hub.snapshot().workspaces[0]!.sessions.find(s => s.key === key)!
    expect(snap.retryAt).toBeGreaterThan(Date.now())

    const r = await hub.enqueue(() => hub.wake(key))
    expect(r.message).toMatch(/^retrying/)
    expect(b.got.length).toBe(2)
    expect(hub.held(key)).toBe(false)
    await hook(hub, key, 'StopFailure', { error: 'rate_limit — 429' })
    expect(posts.length).toBe(1) // said once, not on every try
    await hub.enqueue(() => hub.wake(key))

    await hook(hub, key, 'StopFailure', { error: 'authentication_failed — invalid x-api-key' })
    expect(hub.store.task(taskId)!.state).toBe('failed')
    expect(hub.held(key)).toBe(false)
    expect(posts.at(-1)!.message).toContain('Not retrying automatically')
  }, T)

  test("a router that crashes mid-turn gets the message again after it resumes", async () => {
    const { hub, tmux, posts } = setup()
    const w = hub.ws('demo')!
    const rkey = hub.createRouter({ threadId: 'T2', channelId: 'C1', workspace: w, label: 'thread two' })
    await hub.enqueue(() => hub.deliver(rkey, 'what does the login page do?', { chat_id: 'C1', thread_id: 'T2', message_id: 'm1', user: 'alice' }))
    const b1 = await connect(hub, tmux, rkey, 1)
    expect(b1.got.map(m => m.content)).toEqual(['what does the login page do?'])
    expect(hub.inFlight(rkey)).toBe(1)

    // The claude process dies (kill -9): tmux session and bridge go with it.
    tmux.alive.delete(tmuxName(rkey))
    hub.onBridgeGone(rkey, b1.conn)
    const b2 = await connect(hub, tmux, rkey, 2)
    expect(posts).toEqual([]) // recovered on its own: nothing to tell people
    expect(b2.got.length).toBe(1)
    expect(b2.got[0]!.content).toMatch(/^\(Re-delivered: your session was interrupted/)
    expect(b2.got[0]!.content).toContain('what does the login page do?')
    expect(b2.got[0]!.meta.message_id).toBe('m1')
    expect(hub.store.session(rkey)!.closeReason).toBeUndefined()
  }, T)

  test('a session stopped by hand keeps its work for later instead of restarting itself', async () => {
    const { hub, tmux, w } = setup()
    const { key, taskId } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(key))
    await connect(hub, tmux, key, 1)

    await hub.enqueue(() => hub.close(key, 'manual'))
    expect(hub.store.task(taskId)!.state).toBe('interrupted')
    await hub.enqueue(() => hub.pump())
    expect(tmux.launches.length).toBe(1)

    await hub.enqueue(() => hub.wake(key))
    const b = await connect(hub, tmux, key, 2)
    expect(b.got[0]!.content).toContain('Re-delivered: your session was interrupted while you worked on this')
  }, T)
})

describe('typing indicator', () => {
  test('shown in the thread a session works for while it runs; not while it starts, nor while it waits on a person or a retry', async () => {
    const { hub, tmux, w, typing } = setup()
    const { key } = worker(hub, w)
    hub.keepTyping()
    expect(typing).toEqual([]) // not started yet
    await hub.enqueue(() => hub.ensureStarted(key))
    hub.keepTyping()
    expect(typing).toEqual([]) // starting, with a task waiting: not running yet
    await connect(hub, tmux, key, 1) // the task goes in: busy
    typing.length = 0
    hub.keepTyping()
    expect(typing).toEqual(['C1/T1'])

    hub.desk.add({ code: 'abcde', key, title: 'Fixer', toolName: 'Bash', description: 'ls', inputPreview: '', threadId: 'T1', channelId: 'C1', createdAt: 0 })
    typing.length = 0
    hub.keepTyping()
    expect(typing).toEqual([]) // waiting on a 🔐 answer
    hub.desk.take('abcde')

    await hook(hub, key, 'StopFailure', { error: 'overloaded' })
    typing.length = 0
    hub.keepTyping()
    expect(typing).toEqual([]) // idle, a retry is scheduled
    hub.clearRetry(key)
  }, T)
})

describe('background work', () => {
  test('typing stays up while work the session left running goes on; its notice runs a turn; idle close, cleanup and a graceful restart wait for it', async () => {
    const { hub, tmux, w, typing } = setup()
    const { key, taskId } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(key))
    const b = await connect(hub, tmux, key, 1)
    const row = hub.store.session(key)!
    const tp = transcriptPath(row.cwd, row.sessionId)
    mkdirSync(dirname(tp), { recursive: true })
    const at = (ms: number) => new Date(ms).toISOString()
    // The turn starts a build in the background, then ends ("I'll report when it's done").
    writeFileSync(tp, `${JSON.stringify({ type: 'user', timestamp: at(Date.now()), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Command running in background with ID: bk1.' }] }, toolUseResult: { stdout: '', stderr: '', backgroundTaskId: 'bk1' } })}\n`)
    await hook(hub, key, 'Stop')
    expect(hub.store.task(taskId)!.state).toBe('ended')
    expect(hub.store.session(key)!.status).toBe('idle')
    expect(hub.backgroundOf(key).map(t => t.id)).toEqual(['bk1'])
    typing.length = 0
    hub.keepTyping()
    expect(typing).toEqual(['C1/T1'])
    expect(hub.snapshot().workspaces[0]!.sessions.find(s => s.key === key)!.background).toBe(1)

    // Not closed for being idle, nor cleaned up, nor restarted under it.
    hub.store.patchSession(key, { lastActiveAt: Date.now() - 48 * 3_600_000 })
    await hub.enqueue(() => hub.reap())
    expect(hub.store.session(key)!.status).toBe('idle')
    expect(b.got.length).toBe(1) // no cleanup job
    const r = await hub.enqueue(() => hub.restart(key))
    expect(r.state).toBe('pending')
    expect(r.message).toContain('once the work it runs in the background is done (1 task)')
    expect(tmux.launches.length).toBe(1)
    // New work doesn't wait for that restart: the background work holds it off anyway.
    const more = await hub.enqueue(() => delegate(hub, { thread: hub.store.thread('T1')!, workerKey: key, task: 'and update the docs', messageIds: [] }))
    expect(more.state).toBe('delivered')
    await hook(hub, key, 'Stop')
    expect(tmux.launches.length).toBe(1) // still running in the background

    // The build ends: Claude Code queues its notice and starts a turn with it.
    const done = Date.now() + 5
    const note = '<task-notification>\n<task-id>bk1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n</task-notification>'
    writeFileSync(tp, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(done), content: note })}\n${JSON.stringify({ type: 'user', timestamp: at(done), origin: { kind: 'task-notification' }, message: { role: 'user', content: note } })}\n`, { flag: 'a' })
    await Bun.sleep(10)
    typing.length = 0
    hub.keepTyping()
    await hub.enqueue(async () => {})
    expect(hub.backgroundOf(key)).toEqual([])
    expect(hub.store.session(key)!.status).toBe('busy') // its own turn, for the notice
    hub.keepTyping()
    expect(typing).toEqual(['C1/T1'])

    // That turn ends: nothing runs any more, so the pending restart happens.
    await hook(hub, key, 'Stop')
    await connect(hub, tmux, key, 2)
    expect(hub.restartPending(key)).toBe(false)
    expect(hub.backgroundOf(key)).toEqual([]) // the new process starts with none
  }, T)

  test("Code Mode: a script and a command it didn't await hold off the idle close; its event, while idle, runs a turn", async () => {
    const { hub, w, tmux } = setup()
    const { key } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(key))
    await connect(hub, tmux, key, 1)
    const row = hub.store.session(key)!
    const tp = transcriptPath(row.cwd, row.sessionId)
    mkdirSync(dirname(tp), { recursive: true })
    const add = (o: Record<string, unknown>) => writeFileSync(tp, `${JSON.stringify({ timestamp: new Date(Date.now() + 5).toISOString(), ...o })}\n`, { flag: 'a' })
    const result = (r: Record<string, unknown>) => add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] }, toolUseResult: { code: 'x', stdout: '', stderr: '', ...r } })
    const ev = (status: string, body: string) => `<event nonce="n" kind="repl-eval" at="2026-11-25T10:00:00.000Z" eval="1" status="${status}">\n${body}\n</event>`
    result({ result: '(dispatched #1)', evalId: 1, asyncDispatched: true })
    await hook(hub, key, 'Stop')
    const idleLong = async () => {
      hub.store.patchSession(key, { lastActiveAt: Date.now() - 48 * 3_600_000 })
      await hub.enqueue(() => hub.reap())
      return hub.store.session(key)!.status
    }
    expect(await idleLong()).toBe('idle') // not closed: the script runs on
    hub.store.patchSession(key, { lastActiveAt: Date.now() })
    await Bun.sleep(10)

    // It ends with a command still running, and Claude Code starts a turn with its event.
    const settled = ev('settled', '<log>[stderr] ⚠ 1 tool call(s) still running at script end (Bash) — they run on</log>')
    add({ type: 'queue-operation', operation: 'enqueue', content: settled.replace(' nonce="n"', '') })
    add({ type: 'attachment', attachment: { type: 'poll_events', envelopes: [settled], kinds: ['repl-eval'], remainingWakeCount: 0 } })
    await Bun.sleep(10)
    hub.keepTyping()
    await hub.enqueue(async () => {})
    expect(hub.store.session(key)!.status).toBe('busy')
    expect(hub.backgroundOf(key).map(t => t.id)).toEqual(['calls:1'])
    await hook(hub, key, 'Stop')
    expect(await idleLong()).toBe('idle') // not closed: the command runs on
    add({ type: 'queue-operation', operation: 'enqueue', content: ev('late', '<log>The tool calls that this script left running have ended. Completed since it returned: Bash.</log>').replace(' nonce="n"', '') })
    expect(hub.backgroundOf(key)).toEqual([])
    expect(await idleLong()).not.toBe('idle')
  }, T)
})

/** A Stop hook the way the hub's socket answers it: the turn is sent back, or it ends. */
async function stopWith(hub: Hub, key: string, text: string, active = false): Promise<string | undefined> {
  const block = hub.unpostedStop({ t: 'hook', key, event: 'Stop', stop_hook_active: active, text })
  if (!block) await hook(hub, key, 'Stop')
  return block
}

describe('a turn that posts nothing', () => {
  test('ending with text but no reply goes back to the session once, to post it', async () => {
    const { hub, tmux, posts } = setup()
    const w = hub.ws('demo')!
    const rkey = hub.createRouter({ threadId: 'T2', channelId: 'C1', workspace: w, label: 'recap' })
    await hub.enqueue(() => hub.deliver(rkey, 'recap the issues in that thread as a table', { chat_id: 'C1', thread_id: 'T2', message_id: 'm1', user: 'ami' }))
    await connect(hub, tmux, rkey, 1)
    await handleCall(hub, rkey, 'fetch_thread', {}) // reading reaches no one

    // The table went to its terminal: the turn goes on, still busy, the message still in flight.
    const block = await stopWith(hub, rkey, '| # | Issue | Status |\n|---|---|---|\n| 1 | Financial impact | Saved |')
    expect(block).toContain('Nothing was posted this turn: people read Mattermost, not this terminal')
    expect(block).toContain('send it now with reply (thread_id T2): all of it')
    expect(hub.store.session(rkey)!.status).toBe('busy')
    expect(hub.inFlight(rkey)).toBe(1)
    expect(posts).toEqual([])

    // Claude Code marks the Stop after a sent-back turn: that one ends the turn, whatever it says.
    expect(await stopWith(hub, rkey, 'Posted the table.', true)).toBeUndefined()
    expect(hub.store.session(rkey)!.status).toBe('idle')
    expect(hub.inFlight(rkey)).toBe(0)
  }, T)

  test('not after a reply, not without text, not for a turn the hub did not start', async () => {
    const { hub, tmux } = setup()
    const w = hub.ws('demo')!
    const rkey = hub.createRouter({ threadId: 'T2', channelId: 'C1', workspace: w, label: 'recap' })
    await hub.enqueue(() => hub.deliver(rkey, 'what is left?', { chat_id: 'C1', thread_id: 'T2', message_id: 'm1', user: 'ami' }))
    const b = await connect(hub, tmux, rkey, 1)
    await handleCall(hub, rkey, 'reply', { text: 'Two items are left.' })
    expect(await stopWith(hub, rkey, 'Answered Ami in the thread.')).toBeUndefined()
    expect(hub.store.session(rkey)!.status).toBe('idle')

    await hub.enqueue(() => hub.deliver(rkey, 'thanks', { chat_id: 'C1', thread_id: 'T2', message_id: 'm2', user: 'ami' }))
    expect(b.got.length).toBe(2)
    expect(await stopWith(hub, rkey, '  ')).toBeUndefined() // said nothing on purpose
    expect(hub.store.session(rkey)!.status).toBe('idle')

    // Someone typed in its terminal: that turn's text is for them.
    expect(await stopWith(hub, rkey, 'Here is the summary you asked for.')).toBeUndefined()
  }, T)

  test("a worker that writes its result instead of reporting is told the router reads only its reports", async () => {
    const { hub, tmux, w } = setup()
    const { key } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(key))
    await connect(hub, tmux, key, 1)
    const block = await stopWith(hub, key, 'Fixed the login bug; tests pass.')
    expect(block).toContain("Nothing was posted this turn: the thread's router reads only your reports, not this terminal")
    expect(block).toContain('reply (thread_id T1)')
    expect(hub.store.session(key)!.status).toBe('busy')
    await stopWith(hub, key, 'Reported.', true)
    expect(hub.store.session(key)!.status).toBe('idle')
  }, T)
})

describe('cleanup after a day without work', () => {
  const H = 3_600_000
  /** A closed worker with worktrees, last active `ago` ms before `now`. */
  function idleWorker(hub: Hub, w: Workspace, now: number, ago: number) {
    const key = hub.createWorker({ workspace: w, title: 'Fixer', summary: 'fixes things' })
    hub.store.patchWorker(key, { threads: ['T1'], repos: { app: { path: '/ws/.worktrees/app-fixer', branch: 'fixer' }, notes: { path: '/ws/notes', shared: true } } })
    hub.store.patchSession(key, { lastActiveAt: now - ago })
    return key
  }

  test("the worker's own session gets the job, posts nothing, and closes after it; once per stretch without work", async () => {
    const { hub, tmux, w, posts, typing } = setup()
    const now = Date.now()
    const key = idleWorker(hub, w, now, 25 * H)
    await hub.enqueue(() => hub.cleanupDue(now))
    const b = await connect(hub, tmux, key, 1)
    expect(b.got.length).toBe(1)
    expect(b.got[0]!.meta.kind).toBe('cleanup')
    const job = b.got[0]!.content
    expect(job).toContain('Cleanup: you have had no work for 24 hours')
    expect(job).toContain('docker compose down')
    expect(job).toContain('delete node_modules, dist, build')
    expect(job).toContain('Your worktrees:\n- /ws/.worktrees/app-fixer (app)')
    expect(job).toContain('Shared with other sessions, so leave their dependencies and build output alone:\n- /ws/notes (notes)')
    expect(job).toContain("don't use git clean")

    hub.keepTyping()
    expect(typing).toEqual([]) // nobody is waiting on it in the thread

    // Unattended, as with bypassPermissions: a prompt is allowed at once, without a 🔐 post.
    const answers: HubMsg[] = []
    const send = b.conn.send
    b.conn.send = m => { answers.push(m); send(m) }
    await hub.enqueue(() => hub.onPermissionRequest(key, { t: 'permission_request', request_id: 'abcde', tool_name: 'Bash', description: 'Remove build output', input_preview: '{"command":"rm -rf node_modules dist"}' }))
    expect(answers).toEqual([{ t: 'permission', request_id: 'abcde', behavior: 'allow' }])
    expect(hub.desk.count(key)).toBe(0)

    expect(hub.unpostedStop({ t: 'hook', key, event: 'Stop', text: 'Removed node_modules and dist.' })).toBeUndefined()

    await hook(hub, key, 'Stop')
    expect(hub.store.session(key)!.status).toBe('stopped')
    expect(posts).toEqual([])

    // Done for this stretch: no second job until it has worked again.
    await hub.enqueue(() => hub.cleanupDue(now + 48 * H))
    expect(tmux.launches.length).toBe(1)
    hub.store.patchSession(key, { lastActiveAt: now + 50 * H })
    await hub.enqueue(() => hub.cleanupDue(now + 75 * H))
    await until('second cleanup launch', () => tmux.launches.length === 2)
  }, T)

  test('not before cleanupHours, nor with work waiting, nor pinned; 0 turns it off; a task drops a waiting job', async () => {
    const { hub, tmux, w } = setup()
    const now = Date.now()
    const recent = idleWorker(hub, w, now, 23 * H)
    const pinned = idleWorker(hub, w, now, 25 * H)
    hub.store.patchSession(pinned, { pinned: true })
    const busy = worker(hub, w) // a task waits for it
    hub.store.patchSession(busy.key, { lastActiveAt: now - 25 * H })
    await hub.enqueue(() => hub.cleanupDue(now))
    expect(hub.store.messagesFor(recent, ['queued'])).toEqual([])
    expect(hub.store.messagesFor(pinned, ['queued'])).toEqual([])
    expect(hub.store.messagesFor(busy.key, ['queued'])).toEqual([])

    hub.cfg.cleanupHours = 0
    const off = idleWorker(hub, w, now, 100 * H)
    await hub.enqueue(() => hub.cleanupDue(now))
    expect(hub.store.messagesFor(off, ['queued'])).toEqual([])
    hub.cfg.cleanupHours = 24

    // A job and a task both wait: the task goes in, the job is dropped.
    const both = worker(hub, w)
    const jobId = hub.store.insertMessage({ sessionKey: both.key, content: 'Cleanup: …', meta: { kind: 'cleanup' }, state: 'queued', createdAt: now })
    await hub.enqueue(() => hub.ensureStarted(both.key))
    const b = await connect(hub, tmux, both.key, 1)
    expect(b.got.map(m => m.meta.task_id)).toEqual([String(both.taskId)])
    expect(hub.store.messagesFor(both.key, ['ended']).map(m => m.id)).toEqual([jobId])
  }, T)
})

describe('graceful restart', () => {
  test('waits for the turn to end, then relaunches with --resume; late hooks of the old process are ignored', async () => {
    const { hub, tmux, w } = setup()
    const { key, taskId } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(key))
    const b1 = await connect(hub, tmux, key, 1)
    const firstSpawn = tmux.launches[0]!.env.MMHUB_SPAWN!
    expect(firstSpawn).toBeTruthy()

    const r = await hub.enqueue(() => hub.restart(key))
    expect(r.state).toBe('pending')
    expect(hub.restartPending(key)).toBe(true)
    expect(hub.snapshot().workspaces[0]!.sessions.find(s => s.key === key)!.restartPending).toBe(true)
    expect(tmux.launches.length).toBe(1) // the running turn is left alone

    // New work meanwhile waits for the restarted session (it should get the new settings).
    const more = await hub.enqueue(() => delegate(hub, { thread: hub.store.thread('T1')!, workerKey: key, task: 'also fix the logout bug', messageIds: [] }))
    expect(more.state).toBe('queued')
    expect(b1.got.length).toBe(1)

    // The worker has a transcript by now, so the restart resumes it.
    const row = hub.store.session(key)!
    const tp = transcriptPath(row.cwd, row.sessionId)
    mkdirSync(dirname(tp), { recursive: true })
    writeFileSync(tp, '{}\n')

    await hook(hub, key, 'Stop')
    expect(hub.store.task(taskId)!.state).toBe('ended') // finished before the restart
    const b2 = await connect(hub, tmux, key, 2)
    expect(hub.restartPending(key)).toBe(false)
    const relaunch = tmux.launches[1]!
    expect(relaunch.argv).toContain('--resume')
    expect(relaunch.argv).toContain(row.sessionId)
    expect(relaunch.env.MMHUB_SPAWN).not.toBe(firstSpawn)
    expect(b1.got.length).toBe(1)
    // Nothing re-delivered (nothing was cut off); the work that waited goes to the new process.
    expect(b2.got.map(m => m.meta.task_id)).toEqual([String(more.task_id)])
    expect(b2.got[0]!.content).not.toContain('Re-delivered')

    // The old process's SessionEnd arrives late: it must not touch the new one
    // (otherwise the hub would take it for the new process exiting and kill it).
    const hookAt = hub.liveOf(key).lastHookAt
    await hook(hub, key, 'SessionEnd', { spawn: firstSpawn })
    await hook(hub, key, 'Stop', { spawn: firstSpawn })
    expect(hub.liveOf(key).lastHookAt).toBe(hookAt)
    expect(hub.store.session(key)!.turns).toBe(row.turns + 1) // only the real Stop counted
    expect(tmux.alive.has(tmuxName(key))).toBe(true)
    // Still working on the task that waited: the old process's Stop didn't end it.
    expect(hub.store.session(key)!.status).toBe('busy')
    expect(hub.store.task(more.task_id)!.state).toBe('delivered')
  }, T)

  test('an idle session restarts right away; --now cuts the turn and re-delivers it', async () => {
    const { hub, tmux, w } = setup()
    const { key, taskId } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(key))
    await connect(hub, tmux, key, 1)

    const r = await hub.enqueue(() => hub.restart(key, true))
    expect(r.state).toBe('restarted')
    expect(r.message).toContain('re-delivered')
    const b2 = await connect(hub, tmux, key, 2)
    expect(b2.got[0]!.meta.task_id).toBe(String(taskId))
    expect(b2.got[0]!.content).toContain('Re-delivered')

    await hook(hub, key, 'Stop')
    const idle = await hub.enqueue(() => hub.restart(key))
    expect(idle.state).toBe('restarted')
    await connect(hub, tmux, key, 3)
  }, T)
})

describe('worker reports', () => {
  /** A thread with its own router (stopped), and a worker linked to it with a task in flight. */
  async function scene() {
    const env = setup()
    const { hub, tmux, w } = env
    const rkey = hub.createRouter({ threadId: 'T3', channelId: 'C1', workspace: w, label: 'thread three' })
    const key = hub.createWorker({ workspace: w, title: 'Fixer', summary: 'fixes things' })
    hub.store.patchWorker(key, { threads: ['T3'] })
    const taskId = hub.store.insertTask({ workerKey: key, threadId: 'T3', channelId: 'C1', text: 'fix the login bug', state: 'queued', createdAt: Date.now() })
    await hub.enqueue(() => hub.ensureStarted(key))
    await connect(hub, tmux, key, 1)
    return { ...env, rkey, key, taskId }
  }

  test('by default they go to the router, which decides what the person sees', async () => {
    const { hub, tmux, posts, rkey, key, taskId, w } = await scene()
    const shot = join(w.dir, 'inbox', 'shot.png')
    mkdirSync(dirname(shot), { recursive: true })
    writeFileSync(shot, 'png')
    const res = await handleCall(hub, key, 'reply', { thread_id: 'T3', text: 'Fixed the login bug on mm/' + key + '; tests pass.', files: [shot] })
    expect(res).toContain("reported to the thread's router")
    expect(posts).toEqual([]) // nothing in the thread from the worker

    // The router wasn't running: the report waits in its inbox and starts it.
    const rb = await connect(hub, tmux, rkey, 2)
    expect(rb.got.length).toBe(1)
    const report = rb.got[0]!
    expect(report.meta).toMatchObject({ kind: 'worker_report', worker_id: key, task_id: String(taskId), thread_id: 'T3', chat_id: 'C1' })
    expect(report.content).toContain(`[Report from worker "Fixer" (${key}) on task #${taskId}`)
    expect(report.content).toContain('(The task: fix the login bug)') // the router may not have given it
    expect(report.content).toContain('Fixed the login bug')
    expect(report.content).toContain(`Files you can attach (reply's files): ${shot}`)
    expect(hub.store.worker(key)!.lastPost).toContain('Fixed the login bug')

    // Files must exist and be absolute; threads must be the worker's own.
    await expect(handleCall(hub, key, 'reply', { thread_id: 'T3', text: 'x', files: ['shot.png'] })).rejects.toThrow(ToolError)
    await expect(handleCall(hub, key, 'reply', { thread_id: 'T3', text: 'x', files: [join(w.dir, 'missing.png')] })).rejects.toThrow('no such file')
    await expect(handleCall(hub, key, 'reply', { thread_id: 'T1', text: 'x' })).rejects.toThrow('not linked to you')

    // Sessions are told the mode: the bridge (tool wording) and the context (rules).
    const mcp = JSON.parse(readFileSync(join(hub.p.sessions, key, 'mcp.json'), 'utf8'))
    expect(mcp.mcpServers.mmhub.env.MMHUB_REPORTS).toBe('router')
    expect(hub.hookContext(rkey)).toContain('kind="worker_report"')
    expect(hub.hookContext(rkey)).toContain('react to it with "pray" and say nothing')
    expect(hub.hookContext(key)).toContain("goes to that thread's router")
  }, T)

  test('with workerReports "thread", workers post in the thread under their title', async () => {
    const { hub, posts, key } = await scene()
    writeFileSync(hub.p.config, JSON.stringify({ ...JSON.parse(readFileSync(hub.p.config, 'utf8')), workerReports: 'thread' }))
    hub.reloadConfig()
    const res = await handleCall(hub, key, 'reply', { thread_id: 'T3', text: 'Fixed it.' })
    expect(res).toMatch(/^sent/)
    expect(posts.map(p => [p.root_id, p.message])).toEqual([['T3', '**🛠 Fixer**\nFixed it.']])
    expect(hub.hookContext(key)).toContain('posts in that thread under your title')
  }, T)
})

describe('provider fallback', () => {
  const KEY = 'sk-ant-api03-NEVER-IN-ARGV'
  /** Hub-wide chain: an API-key provider first, the hub's own login after it. */
  function withProviders() {
    return setup({ providers: ['primary', 'default'] }, dir => {
      saveProviders(dir, { primary: { kind: 'api-key', description: 'team key' }, bk: { kind: 'bedrock', env: { AWS_REGION: 'us-east-1' }, channels: true } })
      writeSecret(dir, 'primary', 'ANTHROPIC_API_KEY', KEY)
    })
  }

  test('a sign-in error moves the work to the next provider, resuming the conversation; the primary comes back after its rest', async () => {
    const { hub, tmux, posts, w, p } = withProviders()
    const { key, taskId } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(key))
    const b1 = await connect(hub, tmux, key, 1)

    // On the primary: the launch goes through the launch script; the key reaches claude via apiKeyHelper.
    const first = tmux.launches[0]!
    expect(first.argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(first.argv[4]).toBe(join(p.sessions, key, 'provider.env'))
    expect(JSON.stringify(first)).not.toContain(KEY)
    const settings = JSON.parse(readFileSync(join(p.sessions, key, 'settings.json'), 'utf8')) as { apiKeyHelper?: string }
    expect(settings.apiKeyHelper).toBe(`cat ${secretFile(p.dir, 'primary', 'ANTHROPIC_API_KEY')}`)
    expect(hub.providerOf(key)).toBe('primary')
    let snap = hub.snapshot().workspaces[0]!
    expect(snap.provider).toMatchObject({ active: 'primary', kind: 'api-key', fallback: false, healthy: true })
    expect(snap.sessions.find(s => s.key === key)!.provider).toBe('primary')

    const row = hub.store.session(key)!
    const tp = transcriptPath(row.cwd, row.sessionId)
    mkdirSync(dirname(tp), { recursive: true })
    writeFileSync(tp, '{}\n')

    await hook(hub, key, 'StopFailure', { error: `authentication_failed — invalid x-api-key ${KEY}` })
    // Said once in the thread, without the key.
    expect(posts.map(x => x.message)).toEqual([expect.stringMatching(/^⇄ \*\*Fixer\*\* hit a sign-in error on provider `primary` .*now runs on `default`.*tried again in 1h/)])
    expect(posts[0]!.message).not.toContain('NEVER-IN-ARGV')

    // Restarted on the next provider right away (the turn had ended), resuming, with the work re-delivered.
    const b2 = await connect(hub, tmux, key, 2)
    const second = tmux.launches[1]!
    expect(second.argv[0]).toBe('/bin/claude') // the hub's own login: no launch script
    expect(second.argv).toContain('--resume')
    expect(second.argv).toContain(row.sessionId)
    expect(b1.got.length).toBe(1)
    expect(b2.got[0]!.meta.task_id).toBe(String(taskId))
    expect(b2.got[0]!.content).toContain('Re-delivered')
    expect(b2.got[0]!.content).toContain('fix the login bug')
    expect(hub.providerOf(key)).toBe('default')
    expect(JSON.parse(readFileSync(join(p.sessions, key, 'settings.json'), 'utf8')).apiKeyHelper).toBeUndefined()

    snap = hub.snapshot().workspaces[0]!
    expect(snap.provider!.active).toBe('default')
    expect(snap.provider!.fallback).toBe(true)
    expect(snap.provider!.healthy).toBe(true)
    expect(snap.provider!.chain[0]).toMatchObject({ name: 'primary', kind: 'api-key', reason: expect.stringMatching(/^auth: authentication_failed/) })
    expect(snap.provider!.chain[0]!.coolingUntil).toBeGreaterThan(Date.now() + 50 * 60_000)
    expect(JSON.stringify(hub.snapshot())).not.toContain('NEVER-IN-ARGV')
    expect(hub.providerLine(w)).toMatch(/^`default` \(fallback\) — `primary` auth: .*, back in /)

    await hook(hub, key, 'Stop')
    expect(hub.store.task(taskId)!.state).toBe('ended')

    // The rest is over: the next rebalance moves the (idle) session back to the primary.
    hub.providerHealth('primary')!.coolUntil = Date.now() - 1
    expect(await hub.enqueue(() => hub.rebalanceProviders())).toBe(1)
    await connect(hub, tmux, key, 3)
    expect(tmux.launches[2]!.argv[0]).toBe('/bin/sh')
    expect(tmux.launches[2]!.argv).toContain('--resume')
    expect(hub.providerOf(key)).toBe('primary')
    expect(hub.snapshot().workspaces[0]!.provider).toMatchObject({ active: 'primary', fallback: false })
    // Nothing else to move.
    expect(await hub.enqueue(() => hub.rebalanceProviders())).toBe(0)
  }, T)

  test("a start that shows no channels (third-party provider) rests it and starts on the next one", async () => {
    const { hub, tmux, posts, w } = withProviders()
    setWorkspaceProviders(hub.cfg, w.name, ['bk', 'hub'])
    const ws = hub.ws(w.name)!
    expect(hub.chainOf(ws)).toEqual(['bk', 'primary', 'default'])
    const { key, taskId } = worker(hub, ws)
    tmux.screen = () => hub.liveOf(key).provider === 'bk'
      ? ' ▐▛███▛█   Claude Code v2.1.325\n▎ --dangerously-load-development-channels ignored (server:mmhub)\n▎ Channels are not available on third-party providers\n❯ '
      : ''
    await hub.enqueue(() => hub.ensureStarted(key))
    // The bedrock start never gets a bridge that hears anything; the hub moves on.
    const b = await connect(hub, tmux, key, 2)
    expect(tmux.launches.length).toBe(2)
    expect(hub.providerOf(key)).toBe('primary')
    expect(b.got[0]!.meta.task_id).toBe(String(taskId))
    expect(posts.map(x => x.message)).toEqual([expect.stringMatching(/^⇄ \*\*Fixer\*\* hit no channel messages on provider `bk` \(no channels on third-party providers\).*now runs on `primary`.*tried again in 6h/)])
    expect(hub.snapshot().workspaces[0]!.provider).toMatchObject({ active: 'primary', fallback: true, chain: [{ name: 'bk', kind: 'bedrock', reason: 'channels: no channels on third-party providers' }, { name: 'primary' }, { name: 'default' }] })
  }, T)

  test('a workspace with no usable provider says so instead of starting', async () => {
    const { hub, tmux, posts, w } = withProviders()
    setWorkspaceProviders(hub.cfg, w.name, ['nope'])
    const { key } = worker(hub, hub.ws(w.name)!)
    await hub.enqueue(() => hub.ensureStarted(key))
    expect(tmux.launches.length).toBe(0)
    expect(hub.store.session(key)!.status).toBe('failed')
    expect(posts.map(x => x.message)).toEqual([expect.stringContaining("can't start: workspace **demo** has no usable provider (`nope`: not defined)")])
    expect(hub.snapshot().workspaces[0]!.provider).toMatchObject({ active: 'nope', healthy: false, chain: [{ name: 'nope', kind: 'unknown', unusable: 'not defined' }] })
  }, T)
})

describe('sleep recovery', () => {
  test('a long gap between ticks, or quiet timers: new timers (retries keep their time) and a new Mattermost socket', async () => {
    const { hub, tmux, w, reconnects } = setup()
    const { key } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(key))
    await connect(hub, tmux, key, 1)
    await hook(hub, key, 'StopFailure', { error: 'rate_limit — 429' })
    const due = hub.retryAt(key)!

    hub.onTick(Date.now(), 5_000) // an ordinary tick
    expect(reconnects).toEqual([])

    hub.onTick(Date.now(), 49 * 60_000) // the machine slept 49 minutes
    expect(reconnects).toEqual([expect.stringMatching(/^no ticks for 49m/)])
    expect(Math.abs(hub.retryAt(key)! - due)).toBeLessThan(100) // re-armed, same due time
    expect(hub.snapshot().workspaces[0]!.sessions.find(s => s.key === key)!.retryAt).toBe(hub.retryAt(key))

    // Ticks keep coming but the hub's own timers stay quiet: same recovery.
    hub.onTick(Date.now() + 60_000, 5_000)
    expect(reconnects[1]).toMatch(/^the hub's timers stopped/)

    hub.clearRetry(key)
    await hub.enqueue(async () => {})
    await hub.shutdown()
  }, T)
})

describe('cross-workspace requests and DMs', () => {
  /** Workspace demo (thread T1, a worker busy on it) and workspace bee (bound to channel CB). */
  async function scene(before?: (stateDir: string) => void) {
    const env = setup({}, before)
    const { hub, tmux, w, p } = env
    hub.bot = { id: 'BOT', username: 'claude' }
    const bee = createWorkspace(loadConfig(p.config), 'bee')
    bindChannel(p.bindings, 'CB', 'bee')
    const { key } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(key))
    const wb = await connect(hub, tmux, key, 1)
    expect(wb.got.length).toBe(1) // its task on T1
    return { ...env, bee, key, wb }
  }

  test("a worker asks another workspace: the hub posts nothing, that workspace's router opens a thread in its own words, and its answers come back", async () => {
    const { hub, tmux, posts, others, bee, key, wb } = await scene()
    const res = await handleCall(hub, key, 'message_workspace', { workspace: 'bee', text: 'What is the staging DB host?' })
    const draft = /request_id (draft-\w+)/.exec(res)![1]!
    expect(res).toContain("sent to workspace bee's router")
    expect(posts).toEqual([]) // no 📨 post of the hub's: the other router writes what its channel reads
    expect(hub.store.link(draft)).toMatchObject({ kind: 'workspace', fromKey: key, fromThread: 'T1', peer: 'bee', chain: ['demo'], channelId: 'CB' })

    // bee gets a router for the request, told who is asking (never the asking thread's label) and that it opens the thread.
    const t = hub.store.thread(draft)!
    expect(t).toMatchObject({ channelId: 'CB', workspace: 'bee', label: 'request from workspace demo' })
    const rb = await connect(hub, tmux, t.routerKey, 2)
    expect(rb.got[0]!.meta).toMatchObject({ kind: 'workspace_request', from_workspace: 'demo', from_session: 'its worker "Fixer"', thread_id: draft, chat_id: 'CB', workspace: 'bee' })
    expect(rb.got[0]!.content).toContain('[Request from workspace demo — its worker "Fixer". Not a person')
    expect(rb.got[0]!.content).toContain('Your first reply opens this thread as a new post in ~CB')
    expect(rb.got[0]!.content).toContain('What is the staging DB host?')

    // Its first reply opens the thread in its channel, in its words, and reaches the worker as work for T1.
    await handleCall(hub, t.routerKey, 'reply', { chat_id: 'CB', text: 'Workspace demo asked for the staging DB host: staging-db.internal:5432' })
    expect(posts[0]).toMatchObject({ id: 'p1', channel_id: 'CB', message: 'Workspace demo asked for the staging DB host: staging-db.internal:5432' })
    expect(posts[0]!.root_id).toBeUndefined()
    expect(hub.store.link('p1')).toMatchObject({ kind: 'workspace', fromKey: key })
    await until('the answer reaches the worker', () => wb.got.length === 2)
    expect(wb.got[1]!.content).toContain('[Answer from workspace "bee" (its router) to your request p1')
    expect(wb.got[1]!.content).toContain('staging-db.internal:5432')
    expect(wb.got[1]!.meta).toMatchObject({ thread_id: 'T1' })

    // The asker reads the request thread. The other router reads threads not its own only for a person, and a workspace's request has none.
    expect(await handleCall(hub, key, 'fetch_thread', { thread_id: 'p1' })).toContain('staging-db.internal:5432')
    others.push({ id: 'T1', root_id: '', user_id: 'U1', channel_id: 'C1', message: 'demo work', create_at: 0 } as MMPost)
    await expect(handleCall(hub, t.routerKey, 'fetch_thread', { thread_id: 'T1' })).rejects.toThrow('no person to read for')

    // A follow-up, by the id the asker was given, goes to the same router as a message: nothing is posted.
    const n = rb.got.length
    await handleCall(hub, key, 'message_workspace', { request_id: draft, text: 'And the read replica?' })
    expect(posts.length).toBe(1)
    await until('the follow-up reaches the router', () => rb.got.length === n + 1)
    expect(rb.got[n]!.content).toContain('[Follow-up from workspace demo (its worker "Fixer") on its request')
    expect(rb.got[n]!.content).toContain('And the read replica?')
    expect(hub.store.link('p1')!.messages).toBe(3)

    // Refused: its own workspace, an unknown one, a loop back, a workspace that doesn't take requests.
    await expect(handleCall(hub, key, 'message_workspace', { workspace: 'demo', text: 'x' })).rejects.toThrow('your own workspace')
    await expect(handleCall(hub, key, 'message_workspace', { workspace: 'nope', text: 'x' })).rejects.toThrow('no workspace "nope"')
    await expect(handleCall(hub, t.routerKey, 'message_workspace', { workspace: 'demo', text: 'x' })).rejects.toThrow('already part of this request')
    await expect(handleCall(hub, 'w-someone-else', 'message_workspace', { request_id: 'p1', text: 'x' })).rejects.toThrow(ToolError)
    const manifest = join(bee.dir, 'workspace.json')
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), acceptFrom: ['ops'] }))
    await expect(handleCall(hub, key, 'message_workspace', { workspace: 'bee', text: 'x' })).rejects.toThrow("doesn't take requests from demo")
    expect(await handleCall(hub, key, 'list_workspaces', {})).toContain('- bee — does not take requests from your workspace')

    // A long conversation stops at the message limit.
    for (let i = hub.store.link('p1')!.messages; i < 60; i++) hub.store.bumpLink('p1')
    await expect(handleCall(hub, key, 'message_workspace', { request_id: 'p1', text: 'x' })).rejects.toThrow('reached 60 messages')
  }, T)

  /** A router of demo for thread T3, running. */
  async function askingRouter(hub: Hub, tmux: FakeTmux, w: Workspace, launch: number) {
    const rkey = hub.createRouter({ threadId: 'T3', channelId: 'C1', workspace: w, label: 'deploy plan' })
    await hub.enqueue(() => hub.ensureStarted(rkey))
    return { rkey, rb: await connect(hub, tmux, rkey, launch) }
  }

  test("a private question goes through the person's own agent: it asks them in a DM and sends their answer back", async () => {
    const { hub, tmux, w, p, posts, others, key } = await scene(dir => {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
    })
    const { rkey, rb } = await askingRouter(hub, tmux, w, 2)
    // bob (U2) wrote in the asking thread: it asks for him.
    hub.store.insertMessage({ sessionKey: rkey, content: 'Can we deploy today?', meta: { user_id: 'U2', user: 'bob' }, state: 'ended', createdAt: Date.now() })

    // Routers only: a worker reports the question to its router instead.
    await expect(handleCall(hub, key, 'send_dm', { user: 'alice', text: 'May I deploy?' })).rejects.toThrow('only routers ask people privately')

    const res = await handleCall(hub, rkey, 'send_dm', { user: '@alice', text: 'May I deploy to staging today?' })
    const draft = /thread_id (draft-\w+)/.exec(res)![1]!
    expect(res).toContain("asked @alice's own agent (workspace personal-U1)")
    expect(posts).toEqual([]) // the hub posts nothing: her agent asks in its own words
    expect(loadBindings(p.bindings)['D1']).toBe('personal-U1')
    const t = hub.store.thread(draft)!
    expect(t).toMatchObject({ channelId: 'D1', workspace: 'personal-U1' })
    expect(hub.store.link(draft)).toMatchObject({ kind: 'personal', fromKey: rkey, peer: 'U1', fromThread: 'T3' })

    // Her agent gets the question, asks her in the DM (its first reply opens the thread) ...
    const ab = await connect(hub, tmux, t.routerKey, 3)
    expect(ab.got[0]!.meta).toMatchObject({ kind: 'dm_request', from_workspace: 'demo' })
    expect(ab.got[0]!.content).toContain('[Private question from workspace demo — the router of one of its threads, for @alice. Not a person')
    expect(ab.got[0]!.content).toContain('May I deploy to staging today?')
    await handleCall(hub, t.routerKey, 'reply', { text: 'Hi Alice, the deploy-plan thread in demo asks: may it deploy to staging today?' })
    const root = posts[0]!.id
    expect(posts[0]).toMatchObject({ channel_id: 'D1' })
    expect(hub.store.link(root)).toMatchObject({ kind: 'personal', fromKey: rkey })
    expect(rb.got.length).toBe(0) // the question to her doesn't go back to the asker

    // ... she answers there: it reaches her agent, not the asker, which can't read the DM either.
    const said = 'May it deploy to staging today? Yes, but only after 3pm, once the payments migration has finished running.'
    const reply = { id: 'R1', root_id: root, user_id: 'U1', channel_id: 'D1', message: said, create_at: Date.now() } as MMPost
    others.push(reply)
    await hub.enqueue(() => hub.onPosted(reply, 'D'))
    await until('her answer reaches her agent', () => ab.got.length === 2)
    expect(ab.got[1]!.content).toContain(said)
    expect(rb.got.length).toBe(0)
    await expect(handleCall(hub, rkey, 'fetch_thread', { thread_id: root })).rejects.toThrow()

    // Her agent sends back what was asked, in its own words: her words, quoted, are refused.
    await expect(handleCall(hub, t.routerKey, 'answer_request', { text: `She said: "${said.slice(31)}"` }))
      .rejects.toThrow(`"yes but only after 3pm once…" is @alice's own words`)
    expect(rb.got.length).toBe(0)
    // Words of the question she echoed don't count.
    const gist = 'Re may it deploy to staging today: approved after 3pm, when the payments migration is done.'
    expect(await handleCall(hub, t.routerKey, 'answer_request', { text: gist })).toContain('sent back to workspace demo')
    await until('the answer reaches the asker', () => rb.got.length === 1)
    expect(rb.got[0]!.meta).toMatchObject({ kind: 'dm_reply', user: 'alice' })
    expect(rb.got[0]!.content).toContain("[Answer from @alice's own agent (workspace personal-U1)")
    expect(rb.got[0]!.content).toContain(gist)
    expect(rb.got[0]!.content).not.toContain('quotes')
    // Her exact words only when the agent says why they must go as they are.
    await handleCall(hub, t.routerKey, 'answer_request', { text: said, verbatim: 'she asked me to send her wording as it is' })
    await until('the quote reaches the asker', () => rb.got.length === 2)
    expect(rb.got[1]!.content).toContain(said)
    expect(rb.got[1]!.content).toContain("(It quotes @alice's own words, as they asked: she asked me to send her wording as it is)")

    // The asker asks more, by the id it was given: her agent gets it. Her answer to the asker doesn't make her the one it serves.
    await handleCall(hub, rkey, 'send_dm', { thread_id: draft, text: 'Which branch?' })
    expect(hub.store.latestSender(rkey)).toBe('U2')
    await until('the follow-up reaches her agent', () => ab.got.length === 3)
    expect(ab.got[2]!.content).toContain('[Follow-up from workspace demo (the router of one of its threads, for @alice) on its private question')
    // answer_request only answers a private question.
    await expect(handleCall(hub, rkey, 'answer_request', { text: 'x' })).rejects.toThrow('no private question')
  }, T)

  test('with personalWorkspaces false a router DMs an owner directly, and their reply comes back', async () => {
    const { hub, tmux, w, posts } = await scene(dir => {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')), personalWorkspaces: false }))
    })
    const { rkey, rb } = await askingRouter(hub, tmux, w, 2)
    const res = await handleCall(hub, rkey, 'send_dm', { user: '@alice', text: 'May I deploy to staging?' })
    expect(res).toContain('DM thread_id p1')
    expect(posts[0]).toMatchObject({ id: 'p1', channel_id: 'D1' })
    expect(posts[0]!.message).toContain('May I deploy to staging?')
    expect(hub.store.link('p1')).toMatchObject({ kind: 'dm', fromKey: rkey, peer: 'U1', fromThread: 'T3' })
    expect(hub.store.get('seen:D1')).toBeDefined()

    // Owners only.
    await expect(handleCall(hub, rkey, 'send_dm', { user: 'bob', text: 'hi' })).rejects.toThrow('@bob is not a hub owner')

    // alice answers in the thread: the router gets it.
    const reply = { id: 'R1', root_id: 'p1', user_id: 'U1', channel_id: 'D1', message: 'Go ahead.', create_at: Date.now() } as MMPost
    await hub.enqueue(() => hub.onPosted(reply, 'D'))
    await until('the DM reply reaches the router', () => rb.got.length === 1)
    expect(rb.got[0]!.content).toContain('[DM reply from @alice')
    expect(rb.got[0]!.content).toContain('Go ahead.')

    // The router answers in the same DM thread.
    await handleCall(hub, rkey, 'send_dm', { thread_id: 'p1', text: 'Thanks, deploying.' })
    expect(posts.at(-1)).toMatchObject({ root_id: 'p1', channel_id: 'D1', message: 'Thanks, deploying.' })
    await expect(handleCall(hub, rkey, 'send_dm', { thread_id: 'T1', text: 'x' })).rejects.toThrow("isn't one of yours")

    // At most 10 new requests or DMs an hour.
    for (let i = 0; i < 9; i++) hub.store.insertLink({ threadId: `X${i}`, kind: 'dm', channelId: 'D1', fromKey: rkey, fromWorkspace: 'demo', peer: 'U1', chain: ['demo'], createdAt: Date.now() })
    await expect(handleCall(hub, rkey, 'send_dm', { user: 'alice', text: 'again' })).rejects.toThrow('in the last hour')
  }, T)

  test('with "*" in allowFrom a router asks any person privately, never a bot', async () => {
    const { hub, tmux, w } = await scene(dir => {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['*'], channels: {}, pending: {} }))
    })
    const { rkey } = await askingRouter(hub, tmux, w, 2)
    const people: Record<string, { id: string; username: string; is_bot?: boolean }> = {
      dave: { id: 'U9', username: 'dave' }, devbot: { id: 'UBOT', username: 'devbot', is_bot: true }, claude: { id: 'BOT', username: 'claude' },
    }
    ;(hub.mm as unknown as { userByName: (n: string) => Promise<unknown> }).userByName = async n => people[n]
    const res = await handleCall(hub, rkey, 'send_dm', { user: '@dave', text: 'Can you check the build?' })
    expect(res).toContain("asked @dave's own agent (workspace personal-U9)")
    expect(hub.store.link(/thread_id (draft-\w+)/.exec(res)![1]!)).toMatchObject({ kind: 'personal', peer: 'U9' })
    await expect(handleCall(hub, rkey, 'send_dm', { user: 'devbot', text: 'x' })).rejects.toThrow('not a person')
    await expect(handleCall(hub, rkey, 'send_dm', { user: 'claude', text: 'x' })).rejects.toThrow('not a person')
    await expect(handleCall(hub, rkey, 'send_dm', { user: 'nobody', text: 'x' })).rejects.toThrow('not a person')
  }, T)
})

describe('new threads, and other bots', () => {
  /** Workspace demo bound to C1; a running router for thread T3 there; alice (U1) is a member of C1, bob (U2) isn't. */
  async function scene() {
    const env = setup({}, dir => {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
    })
    const { hub, tmux, w, p, others } = env
    hub.bot = { id: 'BOT', username: 'claude' }
    bindChannel(p.bindings, 'C1', 'demo')
    const people: Record<string, { id: string; username: string; is_bot?: boolean }> = {
      alice: { id: 'U1', username: 'alice' }, hermes: { id: 'UH', username: 'hermes', is_bot: true }, claude: { id: 'BOT', username: 'claude', is_bot: true },
    }
    const mm = hub.mm as unknown as Record<string, unknown>
    mm.userByName = async (n: string) => people[n]
    mm.isMember = async (_ch: string, user: string) => user === 'U1'
    const rkey = hub.createRouter({ threadId: 'T3', channelId: 'C1', workspace: w, label: 'onboarding' })
    await hub.enqueue(() => hub.ensureStarted(rkey))
    const rb = await connect(hub, tmux, rkey, 1)
    const ask = (id: string, message: string, user_id = 'U1') => {
      others.push({ id, root_id: 'T3', user_id, channel_id: 'C1', message, create_at: Date.now(), props: {} } as unknown as MMPost)
      return id
    }
    return { ...env, rkey, rb, ask }
  }

  test('a router starts a new thread in its channel when a person asks; the thread gets a router of its own, started by the first reply', async () => {
    const { hub, tmux, posts, rkey, ask } = await scene()
    const m = ask('M1', 'Introduce yourself to the channel')
    const res = await handleCall(hub, rkey, 'new_thread', { text: 'Hi all, I am Claude: mention me for help with the finance portal.', message_id: m })
    expect(res).toContain('posted: http://mm/pl/p1, a new thread in ~C1')
    expect(posts[0]).toMatchObject({ id: 'p1', channel_id: 'C1' })
    expect(posts[0]!.root_id).toBeUndefined()
    const t = hub.store.thread('p1')!
    expect(t).toMatchObject({ channelId: 'C1', workspace: 'demo', label: 'Hi all, I am Claude: mention me for help with the finance po' })
    expect(t.routerKey).not.toBe(rkey)
    expect(hub.store.thread('T3')!.routerKey).toBe(rkey) // the asking router keeps its thread
    expect(hub.store.session(t.routerKey)!.status).toBe('stopped') // nothing runs until someone replies
    expect(tmux.launches.length).toBe(1)

    // The first reply starts its router, which learns where the thread came from.
    const reply = { id: 'R1', root_id: 'p1', user_id: 'U1', channel_id: 'C1', message: 'Welcome!', create_at: Date.now() } as MMPost
    await hub.enqueue(() => hub.onPosted(reply, 'O'))
    const nb = await connect(hub, tmux, t.routerKey, 2)
    expect(nb.got[0]!.content).toContain('[You are the router of a thread the hub started: the router of thread T3 ("onboarding") posted its first post in ~C1, because @alice asked for it there.')
    expect(nb.got[0]!.content).toContain('> Hi all, I am Claude')
    expect(nb.got[0]!.content).toContain('Welcome!')
    expect(hub.store.get(`origin:${t.routerKey}`)).toBeUndefined()
  }, T)

  test("new_thread: routers only, on a person's request, in the workspace's own channels they are members of, a few an hour", async () => {
    const { hub, w, posts, others, rkey, ask } = await scene()
    const { key } = worker(hub, w)
    await expect(handleCall(hub, key, 'new_thread', { text: 'hi', message_id: 'M1' })).rejects.toThrow('routers only')
    others.push({ id: 'B1', root_id: 'T3', user_id: 'UH', channel_id: 'C1', message: 'post it', create_at: Date.now(), props: { from_bot: 'true' } } as unknown as MMPost)
    await expect(handleCall(hub, rkey, 'new_thread', { text: 'hi', message_id: 'B1' })).rejects.toThrow("message B1 is not a person's")
    const other = 'abcdefghijklmnopqrstuvwxyz' // a channel of no workspace
    await expect(handleCall(hub, rkey, 'new_thread', { text: 'hi', message_id: ask('M2', 'post it'), channel: other })).rejects.toThrow('is not a channel of workspace demo')
    await expect(handleCall(hub, rkey, 'new_thread', { text: 'hi', message_id: ask('M3', 'post it', 'U2') })).rejects.toThrow('is not a member of ~C1')
    hub.store.set(`newthreads:${rkey}`, JSON.stringify(Array(5).fill(Date.now())))
    await expect(handleCall(hub, rkey, 'new_thread', { text: 'hi', message_id: ask('M4', 'post it') })).rejects.toThrow('in the last hour')
    expect(posts).toEqual([])
  }, T)

  test('a post that @mentions another bot is refused, unless a person here named that bot', async () => {
    const { hub, posts, rkey, ask } = await scene()
    await expect(handleCall(hub, rkey, 'reply', { text: '@hermes please build the report for this thread' })).rejects.toThrow('@hermes is a bot, not a person')
    await expect(handleCall(hub, rkey, 'new_thread', { text: 'Hey @hermes, can you take this?', message_id: ask('M1', 'Introduce yourself') })).rejects.toThrow('@hermes is a bot')
    expect(posts).toEqual([])
    // People, @here, its own name and things that aren't users are fine.
    await handleCall(hub, rkey, 'reply', { text: 'Done, @alice. Ping @here if it breaks; install @types/node first. I am @claude.' })
    expect(posts.length).toBe(1)
    // A person asked for it: then it may.
    ask('M2', 'Can you ask hermes to run the nightly report?')
    await handleCall(hub, rkey, 'reply', { text: '@hermes please run the nightly report.' })
    expect(posts.length).toBe(2)
    await handleCall(hub, rkey, 'edit_message', { message_id: posts[1]!.id, text: '@hermes please run the nightly report now.' })
  }, T)

  test("a worker's command that runs another agent is denied, unless a person in its thread named that agent", async () => {
    const { hub, w, others } = await scene()
    const { key } = worker(hub, w)
    const bg = 'cd repo && nohup hermes chat -q "fix the login bug" > /tmp/h.log 2>&1 &'
    expect(await otherAgentCheck(hub, key, bg)).toContain("hermes is another AI agent: don't hand it this work")
    expect(await otherAgentCheck(hub, key, 'npm test && git commit -m "hermes support"')).toBeUndefined()
    // config otherAgents: [] allows them all.
    hub.cfg.otherAgents = []
    expect(await otherAgentCheck(hub, key, bg)).toBeUndefined()
    hub.cfg.otherAgents = ['hermes']
    // A person in the worker's thread asked for it.
    others.push({ id: 'M9', root_id: 'T1', user_id: 'U1', channel_id: 'C1', message: 'Let Hermes take a first pass at it', create_at: Date.now(), props: {} } as unknown as MMPost)
    expect(await otherAgentCheck(hub, key, bg)).toBeUndefined()
  }, T)

  test("a bot naming another bot doesn't count as asking for it", async () => {
    const { hub, others, rkey } = await scene()
    others.push({ id: 'B1', root_id: 'T3', user_id: 'UH', channel_id: 'C1', message: 'ask @hermes for the numbers', create_at: Date.now(), props: { from_bot: 'true' } } as unknown as MMPost)
    await expect(handleCall(hub, rkey, 'reply', { text: '@hermes the numbers, please' })).rejects.toThrow('nobody here named @hermes')
  }, T)
})

describe('personal workspaces', () => {
  const owners = (dir: string) => writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1', 'U2'], channels: {}, pending: {} }))
  const dm = (hub: Hub, user: string, chat: string, id: string, message: string) =>
    hub.enqueue(() => hub.onPosted({ id, root_id: '', user_id: user, channel_id: chat, message, create_at: Date.now() } as MMPost, 'D'))

  test("a DM from a chat without a workspace starts in the person's own, made once and named from their user id", async () => {
    const { hub, p, posts } = setup({}, owners)
    hub.bot = { id: 'BOT', username: 'hubbot' }
    await dm(hub, 'U1', 'D1', 'DM1', 'can you check the build?')
    expect(posts).toEqual([]) // no "which workspace?"
    expect(hub.store.thread('DM1')).toMatchObject({ channelId: 'D1', workspace: 'personal-U1' })
    expect(workspaceTitle(hub, 'personal-U1')).toBe("@alice's personal workspace")
    expect(workspaceTitle(hub, 'demo')).toBe('workspace demo')
    const labels = () => Object.fromEntries(hub.snapshot().workspaces.map(w => [w.name, w.label]))
    expect(labels()).toEqual({ demo: undefined, 'personal-U1': '@alice' }) // the panel shows whose it is
    expect(loadBindings(p.bindings)['D1']).toBe('personal-U1')
    expect(loadWorkspace(hub.cfg, 'personal-U1')).toMatchObject({ description: 'Personal workspace of @alice', repos: [] })
    expect(hub.queued(hub.store.thread('DM1')!.routerKey)).toBe(1) // the message waits for its router

    // The next thread in that chat goes to the same workspace; another person gets their own.
    await dm(hub, 'U1', 'D1', 'DM2', 'and the tests?')
    expect(hub.store.thread('DM2')!.workspace).toBe('personal-U1')
    await dm(hub, 'U2', 'D2', 'DM3', 'hi, a question')
    expect(hub.store.thread('DM3')!.workspace).toBe('personal-U2')
    expect(loadBindings(p.bindings)).toMatchObject({ D1: 'personal-U1', D2: 'personal-U2' })
  }, T)

  test('a chat bound to a workspace stays there; personalWorkspaces false asks "which workspace?" as before', async () => {
    const a = setup({}, owners)
    a.hub.bot = { id: 'BOT', username: 'hubbot' }
    bindChannel(a.p.bindings, 'D1', 'demo')
    await dm(a.hub, 'U1', 'D1', 'DM1', 'can you check the build?')
    expect(a.hub.store.thread('DM1')!.workspace).toBe('demo')
    expect(loadWorkspace(a.hub.cfg, 'personal-U1')).toBeUndefined()

    const b = setup({ personalWorkspaces: false }, owners)
    b.hub.bot = { id: 'BOT', username: 'hubbot' }
    await dm(b.hub, 'U1', 'D1', 'DM1', 'can you check the build?')
    expect(b.posts[0]!.message).toContain('This chat is not connected to a workspace yet')
    expect(b.hub.store.thread('DM1')).toBeUndefined()
    expect(loadWorkspace(b.hub.cfg, 'personal-U1')).toBeUndefined()
  }, T)
})

describe('trigger mention-only', () => {
  test('a reply without a mention never reaches the router; the next mention does, and says how many it missed', async () => {
    const { hub, tmux, w, p } = setup({}, dir => {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['*'], channels: {}, pending: {} }))
    })
    hub.bot = { id: 'BOT', username: 'hubbot' }
    setWorkspaceTrigger(loadConfig(p.config), 'demo', 'mention-only')
    bindChannel(p.bindings, 'C1', 'demo')
    const rkey = hub.createRouter({ threadId: 'T3', channelId: 'C1', workspace: w, label: 'thread three' })
    const post = (id: string, user: string, message: string) => ({ id, root_id: 'T3', user_id: user, channel_id: 'C1', message, create_at: Date.now() }) as MMPost
    const send = (id: string, user: string, message: string) => hub.enqueue(() => hub.onPosted(post(id, user, message), 'O'))

    await send('M1', 'U1', 'lunch at noon?')
    await send('M2', 'U2', 'sure, and is the build green?')
    expect(hub.store.get('skipped:T3')).toBe('2')
    expect(tmux.launches.length).toBe(0)

    await send('M3', 'U1', '@hubbot is the build green?')
    const rb = await connect(hub, tmux, rkey, 1)
    await until('M3 reaches the router', () => rb.got.length === 1)
    expect(rb.got[0]!.content).toContain("2 earlier message(s) in this thread didn't @mention you")
    expect(rb.got[0]!.content).toContain('@hubbot is the build green?')
    expect(hub.store.get('skipped:T3')).toBe('0')

    // The router is told people must mention it.
    expect(hub.hookContext(rkey)).toContain('only messages that @mention you reach you')
    // Nothing to follow or unfollow.
    expect(await handleCall(hub, rkey, 'unfollow', { thread_id: 'T3' })).toContain('trigger mention-only')
  }, T)
})

describe('trigger openrouter', () => {
  test('a hosted decision model judges replies in followed threads, with the key from .env; when it fails, only mentions get through', async () => {
    let toBot = 0.1
    let down = false
    const listings: string[] = []
    const seen: { url: string; auth: string | null; body: { model: string; provider: unknown; state: string; questions: Record<string, unknown> } }[] = []
    const or = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url).pathname
        if (url.includes('/models/')) {
          listings.push(url)
          return Response.json({ data: { architecture: { output_modalities: ['decisions'] }, endpoints: [{}] } })
        }
        if (down) return Response.json({ error: { message: 'boom' } }, { status: 500 })
        seen.push({ url, auth: req.headers.get('authorization'), body: (await req.json()) as (typeof seen)[number]['body'] })
        return Response.json({ answers: { who: { type: 'choice', probabilities: { hubbot: toBot, bob: 0, nobody: 1 - toBot } } } })
      },
    })
    try {
      const { hub, tmux, w, p, others } = setup({ openrouter: { url: `http://127.0.0.1:${or.port}/api/v1`, timeoutMs: 2000 } }, dir => {
        writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
        writeFileSync(join(dir, '.env'), 'MATTERMOST_URL=http://mm\nOPENROUTER_API_KEY=sk-or-v1-test\n')
      })
      hub.bot = { id: 'BOT', username: 'hubbot' }
      setWorkspaceTrigger(loadConfig(p.config), 'demo', 'openrouter')
      bindChannel(p.bindings, 'C1', 'demo')
      const rkey = hub.createRouter({ threadId: 'T3', channelId: 'C1', workspace: w, label: 'thread three' })
      // Someone else has posted, so it isn't a two-person thread.
      others.push({ id: 'B1', root_id: 'T3', user_id: 'U2', channel_id: 'C1', message: 'I can look at it later', create_at: 0 } as MMPost)
      const post = (id: string, message: string) => ({ id, root_id: 'T3', user_id: 'U1', channel_id: 'C1', message, create_at: Date.now() }) as MMPost
      const send = (id: string, message: string) => hub.enqueue(() => hub.onPosted(post(id, message), 'O'))

      await send('M1', 'lunch at noon?')
      await until('the model judged M1', () => hub.store.get('skipped:T3') === '1')
      expect(tmux.launches.length).toBe(0)
      expect(listings).toEqual(['/api/v1/models/google/gemini-decision-1/endpoints'])
      expect(seen[0]!.url).toBe('/api/alpha/decisions')
      expect(seen[0]!.auth).toBe('Bearer sk-or-v1-test')
      expect(seen[0]!.body.model).toBe('google/gemini-decision-1')
      expect(seen[0]!.body.provider).toEqual({ data_collection: 'deny' })
      expect(seen[0]!.body.state).toContain('>> @alice: lunch at noon?')
      expect(Object.keys(seen[0]!.body.questions)).toContain('who')

      toBot = 0.9
      await send('M2', 'is the build green?')
      const rb = await connect(hub, tmux, rkey, 1)
      await until('M2 reaches the router', () => rb.got.length === 1)
      expect(rb.got[0]!.content).toContain('1 earlier message(s) in this thread were judged not meant for you')
      expect(hub.hookContext(rkey)).toContain('this workspace uses an AI model (through OpenRouter)')
      // The model's API was looked up once.
      expect(listings.length).toBe(1)

      // OpenRouter down: no reply reaches the router (nor starts it) without a mention.
      down = true
      await hook(hub, rkey, 'Stop')
      await hub.enqueue(() => hub.close(rkey, 'idle'))
      await send('M3', 'and the tests?')
      await send('M4', 'anyone?')
      await until('M3 and M4 not judged', () => hub.store.get('unjudged:T3') === '2')
      expect(hub.store.session(rkey)!.status).toBe('stopped')
      expect(tmux.launches.length).toBe(1)
      expect(hub.queued(rkey)).toBe(0)
      expect(hub.hookContext(rkey)).toContain("While the model can't be reached, only @mentions do")

      // A mention gets through, and tells the router about them, once.
      await send('M5', '@hubbot and the tests?')
      const again = await connect(hub, tmux, rkey, 2)
      await until('M5 reaches the router', () => again.got.length === 1)
      expect(again.got[0]!.content).toContain("2 earlier message(s) in this thread without an @mention didn't reach you, because the model that judges them couldn't be reached")
      expect(again.got[0]!.content).not.toContain('judged not meant for you')

      // It answers again: judged as before, the thread still followed.
      down = false
      await send('M6', 'is the build green now?')
      await until('M6 reaches the router', () => again.got.length === 2)
      expect(again.got[1]!.content).not.toContain("couldn't be reached")
    } finally {
      or.stop(true)
    }
  }, T)

  test('while it fails, a thread of only the bot and one person goes on; what isn\'t OpenRouter\'s failure still reaches the router', async () => {
    const { hub, tmux, w, p, others } = setup({ openrouter: { url: 'http://127.0.0.1:9/api/v1', timeoutMs: 500 } }, dir => {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
    })
    hub.bot = { id: 'BOT', username: 'hubbot' }
    setWorkspaceTrigger(loadConfig(p.config), 'demo', 'openrouter')
    bindChannel(p.bindings, 'C1', 'demo')
    const rkey = hub.createRouter({ threadId: 'T3', channelId: 'C1', workspace: w, label: 'thread three' })
    others.push({ id: 'T3', root_id: '', user_id: 'U1', channel_id: 'C1', message: '@hubbot hi', create_at: 0 } as MMPost)
    const send = (id: string, message: string) => hub.enqueue(() => hub.onPosted({ id, root_id: 'T3', user_id: 'U1', channel_id: 'C1', message, create_at: Date.now() } as MMPost, 'O'))
    await send('M1', 'and the tests?')
    const rb = await connect(hub, tmux, rkey, 1)
    await until('M1 reaches the router', () => rb.got.length === 1)

    // A third person: no key, so it can't be judged.
    others.push({ id: 'B1', root_id: 'T3', user_id: 'U2', channel_id: 'C1', message: 'me too', create_at: 1 } as MMPost)
    await send('M2', 'what about you?')
    await until('M2 not judged', () => hub.store.get('unjudged:T3') === '1')
    expect(rb.got.length).toBe(1)

    // Mattermost fails to show the thread: OpenRouter was never asked.
    const mm = hub.mm as unknown as { getThread: () => Promise<unknown> }
    mm.getThread = async () => { throw new Error('502') }
    await send('M3', 'hello?')
    await until('M3 reaches the router', () => rb.got.length === 2)
  }, T)
})

describe('a finished request leaves its thread followed', () => {
  test('no reply asks the router about unfollowing, and it is told not to for that', async () => {
    const { hub, p, w } = setup({}, owner => writeFileSync(join(owner, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} })))
    const rkey = hub.createRouter({ threadId: 'T3', channelId: 'C1', workspace: w, label: 'thread three' })
    for (const trigger of ['laya', 'openrouter'] as const) {
      setWorkspaceTrigger(loadConfig(p.config), 'demo', trigger)
      expect(await handleCall(hub, rkey, 'reply', { text: 'done: the build is green' })).toMatch(/^sent \(id: \S+\)$/)
      const ctx = hub.hookContext(rkey)!
      expect(ctx).toContain('You keep following it when a request is done')
      expect(ctx).not.toContain('after each reply you send')
    }
    expect(hub.store.get('follow:T3')).toBeUndefined()
    const unfollow = toolsFor('router', 'router').find(t => t.name === 'unfollow')!
    expect(unfollow.description).toContain('never because a request is done')
  }, T)

  test('the hub leaves a quiet thread followed: a post after many without one from the bot is still judged, and reaches the router when it is for it', async () => {
    let judgedPosts = 0
    const laya = Bun.serve({
      port: 0,
      async fetch() {
        judgedPosts++
        return Response.json({ answers: { who: { type: 'choice', probabilities: { hubbot: 0.9, nobody: 0.1 } } } })
      },
    })
    try {
      const { hub, tmux, w, p, others } = setup({ laya: { url: `http://127.0.0.1:${laya.port}`, timeoutMs: 2000 } }, dir => {
        writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
      })
      hub.bot = { id: 'BOT', username: 'hubbot' }
      setWorkspaceTrigger(loadConfig(p.config), 'demo', 'laya')
      bindChannel(p.bindings, 'C1', 'demo')
      const rkey = hub.createRouter({ threadId: 'T3', channelId: 'C1', workspace: w, label: 'thread three' })
      others.push({ id: 'A0', root_id: 'T3', user_id: 'BOT', channel_id: 'C1', message: 'Done: the build is green.', create_at: 1 } as MMPost)
      for (let i = 0; i < 40; i++) others.push({ id: `B${i}`, root_id: 'T3', user_id: i % 2 ? 'U1' : 'U2', channel_id: 'C1', message: `chat ${i}`, create_at: 2 + i } as MMPost)
      const post = { id: 'M1', root_id: 'T3', user_id: 'U1', channel_id: 'C1', message: 'and is staging green too?', create_at: 100 } as MMPost
      others.push(post)
      await hub.enqueue(() => hub.onPosted(post, 'O'))
      const rb = await connect(hub, tmux, rkey, 1)
      await until('M1 reaches the router', () => rb.got.length === 1)
      expect(rb.got[0]!.content).toContain('and is staging green too?')
      expect(judgedPosts).toBe(1)
      expect(hub.store.get('follow:T3')).toBeUndefined()
    } finally {
      laya.stop(true)
    }
  }, T)
})

describe('unfollowing a quiet thread (unfollowAfter set)', () => {
  test('after unfollowAfter posts without one from the bot, the hub stops following; a mention brings the bot back and says what it missed', async () => {
    let judged = 0
    const or = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname.includes('/models/')) return Response.json({ data: { architecture: { output_modalities: ['decisions'] }, endpoints: [{}] } })
        judged++
        return Response.json({ answers: { who: { type: 'choice', probabilities: { hubbot: 0.1, nobody: 0.9 } } } })
      },
    })
    try {
      const { hub, tmux, w, p, others } = setup({ unfollowAfter: 3, openrouter: { url: `http://127.0.0.1:${or.port}/api/v1`, timeoutMs: 2000 } }, dir => {
        writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
        writeFileSync(join(dir, '.env'), 'MATTERMOST_URL=http://mm\nOPENROUTER_API_KEY=sk-or-v1-test\n')
      })
      hub.bot = { id: 'BOT', username: 'hubbot' }
      setWorkspaceTrigger(loadConfig(p.config), 'demo', 'openrouter')
      bindChannel(p.bindings, 'C1', 'demo')
      const rkey = hub.createRouter({ threadId: 'T3', channelId: 'C1', workspace: w, label: 'thread three' })
      // The bot answered, then bob posted.
      others.push(
        { id: 'A0', root_id: 'T3', user_id: 'BOT', channel_id: 'C1', message: 'Done: the build is green.', create_at: 1 } as MMPost,
        { id: 'B1', root_id: 'T3', user_id: 'U2', channel_id: 'C1', message: 'nice', create_at: 2 } as MMPost,
      )
      let at = 10
      const send = async (id: string, message: string) => {
        const post = { id, root_id: 'T3', user_id: 'U1', channel_id: 'C1', message, create_at: at++ } as MMPost
        others.push(post)
        await hub.enqueue(() => hub.onPosted(post, 'O'))
      }

      // Two posts since the bot's: judged (not for it).
      await send('M1', 'lunch?')
      await until('M1 judged', () => hub.store.get('skipped:T3') === '1')
      expect(judged).toBe(1)
      // The third: no judge, the hub stops following.
      await send('M2', 'sure, at noon')
      await until('unfollowed', () => hub.store.get('follow:T3') === 'off')
      expect(judged).toBe(1)
      expect(hub.store.get('skipped:T3')).toBe('2')
      // Not followed: not judged, but counted.
      await send('M3', 'see you there')
      await hub.enqueue(() => undefined)
      expect(judged).toBe(1)
      expect(hub.store.get('skipped:T3')).toBe('3')
      expect(tmux.launches.length).toBe(0)

      // A mention follows it again; the router hears what it missed and why.
      await send('M4', '@hubbot what did I miss?')
      const rb = await connect(hub, tmux, rkey, 1)
      await until('M4 reaches the router', () => rb.got.length === 1)
      expect(rb.got[0]!.content).toContain("3 earlier message(s) in this thread didn't reach you: 3 messages went by without a post from you, so the hub stopped following this thread, and they didn't @mention you. You follow it again now.")
      expect(hub.store.get('follow:T3')).toBeUndefined()
      expect(hub.hookContext(rkey)).toContain('The hub also stops following by itself once 3 messages go by without a post from you')
    } finally {
      or.stop(true)
    }
  }, T)
})

describe('Laya decides what reaches the bot', () => {
  test('in threads the bot follows (from a mention until it is unfollowed), by its judgement; workers keep the rules', async () => {
    let answer = 0.2
    let down = false
    const seen: { model?: string; state?: string; questions?: unknown }[] = []
    const laya = Bun.serve({
      port: 0,
      async fetch(req) {
        if (down) return Response.json({ error: 'boom' }, { status: 500 })
        seen.push((await req.json()) as (typeof seen)[number])
        return Response.json({ answers: { who: { type: 'choice', probabilities: { hubbot: answer, nobody: 1 - answer } } } })
      },
    })
    try {
      const { hub, tmux, w, p, posts, others } = setup({ laya: { url: `http://127.0.0.1:${laya.port}`, timeoutMs: 2000 } }, dir => {
        writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
      })
      hub.bot = { id: 'BOT', username: 'hubbot' }
      setWorkspaceTrigger(loadConfig(p.config), 'demo', 'laya')
      bindChannel(p.bindings, 'C1', 'demo')
      writeFileSync(join(w.dir, 'TRIGGER.md'), "## Answer\n- questions about the build\n## Don't answer\n- lunch plans\n")
      const rkey = hub.createRouter({ threadId: 'T3', channelId: 'C1', workspace: w, label: 'thread three' })
      // Someone else has posted in the thread too, so Laya judges (with only the bot and alice, it wouldn't).
      others.push({ id: 'B1', root_id: 'T3', user_id: 'U2', channel_id: 'C1', message: 'I can look at it later', create_at: 0 } as MMPost)
      const post = (id: string, message: string, root = 'T3') => ({ id, root_id: root, user_id: 'U1', channel_id: 'C1', message, create_at: Date.now() }) as MMPost
      const send = (id: string, message: string, root?: string) => hub.enqueue(() => hub.onPosted(post(id, message, root), 'O'))

      // Followed from the start. Not for the bot: its router doesn't get it (nor start for it).
      await send('M1', 'lunch at noon?')
      await until('Laya judged M1', () => hub.store.get('skipped:T3') === '1')
      expect(tmux.launches.length).toBe(0)
      expect(seen[0]!.model).toBe('laya')
      expect(seen[0]!.state).toEndWith('>> @alice: lunch at noon?')
      expect(seen[0]!.state).toStartWith('People in this thread: @hubbot (AI assistant), @bob, @alice.\n@bob: I can look at it later')
      expect(Object.keys(seen[0]!.questions as object)).toEqual(['who', 'greeting', 'thanks', 'no0', 'yes0']) // the base question, greeting, thanks, then each rule
      expect(JSON.stringify(seen[0]!.questions)).toContain('questions about the build')
      // Laya picks who the post is talking to, from the thread's participants.
      const who0 = (seen[0]!.questions as { who: { instructions: string; criteria: Record<string, string> } }).who
      expect(who0.instructions).toBe('Who is the last message (marked >>) talking to?')
      expect(Object.keys(who0.criteria)).toEqual(['hubbot', 'bob', 'nobody'])

      // For the bot: the router gets it, and hears about the one it didn't get.
      answer = 0.9
      await send('M2', 'is the build green?')
      const rb = await connect(hub, tmux, rkey, 1)
      await until('M2 reaches the router', () => rb.got.length === 1)
      expect(rb.got[0]!.content).toContain('1 earlier message(s) in this thread were judged not meant for you')
      expect(rb.got[0]!.content).toContain('is the build green?')
      expect(hub.store.get('skipped:T3')).toBe('0')

      // Another bot's post, and a reply to someone else: both are Laya's to judge, with everyone named.
      answer = 0.1
      const n = seen.length
      await hub.enqueue(() => hub.onPosted({ ...post('M2b', 'Report: 3 alerts.'), user_id: 'UBOT', props: { from_bot: 'true' } } as MMPost, 'O'))
      await send('M2c', '@dave what do you think?')
      await until('Laya judged M2b and M2c', () => hub.store.get('skipped:T3') === '2')
      expect(seen[n]!.state).toEndWith('>> @devbot (another AI bot): Report: 3 alerts.')
      expect(Object.keys((seen[n + 1]!.questions as { who: { criteria: object } }).who.criteria)).toEqual(['hubbot', 'dave', 'bob', 'nobody'])
      expect(rb.got.length).toBe(1)
      answer = 0.9

      // A mention needs no judgement. Posts outside hub threads are never judged.
      const asked = seen.length
      await send('M3', '@hubbot and staging?')
      await until('M3 reaches the router', () => rb.got.length === 2)
      await send('M4', 'can someone check why CI fails?', '')
      expect(hub.store.thread('M4')).toBeUndefined()
      expect(seen.length).toBe(asked)

      // Laya failing: replies in a followed thread still reach the router.
      down = true
      await send('M5', 'still there?')
      await until('M5 reaches the router anyway', () => rb.got.length === 3)
      down = false

      // A person asks the bot to stop following: the router unfollows, also while a worker still has work for the thread.
      hub.store.insertTask({ workerKey: 'w-busy', threadId: 'T3', channelId: 'C1', text: 'x', state: 'queued', createdAt: Date.now() })
      expect(await handleCall(hub, rkey, 'unfollow', {})).toContain('No longer following this thread')
      // Now replies without a mention are dropped without asking Laya; a mention follows the thread again.
      const before = seen.length
      await send('M6', 'thanks all')
      expect(rb.got.length).toBe(3)
      expect(seen.length).toBe(before)
      await send('M7', '@hubbot one more thing: the docs')
      await until('M7 reaches the router', () => rb.got.length === 4)
      await send('M8', 'and the changelog too')
      await until('M8 is judged and passed on', () => rb.got.length === 5)
      expect(seen.length).toBe(before + 1)

      // Owners can switch it by hand.
      await send('M9', '!unfollow')
      expect(posts.at(-1)!.message).toContain('Stopped following this thread')
      await send('M10', 'hello?')
      expect(seen.length).toBe(before + 1)
      await send('M11', '!follow')
      expect(posts.at(-1)!.message).toContain('Following this thread')

      // Sessions are told. Workers read and change the rules; routers can't, and workers can't unfollow.
      expect(hub.hookContext(rkey)).toContain('this workspace uses Laya')
      expect(hub.hookContext(rkey)).toContain('Call unfollow only when a person in the thread asks you to')
      const { key } = worker(hub, w)
      expect(hub.hookContext(key)).toContain('update them with trigger_rules')
      expect(await handleCall(hub, key, 'trigger_rules', {})).toContain('- questions about the build')
      const saved = await handleCall(hub, key, 'trigger_rules', { content: "## Answer\n- questions about the build\n- deploy requests\n## Don't answer\n- lunch plans\n" })
      expect(saved).toContain('saved: 2 "answer" and 1 "don\'t answer" rule(s).')
      expect(saved).toContain('Laya judges replies for this workspace')
      expect(readFileSync(join(w.dir, 'TRIGGER.md'), 'utf8')).toContain('- deploy requests')
      await expect(handleCall(hub, key, 'trigger_rules', { content: 'no rules here' })).rejects.toThrow('no rules found')
      await expect(handleCall(hub, rkey, 'trigger_rules', {})).rejects.toThrow('workers only')
      await expect(handleCall(hub, key, 'unfollow', {})).rejects.toThrow('routers only')

      // Back to mentions: Laya is no longer asked, every reply reaches the router, and sessions aren't told about it.
      setWorkspaceTrigger(loadConfig(p.config), 'demo', 'mention')
      const last = seen.length
      const got = rb.got.length
      await send('M12', 'thanks!')
      await until('M12 reaches the router', () => rb.got.length === got + 1)
      expect(seen.length).toBe(last)
      expect(hub.hookContext(rkey)).not.toContain('Laya')
      expect(await handleCall(hub, rkey, 'unfollow', {})).toContain('Nothing to do')
    } finally {
      laya.stop(true)
    }
  }, T)

  test('a thread of only the bot and one person: every reply of theirs reaches the router without asking Laya', async () => {
    const asked: unknown[] = []
    const laya = Bun.serve({
      port: 0,
      async fetch(req) {
        asked.push(await req.json())
        return Response.json({ answers: { who: { type: 'choice', probabilities: { hubbot: 0, nobody: 1 } } } })
      },
    })
    try {
      const { hub, tmux, w, p, others } = setup({ laya: { url: `http://127.0.0.1:${laya.port}`, timeoutMs: 2000 } }, dir => {
        writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
      })
      hub.bot = { id: 'BOT', username: 'hubbot' }
      setWorkspaceTrigger(loadConfig(p.config), 'demo', 'laya')
      bindChannel(p.bindings, 'C1', 'demo')
      const rkey = hub.createRouter({ threadId: 'T5', channelId: 'C1', workspace: w, label: 'thread five' })
      const reply = (id: string, message: string, user = 'U1') => {
        const post = { id, root_id: 'T5', user_id: user, channel_id: 'C1', message, create_at: Date.now() } as MMPost
        others.push(post)
        return hub.enqueue(() => hub.onPosted(post, 'O'))
      }
      others.push({ id: 'T5', root_id: '', user_id: 'U1', channel_id: 'C1', message: '@hubbot check the alerts', create_at: 0 } as MMPost)
      others.push({ id: 'R1', root_id: 'T5', user_id: 'BOT', channel_id: 'C1', message: '2 alerts today.', create_at: 1 } as MMPost)

      // Laya would say "not for the bot", but isn't asked: a greeting or thanks reaches the bot too.
      await reply('M1', 'thanks!')
      const rb = await connect(hub, tmux, rkey, 1)
      await until('M1 reaches the router', () => rb.got.length === 1)
      await reply('M2', 'hi again')
      await until('M2 reaches the router', () => rb.got.length === 2)
      expect(asked.length).toBe(0)

      // A third person joins: from then on, Laya judges.
      others.push({ id: 'B1', root_id: 'T5', user_id: 'U2', channel_id: 'C1', message: 'one of them is mine', create_at: Date.now() } as MMPost)
      await reply('M3', 'ok')
      await until('Laya judged M3', () => hub.store.get('skipped:T5') === '1')
      expect((asked[0] as { state: string }).state).toStartWith('People in this thread: @alice, @hubbot (AI assistant), @bob.')
      expect(rb.got.length).toBe(2)
    } finally {
      laya.stop(true)
    }
  }, T)

  test('a DM is never judged: every message reaches the router, which hears nothing of Laya or unfollow', async () => {
    const asked: unknown[] = []
    const laya = Bun.serve({
      port: 0,
      async fetch(req) {
        asked.push(await req.json())
        return Response.json({ answers: { who: { type: 'choice', probabilities: { hubbot: 0, nobody: 1 } } } })
      },
    })
    try {
      const { hub, tmux, p, posts } = setup({ laya: { url: `http://127.0.0.1:${laya.port}`, timeoutMs: 2000 } }, dir => {
        writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
      })
      hub.bot = { id: 'BOT', username: 'hubbot' }
      setWorkspaceTrigger(loadConfig(p.config), 'demo', 'laya')
      bindChannel(p.bindings, 'D1', 'demo')
      const dm = (id: string, message: string, root = '') =>
        hub.enqueue(() => hub.onPosted({ id, root_id: root, user_id: 'U1', channel_id: 'D1', message, create_at: Date.now() } as MMPost, 'D'))

      // No mention needed to start a thread ...
      await dm('DM1', 'can you check the build?')
      const t = hub.store.thread('DM1')!
      expect(t).toMatchObject({ channelId: 'D1', workspace: 'demo' })
      const rb = await connect(hub, tmux, t.routerKey, 1)
      await until('the first DM reaches the router', () => rb.got.length === 1)
      expect(hub.hookContext(t.routerKey)).not.toContain('Laya')

      // ... nor to go on: replies skip Laya (which would say "not for the bot"), and there is nothing to unfollow.
      await dm('DM2', 'thanks!', 'DM1')
      await until('DM2 reaches the router', () => rb.got.length === 2)
      expect(await handleCall(hub, t.routerKey, 'unfollow', {})).toContain('this thread is a DM')
      await dm('DM3', '!unfollow', 'DM1')
      expect(posts.some(x => x.message.includes('Nothing to unfollow: this is a DM'))).toBe(true)
      await dm('DM4', 'and the logs?', 'DM1')
      await until('DM4 reaches the router', () => rb.got.length === 3)
      expect(rb.got[2]!.content).toContain('and the logs?')
      expect(asked.length).toBe(0)
      expect(hub.store.get('follow:DM1')).toBeUndefined()
    } finally {
      laya.stop(true)
    }
  }, T)
})

describe('reading Mattermost beyond the thread', () => {
  test('any thread by link, a channel, a search, the channel list: only what the person asking can read', async () => {
    const { hub, p, w, others } = setup({}, dir => {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
    })
    hub.bot = { id: 'BOT', username: 'claude' }
    bindChannel(p.bindings, 'C1', 'demo')
    const rkey = hub.createRouter({ threadId: 'T2', channelId: 'C1', workspace: w, label: 'recap' })
    const X1 = 'xone' + 'a'.repeat(22)
    const X2 = 'xtwo' + 'a'.repeat(22)
    const post = (id: string, root: string, user: string, channel: string, message: string, at: number) =>
      ({ id, root_id: root, user_id: user, channel_id: channel, message, create_at: at, props: {} }) as MMPost
    others.push(
      post('M1', 'T2', 'U1', 'C1', `@claude recap the issues in https://mm.example.com/team/pl/${X1} as a table`, 1),
      post('M2', 'T2', 'U2', 'C1', 'me too', 2),
      post('M3', 'T2', 'BOT', 'C1', 'On it.', 3),
      post(X1, '', 'U3', 'C9', '[Thread] payroll issues', 4),
      post(X2, X1, 'U2', 'C9', 'Overtime is rounded wrong', 5),
    )
    const chans: Record<string, { name: string; display_name?: string; type?: string }> = {
      C1: { name: 'ops' }, C8: { name: 'secret', type: 'P' }, C9: { name: 'payroll-module', display_name: 'Payroll Module' },
    }
    const chan = (id: string) => ({ id, type: chans[id]?.type ?? 'O', name: chans[id]?.name ?? id, display_name: chans[id]?.display_name ?? chans[id]?.name ?? id, team_id: 'TM' })
    const members: Record<string, string[]> = { C9: ['U1'], C8: ['U2'] }
    const secret = post('S1', '', 'U2', 'C8', 'Overtime secret', 6)
    Object.assign(hub.mm, {
      channel: async (id: string) => chan(id),
      isMember: async (c: string, u: string) => (members[c] ?? []).includes(u),
      myTeams: async () => [{ id: 'TM', name: 'team', display_name: 'Team' }],
      myChannels: async () => Object.keys(chans).map(chan),
      channelByName: async (_t: string, name: string) => Object.keys(chans).map(chan).find(c => c.name === name),
      channelPosts: async (c: string, n: number) => {
        const ps = others.filter(o => o.channel_id === c).sort((a, b) => b.create_at - a.create_at).slice(0, n)
        return { order: ps.map(x => x.id), posts: Object.fromEntries(ps.map(x => [x.id, x])) }
      },
      searchPosts: async () => ({ order: [X2, 'S1'], posts: { [X2]: others.find(o => o.id === X2)!, S1: secret } }),
    })
    // Alice (U1) wrote to the router last: it reads for her.
    hub.store.insertMessage({ sessionKey: rkey, content: 'recap', meta: { user_id: 'U1', thread_id: 'T2', chat_id: 'C1' }, state: 'delivered', createdAt: 1 })

    // A thread from its link, or from the id of any post in it: alice is in its channel.
    const thread = await handleCall(hub, rkey, 'fetch_thread', { thread_id: `https://mm.example.com/team/pl/${X1}` })
    expect(thread).toContain(`Thread ${X1} in ~payroll-module (Payroll Module)`)
    expect(thread).toContain('[Thread] payroll issues')
    expect(thread).toContain('Overtime is rounded wrong')
    expect(await handleCall(hub, rkey, 'fetch_thread', { thread_id: X2 })).toContain(`Thread ${X1} in ~payroll-module`)
    // Its own thread, as before.
    expect(await handleCall(hub, rkey, 'fetch_thread', {})).toContain('Thread T2')
    // Read for bob (not in that channel), or for the bot itself: no.
    await expect(handleCall(hub, rkey, 'fetch_thread', { thread_id: X1, message_id: 'M2' })).rejects.toThrow('is not a member of that channel')
    await expect(handleCall(hub, rkey, 'fetch_thread', { thread_id: X1, message_id: 'M3' })).rejects.toThrow("is not a person's")

    // A channel by ~name, display name or link; one alice isn't in stays closed.
    const ch = await handleCall(hub, rkey, 'read_channel', { channel: '~payroll-module' })
    expect(ch).toContain('~payroll-module (Payroll Module): 2 latest post(s), oldest first')
    expect(ch).toContain(`reply in thread ${X1}`)
    expect(await handleCall(hub, rkey, 'read_channel', { channel: 'payroll module' })).toContain('Overtime is rounded wrong')
    expect(await handleCall(hub, rkey, 'read_channel', { channel: 'https://mm.example.com/team/channels/payroll-module' })).toContain('[Thread] payroll issues')
    await expect(handleCall(hub, rkey, 'read_channel', { channel: '~secret' })).rejects.toThrow('~secret: @alice is not a member of that channel')
    await expect(handleCall(hub, rkey, 'read_channel', { channel: '~nowhere' })).rejects.toThrow('no channel "~nowhere"')

    // Search: results in channels alice can't read are left out, and counted.
    const found = await handleCall(hub, rkey, 'search_messages', { terms: 'overtime' })
    expect(found).toContain('Overtime is rounded wrong')
    expect(found).not.toContain('Overtime secret')
    expect(found).toContain('1 more result(s) are in channels you may not read for this person')

    // The channels: its own (bound to the workspace), and those alice is in.
    const list = await handleCall(hub, rkey, 'list_channels', {})
    expect(list).toContain('~ops: public, workspace demo')
    expect(list).toContain('~payroll-module (Payroll Module): public')
    expect(list).not.toContain('secret')

    // A worker with no person behind it reads only its own channels, until it names the message it acts on.
    const wkey = hub.createWorker({ workspace: w, title: 'Ops', summary: 'ops' })
    hub.store.patchWorker(wkey, { threads: ['T2'] })
    await expect(handleCall(hub, wkey, 'fetch_thread', { thread_id: X1 })).rejects.toThrow('no person to read for')
    expect(await handleCall(hub, wkey, 'fetch_thread', { thread_id: X1, message_id: 'M1' })).toContain('Overtime is rounded wrong')
  }, T)
})

describe('adding repos', () => {
  /** Owner U1 (alice) asks router r-t2 to add a repo; bob (U2) too. git is a fake that clones by making a folder. */
  function scene() {
    const tools = mkdtempSync(join(tmpdir(), 'mmhub-git-'))
    const git = join(tools, 'git')
    writeFileSync(git, [
      '#!/bin/sh',
      'if [ "$1" = config ]; then exit 1; fi',
      'case "$2" in',
      '  *fail*) echo "fatal: could not read from $2" >&2; exit 128;;',
      '  *slow*) sleep 1;;',
      'esac',
      'mkdir -p "$3/.git" && echo "$GIT_TERMINAL_PROMPT $GIT_SSH_COMMAND" > "$3/env"',
    ].join('\n'), { mode: 0o755 })
    const env = setup({ gitBin: git }, dir => {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
    })
    const { hub, p, w, others } = env
    hub.bot = { id: 'BOT', username: 'claude' }
    bindChannel(p.bindings, 'C1', 'demo')
    const rkey = hub.createRouter({ threadId: 'T2', channelId: 'C1', workspace: w, label: 'repos' })
    const msg = (id: string, user: string, message: string) =>
      ({ id, root_id: 'T2', user_id: user, channel_id: 'C1', message, create_at: Date.now(), props: {} }) as unknown as MMPost
    others.push(msg('M1', 'U1', 'Add the app repo to this workspace'), msg('M2', 'U2', 'and my dotfiles'))
    return { ...env, rkey, tools }
  }

  test("an owner asks a router: a git URL is cloned into the workspace, a folder outside it is added and the sessions that need it restart", async () => {
    const { hub, tmux, posts, w, p, rkey, tools } = scene()
    const add = (source: string, message_id = 'M1', name?: string) => handleCall(hub, rkey, 'add_repo', { source, message_id, ...(name ? { name } : {}) })
    const repos = () => loadWorkspace(hub.cfg, 'demo')!.repos.map(r => r.name)
    // The router at work for alice, another router of the workspace and a worker, both idle.
    await hub.enqueue(() => hub.deliver(rkey, 'Add the app repo to this workspace', { chat_id: 'C1', thread_id: 'T2' }))
    const rb = await connect(hub, tmux, rkey, 1)
    const other = hub.createRouter({ threadId: 'T3', channelId: 'C1', workspace: w, label: 'other' })
    await hub.enqueue(() => hub.deliver(other, 'hi', { chat_id: 'C1', thread_id: 'T3' }))
    await connect(hub, tmux, other, 2)
    await hook(hub, other, 'Stop')
    const { key: wkey } = worker(hub, w)
    await hub.enqueue(() => hub.ensureStarted(wkey))
    await connect(hub, tmux, wkey, 3)
    await hook(hub, wkey, 'Stop')

    // Refused: not an owner's message, none, a worker, a relative path, the hub's own state, Claude's config, every workspace, another workspace.
    await expect(add('https://github.com/org/api.git', 'M2')).rejects.toThrow('only a hub owner can add repos to the workspace')
    await expect(handleCall(hub, rkey, 'add_repo', { source: 'https://github.com/org/api.git' })).rejects.toThrow('pass message_id')
    await expect(handleCall(hub, wkey, 'add_repo', { source: tools, message_id: 'M1' })).rejects.toThrow('routers only')
    await expect(add('code/app')).rejects.toThrow("pass the folder's full path")
    await expect(add(p.dir)).rejects.toThrow("is part of the hub's own state")
    await expect(add(dirname(p.dir))).rejects.toThrow("holds the hub's own state")
    await expect(add(process.env.CLAUDE_CONFIG_DIR!)).rejects.toThrow("Claude Code's settings and logins")
    await expect(add(hub.cfg.workspacesDir)).rejects.toThrow('holds every workspace')
    const elsewhere = createWorkspace(hub.cfg, 'elsewhere')
    await expect(add(elsewhere.dir)).rejects.toThrow('inside another workspace')
    expect(repos()).toEqual([])

    // A git URL: cloned into the workspace's repos/, never waiting on a prompt. Routers read it already: nobody restarts.
    const res = await add('https://bot:s3cret@github.com/org/api.git')
    expect(res).toContain(`added repo "api" (${join(w.dir, 'repos', 'api')}) to workspace demo for @alice`)
    expect(res).toContain('You can read it now')
    expect(res).toContain('prepare_repo(repo="api")')
    expect(readFileSync(join(w.dir, 'repos', 'api', 'env'), 'utf8').trim()).toBe('0 ssh -o BatchMode=yes')
    expect(repos()).toEqual(['api'])
    expect(tmux.launches.length).toBe(3)
    await expect(add('https://github.com/org/api.git')).rejects.toThrow('already has a repo named api')
    // A failed clone leaves nothing, and never shows the password in its URL.
    const failed = add('https://bot:s3cret@github.com/org/fail.git')
    await expect(failed).rejects.toThrow('git clone failed: fatal: could not read from https://…@github.com/org/fail.git')
    expect(existsSync(join(w.dir, 'repos', 'fail'))).toBe(false)

    // A clone longer than a tool call may wait goes on; the router hears when it is done.
    const slow = await addRepoTool(hub, rkey, { source: 'https://github.com/org/slow.git', messageId: 'M1' }, 50)
    expect(slow).toContain('it goes on, and you get a message (kind="repo_added")')
    await until('the clone is reported', () => rb.got.some(m => m.meta.kind === 'repo_added'))
    expect(rb.got.at(-1)!.content).toContain(`"slow" at ${join(w.dir, 'repos', 'slow')}`)
    expect(repos()).toEqual(['api', 'slow'])

    // A git repo outside the workspace: routers restart to read it (alice's after its turn), workers work in their own checkout.
    const app = join(tools, 'app')
    mkdirSync(join(app, '.git'), { recursive: true })
    const r2 = await add(app)
    expect(r2).toContain('you restart after this turn, with your memory, and so does 1 other live session of the workspace')
    expect(hub.restartPending(rkey)).toBe(true)
    expect(tmux.launches.map(l => l.name).slice(3)).toEqual([tmuxName(other)])
    await expect(add(app, 'M1', 'app2')).rejects.toThrow(`already has ${app}, as repo app`)
    await hook(hub, rkey, 'Stop')
    await until('the router restarts', () => tmux.launches.length === 5)
    expect(tmux.launches[4]!.argv.join(' ')).toContain(`--add-dir ${app}`)

    // A folder that isn't a git repo: workers share it as it is, so they restart too.
    await connect(hub, tmux, other, 4)
    await connect(hub, tmux, rkey, 5)
    const notes = join(tools, 'notes')
    mkdirSync(notes)
    expect(await add(notes)).toContain("It isn't a git repo: workers share the folder as it is")
    await until('the worker restarts', () => tmux.launches.some((l, i) => i >= 5 && l.name === tmuxName(wkey)))
    expect(tmux.launches.findLast(l => l.name === tmuxName(wkey))!.argv.join(' ')).toContain(`--add-dir ${notes}`)
    expect(repos()).toEqual(['api', 'slow', 'app', 'notes'])
    expect(posts).toEqual([]) // the router tells the person itself
  }, T)

  test('a direct session works in the original checkouts, so a git repo outside the workspace restarts it too', async () => {
    const { hub, tmux, rkey, tools } = scene()
    const { key } = await hub.enqueue(() => hub.newDirectSession('demo'))
    await connect(hub, tmux, key!, 1)
    const app = join(tools, 'app')
    mkdirSync(join(app, '.git'), { recursive: true })
    expect(await handleCall(hub, rkey, 'add_repo', { source: app, message_id: 'M1' })).toContain('and so does 1 other live session of the workspace')
    await until('the direct session restarts', () => tmux.launches.length === 2)
    expect(tmux.launches[1]!.argv.join(' ')).toContain(`--add-dir ${app}`)
  }, T)
})

describe('scheduled jobs', () => {
  /** Workspace demo bound to C1, owner U1 (alice); a router in thread T2 where alice and bob talk. */
  function scene() {
    const env = setup({}, dir => {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
    })
    const { hub, p, w, others } = env
    hub.bot = { id: 'BOT', username: 'claude' }
    bindChannel(p.bindings, 'C1', 'demo')
    const rkey = hub.createRouter({ threadId: 'T2', channelId: 'C1', workspace: w, label: 'ops talk' })
    const msg = (id: string, user: string, message: string, root = 'T2') =>
      ({ id, root_id: root, user_id: user, channel_id: 'C1', message, create_at: Date.now(), props: {} }) as unknown as MMPost
    others.push(msg('M1', 'U1', 'Every weekday at 9, check the alerts dashboard'), msg('M2', 'U2', 'and every 5 minutes ping me'))
    return { ...env, rkey, msg }
  }

  test("an owner's request through a router; each run opens a new thread with its own router, never twice, never piled up", async () => {
    const { hub, tmux, posts, rkey, w, msg } = scene()
    // Owners only, at least 15 minutes apart, a message from the session's own thread.
    await expect(handleCall(hub, rkey, 'schedule', { schedule: 'every weekday 09:00', text: 'x', message_id: 'M2' })).rejects.toThrow('only a hub owner')
    await expect(handleCall(hub, rkey, 'schedule', { schedule: 'every 5m', text: 'x', message_id: 'M1' })).rejects.toThrow('at least 15 minutes apart')
    await expect(handleCall(hub, rkey, 'schedule', { schedule: 'every weekday 09:00', text: 'x' })).rejects.toThrow('pass message_id')
    expect(hub.store.jobs()).toEqual([])

    const posted = posts.length
    const res = await handleCall(hub, rkey, 'schedule', {
      schedule: 'every weekday 09:00 Asia/Jakarta', text: 'Check the alerts dashboard; post anything red.\nIf it is down, tell @channel.', message_id: 'M1', name: 'Morning alerts',
    })
    expect(res).toContain('scheduled job #1 "Morning alerts" set up for @alice')
    // The hub posts nothing: the session confirms it in its own words.
    expect(posts.length).toBe(posted)
    expect(res).toContain('Nothing was posted: confirm it to the person yourself with reply')
    expect(res).toContain('Nothing more: no !cron commands, nor how to remove or pause it.')
    expect(res).not.toContain('!cron rm')
    const job = hub.store.job(1)!
    expect(job).toMatchObject({ workspace: 'demo', schedule: 'every weekday 09:00', cron: '0 9 * * 1-5', tz: 'Asia/Jakarta', channelId: 'C1', createdBy: '@alice', origin: 'thread T2', paused: false })
    const listed = await handleCall(hub, rkey, 'list_schedules', {})
    expect(listed).toContain('#1 Morning alerts  [demo]')
    expect(listed).not.toContain('!cron')

    // Not due yet: nothing. Due: a router of its own for a new thread in C1 gets the instruction, and the hub posts nothing.
    const slot = job.nextAt!
    const before = posts.length
    expect(await hub.enqueue(() => runDueJobs(hub, slot - 1000))).toBe(0)
    await hub.enqueue(() => runDueJobs(hub, slot + 2000))
    expect(posts.length).toBe(before)
    const draft = hub.store.runs(1, 1)[0]!.threadId!
    expect(draft).toStartWith('draft-')
    const t = hub.store.thread(draft)!
    expect(t).toMatchObject({ workspace: 'demo', channelId: 'C1' })
    const r = await connect(hub, tmux, t.routerKey, 1)
    expect(r.got[0]!.meta).toMatchObject({ kind: 'scheduled', job_id: '1', thread_id: draft, chat_id: 'C1' })
    expect(r.got[0]!.meta.message_id).toBeUndefined()
    expect(r.got[0]!.content).toContain('[Scheduled job #1 "Morning alerts"')
    expect(r.got[0]!.content).toContain('Not a person')
    expect(r.got[0]!.content).toContain('your first reply is a new post in the channel, which opens this run\'s thread')
    expect(r.got[0]!.content).toContain('If there is nothing worth posting, post nothing.')
    expect(r.got[0]!.content).toContain('Check the alerts dashboard; post anything red.\nIf it is down, tell @channel.')
    expect(hub.store.runs(1, 1)[0]).toMatchObject({ status: 'started', slot, threadId: draft })
    expect(await handleCall(hub, t.routerKey, 'fetch_thread', {})).toContain('Nothing is posted in thread')
    expect(hub.permalink(draft)).toBe('(not posted yet)')
    const wkey = hub.createWorker({ workspace: w, title: 'Ops', summary: 'ops' })
    hub.store.patchWorker(wkey, { threads: [draft] })

    // The router's first reply is a new post in the channel: it opens the thread, which goes by its id from then on.
    const sent = await handleCall(hub, t.routerKey, 'reply', { text: 'Two alerts are red: checkout latency and disk on db-2.' })
    const root = posts[before]!
    expect(root).toMatchObject({ channel_id: 'C1', message: 'Two alerts are red: checkout latency and disk on db-2.' })
    expect(root.root_id).toBeUndefined()
    expect(sent).toContain(root.id)
    expect(hub.store.thread(root.id)).toMatchObject({ id: root.id, routerKey: t.routerKey, channelId: 'C1' })
    expect(hub.store.thread(draft)!.id).toBe(root.id)
    expect(hub.store.runs(1, 1)[0]!.threadId).toBe(root.id)
    expect(hub.store.job(1)!.lastThread).toBe(root.id)
    expect(hub.store.worker(wkey)!.threads).toEqual([root.id])
    // Whoever still holds the draft's id (a worker's task) reaches the opened thread.
    expect(await handleCall(hub, wkey, 'reply', { thread_id: draft, text: 'db-2 is at 91%' })).toContain("thread's router")
    await handleCall(hub, t.routerKey, 'reply', { text: 'Disk on db-2 is at 91%.' })
    expect(posts.at(-1)!.root_id).toBe(root.id)
    // A person's reply in it reaches the same router.
    await hub.enqueue(() => hub.onPosted(msg('P1', 'U1', 'which disk?', root.id), 'O'))
    await until('the reply reaches the router', () => r.got.some(m => m.content.includes('which disk?')))
    const opened = posts.length

    // The same time is never run twice (say the hub restarted before it moved on).
    hub.store.patchJob(1, { nextAt: slot })
    await hub.enqueue(() => runDueJobs(hub, slot + 3000))
    expect(hub.store.runs(1, 5).filter(x => x.status === 'started').length).toBe(1)
    expect(hub.store.job(1)!.nextAt).toBeGreaterThan(slot)

    // The next time comes while that run is still being worked on: skipped.
    const slot2 = hub.store.job(1)!.nextAt!
    await hub.enqueue(() => runDueJobs(hub, slot2 + 1000))
    expect(hub.store.runs(1, 1)[0]).toMatchObject({ status: 'skipped', slot: slot2 })
    expect(hub.store.runs(1, 1)[0]!.note).toContain('the run before is still waiting or being worked on')

    // An owner stopped that router: its message waits for them, and doesn't hold up the time after.
    await hub.enqueue(() => hub.close(t.routerKey, 'manual'))
    expect(hub.store.messageState(hub.store.runs(1, 2)[1]!.inboxId!)).toBe('interrupted')
    const slot3 = hub.store.job(1)!.nextAt!
    await hub.enqueue(() => runDueJobs(hub, slot3 + 1000))
    expect(posts.length).toBe(opened)
    const t2 = hub.store.thread(hub.store.runs(1, 1)[0]!.threadId!)!
    expect(t2.id).toStartWith('draft-')
    expect(t2.routerKey).not.toBe(t.routerKey)
    await connect(hub, tmux, t2.routerKey, 2)

    // Removed by an owner, through the router.
    await expect(handleCall(hub, rkey, 'unschedule', { job_id: 1, message_id: 'M2' })).rejects.toThrow('only a hub owner')
    const beforeRemove = posts.length
    const removed = await handleCall(hub, rkey, 'unschedule', { job_id: '#1', message_id: 'M1' })
    expect(removed).toContain('removed job #1 "Morning alerts"')
    expect(removed).toContain('Nothing was posted: tell the person yourself with reply')
    expect(hub.store.jobs()).toEqual([])
    expect(posts.length).toBe(beforeRemove)
  }, T)

  test('with "*" in allowFrom any person may ask for a job; the hub itself and bot accounts may not', async () => {
    const { hub, p, rkey, msg, others } = scene()
    writeFileSync(p.access, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['*'], channels: {}, pending: {} }))
    others.push(
      msg('M3', 'BOT', 'every weekday at 9, as the hub'),
      { ...msg('M4', 'UBOT', 'every weekday at 9, from a bot'), props: { from_bot: 'true' } } as MMPost,
    )
    await expect(handleCall(hub, rkey, 'schedule', { schedule: 'every weekday 09:00', text: 'x', message_id: 'M3' })).rejects.toThrow('only a hub owner')
    await expect(handleCall(hub, rkey, 'schedule', { schedule: 'every weekday 09:00', text: 'x', message_id: 'M4' })).rejects.toThrow('only a hub owner')
    // U2 isn't listed, but "*" makes every person an owner.
    expect(await handleCall(hub, rkey, 'schedule', { schedule: 'every weekday 09:00', text: 'Ping bob', message_id: 'M2', name: 'Ping' })).toContain('scheduled job #1 "Ping" set up')
  }, T)

  test('missed while the hub was down or the machine asleep: run once within the grace, skipped beyond it', async () => {
    const { hub, posts } = scene()
    const daily = await hub.enqueue(() => addJob(hub, { workspace: 'demo', schedule: 'every day 09:00', text: 'Daily report', createdBy: 'mmhub cli', origin: 'cli' }))
    // Found two days and three hours late: skipped and recorded, nothing posted.
    const late = daily.nextAt! + 2 * 86_400_000 + 3 * 3_600_000
    await hub.enqueue(() => runDueJobs(hub, late))
    expect(posts).toEqual([])
    const missed = hub.store.runs(daily.id, 1)[0]!
    expect(missed.status).toBe('missed')
    expect(missed.note).toContain('found 3h late')
    expect(missed.note).toContain('2 earlier time(s) missed too')
    expect(hub.store.job(daily.id)!.nextAt).toBeGreaterThan(late)

    // Three times came and went, the latest 10 minutes ago: it runs once.
    const often = await hub.enqueue(() => addJob(hub, { workspace: 'demo', schedule: 'every 2h', text: 'Check the queue', createdBy: 'mmhub cli', origin: 'cli' }))
    const now = often.nextAt! + 4 * 3_600_000 + 10 * 60_000
    await hub.enqueue(() => runDueJobs(hub, now))
    expect(posts).toEqual([])
    const run = hub.store.runs(often.id, 1)[0]!
    expect(run).toMatchObject({ status: 'started', slot: often.nextAt! + 4 * 3_600_000, note: '2 earlier time(s) missed' })
    expect(hub.store.job(often.id)!.nextAt).toBe(often.nextAt! + 6 * 3_600_000)
  }, T)

  test("the ticker runs due jobs, but not while Mattermost is down; a job can go to one thread's router", async () => {
    const { hub, tmux, posts, w } = scene()
    const mm = hub.mm as unknown as { connected: boolean }
    // Every run goes to this thread's router, which remembers the earlier ones.
    const res = await control(hub, 'cron', { op: 'add', workspace: 'demo', schedule: 'every day 07:30', text: 'Compare with yesterday', thread: 'T2', name: 'Diff' }, () => {})
    expect(res.ok).toBe(true)
    expect(res.message).toContain('in thread T2')
    expect((await control(hub, 'cron', { op: 'add', workspace: 'demo', schedule: 'every day 07:30', text: 'x', thread: 'nope' }, () => {})).message).toContain('not a hub thread of workspace demo')
    expect((await control(hub, 'cron', { op: 'add', workspace: 'demo', schedule: 'every day 07:30', text: 'x', channel: 'C9' }, () => {})).message).toContain('not bound to workspace demo')

    hub.store.patchJob(1, { nextAt: Date.now() - 1000 })
    mm.connected = false
    hub.onTick(Date.now(), 5000)
    await hub.enqueue(() => undefined)
    expect(posts).toEqual([])
    mm.connected = true
    hub.onTick(Date.now(), 5000)
    await until('the job runs', () => hub.store.runs(1, 1).length === 1)
    await hub.enqueue(() => undefined)
    // In an existing thread the hub posts nothing: the router's reply is the run's only post.
    expect(posts).toEqual([])
    const rkey = hub.store.thread('T2')!.routerKey
    const r = await connect(hub, tmux, rkey, 1)
    expect(r.got[0]!.meta).toMatchObject({ kind: 'scheduled', job_id: '1', thread_id: 'T2' })
    expect(r.got[0]!.meta.message_id).toBeUndefined()
    expect(r.got[0]!.content).toContain('Compare with yesterday')
    expect(r.got[0]!.content).toContain('the hub posts nothing for this run, so your reply is all people see')

    // A worker sets one up from the owner's words its task quotes.
    const wkey = hub.createWorker({ workspace: w, title: 'Ops', summary: 'ops' })
    hub.store.patchWorker(wkey, { threads: ['T2'] })
    expect(await handleCall(hub, wkey, 'schedule', { schedule: 'every mon 08:00', text: 'Weekly cost report', message_id: 'M1', in_this_thread: true })).toContain('scheduled job #2')
    expect(hub.store.job(2)).toMatchObject({ threadId: 'T2', createdBy: '@alice', name: 'Weekly cost report' })
    await expect(handleCall(hub, wkey, 'unschedule', { job_id: 2, message_id: 'X1' })).rejects.toThrow('no message X1')
  }, T)

  test('owners manage jobs in chat with !cron', async () => {
    const { hub, tmux, posts, msg } = scene()
    const say = async (text: string) => {
      const n = posts.length
      await hub.enqueue(() => hub.onPosted({ ...msg(`P${Math.random()}`, 'U1', text, ''), root_id: '' }, 'O'))
      return posts.slice(n).map(p => p.message).join('\n')
    }
    expect(await say('@claude !cron')).toContain('No scheduled jobs in workspace demo')
    expect(await say('@claude !cron add every weekday 09:00')).toContain('Usage: `!cron`')
    expect(await say('@claude !cron add every 5m | ping')).toContain('⚠️ "every 5m" runs every 5 min')
    const added = await say("@claude !cron add every weekday 08:00 Asia/Jakarta | Summarise yesterday's deploys\nand flag failures")
    expect(added).toContain("⏰ Scheduled job #1 **Summarise yesterday's deploys and flag failures**: every weekday 08:00 (Asia/Jakarta)")
    expect(hub.store.job(1)!.text).toBe("Summarise yesterday's deploys\nand flag failures")
    expect(await say('@claude !cron')).toContain("**#1 Summarise yesterday's deploys and flag failures**")

    expect(await say('@claude !cron pause 1')).toContain('⏸ Job #1')
    expect(hub.store.dueJobs(Date.now() + 7 * 86_400_000)).toEqual([])
    expect(await say('@claude !cron resume 1')).toContain('▶️ Job #1')
    expect(hub.store.job(1)!.nextAt).toBeGreaterThan(Date.now())

    const ran = await say('@claude !cron run 1')
    expect(ran).toContain('▶️ Running job #1')
    await connect(hub, tmux, hub.store.thread(hub.store.runs(1, 1)[0]!.threadId!)!.routerKey, 1)
    expect(hub.store.runs(1, 1)[0]).toMatchObject({ kind: 'manual', status: 'started', note: 'run now by @alice' })
    expect(await say('@claude !cron show 1')).toContain('manual started')

    expect(await say('@claude !cron rm 1')).toContain('🗑 Removed scheduled job #1')
    expect(await say('@claude !cron rm 1')).toContain('⚠️ no job #1')
  }, T)
})

describe("checking a provider's login where its sessions run", () => {
  // A stand-in for claude: signed in with whatever credential reached it; shows its PATH.
  const bin = mkdtempSync(join(tmpdir(), 'mmhub-authbin-'))
  const claude = join(bin, 'claude')
  writeFileSync(claude, `#!/bin/sh
li=false; m=none
[ -n "$ANTHROPIC_API_KEY" ] && { li=true; m="api_key:$ANTHROPIC_API_KEY"; }
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && { li=true; m="oauth_token:$CLAUDE_CODE_OAUTH_TOKEN"; }
printf '{"loggedIn": %s, "authMethod": "%s", "apiProvider": "firstParty", "orgName": "%s"}\\n' "$li" "$m" "$PATH"
`, { mode: 0o755 })

  test("each provider is launched as its sessions are: the session's PATH, its secret through the wrapper; mmhub asks through control", async () => {
    const { hub, tmux } = setup({ path: '/opt/hub/bin:/usr/bin:/bin' }, dir => {
      saveProviders(dir, { tok: { kind: 'oauth-token' }, key: { kind: 'api-key' } })
      writeSecret(dir, 'tok', 'CLAUDE_CODE_OAUTH_TOKEN', 'oat-SECRET')
      writeSecret(dir, 'key', 'ANTHROPIC_API_KEY', 'sk-ant-api03-SECRET')
    }, { claudeBin: claude })

    expect(await hub.authStatus('default')).toEqual({ loggedIn: false, text: 'not signed in · auth none · API firstParty (/opt/hub/bin:/usr/bin:/bin)' })
    expect(tmux.authChecks[0]!.argv).not.toContain('mmhub-launch') // the hub's own login: no provider wrapper
    expect(await hub.authStatus('tok')).toMatchObject({ loggedIn: true, text: expect.stringContaining('auth oauth_token:oat-SECRET') })
    expect(await hub.authStatus('key')).toMatchObject({ loggedIn: true, text: expect.stringContaining('auth api_key:sk-ant-api03-SECRET') })
    expect(JSON.stringify(tmux.authChecks)).not.toContain('SECRET')
    expect(tmux.launches).toEqual([]) // no session was started for it
    await expect(hub.authStatus('nope')).rejects.toThrow('no provider nope')

    expect(await control(hub, 'provider', { op: 'check', name: 'tok' }, () => {})).toMatchObject({ ok: true, data: { loggedIn: true } })
    expect(await control(hub, 'provider', { op: 'check', name: 'nope' }, () => {})).toEqual({ ok: false, message: 'no provider nope' })
  }, T)
})

describe('direct sessions (mmhub session new)', () => {
  test('an owner opens one in the workspace folder: started at once, its own prompt, the attach command in the answer', async () => {
    const { hub, tmux, w } = setup()
    const res = await control(hub, 'session', { op: 'new', workspace: 'demo' }, () => {})
    expect(res.ok).toBe(true)
    const key = (res.data as { key: string }).key
    expect(key).toMatch(/^w-[a-z0-9]+$/)
    expect(res.message).toBe(`starting ${key} (Direct session 1) in ${w.dir} — attach: tmux -L ${hub.cfg.tmuxSocket} attach -t ${tmuxName(key)}`)
    expect(hub.store.session(key)).toMatchObject({ role: 'worker', workspace: 'demo', cwd: w.dir })
    expect(hub.store.worker(key)).toMatchObject({ title: 'Direct session 1', direct: true, threads: [] })

    await connect(hub, tmux, key, 1)
    const launch = tmux.launches[0]!
    expect(launch.cwd).toBe(w.dir)
    const prompt = readFileSync(launch.argv[launch.argv.indexOf('--append-system-prompt-file') + 1]!, 'utf8')
    expect(prompt).toContain('direct session "Direct session 1"')
    expect(prompt).toContain('they read and type in this terminal')
    expect(prompt).not.toContain('Nobody reads this terminal')
    const env = (k: string) => JSON.parse(readFileSync(join(hub.p.sessions, k, 'mcp.json'), 'utf8')).mcpServers.mmhub.env
    expect(env(key)).toMatchObject({ MMHUB_ROLE: 'worker', MMHUB_DIRECT: '1' }) // the bridge: no posting tools, answer here
    const ctx = hub.hookContext(key)!
    expect(ctx).toContain(`Workspace "demo" at ${w.dir}`)
    expect(ctx).toContain('Repos (work in them where they are):')
    expect(ctx).not.toContain('do not edit')
    expect(ctx).not.toContain('reply(thread_id')

    // The next one is numbered on.
    const second = await control(hub, 'session', { op: 'new', workspace: 'demo' }, () => {})
    expect(hub.store.worker((second.data as { key: string }).key)!.title).toBe('Direct session 2')
  }, T)

  test("routers don't see one, can't hand it a task, and the cleanup job leaves it alone", async () => {
    const { hub, w } = setup()
    const direct = hub.createWorker({ workspace: w, title: 'Direct session 1', summary: '', direct: true })
    const fixer = hub.createWorker({ workspace: w, title: 'Fixer', summary: 'fixes things' })
    const rkey = hub.createRouter({ threadId: 'T2', channelId: 'C1', workspace: w, label: 'thread two' })

    const listed = await handleCall(hub, rkey, 'list_workers', {})
    expect(listed).toContain(fixer)
    expect(listed).not.toContain(direct)
    expect(hub.hookContext(rkey)).toContain(fixer)
    expect(hub.hookContext(rkey)).not.toContain(direct)
    const thread = hub.store.thread('T2')!
    await expect(delegate(hub, { thread, workerKey: direct, task: 'x', messageIds: [] })).rejects.toThrow(`no worker ${direct} in workspace demo`)

    // A day without work: workers clear their build output, but this one works in the original checkouts.
    hub.store.patchSession(direct, { lastActiveAt: Date.now() - 100 * 3_600_000 })
    await hub.enqueue(() => hub.cleanupDue())
    expect(hub.store.messagesFor(direct, ['queued', 'delivered'])).toEqual([])
  }, T)

  test('an unknown workspace is refused, and nothing starts', async () => {
    const { hub, tmux } = setup()
    expect(await control(hub, 'session', { op: 'new', workspace: 'nope' }, () => {})).toEqual({ ok: false, message: 'no workspace nope' })
    expect(await control(hub, 'session', { op: 'new' }, () => {})).toEqual({ ok: false, message: 'which workspace? mmhub session new <workspace>' })
    expect(hub.store.sessions({ role: 'worker' })).toEqual([])
    expect(tmux.launches).toEqual([])
  })

  test('a state database from before direct sessions gets the column', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mmhub-store-')), 'hub.db')
    const old = new Database(file)
    old.exec(`CREATE TABLE workers (key TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
      threads TEXT NOT NULL DEFAULT '[]', repos TEXT NOT NULL DEFAULT '{}', active_thread TEXT, active_task INTEGER, last_post TEXT)`)
    old.exec(`INSERT INTO workers (key, workspace, title) VALUES ('w-old', 'demo', 'Fixer')`)
    old.close()
    const store = new Store(file)
    expect(store.worker('w-old')!.direct).toBeUndefined()
    store.insertWorker({ key: 'w-new', workspace: 'demo', title: 'Direct session 1', summary: '', threads: [], repos: {}, direct: true })
    expect(store.worker('w-new')!.direct).toBe(true)
    store.close()
  })
})
