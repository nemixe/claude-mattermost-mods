#!/usr/bin/env bun
/**
 * End-to-end run: the real hub (started with `mmhub start`), real interactive
 * `claude` sessions on a private tmux socket, and an in-memory Mattermost
 * (scripts/fake-mattermost.ts) where a scripted owner posts and answers 🔐 prompts.
 *
 *   bun scripts/e2e.ts            # E2E_WORKER_MODEL=opus to use Opus for workers (default sonnet)
 *   E2E_IDLE=1 bun scripts/e2e.ts # also wait for idle auto-close (≈3 extra minutes)
 *
 * Covers: router answers, delegation to a worker with worktrees and 🔐 prompts, the
 * worker reporting to the router (which alone posts, without process noise), the
 * read-only router, a second channel reusing the worker, stop → resume with memory,
 * hub restart adoption, a worker and a router killed mid-turn resuming their work
 * quietly, and a graceful restart that waits for the running turn.
 *
 * Everything lives in .spike/e2e-<ts>/ (gitignored). Costs a few Sonnet turns.
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import type { HubSnapshot, SessionSnapshot } from '../src/shared/snapshot'
import { startFakeMattermost, type FakePost } from './fake-mattermost'

const ROOT = resolve(import.meta.dir, '..')
const DIR = join(ROOT, '.spike', `e2e-${Date.now()}`)
const STATE = join(DIR, 'state')
const WSROOT = join(DIR, 'workspaces')
const APP = join(DIR, 'app')
const SOCKET = 'mmhub-e2e'
const BUN = process.execPath
const env: Record<string, string | undefined> = { ...process.env, MMHUB_STATE_DIR: STATE }
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k]

const OWNER = { id: 'uowner000000000000000000aa', username: 'alice' }
const BOT = { id: 'ubot00000000000000000000aa', username: 'claude', is_bot: true }
const C_A = 'chana00000000000000000000a'
const C_B = 'chanb00000000000000000000b'
const TOKEN = 'e2e-token'

const results: [boolean, string][] = []
const check = (ok: boolean, what: string) => {
  results.push([ok, what])
  console.log(`${ok ? '✓' : '✗'} ${what}`)
  return ok
}

async function sh(cmd: string[], cwd = ROOT, extraEnv: Record<string, string | undefined> = env): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd, env: extraEnv, stdout: 'pipe', stderr: 'pipe' })
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, out: (o + e).trim() }
}
const mmhub = (...a: string[]) => sh([BUN, join(ROOT, 'bin', 'mmhub'), ...a])
const tmuxLs = async () => (await sh(['tmux', '-L', SOCKET, 'list-sessions', '-F', '#{session_name}'])).out.split('\n').filter(s => s.startsWith('mm'))

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await Bun.sleep(1000)
  }
  console.log(`  … timed out waiting for ${what}`)
  return undefined
}

function snapshot(): HubSnapshot | undefined {
  try {
    return JSON.parse(readFileSync(join(STATE, 'status.json'), 'utf8')) as HubSnapshot
  } catch {
    return undefined
  }
}
const sessions = (): SessionSnapshot[] => snapshot()?.workspaces.flatMap(w => w.sessions) ?? []
const db = () => new Database(join(STATE, 'hub.db'), { readonly: true })
const sessionId = (key: string) => (db().query('SELECT session_id FROM sessions WHERE key = ?').get(key) as { session_id: string } | null)?.session_id
/** The worker that got the latest task from a thread. */
const workerFor = (threadId: string) => (db().query('SELECT worker_key FROM tasks WHERE thread_id = ? ORDER BY id DESC LIMIT 1').get(threadId) as { worker_key: string } | null)?.worker_key
/** Worker reports a router received (they go to its inbox, never to the thread). */
const reportsTo = (routerKey: string, after = 0) =>
  (db().query("SELECT content, created_at FROM inbox WHERE session_key = ? AND meta LIKE '%worker_report%' AND created_at > ? ORDER BY id").all(routerKey, after) as { content: string; created_at: number }[])

// ---------------------------------------------------------------- setup

mkdirSync(STATE, { recursive: true, mode: 0o700 })
mkdirSync(APP, { recursive: true })
await sh(['git', 'init', '-q', '-b', 'main'], APP)
await sh(['git', 'config', 'user.name', 'e2e'], APP)
await sh(['git', 'config', 'user.email', 'e2e@example.invalid'], APP)
writeFileSync(join(APP, 'README.md'), '# app\n\nA tiny test repo.\n')
await sh(['git', 'add', '.'], APP)
await sh(['git', 'commit', '-qm', 'init'], APP)

