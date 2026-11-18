#!/usr/bin/env bun
/**
 * mmhub — control the Mattermost hub.
 *
 *   mmhub start [--json]            start the daemon (detached; logs to hub.log); restarts one whose heartbeat stopped
 *   mmhub stop [--json]             stop it (sessions keep running; adopted at next start)
 *   mmhub status [--json]           hub, workspaces and sessions
 *   mmhub logs [-n N] [-f]          hub log
 *   mmhub doctor                    check the setup
 *   mmhub session <stop|wake|pin|unpin> <key> [--json]
 *   mmhub session restart <key|all|workers|routers> [--now] [--json]
 *                                   restart with current settings, keeping the conversation:
 *                                   after the current turn ends (default), or right away (--now)
 *   mmhub ws list | create <name> [description] | bind <ws> <channel-id> | unbind <channel-id> | show <name>
 *   mmhub ws template               path of <workspacesDir>/workspace-template (created if missing)
 *   mmhub ws trigger <ws> [mention|mention-only|laya|openrouter|inherit]
 *                                   which replies in the bot's threads reach it: all (mention), only those that
 *                                   @mention it (mention-only), or in threads it follows, those a judge (Laya, or a
 *                                   model through OpenRouter) finds meant for it (TRIGGER.md rules)
 *   mmhub repo add <ws> <path|git-url> [--name <n>] | rm <ws> <name>
 *   mmhub lookup user <username> | lookup channel <team> <channel>   Mattermost ids
 *   mmhub agent install|uninstall   (macOS) start the hub at login via launchd
 *   mmhub laya install [--port N] [--device cpu|mps|cuda] [--english-only] [--unload-after MIN]
 *                                   Laya without Ollama: install Laya's own server (laya-serve, Python via
 *                                   uv) and its English and multilingual models in the state dir; the hub
 *                                   then keeps it running while a workspace uses Laya (the models are
 *                                   freed after 5 idle minutes, or MIN; 0 keeps them loaded)
 *   mmhub laya status | restart | logs [-n N] | use ollama|serve | uninstall
 *   mmhub openrouter [status] | key | model <id>
 *                                   the OpenRouter judge: key (read from stdin into .env), model (any OpenRouter id)
 *   mmhub reload                    re-read config.json (sessions move if their provider changed)
 *
 * Scheduled jobs (at set times the hub hands an instruction to a router of the workspace):
 *   mmhub cron list [<ws>] | show <id>              jobs, their next and last runs (show: run history)
 *   mmhub cron add <ws> "<schedule>" <instruction…|-> [--name N] [--tz ZONE] [--channel ID | --thread ID] [--grace MIN]
 *                                   schedule: "every day 09:00", "every weekday 8:30", "every mon,thu 17:00",
 *                                   "every month on the 1st 09:00", "every 2h", "every 30m", or cron "0 9 * * 1-5"
 *                                   (at least 15 minutes apart; ZONE defaults to this machine's). Each run opens a
 *                                   new thread in the workspace's channel (--channel: which one), or goes to one
 *                                   hub thread's router (--thread). "-" reads the instruction from stdin. A run
 *                                   found due more than MIN (30) minutes late is skipped
 *   mmhub cron rm|pause|resume|run <id>             run: once now, besides its schedule
 *   mmhub cron next "<schedule>" [--tz ZONE] [-n N] the times it would run (no hub needed)
 *
 * Providers (the login or API each workspace's sessions run on, in fallback order):
 *   mmhub provider list                          providers, their state, each workspace's chain and active one
 *   mmhub provider add <name> <kind> [--env K=V]… [--config-dir D] [--router-model M] [--worker-model M] [--channels]
 *                                   kinds: login | oauth-token | api-key | gateway | bedrock | vertex | foundry
 *   mmhub provider login <name>                  the command you run yourself to sign a login provider in
 *   mmhub provider secret <name> <VAR> [--unset] store a secret, read from stdin (hidden at a terminal)
 *   mmhub provider check <name>                  validate it and ask `claude auth status` with its settings
 *   mmhub provider use <workspace|--hub> <name>… | <workspace> --inherit
 *                                                set the fallback chain ("default" = the hub's own login)
 *   mmhub provider reset <name>                  forget its failures, so it is tried again now
 *   mmhub provider rm <name> [--purge]           remove it (--purge: its login config dir too)
 *
 * With --json, prints one line {"ok":boolean,"message":string} (the panel mod reads it).
 */

import { spawn as nodeSpawn } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { roundTrip, type HubMsg } from './shared/ipc'
import { DEFAULT_LAYA, DEFAULT_TRIGGER_MD, layaReady, loadTrigger, triggerFile, type LayaCall, type LayaConfig, type ServeConfig } from './hub/laya'
import { DEFAULT_SERVE_PORT, DEFAULT_UNLOAD_MINUTES, installed, installedVersion, LAYA_PACKAGE, LAYA_PYTHON, SERVE_MODELS, SERVE_SESSION, serveEnv, serveKey, servePaths, startServe, warmUp } from './hub/layaserve'
import { fmtLocal, hubTimezone, minGapMinutes, nextRun, parseSchedule, validTimezone } from './hub/cron'
import { MIN_GAP_MINUTES } from './hub/jobs'
import { cleanEnv, Tmux } from './hub/tmux'
import { paths, ROOT } from './shared/paths'
import { SESSION_KEY_RE, type HubSnapshot, type SessionSnapshot } from './shared/snapshot'
import { errMsg, fmtAge, isPidAlive, readEnvFile, readJson, setEnvVar, writeJsonAtomic } from './shared/util'
import { Database } from 'bun:sqlite'
import { isTrigger, judged, loadConfig } from './hub/config'
import { apiOf, modelReady, OPENROUTER_KEY, openRouterReady, type OpenRouterCall, type OpenRouterConfig } from './hub/openrouter'
import { routerPersona } from './hub/prompts'
import {
  buildLaunch, chooseProvider, configDirOf, cooling, DEFAULT_PROVIDER, deleteSecret, ensureConfigDir, HUB_LIST, isKind, KINDS, loadProviders,
  loginCommand, loginState, PROVIDER_KINDS, providerChain, removeProviderFiles, saveProviders, secretNames, unusableReason, validateDef, writeSecret,
  type Health, type ProviderDef,
} from './hub/providers'
import { PROVIDER_UNSET } from './hub/spawn'
import { addRepo, bindChannel, channelsOf, effective, setWorkspaceTrigger, createWorkspace, ensureTemplate, listWorkspaces, loadBindings, loadWorkspace, removeRepo, setWorkspaceProviders, TEMPLATE_DIR, unbindChannel, validName } from './hub/workspaces'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const restartNowFlag = argv.includes('--now')
const args = argv.filter(a => a !== '--json' && a !== '--now')
const p = paths()

function out(ok: boolean, message: string): never {
  if (json) process.stdout.write(JSON.stringify({ ok, message }) + '\n')
  else (ok ? process.stdout : process.stderr).write(message + '\n')
  process.exit(ok ? 0 : 1)
}

async function controlOp(op: string, a: Record<string, unknown> = {}, timeoutMs = 45_000): Promise<Extract<HubMsg, { t: 'result' }>> {
  const r = await roundTrip(p.sock, { t: 'control', id: 1, op, args: a }, timeoutMs)
  if (r.t !== 'result') throw new Error('unexpected answer from the hub')
  return r
}

async function hubRunning(): Promise<boolean> {
  if (!existsSync(p.sock)) return false
  try {
    return (await controlOp('ping', {}, 3000)).ok
  } catch {
    return false
  }
}

function lockPid(): number | undefined {
  try {
    const pid = parseInt(readFileSync(p.lock, 'utf8'), 10)
    return isPidAlive(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

function tail(file: string, n: number): string {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n).join('\n')
  } catch {
    return ''
  }
}

// ------------------------------------------------------------------ commands

/** The panel counts a hub as down past this heartbeat age (hooks/panel.tsx STALE_MS). */
const HEARTBEAT_STALE_MS = 15_000

/** How old status.json's heartbeat is (undefined: no status.json). */
function heartbeatAge(): number | undefined {
  const at = readJson<HubSnapshot | undefined>(p.status, () => undefined)?.hub?.heartbeatAt
  return typeof at === 'number' && at > 0 ? Date.now() - at : undefined
}

/** Ask the hub to stop; past 8 s, SIGTERM, then SIGKILL. Returns whether it is gone. */
async function stopHub(): Promise<boolean> {
  const gone = async (ms: number) => {
    const end = Date.now() + ms
    while (Date.now() < end && lockPid()) await Bun.sleep(200)
    return !lockPid()
  }
  try {
    await controlOp('shutdown', {}, 5000)
  } catch {}
  if (await gone(8000)) return true
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    const pid = lockPid()
    if (!pid) return true
    try { process.kill(pid, sig) } catch {}
    if (await gone(3000)) return true
  }
  return false
}

