#!/usr/bin/env bun
/**
 * Phase-0 spike: verify the Claude Code CLI behaviours the hub relies on, using
 * real interactive `claude` sessions on a private tmux server (`-L mmhub-spike`).
 *
 *   bun scripts/spike/run.ts [router|worker|all]
 *
 * Results are printed and kept under .spike/<ts>/ (events.jsonl).
 */
import { randomUUID } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { shepherd, waitForCalm } from '../../src/hub/shepherd'
import { Tmux } from '../../src/hub/tmux'

const which = process.argv[2] ?? 'all'
const ROOT = resolve(import.meta.dir, '../..')
const DIR = join(ROOT, '.spike', String(Date.now()))
const WS = join(DIR, 'ws')
const OUT = join(DIR, 'outside')
const WT = join(WS, '.worktrees', 'w1')
for (const d of [WS, OUT, WT, join(WS, 'knowledge')]) mkdirSync(d, { recursive: true })
writeFileSync(join(WS, 'CLAUDE.md'), '# Spike workspace\n\nThe workspace secret word is PELICAN-42.\n')
writeFileSync(join(WS, 'notes.txt'), 'notes secret: ORCHID-7\n')
writeFileSync(join(OUT, 'secret.txt'), 'outside secret: GRANITE-9\n')

const BUN = process.execPath
const CLAUDE = Bun.which('claude')
if (!CLAUDE) throw new Error('claude not on PATH')
const tmux = new Tmux('mmhub-spike')
const results: string[] = []
const note = (s: string) => {
  results.push(s)
  console.log(`  ${s}`)
}

type Ev = { at: number; src: string; key: string; ev?: string; hook_event_name?: string; tool?: string; args?: { text?: string }; [k: string]: unknown }
function events(): Ev[] {
  const f = join(DIR, 'events.jsonl')
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Ev)
}
async function waitFor<T>(fn: () => T | undefined, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v !== undefined && v !== false) return v
    await Bun.sleep(500)
  }
  return undefined
}

function files(key: string, role: 'router' | 'worker') {
  const sdir = join(DIR, 'sessions', key)
  mkdirSync(sdir, { recursive: true })
  const env = { SPIKE_DIR: DIR, MMHUB_SESSION_KEY: key, MMHUB_ROLE: role, SPIKE_PERM: 'allow' }
  const mcp = join(sdir, 'mcp.json')
  writeFileSync(mcp, JSON.stringify({ mcpServers: { mmhub: { command: BUN, args: [join(ROOT, 'scripts/spike/bridge.ts')], env } } }, null, 2))
  const hookCmd = `${BUN} ${join(ROOT, 'scripts/spike/hook.ts')}`
  const settings = join(sdir, 'settings.json')
  writeFileSync(settings, JSON.stringify({
    hooks: Object.fromEntries(['SessionStart', 'Stop', 'StopFailure', 'SessionEnd'].map(e => [e, [{ hooks: [{ type: 'command', command: hookCmd }] }]])),
  }, null, 2))
  const prompt = join(sdir, 'prompt.md')
  writeFileSync(prompt, `You are a spike ${role} session. Always answer the sender with the reply tool. Be terse.\n`)
  return { sdir, env, mcp, settings, prompt }
}

function send(key: string, content: string, meta: Record<string, string> = {}): void {
  appendFileSync(join(DIR, `inbox-${key}.jsonl`), JSON.stringify({ content, meta: { chat_id: 'spike', ...meta } }) + '\n')
}