const mm = startFakeMattermost({
  token: TOKEN,
  bot: BOT,
  users: [OWNER],
  channels: [
    { id: C_A, type: 'O', name: 'alpha', display_name: 'Alpha', team_id: 't' },
    { id: C_B, type: 'O', name: 'beta', display_name: 'Beta', team_id: 't' },
  ],
})
writeFileSync(join(STATE, '.env'), `MATTERMOST_URL=${mm.url}\nMATTERMOST_BOT_TOKEN=${TOKEN}\n`, { mode: 0o600 })
writeFileSync(join(STATE, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [OWNER.id], channels: {}, pending: {} }))
writeFileSync(join(STATE, 'config.json'), JSON.stringify({
  workspacesDir: WSROOT,
  tmuxSocket: SOCKET,
  workerModel: process.env.E2E_WORKER_MODEL ?? 'sonnet',
  routerArgs: ['--effort', 'low'],
  workerArgs: ['--effort', 'low'],
}, null, 2))

check((await mmhub('ws', 'create', 'demo', 'E2E demo workspace')).code === 0, 'mmhub ws create demo')
check((await mmhub('repo', 'add', 'demo', APP, '--name', 'app')).code === 0, 'mmhub repo add demo app')
await mmhub('ws', 'bind', 'demo', C_A)
await mmhub('ws', 'bind', 'demo', C_B)

// The owner answers 🔐 prompts: first by ✅ reaction, then with "yes <code>".
const answered = new Set<string>()
let promptsSeen = 0
const answerer = setInterval(() => {
  for (const p of mm.posts()) {
    if (p.user_id !== BOT.id || !p.message.startsWith('🔐') || answered.has(p.id)) continue
    const code = /`yes ([a-km-z]{5})`/.exec(p.message)?.[1]
    if (!code) continue
    answered.add(p.id)
    promptsSeen++
    console.log(`  (owner answers prompt ${code}: ${p.message.split('\n')[0]!.slice(0, 90)})`)
    if (promptsSeen === 1) mm.react(OWNER.id, p.id, 'white_check_mark')
    else mm.post(OWNER.id, p.channel_id, `yes ${code}`, p.root_id)
  }
}, 1000)

const botPostsIn = (root: string, prefix: string, after = 0): FakePost[] =>
  mm.thread(root).filter(p => p.user_id === BOT.id && String(p.props.mmhub_session ?? '').startsWith(prefix) && p.create_at > after)