async function start(): Promise<never> {
  let restarted = ''
  const running = await hubRunning()
  if (running) {
    const age = heartbeatAge()
    if (age === undefined || age <= HEARTBEAT_STALE_MS) out(true, `hub already running (pid ${lockPid() ?? '?'})`)
    restarted = `its heartbeat had stopped ${fmtAge(age)} ago`
  }
  const env = readEnvFile(p.env)
  if (!env.MATTERMOST_URL || !env.MATTERMOST_BOT_TOKEN) {
    out(false, `${restarted ? `hub runs but ${restarted}; not restarting it: ` : ''}not configured: ${p.env} needs MATTERMOST_URL and MATTERMOST_BOT_TOKEN — run /mattermost-hub:configure`)
  }
  if (running) {
    // It answers, but its heartbeat stopped (seen after the machine slept): the panel shows it down. Restart it;
    // sessions keep running in tmux and the new hub adopts them.
    const pid = lockPid()
    if (!(await stopHub())) out(false, `hub pid ${pid ?? '?'} runs but ${restarted}, and it did not stop — kill it and run mmhub start`)
  }
  mkdirSync(p.dir, { recursive: true, mode: 0o700 })
  const logSize = existsSync(p.log) ? statSync(p.log).size : 0
  const fd = openSync(p.log, 'a', 0o600)
  const child = nodeSpawn(process.execPath, [join(ROOT, 'src', 'hub', 'main.ts')], {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: p.dir,
    env: process.env,
  })
  let exited: number | null = null
  child.on('exit', code => { exited = code ?? 0 })
  child.unref()
  const end = Date.now() + 20_000
  while (Date.now() < end) {
    await Bun.sleep(400)
    if (exited !== null) break
    if (await hubRunning()) {
      // Wait for "ready" (Mattermost connected) or a failure in the log.
      const logNow = readFileSync(p.log, 'utf8').slice(logSize)
      if (/mmhub hub: ready/.test(logNow)) out(true, restarted ? `hub restarted (pid ${child.pid}): ${restarted}` : `hub started (pid ${child.pid})`)
    }
  }
  const fresh = readFileSync(p.log, 'utf8').slice(logSize).trim().split('\n').slice(-3).join(' | ')
  if (exited !== null) out(false, `hub exited: ${fresh || `code ${exited}`}`)
  if (await hubRunning()) out(true, `hub ${restarted ? 'restarted' : 'started'} (pid ${child.pid}), still connecting to Mattermost${restarted ? `: ${restarted}` : ''}`)
  out(false, `hub did not come up in 20s: ${fresh}`)
}

async function stop(): Promise<never> {
  if (await hubRunning()) {
    if (await stopHub()) out(true, 'hub stopped (tmux sessions keep running)')
    out(false, `hub pid ${lockPid() ?? '?'} did not stop`)
  }
  const pid = lockPid()
  if (pid) {
    process.kill(pid, 'SIGTERM')
    out(true, `sent SIGTERM to hub pid ${pid}`)
  }
  out(true, 'hub is not running')
}

/** "acme-key (fallback) · chain acme-login ✗ auth, back in 42m → acme-key → default" */
function providerSummary(p: NonNullable<HubSnapshot['workspaces'][number]['provider']>, now: number): string {
  const chain = p.chain.map(c => {
    const why = c.unusable ? ` ✗ ${c.unusable}` : c.coolingUntil ? ` ⏸ ${c.reason ?? 'resting'}, back in ${fmtAge(c.coolingUntil - now)}` : ''
    return `${c.name === p.active ? '●' : ''}${c.name}${why}`
  }).join(' → ')
  const state = !p.healthy ? ' (every provider failed: waiting)' : p.fallback ? ' (fallback)' : ''
  return `${p.active}${state}${p.chain.length > 1 ? ` · chain ${chain}` : ''}`
}

function sessionRow(s: SessionSnapshot, now: number): string {
  const icon = s.role === 'router' ? '🧭' : '🛠'
  let state: string = s.status
  if (s.status === 'idle') state = `idle ${fmtAge(now - s.lastActiveAt)}${s.closesAt ? ` · closes in ${fmtAge(s.closesAt - now)}` : ''}`
  if (s.status === 'stopped' && s.closedAt) state = `stopped ${fmtAge(now - s.closedAt)} ago${s.closeReason ? ` (${s.closeReason})` : ''}`
  const flags = [
    s.pinned ? '📌' : '', s.attached ? '👁' : '', s.pendingPermissions ? `🔐${s.pendingPermissions}` : '', s.queuedTasks ? `${s.queuedTasks} queued` : '',
    s.restartPending ? '↻ restart pending' : '', s.retryAt ? `⏳ retry in ${fmtAge(s.retryAt - now)}` : '',
  ].filter(Boolean).join(' ')
  return `  ${icon} ${s.key.padEnd(11)} ${state.padEnd(30)} ${s.model.padEnd(7)} ${s.label}${flags ? `  ${flags}` : ''}`
}

async function status(): Promise<never> {
  let snap: HubSnapshot | undefined
  let up = false
  try {
    const r = await controlOp('status', {}, 5000)
    snap = r.data as HubSnapshot
    up = true
  } catch {
    snap = readJson<HubSnapshot | undefined>(p.status, () => undefined)
  }
  if (json) out(up, up ? `hub running (pid ${snap?.hub.pid}), ${snap?.caps.liveRouters ?? 0} routers, ${snap?.caps.liveWorkers ?? 0} workers live` : 'hub is not running')
  const now = Date.now()
  const lines: string[] = []
  if (!snap) out(false, 'hub is not running and has never written status.json')
  lines.push(`hub ${up ? `● running pid ${snap.hub.pid} v${snap.hub.version}, up ${fmtAge(now - snap.hub.startedAt)}` : '○ down (last snapshot below)'}`)
  const age = heartbeatAge()
  if (up && age !== undefined && age > HEARTBEAT_STALE_MS) {
    lines.push(`  ⚠ but status.json's heartbeat stopped ${fmtAge(age)} ago (the panel shows the hub down): run mmhub start to restart it`)
  }
  lines.push(`mattermost ${snap.mattermost.connected ? '●' : '○'} ${snap.mattermost.url}${snap.mattermost.bot ? ` as @${snap.mattermost.bot}` : ''}`)
  lines.push(`live: routers ${snap.caps.liveRouters}/${snap.caps.maxLiveRouters}, workers ${snap.caps.liveWorkers}/${snap.caps.maxLiveWorkers}`)
  for (const w of snap.workspaces) {
    lines.push('', `workspace ${w.name} — ${w.path}`)
    lines.push(`  channels: ${w.channels.map(c => c.name).join(', ') || 'none'} · repos: ${w.repos.map(r => r.name).join(', ') || 'none'}`)
    if (w.provider) lines.push(`  provider: ${providerSummary(w.provider, now)}`)
    for (const s of w.sessions) lines.push(sessionRow(s, now) + (s.provider && w.provider && s.provider !== w.provider.active ? `  (on ${s.provider})` : ''))
  }
  lines.push('', `attach: tmux -L ${loadConfig(p.config).tmuxSocket} attach -t <mmr-…|mmw-…>`)
  console.log(lines.join('\n'))
  process.exit(up ? 0 : 1)
}

async function logs(): Promise<never> {
  const nIdx = args.indexOf('-n')
  const n = nIdx >= 0 ? parseInt(args[nIdx + 1] ?? '100', 10) : 100
  if (args.includes('-f')) {
    const t = nodeSpawn('tail', ['-n', String(n), '-f', p.log], { stdio: 'inherit' })
    await new Promise(r => t.on('exit', r))
    process.exit(0)
  }
  console.log(tail(p.log, n) || `(no log yet at ${p.log})`)
  process.exit(0)
}

async function run(cmd: string[]): Promise<string> {
  try {
    const pr = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const [o, e] = await Promise.all([new Response(pr.stdout).text(), new Response(pr.stderr).text(), pr.exited])
    return (o + e).trim().split('\n')[0] ?? ''
  } catch (err) {
    return `error: ${errMsg(err)}`
  }
}