async function launch(name: string, key: string, cwd: string, argv: string[], role: 'router' | 'worker') {
  const since = Date.now()
  const f = files(key, role)
  await tmux.newSession({
    name, cwd,
    env: { ...f.env, CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
    argv: [CLAUDE!, ...argv, '--mcp-config', f.mcp, '--strict-mcp-config', '--settings', f.settings,
      '--append-system-prompt-file', f.prompt, '--setting-sources', 'project,local',
      '--dangerously-load-development-channels', 'server:mmhub'],
  })
  const outcome = await shepherd(tmux, name, () => events().some(e => e.key === key && e.ev === 'initialized' && e.at >= since), {
    onDialog: d => note(`${name}: answered dialog ${d.name}`),
  })
  note(`${name}: startup → ${outcome}`)
  if (outcome !== 'ready') {
    console.log((await tmux.capture(name)).split('\n').slice(-25).join('\n'))
    return false
  }
  await waitForCalm(tmux, name)
  await Bun.sleep(1500)
  return true
}

async function replyAfter(key: string, since: number, ms = 240_000, pred: (t: string) => boolean = () => true) {
  return waitFor(() => events().find(e => e.key === key && e.ev === 'tool' && e.tool === 'reply' && e.at > since && pred(String(e.args?.text ?? ''))), ms)
}
function hooksSince(key: string, since: number): string[] {
  return events().filter(e => e.src === 'hook' && e.key === key && e.at >= since).map(e => `${e.hook_event_name}${e.source ? `(${e.source})` : ''}${e.session_id ? ` sid=${String(e.session_id).slice(0, 8)}` : ''}`)
}

async function exit(name: string, key: string): Promise<void> {
  const since = Date.now()
  await tmux.text(name, '/exit')
  await Bun.sleep(300)
  await tmux.keys(name, ['Enter'])
  const end = Date.now() + 30_000
  while (Date.now() < end && (await tmux.has(name))) await Bun.sleep(500)
  const stillThere = await tmux.has(name)
  note(`${name}: /exit → tmux ${stillThere ? 'STILL RUNNING' : 'gone'}; hooks since: ${hooksSince(key, since).join(', ') || 'none'}`)
  if (stillThere) await tmux.kill(name)
}

async function routerSpike(): Promise<void> {
  console.log('\n== router lockdown (sonnet, Read/Grep/Glob, dontAsk) ==')
  const key = 'r-spike'
  const id = randomUUID()
  writeFileSync(join(DIR, `token-${key}.txt`), 'TOKEN-ALPHA')
  const routerArgs = ['-n', 'spike-router', '--model', 'sonnet', '--effort', 'low', '--tools', 'Read,Grep,Glob',
    '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__mmhub']
  let since = Date.now()
  if (!(await launch('r-spike', key, WS, ['--session-id', id, ...routerArgs], 'router'))) return
  note(`hooks at start: ${hooksSince(key, since).join(', ')}`)

  since = Date.now()
  send(key, [
    'Answer with ONE reply tool call containing five numbered lines:',
    '1) the workspace secret word from CLAUDE.md;',
    '2) the SPIKE_CONTEXT_TOKEN value from your context, or "none";',
    `3) the content of notes.txt in your working directory (use Read);`,
    `4) try to Read ${join(OUT, 'secret.txt')} and give its content or the exact error;`,
    '5) which tools you have that can create or modify files (list them, or "none").',
  ].join('\n'))
  const r1 = await replyAfter(key, since)
  note(`router reply #1: ${r1 ? JSON.stringify(r1.args?.text) : 'NO REPLY (timeout)'}`)
  await waitFor(() => events().some(e => e.key === key && e.hook_event_name === 'Stop' && e.at > since) || undefined, 30_000)
  note(`hooks after turn: ${hooksSince(key, since).join(', ') || 'none'}`)

  await exit('r-spike', key)

  console.log('\n== router resume ==')
  writeFileSync(join(DIR, `token-${key}.txt`), 'TOKEN-BRAVO')
  since = Date.now()
  if (!(await launch('r-spike', key, WS, ['--resume', id, ...routerArgs], 'router'))) return
  note(`hooks at resume start: ${hooksSince(key, since).join(', ')}`)
  since = Date.now()
  send(key, 'One reply: (a) what workspace secret word did you report in your previous answer in this conversation? (b) what is the SPIKE_CONTEXT_TOKEN value in your context now (list every value you can see, newest last)?')
  const r2 = await replyAfter(key, since)
  note(`router reply #2: ${r2 ? JSON.stringify(r2.args?.text) : 'NO REPLY (timeout)'}`)
  await exit('r-spike', key)
}

async function workerSpike(): Promise<void> {
  console.log('\n== worker (cwd under .worktrees, acceptEdits, permission relay, mid-turn message) ==')
  const key = 'w-spike'
  const id = randomUUID()
  const workerArgs = ['--session-id', id, '-n', 'spike-worker', '--model', 'sonnet', '--effort', 'low',
    '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__mmhub', '--add-dir', join(WS, 'knowledge')]
  if (!(await launch('w-spike', key, WT, workerArgs, 'worker'))) return
  let since = Date.now()
  send(key, `Use the Bash tool to run exactly: touch ${join(OUT, 'touched.txt')} && sleep 8 && echo SLEPT-$((6*7))\nThen send ONE reply with the command output and the workspace secret word from CLAUDE.md. Also create the file knowledge/spike.md containing "ok" with the Write tool.`)
  const perm = await waitFor(() => events().find(e => e.key === key && e.ev === 'permission_request' && e.at > since), 90_000)
  note(`permission_request: ${perm ? `${perm.tool_name} — ${String(perm.input_preview).slice(0, 80)}` : 'none within 90s'}`)
  await Bun.sleep(4000)
  send(key, 'ALSO: include the word BANANA in your reply.')
  const r = await replyAfter(key, since, 240_000, t => t.includes('SLEPT'))
  note(`worker reply: ${r ? JSON.stringify(r.args?.text) : 'NO REPLY (timeout)'}`)
  const banana = await waitFor(() => events().find(e => e.key === key && e.ev === 'tool' && e.tool === 'reply' && e.at > since && String(e.args?.text).includes('BANANA')), 60_000)
  note(`mid-turn message honoured: ${banana ? (banana === r ? 'yes, same reply' : 'yes, separate reply') : 'NO'}`)
  note(`knowledge/spike.md written: ${existsSync(join(WS, 'knowledge', 'spike.md'))}; outside touched: ${existsSync(join(OUT, 'touched.txt'))}`)
  note(`worker hooks: ${hooksSince(key, since).join(', ')}`)
  await exit('w-spike', key)
}

try {
  if (which === 'router' || which === 'all') await routerSpike()
  if (which === 'worker' || which === 'all') await workerSpike()
} finally {
  for (const s of await tmux.list()) await tmux.kill(s)
  writeFileSync(join(DIR, 'results.txt'), results.join('\n') + '\n')
  console.log(`\nresults: ${join(DIR, 'results.txt')}`)
}
