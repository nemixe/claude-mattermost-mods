/**
 * `mmhub start` and `mmhub agent` with a launchd agent: the real CLI, in a HOME
 * and state dir of its own, with a launchctl that only writes down what it is
 * asked (and runs a stand-in hub when it is to start one).
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AGENT_LABEL, isCustom, readAgent, servesState } from '../src/launchd'

const ROOT = join(import.meta.dir, '..')
const CLI = join(ROOT, 'src', 'cli.ts')
const pids: number[] = []

afterEach(() => {
  for (const pid of pids.splice(0)) try { process.kill(pid, 'SIGKILL') } catch {}
})

/** Holds the lock, answers on the socket (shutdown too) and logs that it is ready. */
const FAKE_HUB = `
import { writeFileSync, appendFileSync, rmSync } from 'fs'
const dir = process.argv[2]
writeFileSync(dir + '/hub.lock', String(process.pid))
Bun.listen({ unix: dir + '/hub.sock', socket: { data(s, d) {
  for (const line of d.toString().split('\\n').filter(Boolean)) {
    const m = JSON.parse(line)
    s.write(JSON.stringify({ t: 'result', id: m.id, ok: true, text: 'ok' }) + '\\n')
    if (m.op === 'shutdown') setTimeout(() => { rmSync(dir + '/hub.lock'); rmSync(dir + '/hub.sock', { force: true }); process.exit(0) }, 50)
  }
} } })
appendFileSync(process.argv[3], '[now] mmhub hub: ready\\n')
`

function setup(o: { loaded?: boolean; fail?: string } = {}) {
  // Short: a unix socket's path has room for about 100 characters.
  const dir = mkdtempSync(join('/tmp', 'mmhub-la-'))
  const state = join(dir, 'state')
  const bin = join(dir, 'bin')
  const agents = join(dir, 'Library', 'LaunchAgents')
  for (const d of [state, bin, agents]) mkdirSync(d, { recursive: true })
  writeFileSync(join(state, '.env'), 'MATTERMOST_URL=http://127.0.0.1:1\nMATTERMOST_BOT_TOKEN=test\n')
  writeFileSync(join(dir, 'fakehub.ts'), FAKE_HUB)
  if (o.loaded) writeFileSync(join(dir, 'loaded'), '')
  const calls = join(dir, 'calls')
  const log = join(dir, 'agent.log')
  const run = `${process.execPath} ${join(dir, 'fakehub.ts')} ${state} ${log} >/dev/null 2>&1 &`
  writeFileSync(join(bin, 'launchctl'), `#!/bin/sh
echo "$*" >> ${calls}
case "$1" in
  print) test -f ${dir}/loaded ;;
  ${o.fail ? `${o.fail}) echo "Bootstrap failed: 5: Input/output error" >&2; exit 5 ;;` : ''}
  bootstrap) touch ${dir}/loaded; ${run} ;;
  kickstart) ${run} ;;
  bootout) rm -f ${dir}/loaded ;;
esac
`)
  chmodSync(join(bin, 'launchctl'), 0o755)
  const plist = join(agents, `${AGENT_LABEL}.plist`)
  const install = (args: string[], env: Record<string, string> = { MMHUB_STATE_DIR: state }, extra = '') => writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key><array>${args.map(a => `<string>${a}</string>`).join('')}</array>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${log}</string>
