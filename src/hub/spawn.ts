/**
 * Launch specs: the generated per-session files and the `claude` argv for a
 * router or a worker. Pure apart from writing files — argv is unit-tested.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Paths } from '../shared/paths'
import type { Role } from '../shared/ipc'
import { readJson } from '../shared/util'
import type { Workspace } from './workspaces'

/** Single-quote for sh (hook commands run through a shell). */
export function shq(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

export type SessionFiles = { dir: string; mcp: string; settings: string; prompt: string; providerEnv: string }

export function sessionFiles(p: Paths, key: string): SessionFiles {
  const dir = join(p.sessions, key)
  return { dir, mcp: join(dir, 'mcp.json'), settings: join(dir, 'settings.json'), prompt: join(dir, 'prompt.md'), providerEnv: join(dir, 'provider.env') }
}

/**
 * Variables a session on a non-default provider must not inherit from the
 * hub's own environment, so it runs on exactly the provider it was given.
 * CLAUDE_SECURESTORAGE_CONFIG_DIR would make every login provider share one
 * keychain item. (CLAUDE_CODE_* never reach the tmux server: tmux.ts cleanEnv.)
 */
export const PROVIDER_UNSET = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK', 'CLOUD_ML_REGION', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
]

/**
 * `sh -c` script that starts claude with a provider's env: `$1` is the env file
 * (0600, `export K='v'` lines), the rest is claude's argv. The file is deleted
 * once read, and only its path is ever in argv.
 */
export const LAUNCH_SH = `f=$1; shift; unset ${PROVIDER_UNSET.join(' ')}; . "$f" || exit 97; rm -f "$f"; exec "$@"`

/** Always single-quoted for sh. */
function shqAlways(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function providerEnvText(env: Record<string, string>): string {
  return Object.entries(env).filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k)).map(([k, v]) => `export ${k}=${shqAlways(v)}\n`).join('')
}

/** Write the provider env file a launch sources (0600, in the 0700 session folder). */
export function writeProviderEnv(f: SessionFiles, env: Record<string, string>): string {
  mkdirSync(f.dir, { recursive: true, mode: 0o700 })
  writeFileSync(f.providerEnv, providerEnvText(env), { mode: 0o600 })
  chmodSync(f.providerEnv, 0o600)
  return f.providerEnv
}

/** claude's argv run through the provider launch script (tmux execs it without a shell of its own). */
export function wrapArgv(argv: string[], envFile: string): string[] {
  return ['/bin/sh', '-c', LAUNCH_SH, 'mmhub-launch', envFile, ...argv]
}

const HOOK_EVENTS = ['SessionStart', 'Stop', 'StopFailure', 'SessionEnd'] as const

type Settings = Record<string, unknown> & { hooks?: Record<string, unknown[]> }

/** Merge the workspace's .claude/settings.json with the hub's hooks (and carried user keys). */
export function buildSettings(o: { workspaceSettings: Settings; hookCommand: string; carry: Settings; disablePlugins: string[] }): Settings {
  const out: Settings = { ...o.carry, ...o.workspaceSettings }
  const hooks: Record<string, unknown[]> = { ...(o.workspaceSettings.hooks ?? {}) }
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = [...(hooks[ev] ?? []), { hooks: [{ type: 'command', command: o.hookCommand, timeout: 15 }] }]
  }
  out.hooks = hooks
  if (o.disablePlugins.length) {
    out.enabledPlugins = { ...((o.workspaceSettings.enabledPlugins as Record<string, boolean>) ?? {}), ...Object.fromEntries(o.disablePlugins.map(p => [p, false])) }
  }
  return out
}

/** Keys from the user's own settings that spawned sessions still need (setting-sources skips user settings). */
export function carriedUserSettings(permissionMode: string, configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')): Settings {
  const user = readJson<Settings>(join(configDir, 'settings.json'), () => ({}))
  const out: Settings = {}
  if (permissionMode === 'bypassPermissions' && user.skipDangerousModePermissionPrompt) out.skipDangerousModePermissionPrompt = true
  if (permissionMode === 'auto' && user.skipAutoPermissionPrompt) out.skipAutoPermissionPrompt = true
  return out
}

