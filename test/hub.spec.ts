// The hub's interruption handling and reporting, driven end to end with a fake
// tmux and a fake Mattermost: API-error retries (quiet unless they matter),
// crash → resume → re-delivery, graceful restart after the current turn, a
// hand-stopped session staying stopped, worker reports going to the router, and
// provider fallback (a failing provider rests; the work moves to the next one).
// Each "process" here is a FakeTmux session plus a bridge connection the test
// opens, so a start takes ~1.5 s (the shepherd's polling).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { HubMsg } from '../src/shared/ipc'
import { paths } from '../src/shared/paths'
import { loadConfig } from '../src/hub/config'
import { Hub, type BridgeConn } from '../src/hub/hub'
import { delegate, handleCall, ToolError } from '../src/hub/tools'
import { control } from '../src/hub/control'
import { addJob, runDueJobs } from '../src/hub/jobs'
import { RETRY_DELAYS } from '../src/hub/lifecycle'
import type { Mattermost, MMPost } from '../src/hub/mattermost'
import { tmuxName, transcriptPath } from '../src/hub/spawn'
import type { Tmux } from '../src/hub/tmux'
import { bindChannel, createWorkspace, setWorkspaceProviders, setWorkspaceTrigger, type Workspace } from '../src/hub/workspaces'
import { saveProviders, secretFile, writeSecret } from '../src/hub/providers'

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
  launches: { name: string; argv: string[]; env: Record<string, string> }[] = []
  async newSession(o: { name: string; cwd: string; argv: string[]; env: Record<string, string> }) {
    this.alive.add(o.name)
    this.launches.push({ name: o.name, argv: o.argv, env: o.env })
  }
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

function setup(config: Record<string, unknown> = {}, before?: (stateDir: string) => void) {
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
    claudeBin: '/bin/claude', bunBin: process.execPath, version: 'test', cliPath: '/cli.ts',
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
  test('shown in the thread a busy session works for; not while it waits on a person or a retry', async () => {
    const { hub, tmux, w, typing } = setup()
    const { key } = worker(hub, w)
    hub.keepTyping()
    expect(typing).toEqual([]) // not started yet
    await hub.enqueue(() => hub.ensureStarted(key))
    hub.keepTyping()
    expect(typing).toEqual(['C1/T1']) // starting with a task waiting: shown instead of a "resuming…" post
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

  test("a worker asks another workspace; that workspace's router answers in a visible thread and the answer comes back", async () => {
    const { hub, tmux, posts, bee, key, wb } = await scene()
    const res = await handleCall(hub, key, 'message_workspace', { workspace: 'bee', text: 'What is the staging DB host?' })
    expect(res).toContain('request_id p1')
    expect(posts[0]).toMatchObject({ id: 'p1', channel_id: 'CB' })
    expect(posts[0]!.root_id).toBeUndefined()
    expect(posts[0]!.message).toContain('📨 **Request from workspace demo**')
    expect(posts[0]!.message).toContain('What is the staging DB host?')
    expect(hub.store.link('p1')).toMatchObject({ kind: 'workspace', fromKey: key, fromThread: 'T1', peer: 'bee', chain: ['demo'] })

    // bee gets a router for the request thread, told who is asking.
    const t = hub.store.thread('p1')!
    expect(t).toMatchObject({ channelId: 'CB', workspace: 'bee' })
    const rb = await connect(hub, tmux, t.routerKey, 2)
    expect(rb.got[0]!.meta).toMatchObject({ kind: 'workspace_request', from_workspace: 'demo', thread_id: 'p1', chat_id: 'CB', workspace: 'bee' })
    expect(rb.got[0]!.content).toContain('Not a person')
    expect(rb.got[0]!.content).toContain('What is the staging DB host?')

    // Its answer is posted in the thread, and reaches the worker as work for T1.
    await handleCall(hub, t.routerKey, 'reply', { chat_id: 'CB', text: 'staging-db.internal:5432' })
    expect(posts.at(-1)).toMatchObject({ root_id: 'p1', message: 'staging-db.internal:5432' })
    await until('the answer reaches the worker', () => wb.got.length === 2)
    expect(wb.got[1]!.content).toContain('[Answer from workspace "bee" (its router) to your request p1')
    expect(wb.got[1]!.content).toContain('staging-db.internal:5432')
    expect(wb.got[1]!.meta).toMatchObject({ thread_id: 'T1' })

    // The asker reads the request thread; the router can't read threads not its own.
    expect(await handleCall(hub, key, 'fetch_thread', { thread_id: 'p1' })).toContain('staging-db.internal:5432')
    await expect(handleCall(hub, t.routerKey, 'fetch_thread', { thread_id: 'T1' })).rejects.toThrow('not yours to read')

    // A follow-up goes to the same router, in the same thread.
    const n = rb.got.length
    await handleCall(hub, key, 'message_workspace', { request_id: 'p1', text: 'And the read replica?' })
    expect(posts.at(-1)).toMatchObject({ root_id: 'p1', channel_id: 'CB' })
    await until('the follow-up reaches the router', () => rb.got.length === n + 1)
    expect(rb.got[n]!.content).toContain('[Follow-up from workspace "demo"')
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

  test('a worker DMs an owner; their reply in that DM thread comes back to it', async () => {
    const { hub, posts, key, wb } = await scene(dir => {
      writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['U1'], channels: {}, pending: {} }))
    })
    const res = await handleCall(hub, key, 'send_dm', { user: '@alice', text: 'May I deploy to staging?' })
    expect(res).toContain('DM thread_id p1')
    expect(posts[0]).toMatchObject({ id: 'p1', channel_id: 'D1' })
    expect(posts[0]!.message).toContain('May I deploy to staging?')
    expect(hub.store.link('p1')).toMatchObject({ kind: 'dm', fromKey: key, peer: 'U1', fromThread: 'T1' })
    expect(hub.store.get('seen:D1')).toBeDefined()

    // Owners only.
    await expect(handleCall(hub, key, 'send_dm', { user: 'bob', text: 'hi' })).rejects.toThrow('@bob is not a hub owner')

    // alice answers in the thread: the worker gets it as work for T1.
    const reply = { id: 'R1', root_id: 'p1', user_id: 'U1', channel_id: 'D1', message: 'Go ahead.', create_at: Date.now() } as MMPost
    await hub.enqueue(() => hub.onPosted(reply, 'D'))
    await until('the DM reply reaches the worker', () => wb.got.length === 2)
    expect(wb.got[1]!.content).toContain('[DM reply from @alice')
    expect(wb.got[1]!.content).toContain('Go ahead.')

    // The worker answers in the same DM thread.
    await handleCall(hub, key, 'send_dm', { thread_id: 'p1', text: 'Thanks, deploying.' })
    expect(posts.at(-1)).toMatchObject({ root_id: 'p1', channel_id: 'D1', message: 'Thanks, deploying.' })
    await expect(handleCall(hub, key, 'send_dm', { thread_id: 'T1', text: 'x' })).rejects.toThrow("isn't one of yours")

    // At most 10 new requests or DMs an hour.
    for (let i = 0; i < 9; i++) hub.store.insertLink({ threadId: `X${i}`, kind: 'dm', channelId: 'D1', fromKey: key, fromWorkspace: 'demo', peer: 'U1', chain: ['demo'], createdAt: Date.now() })
    await expect(handleCall(hub, key, 'send_dm', { user: 'alice', text: 'again' })).rejects.toThrow('in the last hour')
  }, T)
})