async function doctor(): Promise<never> {
  const cfg = loadConfig(p.config)
  const PATH = cfg.path ?? process.env.PATH ?? ''
  const rows: [boolean, string][] = []
  const check = (ok: boolean, msg: string) => rows.push([ok, msg])
  check(true, `bun ${Bun.version} (${process.execPath})`)
  const claude = cfg.claudeBin ?? Bun.which('claude', { PATH })
  check(!!claude, claude ? `claude ${await run([claude, '--version'])} (${claude})` : 'claude not found on PATH (set claudeBin in config.json)')
  const tmux = Bun.which('tmux', { PATH })
  check(!!tmux, tmux ? `${await run([tmux, '-V'])} (${tmux})` : 'tmux not found on PATH')
  const git = cfg.gitBin ?? Bun.which('git', { PATH })
  check(!!git, git ? `${await run([git, '--version'])}` : 'git not found (worktrees need it)')
  check(existsSync(p.dir), `state dir ${p.dir}`)
  const env = readEnvFile(p.env)
  check(!!env.MATTERMOST_URL, `MATTERMOST_URL ${env.MATTERMOST_URL ?? 'missing'}`)
  check(!!env.MATTERMOST_BOT_TOKEN, `MATTERMOST_BOT_TOKEN ${env.MATTERMOST_BOT_TOKEN ? 'set' : 'missing'}`)
  if (env.MATTERMOST_URL && env.MATTERMOST_BOT_TOKEN) {
    try {
      const res = await fetch(`${env.MATTERMOST_URL.replace(/\/+$/, '')}/api/v4/users/me`, { headers: { Authorization: `Bearer ${env.MATTERMOST_BOT_TOKEN}` } })
      const me = (await res.json()) as { username?: string; message?: string }
      check(res.ok, res.ok ? `bot account @${me.username}` : `Mattermost refused the token: HTTP ${res.status} ${me.message ?? ''}`)
    } catch (err) {
      check(false, `Mattermost unreachable: ${errMsg(err)}`)
    }
  }
  const access = readJson<{ allowFrom?: string[]; dmPolicy?: string }>(p.access, () => ({}))
  const owners = access.allowFrom ?? []
  check(owners.length > 0, `owners in access.json: ${owners.includes('*') ? 'everyone ("*")' : owners.length} (dmPolicy ${access.dmPolicy ?? 'pairing'})`)
  check(existsSync(cfg.workspacesDir), `workspaces dir ${cfg.workspacesDir}`)
  try {
    check(true, `workspace template ${ensureTemplate(cfg)} (copied into new workspaces)`)
  } catch (err) {
    check(false, `workspace template: ${errMsg(err)}`)
  }
  const bindings = loadBindings(p.bindings)
  for (const [ch, ws] of Object.entries(bindings)) check(!!loadWorkspace(cfg, ws), `channel ${ch} → workspace ${ws}`)
  if (!Object.keys(bindings).length) check(true, 'no channels bound yet (mention the bot in a channel, or `mmhub ws bind`)')
  check(true, `models: router ${cfg.routerModel}, worker ${cfg.workerModel}; idle close: router ${cfg.idleMinutes.router}m, worker ${cfg.idleMinutes.worker}m; worker cleanup ${cfg.cleanupHours ? `after ${cfg.cleanupHours}h without work` : 'off'}`)
  const defs = loadProviders(p.dir)
  for (const [name, def] of Object.entries(defs)) {
    const errs = validateDef(name, def)
    const why = errs.length ? errs.join('; ') : unusableReason(p.dir, name, def)
    check(!why, `provider ${name} (${def.kind})${why ? `: ${why}${why === 'not signed in' ? ` — mmhub provider login ${name}` : ''}` : ': ready'}`)
  }
  for (const w of listWorkspaces(cfg)) {
    const chain = providerChain(cfg.providers, w.providers)
    const missing = chain.filter(n => n !== DEFAULT_PROVIDER && !defs[n])
    if (missing.length || chain.length > 1 || chain[0] !== DEFAULT_PROVIDER) {
      check(!missing.length, `workspace ${w.name} providers: ${chain.join(' → ')}${missing.length ? ` (not defined: ${missing.join(', ')})` : ''}`)
    }
  }
  const byLaya = listWorkspaces(cfg).filter(w => effective(cfg, w).trigger === 'laya').map(w => w.name)
  if (byLaya.length) {
    const why = await layaReady(layaOf(cfg.laya))
    const where = cfg.laya.serve ? `laya-serve at ${cfg.laya.url}, model ${cfg.laya.model}` : `${cfg.laya.model} at ${cfg.laya.url}`
    const fix = cfg.laya.serve && why ? (installed(servePaths(p)) ? ' (mmhub laya status; mmhub laya logs)' : ' (not installed: mmhub laya install)') : ''
    check(!why, `Laya (${where}) for ${byLaya.join(', ')}: ${why ?? 'ready'}${fix}`)
  }
  const byOpenRouter = listWorkspaces(cfg).filter(w => effective(cfg, w).trigger === 'openrouter').map(w => w.name)
  if (byOpenRouter.length) {
    const why = await openRouterReady(openRouterOf(cfg))
    check(!why, `OpenRouter (${cfg.openrouter.model}) for ${byOpenRouter.join(', ')}: ${why ?? 'ready'}`)
  }
  const up = await hubRunning()
  check(true, `hub ${up ? `running (pid ${lockPid() ?? '?'})` : 'not running — mmhub start'}`)
  for (const [ok, msg] of rows) console.log(`${ok ? '✓' : '✗'} ${msg}`)
  process.exit(rows.every(([ok]) => ok) ? 0 : 1)
}

async function session(): Promise<never> {
  const [, op, key] = args
  const usage = 'usage: mmhub session <stop|wake|pin|unpin> <key> | mmhub session restart <key|all|workers|routers> [--now]'
  if (!op || !['stop', 'wake', 'restart', 'pin', 'unpin'].includes(op)) out(false, usage)
  const group = op === 'restart' && (key === 'all' || key === 'workers' || key === 'routers')
  if (!key || (!group && !SESSION_KEY_RE.test(key))) out(false, `malformed session key: ${String(key).slice(0, 40)}`)
  if (!(await hubRunning())) out(false, 'hub is not running — start it first')
  const r = await controlOp('session', { op, key, now: restartNowFlag }, group ? 300_000 : 90_000)
  out(r.ok, r.text ?? r.error ?? (r.ok ? 'ok' : 'failed'))
}

async function ws(): Promise<never> {
  const cfg = loadConfig(p.config)
  const [, sub, a1, ...rest] = args
  const tpl = ensureTemplate(cfg)
  switch (sub) {
    case 'template':
      out(true, tpl)
    case 'list':
    case undefined: {
      const bindings = loadBindings(p.bindings)
      const all = listWorkspaces(cfg)
      if (json) out(true, all.map(w => w.name).join(', ') || 'no workspaces')
      if (!all.length) out(true, `no workspaces in ${cfg.workspacesDir} — mmhub ws create <name> (copied from ${tpl})`)
      for (const w of all) {
        const ch = Object.entries(bindings).filter(([, n]) => n === w.name).map(([c]) => c)
        console.log(`${w.name}  ${w.dir}\n  repos: ${w.repos.map(r => `${r.name}=${r.path}`).join(', ') || 'none'}\n  channels: ${ch.join(', ') || 'none'}`)
      }
      process.exit(0)
    }
    case 'create': {
      if (!a1 || !validName(a1)) out(false, `usage: mmhub ws create <name> [description]  (letters, digits, . _ -; not "${TEMPLATE_DIR}")`)
      const w = createWorkspace(cfg, a1, rest.join(' ') || undefined)
      out(true, `workspace ${w.name} at ${w.dir} (from ${tpl})`)
    }
    case 'show': {
      const w = a1 ? loadWorkspace(cfg, a1) : undefined
      if (!w) out(false, `no workspace ${a1}`)
      console.log(JSON.stringify(w, null, 2))
      console.log(`\nproviders${w.providers ? '' : ' (the hub-wide list)'}: ${providerChain(cfg.providers, w.providers).join(' → ')}`)
      const askers = !w.acceptFrom || w.acceptFrom.includes('*') ? 'every workspace' : w.acceptFrom.length ? w.acceptFrom.join(', ') : 'none'
      const where = channelsOf(loadBindings(p.bindings), w.name)
      console.log(`takes requests from: ${askers}${where.length ? '' : ' (no channel bound, so none can reach it)'}`)
      const trig = loadTrigger(w.dir)
      const tr = effective(cfg, w).trigger
      console.log(`trigger${w.trigger ? '' : ' (config.json)'}: ${tr}${tr === 'openrouter' ? ` (${cfg.openrouter.model})` : ''}${judged(tr) ? ` — rules: ${trig.own ? triggerFile(w.dir) : 'built-in (no TRIGGER.md)'}` : ''}`)
      const persona = routerPersona(cfg, w)
      console.log(`\nrouter persona (${persona.source}):\n${persona.text}`)
      process.exit(0)
    }
    case 'trigger': {
      const w = a1 ? loadWorkspace(cfg, a1) : undefined
      const usage = 'usage: mmhub ws trigger <workspace> [mention|mention-only|laya|openrouter|inherit]'
      if (!w) out(false, a1 ? `no workspace ${a1}` : usage)
      const [want] = rest
      if (want === undefined) {
        const t = effective(cfg, w).trigger
        out(true, `workspace ${w.name}: ${t}${t === 'openrouter' ? ` (${cfg.openrouter.model})` : ''}${w.trigger ? '' : ' (from config.json)'}${judged(t) ? `; rules ${loadTrigger(w.dir).own ? triggerFile(w.dir) : 'built-in'}` : ''}`)
      }
      if (want !== 'inherit' && !isTrigger(want)) out(false, usage)
      const after = effective(cfg, setWorkspaceTrigger(cfg, w.name, want === 'inherit' ? undefined : want)).trigger
      if (after === 'mention-only') out(true, `workspace ${w.name}: only posts that @mention the bot reach it, replies in its threads too (DMs, 🔐 answers and ! commands need none)`)
      if (!judged(after)) out(true, `workspace ${w.name}: posts need an @mention to start a thread; every reply in the bot's threads reaches it`)
      let made = ''
      if (!existsSync(triggerFile(w.dir))) {
        writeFileSync(triggerFile(w.dir), DEFAULT_TRIGGER_MD, { mode: 0o644 })
        made = `; wrote the starter rules to ${triggerFile(w.dir)}`
      }
      if (after === 'openrouter') {
        const why = await openRouterReady(openRouterOf(cfg))
        out(true, `workspace ${w.name}: the bot follows threads it is @mentioned in, and ${cfg.openrouter.model} (through OpenRouter) decides which replies without a mention reach it until the router unfollows${made}. Each such reply sends the thread's last ${cfg.openrouter.messages} posts and the names in it to OpenRouter${cfg.openrouter.dataCollection === 'deny' ? ' (only to providers that keep no prompts)' : ''}${why ? `. ⚠️ not working yet: ${why} (until it is, every reply in a followed thread reaches the router)` : ''}`)
      }
      const why = await layaReady(layaOf(cfg.laya))
      out(true, `workspace ${w.name}: the bot follows threads it is @mentioned in, and Laya decides which replies without a mention reach it until the router unfollows${made}${why ? `. ⚠️ not working yet: ${why} (until it is, every reply in a followed thread reaches the router)` : ''}`)
    }
    case 'bind': {
      const [ch] = rest
      if (!a1 || !ch) out(false, 'usage: mmhub ws bind <workspace> <channel-id>')
      if (!loadWorkspace(cfg, a1)) out(false, `no workspace ${a1}`)
      bindChannel(p.bindings, ch, a1)
      out(true, `channel ${ch} → workspace ${a1}`)
    }
    case 'unbind': {
      if (!a1) out(false, 'usage: mmhub ws unbind <channel-id>')
      out(true, unbindChannel(p.bindings, a1) ? `channel ${a1} unbound` : `channel ${a1} was not bound`)
    }
    default:
      out(false, `unknown: mmhub ws ${sub}`)
  }
}