${extra}</dict></plist>
`)
  const cli = async (...argv: string[]) => {
    const pr = Bun.spawn([process.execPath, CLI, ...argv], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, MMHUB_STATE_DIR: state }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    })
    const [so, se, code] = await Promise.all([new Response(pr.stdout).text(), new Response(pr.stderr).text(), pr.exited])
    const lock = join(state, 'hub.lock')
    if (existsSync(lock)) pids.push(Number(readFileSync(lock, 'utf8')))
    return { code, out: (so + se).trim() }
  }
  return {
    dir, state, plist, install, cli,
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(l => l.replace(/gui\/\d+/, 'gui/UID')) : []),
  }
}

const PLAIN = ['/bun', '/Users/me/claude-mattermost-mods/src/hub/main.ts']
const OWN = ['/bun', '/Users/me/mmhub-launch.ts']
const TARGET = `gui/UID/${AGENT_LABEL}`

describe.skipIf(process.platform !== 'darwin')('mmhub start with a launchd agent', () => {
  test('starts through launchd, with a launcher of the user\'s own too', async () => {
    const s = setup({ loaded: true })
    s.install(OWN)
    const r = await s.cli('start')
    expect(r.out).toMatch(/^hub started by launchd \(pid \d+\)$/)
    expect(r.code).toBe(0)
    expect(s.calls()).toEqual([`print ${TARGET}`, `kickstart ${TARGET}`])
    // Nothing was started from the shell.
    expect(existsSync(join(s.state, 'hub.log'))).toBe(false)

    expect((await s.cli('start')).out).toContain('already running')
    expect(s.calls().length).toBe(2)
    expect((await s.cli('stop')).out).toContain('hub stopped')
    expect((await s.cli('start')).out).toContain('hub started by launchd')
  }, 30_000)

  test('loads an agent that isn\'t loaded, which starts it', async () => {
    const s = setup()
    s.install(PLAIN)
    expect((await s.cli('start')).out).toContain('hub started by launchd')
    expect(s.calls()).toEqual([`print ${TARGET}`, `bootstrap gui/UID ${s.plist}`])
  }, 30_000)

  test('says what launchctl said when it fails, and starts nothing else', async () => {
    const s = setup({ fail: 'bootstrap' })
    s.install(PLAIN)
    const r = await s.cli('start')
    expect(r.code).toBe(1)
    expect(r.out).toContain('launchd did not start the hub: launchctl bootstrap failed: Bootstrap failed: 5')
    expect(r.out).toContain('mmhub start --no-agent')
    expect(existsSync(join(s.state, 'hub.lock'))).toBe(false)
    expect(existsSync(join(s.state, 'hub.log'))).toBe(false)
  }, 30_000)

  test('another hub\'s agent, no agent, or --no-agent: from the shell, launchctl untouched', async () => {
    const s = setup({ loaded: true })
    // No tmux on this PATH, so the real hub stops at once: that it was started is what counts.
    const viaShell = async (...argv: string[]) => {
      const r = await s.cli('start', ...argv)
      expect(r.out).toContain('hub exited')
      expect(s.calls()).toEqual([])
    }
    await viaShell()
    s.install(PLAIN, { MMHUB_STATE_DIR: join(s.dir, 'elsewhere') })
    await viaShell()
    s.install(PLAIN, {}) // the default state dir
    await viaShell()
    s.install(PLAIN)
    await viaShell('--no-agent')
  }, 60_000)

  test('a plist that can\'t be read is said, not passed over', async () => {
    const s = setup()
    writeFileSync(s.plist, 'not a plist')
    const r = await s.cli('start')
    expect(r.code).toBe(1)
    expect(r.out).toContain("can't read the hub's launchd agent")
    expect(existsSync(join(s.state, 'hub.lock'))).toBe(false)
  }, 30_000)
})

describe.skipIf(process.platform !== 'darwin')('mmhub agent install', () => {
  test('keeps an agent that runs a launcher of the user\'s own, unless forced', async () => {
    const s = setup({ loaded: true })
    s.install(OWN)
    const before = readFileSync(s.plist, 'utf8')
    const r = await s.cli('agent', 'install')
    expect(r.code).toBe(1)
    expect(r.out).toContain('/Users/me/mmhub-launch.ts')
    expect(readFileSync(s.plist, 'utf8')).toBe(before)
    expect(s.calls()).toEqual([])

    const forced = await s.cli('agent', 'install', '--force')
    expect(forced.out).toContain(`${s.plist}.old`)
    expect(forced.code).toBe(0)
    expect(readFileSync(`${s.plist}.old`, 'utf8')).toBe(before)
    expect((await readAgent(s.plist))!.args[1]).toBe(join(ROOT, 'src', 'hub', 'main.ts'))
  }, 30_000)

  test('a plain one is written anew and loaded again', async () => {
    const s = setup({ loaded: true })
    s.install(PLAIN)
    const r = await s.cli('agent', 'install')
    expect(r.out).toContain('agent installed')
    expect(s.calls()).toEqual([`bootout ${TARGET}`, `print ${TARGET}`, `print ${TARGET}`, `bootstrap gui/UID ${s.plist}`])
    const a = (await readAgent(s.plist))!
    expect(isCustom(a)).toBe(false)
    expect(servesState(a, s.state)).toBe(true)
    expect(a.log).toBe(join(s.state, 'hub.log'))
    expect(existsSync(`${s.plist}.old`)).toBe(false)
  }, 30_000)
})

describe('which agent is whose', () => {
  const agent = (o: Partial<Parameters<typeof isCustom>[0]>) => ({ file: '/x', args: PLAIN, env: {}, runAtLoad: true, ...o })
  test('custom launchers', () => {
    expect(isCustom(agent({}))).toBe(false)
    expect(isCustom(agent({ args: OWN }))).toBe(true)
    expect(isCustom(agent({ args: ['/bin/sh', '-c', 'bun /x/src/hub/main.ts'] }))).toBe(true)
    expect(isCustom(agent({ args: [] }))).toBe(true)
  })
  test('state dirs: named in the environment, else the working directory or the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmhub-la-'))
    expect(servesState(agent({ env: { MMHUB_STATE_DIR: dir } }), dir)).toBe(true)
    expect(servesState(agent({ env: { MMHUB_STATE_DIR: '/elsewhere' }, cwd: dir }), dir)).toBe(false)
    expect(servesState(agent({ env: { CLAUDE_CONFIG_DIR: dir } }), join(dir, 'channels', 'mattermost-hub'))).toBe(true)
    expect(servesState(agent({ cwd: dir }), dir)).toBe(true)
    expect(servesState(agent({}), dir)).toBe(false)
  })
})