describe('Laya decides what reaches the bot', () => {
  test('in threads the bot follows (from a mention until the router unfollows), by its judgement; workers keep the rules', async () => {
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

      // The request is done: the router unfollows (not while work for the thread is open).
      const task = hub.store.insertTask({ workerKey: 'w-busy', threadId: 'T3', channelId: 'C1', text: 'x', state: 'queued', createdAt: Date.now() })
      await expect(handleCall(hub, rkey, 'unfollow', {})).rejects.toThrow('work for this thread is still open')
      hub.store.setTaskState(task, 'ended')
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
      expect(hub.hookContext(rkey)).toContain('call unfollow')
      const { key } = worker(hub, w)
      expect(hub.hookContext(key)).toContain('update them with trigger_rules')
      expect(await handleCall(hub, key, 'trigger_rules', {})).toContain('- questions about the build')
      const saved = await handleCall(hub, key, 'trigger_rules', { content: "## Answer\n- questions about the build\n- deploy requests\n## Don't answer\n- lunch plans\n" })
      expect(saved).toContain('saved: 2 "answer" and 1 "don\'t answer" rule(s).')
      expect(saved).toContain('Laya is on for this workspace')
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
    const { hub, tmux, posts, rkey } = scene()
    // Owners only, at least 15 minutes apart, a message from the session's own thread.
    await expect(handleCall(hub, rkey, 'schedule', { schedule: 'every weekday 09:00', text: 'x', message_id: 'M2' })).rejects.toThrow('only a hub owner')
    await expect(handleCall(hub, rkey, 'schedule', { schedule: 'every 5m', text: 'x', message_id: 'M1' })).rejects.toThrow('at least 15 minutes apart')
    await expect(handleCall(hub, rkey, 'schedule', { schedule: 'every weekday 09:00', text: 'x' })).rejects.toThrow('pass message_id')
    expect(hub.store.jobs()).toEqual([])

    const res = await handleCall(hub, rkey, 'schedule', {
      schedule: 'every weekday 09:00 Asia/Jakarta', text: 'Check the alerts dashboard; post anything red.\nIf it is down, tell @channel.', message_id: 'M1', name: 'Morning alerts',
    })
    expect(res).toContain('scheduled job #1 "Morning alerts"')
    const job = hub.store.job(1)!
    expect(job).toMatchObject({ workspace: 'demo', schedule: 'every weekday 09:00', cron: '0 9 * * 1-5', tz: 'Asia/Jakarta', channelId: 'C1', createdBy: '@alice', origin: 'thread T2', paused: false })
    expect(posts.at(-1)!.root_id).toBe('T2')
    expect(posts.at(-1)!.message).toContain('⏰ @alice set up scheduled job #1 **Morning alerts**')
    expect(await handleCall(hub, rkey, 'list_schedules', {})).toContain('#1 Morning alerts  [demo]')

    // Not due yet: nothing. Due: a new thread in C1, and its own router gets the instruction.
    const slot = job.nextAt!
    const before = posts.length
    expect(await hub.enqueue(() => runDueJobs(hub, slot - 1000))).toBe(0)
    await hub.enqueue(() => runDueJobs(hub, slot + 2000))
    const root = posts[before]!
    expect(root.channel_id).toBe('C1')
    expect(root.root_id).toBeUndefined()
    expect(root.message).toContain('⏰ **Scheduled: Morning alerts** · job #1')
    expect(root.message).toContain('> Check the alerts dashboard; post anything red.\n> If it is down, tell @\u200bchannel.')
    const t = hub.store.thread(root.id)!
    expect(t).toMatchObject({ workspace: 'demo', channelId: 'C1' })
    const r = await connect(hub, tmux, t.routerKey, 1)
    expect(r.got[0]!.meta).toMatchObject({ kind: 'scheduled', job_id: '1', thread_id: root.id, chat_id: 'C1', message_id: root.id })
    expect(r.got[0]!.content).toContain('[Scheduled job #1 "Morning alerts"')
    expect(r.got[0]!.content).toContain('Not a person')
    expect(r.got[0]!.content).toContain('Check the alerts dashboard; post anything red.\nIf it is down, tell @channel.')
    expect(hub.store.runs(1, 1)[0]).toMatchObject({ status: 'started', slot, threadId: root.id })

    // The same time is never run twice (say the hub restarted before it moved on).
    hub.store.patchJob(1, { nextAt: slot })
    await hub.enqueue(() => runDueJobs(hub, slot + 3000))
    expect(posts.length).toBe(before + 1)
    expect(hub.store.job(1)!.nextAt).toBeGreaterThan(slot)

    // The next time comes while that run is still being worked on: skipped.
    const slot2 = hub.store.job(1)!.nextAt!
    await hub.enqueue(() => runDueJobs(hub, slot2 + 1000))
    expect(posts.length).toBe(before + 1)
    expect(hub.store.runs(1, 1)[0]).toMatchObject({ status: 'skipped', slot: slot2 })
    expect(hub.store.runs(1, 1)[0]!.note).toContain('the run before is still waiting or being worked on')

    // An owner stopped that router: its message waits for them, and doesn't hold up the time after.
    await hub.enqueue(() => hub.close(t.routerKey, 'manual'))
    expect(hub.store.messageState(hub.store.runs(1, 2)[1]!.inboxId!)).toBe('interrupted')
    const slot3 = hub.store.job(1)!.nextAt!
    await hub.enqueue(() => runDueJobs(hub, slot3 + 1000))
    expect(posts.length).toBe(before + 2)
    expect(posts.at(-1)!.message).not.toContain('@channel')
    const t2 = hub.store.thread(posts.at(-1)!.id)!
    expect(t2.routerKey).not.toBe(t.routerKey)
    await connect(hub, tmux, t2.routerKey, 2)

    // Removed by an owner, through the router.
    await expect(handleCall(hub, rkey, 'unschedule', { job_id: 1, message_id: 'M2' })).rejects.toThrow('only a hub owner')
    expect(await handleCall(hub, rkey, 'unschedule', { job_id: '#1', message_id: 'M1' })).toContain('removed job #1')
    expect(hub.store.jobs()).toEqual([])
    expect(posts.at(-1)!.message).toContain('🗑 @alice removed scheduled job #1 **Morning alerts**')
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
    expect(posts.length).toBe(1)
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
    expect(posts.at(-1)).toMatchObject({ root_id: 'T2', message: '⏰ **Diff** (scheduled job #1) is running.' })
    const rkey = hub.store.thread('T2')!.routerKey
    const r = await connect(hub, tmux, rkey, 1)
    expect(r.got[0]!.meta).toMatchObject({ kind: 'scheduled', job_id: '1', thread_id: 'T2' })
    expect(r.got[0]!.content).toContain('Compare with yesterday')

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
    const root = posts.find(p => p.message.startsWith('⏰ **Scheduled:'))!
    await connect(hub, tmux, hub.store.thread(root.id)!.routerKey, 1)
    expect(hub.store.runs(1, 1)[0]).toMatchObject({ kind: 'manual', status: 'started', note: 'run now by @alice' })
    expect(await say('@claude !cron show 1')).toContain('manual started')

    expect(await say('@claude !cron rm 1')).toContain('🗑 Removed scheduled job #1')
    expect(await say('@claude !cron rm 1')).toContain('⚠️ no job #1')
  }, T)
})