async function repo(): Promise<never> {
  const cfg = loadConfig(p.config)
  const [, sub, wsName, src] = args
  const nameIdx = args.indexOf('--name')
  const name = nameIdx >= 0 ? args[nameIdx + 1] : undefined
  try {
    if (sub === 'add') {
      if (!wsName || !src) out(false, 'usage: mmhub repo add <workspace> <path|git-url> [--name <n>]')
      const r = await addRepo(cfg, wsName, src, name)
      out(true, `added ${r.name} → ${r.path}`)
    }
    if (sub === 'rm') {
      if (!wsName || !src) out(false, 'usage: mmhub repo rm <workspace> <name>')
      out(true, removeRepo(cfg, wsName, src) ? `removed ${src} from ${wsName} (files untouched)` : `${wsName} has no repo ${src}`)
    }
  } catch (err) {
    out(false, errMsg(err))
  }
  out(false, 'usage: mmhub repo add|rm …')
}

// ------------------------------------------------------------------ providers

/** Provider failures and rest times, as the hub keeps them in hub.db. */
function readHealth(): Record<string, Health> {
  if (!existsSync(p.db)) return {}
  try {
    const db = new Database(p.db, { readonly: true })
    try {
      const row = db.query("SELECT v FROM kv WHERE k = 'provider-health'").get() as { v?: string } | null
      return row?.v ? (JSON.parse(row.v) as Record<string, Health>) : {}
    } finally {
      db.close()
    }
  } catch {
    return {}
  }
}

/** Forget a provider's failures in hub.db (only while the hub is down; otherwise it is asked). */
function forgetHealth(name: string): boolean {
  if (!existsSync(p.db)) return false
  const db = new Database(p.db)
  try {
    const row = db.query("SELECT v FROM kv WHERE k = 'provider-health'").get() as { v?: string } | null
    const all = row?.v ? (JSON.parse(row.v) as Record<string, Health>) : {}
    if (!all[name]) return false
    delete all[name]
    db.query("INSERT OR REPLACE INTO kv (k, v) VALUES ('provider-health', ?)").run(JSON.stringify(all))
    return true
  } finally {
    db.close()
  }
}

/** Tell a running hub that providers changed (it moves live sessions over). */
async function notifyProviders(): Promise<string> {
  if (!(await hubRunning())) return ''
  try {
    const r = await controlOp('provider', { op: 'changed' }, 120_000)
    return r.text && r.text !== 'providers re-read' ? ` — hub: ${r.text}` : ''
  } catch (err) {
    return ` — hub: ${errMsg(err)}`
  }
}

/** Read a secret: hidden prompt at a terminal, else all of stdin. Never from argv. */
async function readSecretValue(label: string): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).replace(/\r?\n$/, '')
  process.stderr.write(`${label} (input hidden, Enter to finish): `)
  const restore = () => Bun.spawnSync(['stty', 'echo'], { stdin: 'inherit' })
  Bun.spawnSync(['stty', '-echo'], { stdin: 'inherit' })
  process.once('SIGINT', () => {
    restore()
    process.stderr.write('\n')
    process.exit(130)
  })
  try {
    for await (const line of console) return line
    return ''
  } finally {
    restore()
    process.stderr.write('\n')
  }
}

function describeProvider(name: string, def: ProviderDef, health: Health | undefined, now: number): string {
  const bits: string[] = []
  const dir = configDirOf(p.dir, name, def)
  if (dir) bits.push(`config ${dir}${def.kind === 'login' ? ` (${loginState(dir).replace(/-/g, ' ')})` : ''}`)
  const env = Object.entries(def.env ?? {}).map(([k, v]) => `${k}=${v}`)
  if (env.length) bits.push(`env ${env.join(' ')}`)
  const secrets = secretNames(p.dir, name)
  if (secrets.length) bits.push(`secrets ${secrets.join(', ')} (set)`)
  if (def.routerModel || def.workerModel) bits.push(`models ${def.routerModel ?? '-'}/${def.workerModel ?? '-'}`)
  const why = unusableReason(p.dir, name, def)
  if (why) bits.push(`✗ ${why}`)
  if (cooling(health, now)) bits.push(`⏸ resting ${fmtAge(health!.coolUntil! - now)} (${health!.fault}: ${health!.reason ?? ''})`)
  else if (!why) bits.push('✓ ready')
  return `  ${name.padEnd(16)} ${def.kind.padEnd(11)} ${bits.join(' · ')}`
}

/** Flags of `mmhub provider add`: --env K=V (repeatable), --config-dir, --router-model, --worker-model, --description, --channels. */
function parseAddFlags(rest: string[]): { def: Partial<ProviderDef>; errors: string[] } {
  const def: Partial<ProviderDef> = {}
  const errors: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    const val = () => {
      const v = rest[++i]
      if (v === undefined) errors.push(`${a} needs a value`)
      return v ?? ''
    }
    if (a === '--env') {
      const kv = val()
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(kv)
      if (!m) errors.push(`--env wants KEY=VALUE, got ${kv.slice(0, 40)}`)
      else (def.env ??= {})[m[1]!] = m[2]!
    } else if (a === '--config-dir') def.configDir = val()
    else if (a === '--router-model') def.routerModel = val()
    else if (a === '--worker-model') def.workerModel = val()
    else if (a === '--description') def.description = val()
    else if (a === '--channels') def.channels = true
    else errors.push(`unknown flag ${a.slice(0, 40)}`)
  }
  return { def, errors }
}

/** The hub's Laya settings, with laya-serve's API key when the hub runs it. */
function layaOf(c: LayaConfig): LayaConfig & LayaCall {
  return c.serve ? { ...c, apiKey: serveKey(servePaths(p)) } : c
}

/** The hub's OpenRouter settings, with the key from .env. */
function openRouterOf(c: { openrouter: OpenRouterConfig }): OpenRouterCall {
  return { ...c.openrouter, apiKey: readEnvFile(p.env)[OPENROUTER_KEY] || undefined }
}