let ok = true
try {
  const started = await mmhub('start', '--json')
  if (!check(started.code === 0, `mmhub start → ${started.out}`)) throw new Error('hub did not start')

  // ---------------------------------------------------------------- A1: router answers
  const rootA = mm.post(OWNER.id, C_A, '@claude Which repos does this workspace have? Reply with only their names.')
  const a1 = await waitFor('router reply in thread A', () => botPostsIn(rootA.id, 'r-')[0], 240_000)
  check(!!a1, `router replied in thread A: ${JSON.stringify(a1?.message.slice(0, 100))}`)
  check(!!a1 && /app/i.test(a1.message), 'router named the repo "app"')
  const routerA = String(a1?.props.mmhub_session ?? '')
  const ps = (await sh(['ps', '-axo', 'args'])).out.split('\n').find(l => l.includes('--model sonnet') && l.includes('--tools Read,Grep,Glob') && l.includes('mm:r:demo'))
  check(!!ps, 'router runs with --model sonnet --tools Read,Grep,Glob')
  check((await tmuxLs()).includes(`mm${routerA}`), `tmux -L ${SOCKET} has mm${routerA}`)
  const promptFile = readFileSync(join(STATE, 'sessions', routerA, 'prompt.md'), 'utf8')
  check(promptFile.includes('Act as the project manager'), 'router runs with the project-manager persona (built-in default)')

  // ---------------------------------------------------------------- A2: delegate to a new worker; the router relays its report
  const head = async (branch: string) => (await sh(['git', 'rev-parse', '--short=7', branch], APP)).out
  let t = Date.now()
  mm.post(OWNER.id, C_A, 'Please have a worker create HELLO.md containing exactly the line "hi from worker" in the app repo, commit it on its branch, and tell me the commit hash.', rootA.id)
  const a2 = await waitFor('router relays the commit hash', async () => {
    const key = workerFor(rootA.id)
    const hash = key ? await head(`mm/${key}`) : ''
    return /^[0-9a-f]{7}$/.test(hash) && botPostsIn(rootA.id, 'r-', t).find(p => p.message.includes(hash))
  }, 600_000)
  const workerKey = workerFor(rootA.id) ?? ''
  check(!!a2, `router relayed the result: ${JSON.stringify(a2?.message.slice(0, 200))}`)
  check(reportsTo(routerA, t).length > 0, 'the worker reported to the router, not to the thread')
  check(botPostsIn(rootA.id, 'w-').length === 0, 'the worker posted nothing in the thread itself')
  const handOff = botPostsIn(rootA.id, 'r-', t).filter(p => !a2 || p.create_at < a2.create_at)
  check(handOff.length === 0, `quiet hand-off: no router post before the result (${handOff.map(p => JSON.stringify(p.message.slice(0, 80))).join(', ') || 'none'})`)
  // The branch (mm/<worker>) is where the work is, so it may be named; the worker id on its own is process noise.
  const relayed = a2?.message.replaceAll(`mm/${workerKey}`, 'mm/…') ?? ''
  check(!!a2 && !relayed.includes(workerKey) && !/\btask #?\d/i.test(relayed), 'the relayed result names no worker id (beyond its branch) or task number')
  const branchLog = (await sh(['git', 'log', `mm/${workerKey}`, '--name-only', '--format=%h'], APP)).out
  check(branchLog.includes('HELLO.md'), `branch mm/${workerKey} has a commit with HELLO.md`)
  check(!existsSync(join(APP, 'HELLO.md')) && (await sh(['git', 'status', '--porcelain'], APP)).out === '', 'original checkout untouched')
  check(promptsSeen > 0, `permission prompts relayed and answered (${promptsSeen})`)

  // ---------------------------------------------------------------- A3: router cannot write
  t = Date.now()
  mm.post(OWNER.id, C_A, 'Do NOT delegate this one. Yourself, try to create the file NOTE.txt in your working folder using any tool you have, then tell me in one line whether it worked.', rootA.id)
  const a3 = await waitFor('router answer about NOTE.txt', () => botPostsIn(rootA.id, 'r-', t)[0], 240_000)
  check(!!a3, `router answered: ${JSON.stringify(a3?.message.slice(0, 140))}`)
  check(!existsSync(join(WSROOT, 'demo', 'NOTE.txt')), 'router could not create NOTE.txt')

  // ---------------------------------------------------------------- B1: other channel reuses the worker
  t = Date.now()
  const before = sessions().filter(s => s.role === 'worker').length
  const hashA = await head(`mm/${workerKey}`)
  const rootB = mm.post(OWNER.id, C_B, `@claude Ask the existing worker ${workerKey} (use list_workers, do not create a new worker) to append the line "second" to HELLO.md on its branch, commit, and tell me the new commit hash.`)
  const b1 = await waitFor('router B relays the new hash', async () => {
    const hash = await head(`mm/${workerKey}`)
    return hash !== hashA && botPostsIn(rootB.id, 'r-', t).find(p => p.message.includes(hash))
  }, 600_000)
  check(!!b1 && workerFor(rootB.id) === workerKey, `thread B was served by the same worker ${workerKey}`)
  check(sessions().filter(s => s.role === 'worker').length === before, 'no new worker was created')

  // ---------------------------------------------------------------- L1: stop → resume with memory
  const sidBefore = sessionId(routerA)
  const stopped = JSON.parse((await mmhub('session', 'stop', routerA, '--json')).out) as { ok: boolean; message: string }
  check(stopped.ok, `mmhub session stop ${routerA} --json → ${stopped.message}`)
  check(!(await tmuxLs()).includes(`mm${routerA}`), 'router tmux session closed')
  check(sessions().find(s => s.key === routerA)?.status === 'stopped', 'status.json shows it stopped')
  t = Date.now()
  mm.post(OWNER.id, C_A, 'Quick memory check: what was the very first question I asked you in this thread? One line.', rootA.id)
  const l1 = await waitFor('resumed router reply', () => botPostsIn(rootA.id, 'r-', t)[0], 240_000)
  check(!!l1 && /repo/i.test(l1.message), `resumed router remembered: ${JSON.stringify(l1?.message.slice(0, 140))}`)
  check(sessionId(routerA) === sidBefore, 'same Claude session id after resume')
  const psResume = (await sh(['ps', '-axo', 'args'])).out.split('\n').some(l => l.includes(`--resume ${sidBefore}`))
  check(psResume, 'relaunched with --resume <id>')

  // ---------------------------------------------------------------- R1: hub restart adopts sessions
  const pinned = JSON.parse((await mmhub('session', 'pin', routerA, '--json')).out) as { ok: boolean }
  check(pinned.ok, 'pin via CLI')
  check((await mmhub('stop', '--json')).code === 0, 'mmhub stop')
  check((await tmuxLs()).includes(`mm${routerA}`), 'sessions survive a hub stop')
  check((await mmhub('start', '--json')).code === 0, 'mmhub start again')
  t = Date.now()
  mm.post(OWNER.id, C_A, 'Still there after the restart? Answer just "yes".', rootA.id)
  const r1 = await waitFor('reply after hub restart', () => botPostsIn(rootA.id, 'r-', t)[0], 180_000)
  check(!!r1, `adopted router answered after restart: ${JSON.stringify(r1?.message.slice(0, 80))}`)

  // ---------------------------------------------------------------- X1: worker killed mid-task → resumes, finishes it
  const panePid = async (key: string) => Number((await sh(['tmux', '-L', SOCKET, 'display-message', '-p', '-t', `=mm${key}:`, '#{pane_pid}'])).out) || undefined
  const screen = async (key: string) => (await sh(['tmux', '-L', SOCKET, 'capture-pane', '-p', '-t', `=mm${key}:`])).out
  const hubLog = () => readFileSync(join(STATE, 'hub.log'), 'utf8')
  const session = (key: string) => sessions().find(s => s.key === key)
  // Claude Code refuses a bare foreground `sleep N` (the model backgrounds it and ends its turn), so nap with python.
  const napCmd = (secs: number) => `python3 -c "import time; time.sleep(${secs})"`
  const runningSleep = (key: string, secs: number) => async () =>
    session(key)?.status === 'busy' && session(key)?.pendingPermissions === 0 && (await screen(key)).includes(`time.sleep(${secs})`)
  const sidW = sessionId(workerKey)
  t = Date.now()
  mm.post(OWNER.id, C_A, `!delegate ${workerKey} Run this exact shell command in the foreground (one Bash call, not in the background, nothing else first): ${napCmd(25)} — then post exactly "nap one done" in this thread.`, rootA.id)
  const napping = await waitFor('worker running the 25 s nap', runningSleep(workerKey, 25), 300_000)
  const pidX = await panePid(workerKey)
  check(!!napping && !!pidX, `worker ${workerKey} is mid-task (pid ${pidX})`)
  const typingSince = Date.now()
  await Bun.sleep(7000)
  check(mm.typing().filter(x => x.parent_id === rootA.id && x.at >= typingSince).length >= 2, 'the thread shows "typing…" (refreshed) while the worker works')
  if (pidX) process.kill(pidX, 'SIGKILL')
  const noticed = await waitFor('hub notices the crash', () => hubLog().includes(`${workerKey}: exited on its own with work in flight`), 60_000)
  check(!!noticed, 'hub noticed the killed worker had work in flight')
  const nap1 = await waitFor('"nap one done" reported after the crash', () => reportsTo(routerA, t).find(r => /nap one done/i.test(r.content)), 420_000)
  check(!!nap1, 'the resumed worker finished the interrupted task and reported it')
  check(!mm.thread(rootA.id).some(p => p.create_at > t && p.user_id === BOT.id && /♻️|⏳|stopped unexpectedly|resuming/i.test(p.message)), 'the crash was recovered quietly (no notice in the thread)')
  check(sessionId(workerKey) === sidW && (await panePid(workerKey)) !== pidX, 'same conversation, new process')

  // ---------------------------------------------------------------- X2: router killed mid-turn → answers anyway
  t = Date.now()
  mm.post(OWNER.id, C_A, 'Read README.md in the app repo with the Read tool, then reply with its first line only. Do not delegate.', rootA.id)
  await waitFor('router busy', () => session(routerA)?.status === 'busy', 60_000)
  const routerWasBusy = session(routerA)?.status === 'busy' && botPostsIn(rootA.id, 'r-', t).length === 0
  const pidR = await panePid(routerA)
  if (pidR) process.kill(pidR, 'SIGKILL')
  const x2 = await waitFor('router answer after the kill', () => botPostsIn(rootA.id, 'r-', t).find(p => /# app/.test(p.message)), 300_000)
  check(!!x2, `router answered despite being killed: ${JSON.stringify(x2?.message.slice(0, 80))}`)
  if (routerWasBusy) check(hubLog().includes(`${routerA}: exited on its own with work in flight`), 'the router\'s message was re-delivered after the crash')

  // ---------------------------------------------------------------- G1: graceful restart waits for the turn
  t = Date.now()
  mm.post(OWNER.id, C_A, `!delegate ${workerKey} Run this exact shell command in the foreground (one Bash call, not in the background, nothing else first): ${napCmd(30)} — then post exactly "nap two done" in this thread.`, rootA.id)
  const napping2 = await waitFor('worker running the 30 s nap', runningSleep(workerKey, 30), 300_000)
  const pidG = await panePid(workerKey)
  check(!!napping2, 'worker is mid-task')
  const rs = JSON.parse((await mmhub('session', 'restart', workerKey, '--json')).out) as { ok: boolean; message: string }
  check(rs.ok && /current turn ends/.test(rs.message), `mmhub session restart → ${rs.message}`)
  check(session(workerKey)?.restartPending === true, 'status.json shows the restart pending')
  await Bun.sleep(5000)
  check((await panePid(workerKey)) === pidG, 'the running turn was not interrupted')
  const nap2 = await waitFor('"nap two done" reported', () => reportsTo(routerA, t).find(r => /nap two done/i.test(r.content)), 300_000)
  check(!!nap2, 'the worker finished its task before restarting')
  const restarted = await waitFor('the restart after the turn', async () => {
    const pid = await panePid(workerKey)
    const s = session(workerKey)
    return !!pid && pid !== pidG && s?.status === 'idle' && !s.restartPending
  }, 120_000)
  check(!!restarted, 'then it restarted (new process, idle, nothing pending)')
  const restartLine = hubLog().split('\n').find(l => l.includes(`${workerKey}: restarting (pending restart`))
  check(!!restartLine && !!nap2 && Date.parse(restartLine.slice(1, 25)) >= nap2.created_at, 'the restart came after the result was reported')
  check(sessionId(workerKey) === sidW, 'same conversation after the restart')
  check((await sh(['ps', '-axo', 'args'])).out.split('\n').some(l => l.includes(`--resume ${sidW}`)), 'relaunched with --resume')

  // ---------------------------------------------------------------- P1: a new persona (ROUTER.md) reaches a live router at its restart
  writeFileSync(join(WSROOT, 'demo', 'ROUTER.md'), 'You are a pirate project manager. End every message you post with the exact word ARRR.\n')
  const rr = JSON.parse((await mmhub('session', 'restart', routerA, '--json')).out) as { ok: boolean; message: string }
  check(rr.ok, `restart the router → ${rr.message}`)
  t = Date.now()
  mm.post(OWNER.id, C_A, 'In one line: what is the name of the repo in this workspace?', rootA.id)
  const p1 = await waitFor('router reply with the new persona', () => botPostsIn(rootA.id, 'r-', t)[0], 240_000)
  check(!!p1 && /ARRR/.test(p1.message), `the resumed router follows the new ROUTER.md: ${JSON.stringify(p1?.message.slice(-80))}`)

  // ---------------------------------------------------------------- idle auto-close (optional)
  if (process.env.E2E_IDLE) {
    const wsFile = join(WSROOT, 'demo', 'workspace.json')
    const m = JSON.parse(readFileSync(wsFile, 'utf8'))
    writeFileSync(wsFile, JSON.stringify({ ...m, idleMinutes: { router: 1, worker: 1 } }, null, 2))
    const closed = await waitFor('idle close of the worker', () => sessions().find(s => s.key === workerKey && s.status === 'stopped' && s.closeReason === 'idle'), 240_000)
    check(!!closed, `worker ${workerKey} auto-closed after idling`)
    check(sessions().find(s => s.key === routerA)?.status !== 'stopped', 'pinned router stayed open')
  }

  // ---------------------------------------------------------------- the router is the only voice
  check(mm.posts().every(p => !String(p.props.mmhub_session ?? '').startsWith('w-')), 'no worker posted in any thread (everything went through the routers)')

  // ---------------------------------------------------------------- panel contract
  const snap = snapshot()
  check(!!snap && snap.schema === 1 && snap.hub.heartbeatAt > Date.now() - 15_000 && snap.mattermost.connected, 'status.json: schema 1, fresh heartbeat, Mattermost connected')
  const st = await mmhub('status')
  console.log(st.out)
} catch (err) {
  ok = false
  console.error(err)
} finally {
  clearInterval(answerer)
  await mmhub('stop')
  for (const s of await tmuxLs()) await sh(['tmux', '-L', SOCKET, 'kill-session', '-t', s])
  await sh(['tmux', '-L', SOCKET, 'kill-server'])
  mm.stop()
  const log = join(STATE, 'hub.log')
  console.log(`\nhub log: ${log}\nthread dump: ${join(DIR, 'posts.json')}`)
  writeFileSync(join(DIR, 'posts.json'), JSON.stringify(mm.posts(), null, 2))
  const failed = results.filter(([r]) => !r).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(ok && failed === 0 ? 0 : 1)
}
