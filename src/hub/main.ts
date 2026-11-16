#!/usr/bin/env bun
/**
 * mmhub daemon entry: `bun src/hub/main.ts` (normally via `mmhub start`).
 * One per machine/state dir — guarded by hub.lock.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { paths, ROOT } from '../shared/paths'
import { errMsg, isPidAlive, log, readEnvFile } from '../shared/util'
import { loadConfig } from './config'
import { control } from './control'
import { Hub } from './hub'
import { Mattermost } from './mattermost'
import { listen } from './server'
import { cleanEnv, Tmux } from './tmux'
import { ensureTemplate } from './workspaces'

const p = paths()
mkdirSync(p.dir, { recursive: true, mode: 0o700 })
mkdirSync(p.sessions, { recursive: true, mode: 0o700 })

// ---- single instance
if (existsSync(p.lock)) {
  const pid = parseInt(readFileSync(p.lock, 'utf8'), 10)
  if (pid !== process.pid && isPidAlive(pid)) {
    log('hub', `already running (pid ${pid})`)
    process.exit(1)
  }
}
writeFileSync(p.lock, String(process.pid), { mode: 0o600 })

function fail(msg: string, code = 2): never {
  log('hub', msg)
  try { rmSync(p.lock, { force: true }) } catch {}
  process.exit(code)
}

// ---- configuration
const env = { ...readEnvFile(p.env), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('MATTERMOST_'))) }
const url = env.MATTERMOST_URL
const token = env.MATTERMOST_BOT_TOKEN
if (!url || !token) fail(`MATTERMOST_URL and MATTERMOST_BOT_TOKEN must be set in ${p.env} — run /mattermost-hub:configure`)
for (const k of Object.keys(process.env)) if (k.startsWith('MATTERMOST_')) delete process.env[k]

const cfg = loadConfig(p.config)
try {
  ensureTemplate(cfg) // <workspacesDir>/workspace-template, copied into each new workspace
} catch (err) {
  log('hub', `could not create the workspace template in ${cfg.workspacesDir}: ${errMsg(err)}`)
}
const PATH = cfg.path ?? process.env.PATH ?? '/usr/bin:/bin'
const claudeBin = cfg.claudeBin ?? Bun.which('claude', { PATH })
if (!claudeBin) fail('claude CLI not found on PATH — set claudeBin in config.json')
const tmuxBin = Bun.which('tmux', { PATH })
if (!tmuxBin) fail('tmux not found on PATH')
const bunBin = cfg.bunBin ?? process.execPath
const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version

const mm = new Mattermost(url!, token!)
const tmux = new Tmux(cfg.tmuxSocket, cleanEnv({ ...process.env, PATH }), tmuxBin!)
const hub = new Hub({ paths: p, mm, tmux, claudeBin: claudeBin!, bunBin, version, cliPath: join(ROOT, 'src', 'cli.ts') })

let stopping = false
async function shutdown(): Promise<void> {
  if (stopping) return
  stopping = true
  log('hub', 'stopping')
  server.close()
  await hub.shutdown()
  for (const f of [p.lock, p.sock]) try { rmSync(f, { force: true }) } catch {}
  process.exit(0)
}

const server = listen(hub, p.sock, (op, args) => control(hub, op, args, () => void shutdown()))
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
process.on('unhandledRejection', err => log('hub', `unhandled: ${errMsg(err)}`))

try {
  await hub.start()
  log('hub', `ready — v${version}, state ${p.dir}, workspaces ${cfg.workspacesDir}, claude ${claudeBin}`)
} catch (err) {
  server.close()
  fail(`could not connect to Mattermost at ${url}: ${errMsg(err)}`)
}