/** One line from stdin (the key is typed or pasted there, so it stays out of shell history and argv). */
async function readLine(prompt: string): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write(prompt)
  for await (const line of console) return line.trim()
  return ''
}

/** `mmhub openrouter …`: the key and model of the OpenRouter judge (trigger "openrouter"). */
async function openrouter(): Promise<never> {
  const cfg = loadConfig(p.config)
  const [, op, value] = args
  const users = () => listWorkspaces(cfg).filter(w => effective(cfg, w).trigger === 'openrouter').map(w => w.name)
  switch (op) {
    case undefined:
    case 'status': {
      const c = openRouterOf(cfg)
      const why = await openRouterReady(c)
      const ws = users()
      out(!why, `OpenRouter judge: model ${c.model} (${await apiOf(c)} API), key ${c.apiKey ? 'set' : 'missing'}, data collection ${c.dataCollection}; ${why ?? 'ready'}. Workspaces using it: ${ws.length ? ws.join(', ') : 'none (mmhub ws trigger <ws> openrouter)'}`)
    }
    case 'key': {
      const key = value === '-' || value === undefined ? await readLine('OpenRouter API key (sk-or-…): ') : out(false, 'pass the key on stdin, not as an argument: mmhub openrouter key')
      if (!/^sk-or-[\w-]{10,}$/.test(key)) out(false, 'that does not look like an OpenRouter key (sk-or-…); nothing saved')
      const why = await openRouterReady({ ...cfg.openrouter, apiKey: key })
      if (why && /refused the key/.test(why)) out(false, `${why}; nothing saved`)
      setEnvVar(p.env, OPENROUTER_KEY, key)
      out(true, `saved ${OPENROUTER_KEY} to ${p.env} (0600). The hub reads it on the next judged reply; no restart needed${why ? `. ⚠️ ${why}` : ''}`)
    }
    case 'model': {
      if (!value) out(false, `usage: mmhub openrouter model <id>   (now ${cfg.openrouter.model}; decision models: google/gemini-decision-1, openai/gpt-6-luna-decisions; or a chat model, e.g. google/gemini-2.5-flash-lite)`)
      const bad = await modelReady({ ...cfg.openrouter, model: value })
      if (bad && /no model|no provider/.test(bad)) out(false, `${bad}; nothing changed`)
      const why = bad ?? (await openRouterReady({ ...openRouterOf(cfg), model: value }))
      const raw = readJson<Record<string, unknown>>(p.config, () => ({}))
      raw.openrouter = { ...((raw.openrouter as object | undefined) ?? {}), model: value }
      writeJsonAtomic(p.config, raw)
      const live = await hubRunning() ? await controlOp('reload').then(r => r.ok, () => false) : false
      out(true, `OpenRouter model: ${value}${live ? ' (the hub reloaded config.json)' : '. Run mmhub reload if the hub is running'}${why ? `. ⚠️ ${why}` : ''}`)
    }
    default:
      out(false, 'usage: mmhub openrouter [status] | key | model <id>')
  }
}

/** Loads the checkpoints the way laya-serve does (downloading them into HF_HOME), on CPU. */
const LOAD_MODELS_PY = 'import laya.serve as s; s.build_router(); print("models ready", flush=True)'

/** `mmhub laya …`: Laya's own server, installed and run by the hub instead of Ollama (layaserve.ts). */
async function laya(): Promise<never> {
  const cfg = loadConfig(p.config)
  const sp = servePaths(p)
  const [, sub, ...rest] = args
  const PATH = cfg.path ?? process.env.PATH ?? '/usr/bin:/bin'
  const tmux = () => new Tmux(cfg.tmuxSocket, cleanEnv({ ...process.env, PATH }), Bun.which('tmux', { PATH }) ?? 'tmux')
  const flag = (name: string) => {
    const i = rest.indexOf(name)
    return i >= 0 ? rest[i + 1] : undefined
  }
  const saved = join(sp.dir, 'serve.json')
  /** Point config.json at laya-serve (or back at Ollama), and tell a running hub. */
  const useConfig = async (serve: ServeConfig | undefined): Promise<string> => {
    const raw = readJson<Record<string, unknown>>(p.config, () => ({}))
    const prev = (raw.laya ?? {}) as Record<string, unknown>
    const { serve: _old, ...others } = prev
    raw.laya = serve
      ? { ...others, url: `http://127.0.0.1:${serve.port}`, model: serve.models.length > 1 ? 'auto' : 'laya', serve }
      : { ...others, url: DEFAULT_LAYA.url, model: DEFAULT_LAYA.model }
    writeJsonAtomic(p.config, raw)
    if (!(await hubRunning())) return 'The hub is not running; it starts laya-serve when it starts (mmhub start).'
    const r = await controlOp('reload')
    return r.ok ? 'The hub has the new settings.' : `The hub didn't reload: ${r.error ?? r.text ?? 'no reason given'}.`
  }
  const step = async (what: string, cmd: string[], env?: Record<string, string>, tries = 1): Promise<void> => {
    for (let i = 1; ; i++) {
      process.stderr.write(`${what}…\n`)
      const pr = Bun.spawn(cmd, { stdin: 'ignore', stdout: 2, stderr: 2, env: { ...process.env, PATH, ...env } })
      if ((await pr.exited) === 0) return
      if (i >= tries) out(false, `${what} failed (exit ${pr.exitCode}); nothing was switched over. Run it again to retry.`)
      process.stderr.write(`${what} failed; trying again (${i + 1} of ${tries})\n`)
      await Bun.sleep(5000)
    }
  }
  const usersWorkspaces = () => listWorkspaces(cfg).filter(w => effective(cfg, w).trigger === 'laya').map(w => w.name)

  switch (sub) {
    case 'install': {
      const port = Number(flag('--port') ?? cfg.laya.serve?.port ?? DEFAULT_SERVE_PORT)
      if (!Number.isInteger(port) || port < 1024 || port > 65535) out(false, '--port must be a number from 1024 to 65535')
      const device = flag('--device') ?? cfg.laya.serve?.device
      if (device && !/^(cpu|mps|xpu|cuda(:\d+)?)$/.test(device)) out(false, '--device must be cpu, mps, cuda (or cuda:N) or xpu')
      const models = rest.includes('--english-only') ? ['english'] : [...SERVE_MODELS]
      const unload = flag('--unload-after') !== undefined ? Number(flag('--unload-after')) : cfg.laya.serve?.unloadAfterMinutes
      if (unload !== undefined && !(Number.isFinite(unload) && unload >= 0 && unload <= 1440)) out(false, '--unload-after takes minutes, 0 to 1440 (0 keeps the models loaded)')
      const serve: ServeConfig = { port, models, ...(device ? { device } : {}), ...(unload !== undefined ? { unloadAfterMinutes: unload } : {}) }
      const uv = Bun.which('uv', { PATH }) ?? [join(homedir(), '.local', 'bin', 'uv'), join(homedir(), '.cargo', 'bin', 'uv')].find(f => existsSync(f))
      if (!(await tmux().has(SERVE_SESSION)) && (await listening(port))) out(false, `something else listens on 127.0.0.1:${port}: choose another port with --port N`)
      if (!uv) out(false, 'mmhub laya install needs uv, which also installs the Python it uses: run `curl -LsSf https://astral.sh/uv/install.sh | sh` (or `brew install uv`), then run this again')
      mkdirSync(sp.dir, { recursive: true, mode: 0o700 })
      process.stderr.write(`Installing laya-serve into ${sp.dir} (about 2.2 GB: Python with PyTorch, and the ${models.join(' and ')} model${models.length > 1 ? 's' : ''}).\n`)
      if (!existsSync(sp.python)) await step(`Python ${LAYA_PYTHON}`, [uv!, 'venv', '--clear', '--python', LAYA_PYTHON, sp.venv])
      await step(`${LAYA_PACKAGE}`, [uv!, 'pip', 'install', '--python', sp.python, LAYA_PACKAGE])
      const loadEnv = { ...serveEnv({ ...serve, device: 'cpu' }, sp), HF_HUB_OFFLINE: '0' }
      await step(`The model${models.length > 1 ? 's' : ''} (${models.join(', ')})`, [sp.python, '-c', LOAD_MODELS_PY], loadEnv, 3)
      if (!existsSync(sp.key)) writeFileSync(sp.key, randomBytes(32).toString('hex') + '\n', { mode: 0o600 })
      writeJsonAtomic(saved, serve)
      // A server from an earlier install runs the old settings: replace it.
      await tmux().kill(SERVE_SESSION)
      const told = await useConfig(serve)
      const ws = usersWorkspaces()
      if (!ws.length) out(true, `laya-serve ${installedVersion(sp) ?? ''} installed; config.json now uses it (port ${port}, model ${serve.models.length > 1 ? 'auto: English or multilingual by language' : 'English'}). No workspace uses Laya yet: mmhub ws trigger <workspace> laya. ${told}`)
      if (!(await hubRunning())) out(true, `laya-serve installed; config.json now uses it. ${told}`)
      process.stderr.write('Waiting for laya-serve to load its models…\n')
      const state = await warmUp(loadConfig(p.config).laya, serveKey(sp))
      out(state.startsWith('ready'), `laya-serve ${installedVersion(sp) ?? ''} on 127.0.0.1:${port} for ${ws.join(', ')}: ${state}. ${health(await healthOf(loadConfig(p.config).laya))}`)
    }
    case 'status': {
      const c = cfg.laya
      const lines = [
        installed(sp) ? `laya-serve ${installedVersion(sp) ?? '?'} installed in ${sp.dir}` : `laya-serve is not installed (mmhub laya install)`,
        c.serve ? `config.json: laya-serve on port ${c.serve.port}, models ${c.serve.models.join(', ')}, model ${c.model}${c.serve.device ? `, device ${c.serve.device}` : ''}, ${unloading(c.serve)}` : `config.json: Ollama at ${c.url} (model ${c.model})`,
      ]
      if (c.serve) {
        lines.push(`tmux session ${SERVE_SESSION}: ${(await tmux().has(SERVE_SESSION)) ? 'running' : 'not running'}`)
        const why = await layaReady(layaOf(c))
        lines.push(why ? `not answering: ${why}` : `answering. ${health(await healthOf(c))}`)
        const ws = usersWorkspaces()
        lines.push(ws.length ? `used by ${ws.join(', ')}` : 'no workspace uses Laya, so the hub does not start it')
      }
      out(true, lines.join('\n'))
    }
    case 'restart': {
      const serve = cfg.laya.serve
      if (!serve || !installed(sp)) out(false, 'the hub does not run laya-serve (mmhub laya install)')
      const t = tmux()
      await t.kill(SERVE_SESSION)
      // The hub may have started it again in the meantime.
      if (!(await t.has(SERVE_SESSION))) await startServe(t, serve!, sp)
      process.stderr.write('Restarted; waiting for it to load its models…\n')
      const state = await warmUp(cfg.laya, serveKey(sp))
      out(state.startsWith('ready'), `laya-serve: ${state}`)
    }
    case 'logs': {
      const n = Math.max(1, Number(flag('-n') ?? 40) || 40)
      if (!existsSync(sp.log)) out(true, 'no log yet')
      out(true, readFileSync(sp.log, 'utf8').trimEnd().split('\n').slice(-n).join('\n'))
    }
    case 'use': {
      const to = rest[0]
      if (to === 'ollama') {
        const told = await useConfig(undefined)
        await tmux().kill(SERVE_SESSION)
        out(true, `config.json uses Ollama at ${DEFAULT_LAYA.url} again (model ${DEFAULT_LAYA.model}); laya-serve stopped and stays installed. ${told}`)
      }
      if (to === 'serve') {
        if (!installed(sp)) out(false, 'laya-serve is not installed: mmhub laya install')
        const serve = readJson<ServeConfig | undefined>(saved, () => undefined) ?? { port: DEFAULT_SERVE_PORT, models: [...SERVE_MODELS] }
        out(true, `config.json uses laya-serve again (port ${serve.port}). ${await useConfig(serve)}`)
      }
      out(false, 'usage: mmhub laya use ollama|serve')
    }
    case 'uninstall': {
      if (cfg.laya.serve) await useConfig(undefined)
      await tmux().kill(SERVE_SESSION)
      if (existsSync(sp.dir)) rmSync(sp.dir, { recursive: true, force: true })
      out(true, `laya-serve removed (${sp.dir}, with its models and key); config.json uses Ollama at ${DEFAULT_LAYA.url}`)
    }
    default:
      out(false, 'usage: mmhub laya install [--port N] [--device cpu|mps|cuda] [--english-only] [--unload-after MIN] | status | restart | logs [-n N] | use ollama|serve | uninstall')
  }
}