export function writeSessionFiles(o: {
  paths: Paths
  key: string
  role: Role
  workspace: Workspace
  bunBin: string
  root: string
  prompt: string
  permissionMode: string
  disablePlugins: string[]
  /** Where workers' reports go (the bridge words its tools to match). */
  reports: 'router' | 'thread'
  /** The provider's API key helper (a command printing the key), when it uses one. */
  apiKeyHelper?: string
}): SessionFiles {
  const f = sessionFiles(o.paths, o.key)
  mkdirSync(f.dir, { recursive: true, mode: 0o700 })

  const extra = readJson<{ mcpServers?: Record<string, unknown> }>(join(o.workspace.dir, '.mcp.json'), () => ({})).mcpServers ?? {}
  const { mmhub: _reserved, ...wsServers } = extra
  const mcp = {
    mcpServers: {
      ...wsServers,
      mmhub: {
        command: o.bunBin,
        args: [join(o.root, 'src', 'bridge', 'server.ts')],
        env: { MMHUB_SESSION_KEY: o.key, MMHUB_ROLE: o.role, MMHUB_STATE_DIR: o.paths.dir, MMHUB_REPORTS: o.reports },
      },
    },
  }
  writeFileSync(f.mcp, JSON.stringify(mcp, null, 2) + '\n', { mode: 0o600 })

  const wsSettingsFile = join(o.workspace.dir, '.claude', 'settings.json')
  const settings = buildSettings({
    workspaceSettings: existsSync(wsSettingsFile) ? (JSON.parse(readFileSync(wsSettingsFile, 'utf8')) as Settings) : {},
    hookCommand: `${shq(o.bunBin)} ${shq(join(o.root, 'src', 'hook.ts'))} ${o.key}`,
    carry: carriedUserSettings(o.permissionMode),
    disablePlugins: o.disablePlugins,
  })
  // The provider decides how the session authenticates, not the workspace's settings.
  if (o.apiKeyHelper) settings.apiKeyHelper = o.apiKeyHelper
  writeFileSync(f.settings, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })

  // The appended system prompt is recorded on the first request and replayed on
  // every resume — only write it for a new session, never change it afterwards.
  if (!existsSync(f.prompt)) writeFileSync(f.prompt, o.prompt, { mode: 0o600 })
  return f
}

export type LaunchSpec = {
  claudeBin: string
  role: Role
  sessionId: string
  resume: boolean
  displayName: string
  model: string
  permissionMode: string
  addDirs: string[]
  extraArgs: string[]
  files: SessionFiles
  autocompact?: number
}

export function claudeArgs(s: LaunchSpec): string[] {
  const roleArgs = s.role === 'router'
    ? ['--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__mmhub',
        ...(s.autocompact ? ['--autocompact', String(s.autocompact)] : [])]
    : ['--permission-mode', s.permissionMode, '--allowedTools', 'mcp__mmhub']
  return [
    s.claudeBin,
    ...(s.resume ? ['--resume', s.sessionId] : ['--session-id', s.sessionId]),
    '-n', s.displayName,
    '--model', s.model,
    ...roleArgs,
    '--append-system-prompt-file', s.files.prompt,
    '--mcp-config', s.files.mcp,
    '--strict-mcp-config',
    '--settings', s.files.settings,
    '--setting-sources', 'project,local',
    ...s.addDirs.flatMap(d => ['--add-dir', d]),
    ...s.extraArgs,
    '--dangerously-load-development-channels', 'server:mmhub',
  ]
}

/** Claude Code's transcript for a session: ~/.claude/projects/<cwd with / and . → ->/<id>.jsonl */
export function transcriptPath(cwd: string, sessionId: string, configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')): string {
  return join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
}

export function tmuxName(key: string): string {
  return `mm${key}` // r-abc → mmr-abc, w-xyz → mmw-xyz
}