/** Whether anything accepts connections on 127.0.0.1:port. */
async function listening(port: number): Promise<boolean> {
  try {
    const s = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {} } })
    s.end()
    return true
  } catch {
    return false
  }
}

/** laya-serve's /health: the device and the loaded checkpoints. */
async function healthOf(c: LayaConfig): Promise<{ device?: string; loaded?: string[] } | undefined> {
  try {
    const r = await fetch(`${c.url.replace(/\/+$/, '')}/health`, { headers: { Authorization: `Bearer ${serveKey(servePaths(p)) ?? ''}` }, signal: AbortSignal.timeout(3000) })
    return r.ok ? ((await r.json()) as { device?: string; loaded?: string[] }) : undefined
  } catch {
    return undefined
  }
}

function unloading(s: ServeConfig): string {
  const m = s.unloadAfterMinutes ?? DEFAULT_UNLOAD_MINUTES
  return m > 0 ? `models freed after ${m} idle min` : 'models kept loaded'
}

function health(h: { device?: string; loaded?: string[] } | undefined): string {
  if (!h) return ''
  if (!h.loaded?.length) return `Device ${h.device ?? '?'}, no model loaded (freed while idle; the next post loads one, about 2-3 s).`
  const cpu = h.device === 'cpu' ? ' On CPU a post takes about 2 s, and some take longer than the 5 s limit (then the reply reaches the router unjudged); a GPU, or Ollama, is faster.' : ''
  return `Device ${h.device ?? '?'}, loaded ${h.loaded.join(', ')}.${cpu}`
}

async function provider(): Promise<never> {
  const cfg = loadConfig(p.config)
  const [, sub, name, ...rest] = args
  const defs = loadProviders(p.dir)
  const now = Date.now()
  const known = (n: string) => n === DEFAULT_PROVIDER || n === HUB_LIST || !!defs[n]

  switch (sub) {
    case 'list':
    case undefined: {
      const health = readHealth()
      const ws = listWorkspaces(cfg)
      if (json) out(true, `${Object.keys(defs).length} provider(s): ${Object.keys(defs).join(', ') || 'none'}; hub chain ${providerChain(cfg.providers, undefined).join(' → ')}`)
      const lines = ['providers:', `  ${'default'.padEnd(16)} ${'default'.padEnd(11)} the hub's own environment and login${cooling(health[DEFAULT_PROVIDER], now) ? ` · ⏸ resting ${fmtAge(health[DEFAULT_PROVIDER]!.coolUntil! - now)}` : ''}`]
      for (const [n, d] of Object.entries(defs)) lines.push(describeProvider(n, d, health[n], now))
      lines.push('', `hub-wide chain: ${providerChain(cfg.providers, undefined).join(' → ')}${cfg.providers?.length ? '' : ' (built in; set it with mmhub provider use --hub <name>…)'}`)
      if (ws.length) lines.push('', 'workspaces:')
      for (const w of ws) {
        const chain = providerChain(cfg.providers, w.providers)
        const c = chooseProvider(chain, now, n => health[n], n => unusableReason(p.dir, n, defs[n]))
        const state = c.unusable ? `✗ no usable provider (${c.name}: ${c.unusable})` : `active ${c.name}${c.fallback ? ' (fallback)' : ''}${c.healthy ? '' : ' (every provider failed: waiting)'}`
        lines.push(`  ${w.name.padEnd(16)} ${chain.join(' → ')}${w.providers ? '' : ' (hub-wide)'}  ${state}`)
      }
      console.log(lines.join('\n'))
      process.exit(0)
    }

    case 'add': {
      const kind = rest[0]
      if (!name || !kind) out(false, `usage: mmhub provider add <name> <kind> [--env K=V]… [--config-dir D] [--router-model M] [--worker-model M] [--channels]  (kinds: ${PROVIDER_KINDS.join(', ')})`)
      if (!isKind(kind)) out(false, `unknown kind ${kind} — one of ${PROVIDER_KINDS.join(', ')}`)
      const { def: extra, errors } = parseAddFlags(rest.slice(1))
      const def: ProviderDef = { ...extra, kind }
      errors.push(...validateDef(name, def))
      const secretish = Object.keys(def.env ?? {}).filter(k => /KEY|TOKEN|SECRET|PASSWORD/i.test(k) && !/^ANTHROPIC_FOUNDRY_RESOURCE$/.test(k))
      if (secretish.length) errors.push(`${secretish.join(', ')} look like secrets: store them with \`mmhub provider secret ${name} <VAR>\` (stdin), not --env`)
      if (errors.length) out(false, errors.join('; '))
      const replaced = !!defs[name]
      defs[name] = def
      saveProviders(p.dir, defs)
      const info = KINDS[kind]
      const next: string[] = [`${replaced ? 'updated' : 'added'} provider ${name} (${kind}: ${info.label})`]
      if (kind === 'login') {
        const dir = configDirOf(p.dir, name, def)!
        ensureConfigDir(p.dir, name, dir)
        next.push(`sign it in yourself, in your own terminal: ${loginCommand(dir, cfg.claudeBin ?? 'claude')}  — then /login, and /exit once signed in`)
      }
      for (const group of info.needsEnv) if (!group.some(k => def.env?.[k])) next.push(`it needs --env ${group.join(' or --env ')}=…`)
      for (const group of info.needsSecret) next.push(`store its secret: mmhub provider secret ${name} ${group[0]}   (you type or pipe the value; it is never an argument)`)
      if (!(def.channels ?? info.channels)) next.push(`⚠ Claude Code turns channels off on ${info.label}, so hub sessions there would never get a Mattermost message; the hub skips it (pass --channels only if your Claude Code carries channels there)`)
      next.push(`use it: mmhub provider use <workspace> ${name} [fallback…]`)
      const hub = await notifyProviders()
      if (json) out(true, next[0]! + hub)
      console.log(next.join('\n') + hub)
      process.exit(0)
    }

    case 'rm': {
      if (!name || !defs[name]) out(false, `no provider ${name ?? ''}`)
      delete defs[name]
      saveProviders(p.dir, defs)
      const purge = rest.includes('--purge')
      removeProviderFiles(p.dir, name, purge)
      const users = [
        ...(cfg.providers?.includes(name) ? ['the hub-wide chain'] : []),
        ...listWorkspaces(cfg).filter(w => w.providers?.includes(name)).map(w => `workspace ${w.name}`),
      ]
      const hub = await notifyProviders()
      out(true, `removed provider ${name} and its secrets${purge ? ' and config dir' : ''}${users.length ? `; still named in ${users.join(', ')} (skipped there until you change it)` : ''}${hub}`)
    }

    case 'secret': {
      const variable = rest[0]
      if (!name || !variable) out(false, `usage: mmhub provider secret <name> <VAR> [--unset]   (value from stdin; e.g. ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN)`)
      if (!defs[name]) out(false, `no provider ${name} — mmhub provider add ${name} <kind> first`)
      if (!/^[A-Z_][A-Z0-9_]*$/.test(variable)) out(false, `${variable.slice(0, 40)} isn't an environment variable name`)
      if (rest.includes('--unset')) out(true, deleteSecret(p.dir, name, variable) ? `${name}: ${variable} removed` : `${name} had no ${variable}`)
      const value = await readSecretValue(`${name} ${variable}`)
      try {
        writeSecret(p.dir, name, variable, value)
      } catch (err) {
        out(false, `${name} ${variable} not saved: ${errMsg(err)}`)
      }
      const usual = KINDS[defs[name]!.kind].secrets
      const hub = await notifyProviders()
      out(true, `${name}: ${variable} saved (${value.length} characters, 0600)${usual.length && !usual.includes(variable) ? ` — note: ${defs[name]!.kind} usually uses ${usual.join(', ')}` : ''}${hub}`)
    }

    case 'login': {
      const def = name ? defs[name] : undefined
      if (!name || !def) out(false, `no provider ${name ?? ''}`)
      if (def.kind !== 'login') out(false, `${name} is a ${def.kind} provider: ${def.kind === 'oauth-token' ? 'run `claude setup-token` yourself, then' : 'store its secret with'} mmhub provider secret ${name} ${KINDS[def.kind].secrets[0] ?? '<VAR>'}`)
      const dir = configDirOf(p.dir, name, def)!
      ensureConfigDir(p.dir, name, dir)
      const cmd = loginCommand(dir, cfg.claudeBin ?? 'claude')
      if (json) out(true, cmd)
      console.log([
        `Sign provider "${name}" in. In your own terminal (not in a Claude chat), run:`,
        '',
        `  ${cmd}`,
        '',
        'then type /login, sign in with the account this provider stands for, and /exit once it says you are signed in.',
        `It is ${loginState(dir) === 'signed-in' ? 'signed in already' : 'not signed in yet'}. Check it afterwards with: mmhub provider check ${name}`,
      ].join('\n'))
      process.exit(0)
    }

    case 'check': {
      const def = name ? defs[name] : undefined
      if (!name || (!def && name !== DEFAULT_PROVIDER)) out(false, `no provider ${name ?? ''}`)
      const errs = def ? validateDef(name, def) : []
      const why = unusableReason(p.dir, name, def)
      const launch = buildLaunch(p.dir, name, def)
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !(name !== DEFAULT_PROVIDER && PROVIDER_UNSET.includes(k)) && !/^(CLAUDE_CODE_|CLAUDECODE|MMHUB_)/.test(k)) env[k] = v
      Object.assign(env, launch.env)
      if (launch.apiKeyHelper) {
        // auth status only reports which credential it would use: hand it the key through its environment (never argv).
        const key = Bun.spawnSync(['/bin/sh', '-c', launch.apiKeyHelper]).stdout.toString().trim()
        if (key) env.ANTHROPIC_API_KEY = key
      }
      const claude = cfg.claudeBin ?? Bun.which('claude', { PATH: cfg.path ?? process.env.PATH ?? '' })
      let auth = 'claude not found'
      if (claude) {
        const r = Bun.spawnSync([claude, 'auth', 'status', '--json'], { env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000 })
        try {
          const s = JSON.parse(r.stdout.toString()) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string; email?: string; orgName?: string; subscriptionType?: string }
          auth = `${s.loggedIn ? 'signed in' : 'not signed in'} · auth ${s.authMethod ?? '?'} · API ${s.apiProvider ?? '?'}${s.email ? ` · ${s.email}` : ''}${s.orgName ? ` (${s.orgName})` : ''}${s.subscriptionType ? ` · ${s.subscriptionType}` : ''}`
        } catch {
          auth = `claude auth status failed: ${r.stderr.toString().trim().split('\n').pop() ?? `exit ${r.exitCode}`}`
        }
      }
      const health = readHealth()[name]
      const lines = [
        `${name} (${def?.kind ?? 'default'}): ${errs.length ? `✗ ${errs.join('; ')}` : why ? `✗ ${why}` : '✓ usable'}`,
        `  claude: ${auth}`,
        ...(launch.configDir ? [`  CLAUDE_CONFIG_DIR ${launch.configDir}`] : []),
        ...(secretNames(p.dir, name).length ? [`  secrets: ${secretNames(p.dir, name).join(', ')}`] : []),
        ...(cooling(health, now) ? [`  ⏸ resting ${fmtAge(health!.coolUntil! - now)} after ${health!.fault} (${health!.reason ?? ''}) — mmhub provider reset ${name} once fixed`] : []),
      ]
      const ok = !errs.length && !why
      if (json) out(ok, lines.join(' | '))
      console.log(lines.join('\n'))
      process.exit(ok ? 0 : 1)
    }

    case 'use': {
      const target = name
      if (!target) out(false, 'usage: mmhub provider use <workspace|--hub> <name>… | mmhub provider use <workspace> --inherit')
      const inherit = rest.includes('--inherit')
      const list = rest.filter(a => a !== '--inherit').flatMap(a => a.split(',')).map(s => s.trim()).filter(Boolean)
      if (!inherit && !list.length) out(false, 'name at least one provider (in fallback order), or --inherit')
      const unknown = list.filter(n => !known(n))
      if (unknown.length) out(false, `not defined: ${unknown.join(', ')} — mmhub provider add first (built in: default, hub)`)
      const warn = list.filter(n => n !== HUB_LIST).map(n => [n, unusableReason(p.dir, n, defs[n])] as const).filter(([, w]) => w).map(([n, w]) => `${n}: ${w}`)
      let what: string
      if (target === '--hub') {
        if (list.includes(HUB_LIST)) out(false, '"hub" only makes sense in a workspace list')
        const raw = readJson<Record<string, unknown>>(p.config, () => ({}))
        if (inherit) delete raw.providers
        else raw.providers = list
        writeJsonAtomic(p.config, raw)
        what = `hub-wide chain: ${providerChain(inherit ? undefined : list, undefined).join(' → ')}`
      } else {
        if (!loadWorkspace(cfg, target)) out(false, `no workspace ${target}`)
        const w = setWorkspaceProviders(cfg, target, inherit ? [] : list)
        what = `workspace ${target}: ${providerChain(cfg.providers, w.providers).join(' → ')}${inherit ? ' (the hub-wide list)' : ''}`
      }
      const hub = await notifyProviders()
      out(true, `${what}${warn.length ? ` — not usable yet: ${warn.join('; ')}` : ''}${hub}`)
    }

    case 'reset': {
      if (!name) out(false, 'usage: mmhub provider reset <name>')
      if (await hubRunning()) {
        const r = await controlOp('provider', { op: 'reset', name }, 120_000)
        out(r.ok, r.text ?? r.error ?? 'ok')
      }
      out(true, forgetHealth(name) ? `${name}: failures forgotten` : `${name} had no failures`)
    }

    default:
      out(false, `unknown: mmhub provider ${sub} (list|add|rm|secret|login|check|use|reset)`)
  }
}

const AGENT_LABEL = 'com.claude.mmhub'

/** launchd agent (macOS): start the hub at login, restart it if it crashes. */
async function agent(): Promise<never> {
  if (process.platform !== 'darwin') out(false, 'launchd agents are macOS only — use your init system (run: bun src/hub/main.ts)')
  const sub = args[1]
  const plist = join(process.env.HOME ?? '', 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`)
  const uid = process.getuid?.() ?? 0
  if (sub === 'install') {
    const cfg = loadConfig(p.config)
    const PATH = cfg.path ?? process.env.PATH ?? '/usr/bin:/bin'
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    const envs: Record<string, string> = { PATH, HOME: process.env.HOME ?? '' }
    if (process.env.MMHUB_STATE_DIR) envs.MMHUB_STATE_DIR = p.dir
    if (process.env.CLAUDE_CONFIG_DIR) envs.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(cfg.bunBin ?? process.execPath)}</string><string>${esc(join(ROOT, 'src', 'hub', 'main.ts'))}</string></array>
  <key>EnvironmentVariables</key><dict>${Object.entries(envs).map(([k, v]) => `<key>${k}</key><string>${esc(v)}</string>`).join('')}</dict>
  <key>WorkingDirectory</key><string>${esc(p.dir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${esc(p.log)}</string>
  <key>StandardErrorPath</key><string>${esc(p.log)}</string>
</dict></plist>
`
    mkdirSync(join(process.env.HOME ?? '', 'Library', 'LaunchAgents'), { recursive: true })
    await Bun.write(plist, xml)
    if (await hubRunning()) await controlOp('shutdown')
    await Bun.sleep(1000)
    const r = Bun.spawnSync(['launchctl', 'bootstrap', `gui/${uid}`, plist])
    out(r.exitCode === 0, r.exitCode === 0 ? `agent installed (${plist}); the hub now starts at login` : `launchctl bootstrap failed: ${r.stderr.toString().trim()}`)
  }
  if (sub === 'uninstall') {
    Bun.spawnSync(['launchctl', 'bootout', `gui/${uid}/${AGENT_LABEL}`])
    if (existsSync(plist)) (await import('fs')).rmSync(plist)
    out(true, 'agent removed (the hub is stopped; sessions keep running)')
  }
  out(false, 'usage: mmhub agent install|uninstall')
}

/** Resolve names to Mattermost ids with the bot token (for the access / workspace skills). */
async function lookup(): Promise<never> {
  const [, kind, a, b] = args
  const env = readEnvFile(p.env)
  if (!env.MATTERMOST_URL || !env.MATTERMOST_BOT_TOKEN) out(false, 'not configured — run /mattermost-hub:configure')
  const base = env.MATTERMOST_URL.replace(/\/+$/, '')
  const get = async (path: string) => {
    const res = await fetch(`${base}/api/v4${path}`, { headers: { Authorization: `Bearer ${env.MATTERMOST_BOT_TOKEN}` } })
    const body = (await res.json()) as Record<string, unknown>
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${String(body.message ?? '')}`)
    return body
  }
  if (kind === 'user' && a) {
    const u = await get(`/users/username/${encodeURIComponent(a.replace(/^@/, ''))}`)
    out(true, `${String(u.id)}  @${String(u.username)}`)
  }
  if (kind === 'channel' && a && b) {
    const c = await get(`/teams/name/${encodeURIComponent(a)}/channels/name/${encodeURIComponent(b.replace(/^~/, ''))}`)
    out(true, `${String(c.id)}  ~${String(c.name)} (${String(c.display_name)})`)
  }
  out(false, 'usage: mmhub lookup user <username> | mmhub lookup channel <team-name> <channel-name>')
}

// ------------------------------------------------------------------ scheduled jobs

/** `--name x` style flags out of `rest`; the other words in order. */
function flags(rest: string[], known: string[]): { f: Record<string, string>; words: string[] } {
  const f: Record<string, string> = {}
  const words: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    const eq = a.indexOf('=')
    const name = eq > 0 ? a.slice(0, eq) : a
    if (known.includes(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : rest[++i]
      if (v === undefined) out(false, `${name} needs a value`)
      f[name.replace(/^-+/, '')] = v
    } else words.push(a)
  }
  return { f, words }
}

async function cron(): Promise<never> {
  const [, sub = 'list', ...rest] = args
  const usage = 'usage: mmhub cron list [<ws>] | show <id> | add <ws> "<schedule>" <instruction…|-> [--name N] [--tz ZONE] [--channel ID | --thread ID] [--grace MIN] | rm|pause|resume|run <id> | next "<schedule>" [--tz ZONE] [-n N]'
  if (sub === 'next') {
    const { f, words } = flags(rest, ['--tz', '-n'])
    if (!words.length) out(false, usage)
    const parsed = parseSchedule(words.join(' '))
    const tz = f.tz ?? parsed.tz ?? hubTimezone()
    if (!validTimezone(tz)) out(false, `unknown time zone ${tz}`)
    const times: string[] = []
    let t = Date.now()
    for (let i = 0; i < Math.min(Number(f.n ?? 5) || 5, 50); i++) {
      const n = nextRun(parsed.cron, tz, t)
      if (n === undefined) break
      times.push(`  ${fmtLocal(n, tz)}`)
      t = n
    }
    const gap = minGapMinutes(parsed.cron)
    const warn = gap < MIN_GAP_MINUTES ? `\n⚠️ runs ${gap} min apart at times; jobs must be at least ${MIN_GAP_MINUTES} minutes apart` : ''
    out(gap >= MIN_GAP_MINUTES && times.length > 0, `${parsed.cron} (${tz})${times.length ? `, next:\n${times.join('\n')}` : ': never runs'}${warn}`)
  }
  if (!(await hubRunning())) out(false, 'hub is not running — start it first (mmhub start)')
  const send = async (a: Record<string, unknown>): Promise<never> => {
    const r = await controlOp('cron', a, 60_000)
    out(r.ok, r.text ?? r.error ?? (r.ok ? 'ok' : 'failed'))
  }
  const idOf = (v: string | undefined): number => {
    const n = Number((v ?? '').replace(/^#/, ''))
    if (!Number.isInteger(n) || n <= 0) out(false, usage)
    return n
  }
  switch (sub) {
    case 'list':
    case 'ls':
      return send({ op: 'list', workspace: rest[0] })
    case 'show':
      return send({ op: 'show', id: idOf(rest[0]) })
    case 'rm':
    case 'pause':
    case 'resume':
    case 'run':
      return send({ op: sub, id: idOf(rest[0]) })
    case 'add': {
      const { f, words } = flags(rest, ['--name', '--tz', '--channel', '--thread', '--grace'])
      const [workspace, schedule, ...textWords] = words
      if (!workspace || !schedule) out(false, usage)
      try {
        parseSchedule(schedule)
      } catch (err) {
        out(false, `${errMsg(err)} — quote the schedule as one argument, e.g. mmhub cron add ${workspace} "every weekday 09:00" Check the alerts`)
      }
      if (f.channel && f.thread) out(false, 'pass --channel or --thread, not both')
      const text = textWords.length === 0 || (textWords.length === 1 && textWords[0] === '-') ? (await Bun.stdin.text()).trim() : textWords.join(' ')
      if (!text) out(false, 'no instruction: pass it after the schedule, or "-" to read it from stdin')
      return send({ op: 'add', workspace, schedule, text, name: f.name, tz: f.tz, channel: f.channel, thread: f.thread, ...(f.grace !== undefined ? { grace: Number(f.grace) } : {}) })
    }
    default:
      out(false, usage)
  }
}

async function main(): Promise<never> {
  switch (args[0]) {
    case 'cron': return cron()
    case 'lookup': return lookup()
    case 'agent': return agent()
    case 'laya': return laya()
    case 'openrouter': return openrouter()
    case 'start': return start()
    case 'stop': return stop()
    case 'status': return status()
    case 'logs': return logs()
    case 'doctor': return doctor()
    case 'session': return session()
    case 'ws': return ws()
    case 'repo': return repo()
    case 'provider':
    case 'providers': return provider()
    case 'reload': {
      if (!(await hubRunning())) out(false, 'hub is not running')
      const r = await controlOp('reload')
      return out(r.ok, r.text ?? 'ok')
    }
    default: {
      const doc = readFileSync(import.meta.path, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? ''
      console.log(doc.replace(/^ \* ?/gm, '').trim())
      process.exit(args[0] && args[0] !== 'help' && args[0] !== '--help' ? 1 : 0)
    }
  }
}

try {
  await main()
} catch (err) {
  out(false, errMsg(err))
}
