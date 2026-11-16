/**
 * Providers: the account or API a workspace's `claude` sessions run on, and
 * falling back to the next one when it fails.
 *
 *   <state>/providers.json                    definitions, no secrets (0600)
 *   <state>/providers/<name>/secrets/<VAR>    one secret per file (0600, folders 0700),
 *                                             written by `mmhub provider secret` from stdin
 *   <state>/providers/<name>/config/          a login provider's CLAUDE_CONFIG_DIR (made by the hub).
 *                                             `/login` there is that account's own: Claude Code names the
 *                                             keychain item after the config dir. Its projects/ links to the
 *                                             base config's projects/, so transcripts (and --resume) are
 *                                             shared by every provider.
 *
 * A workspace's chain is its workspace.json `providers`, else config.json
 * `providers`, else ["default"]: the hub's own environment and login, as
 * before providers existed. The name "hub" inside a workspace's list stands for
 * the hub-wide list, so a workspace can fall back on it explicitly.
 *
 * Secrets never go in argv, status.json, logs or posts. Sessions get them from
 * a 0600 env file that their launch command sources and deletes (spawn.ts), or,
 * for an API key, from an `apiKeyHelper` that reads the secret file.
 *
 * Claude Code drops channel messages on third-party providers (Bedrock, Vertex,
 * Foundry: "channels are not available on third-party providers"), so those
 * kinds can be defined but are skipped unless `channels: true` says a newer
 * Claude Code carries them.
 */

import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { expandHome } from '../shared/paths'
import { readJson, writeJsonAtomic } from '../shared/util'
import { retryDelay, type FailureKind } from './lifecycle'
import { shq, transcriptPath } from './spawn'

export const PROVIDER_KINDS = ['login', 'oauth-token', 'api-key', 'gateway', 'bedrock', 'vertex', 'foundry'] as const
export type DefinedKind = (typeof PROVIDER_KINDS)[number]
export type ProviderKind = DefinedKind | 'default'

export type ProviderDef = {
  kind: DefinedKind
  /** CLAUDE_CONFIG_DIR for its sessions. login: default <state>/providers/<name>/config. Others: optional. */
  configDir?: string
  /** Non-secret env: ANTHROPIC_BASE_URL, AWS_REGION, AWS_PROFILE, CLOUD_ML_REGION, ANTHROPIC_DEFAULT_OPUS_MODEL, … */
  env?: Record<string, string>
  /** Model for routers / workers on this provider (default: the workspace's). */
  routerModel?: string
  workerModel?: string
  /** Override whether Claude Code carries channels on this provider (third-party kinds: false). */
  channels?: boolean
  description?: string
}

/** The built-in provider: the hub's own environment and login. */
export const DEFAULT_PROVIDER = 'default'
/** In a workspace's list: the hub-wide list. */
export const HUB_LIST = 'hub'
export const PROVIDER_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/

/** Variables a provider may not set (the hub owns them, or they would let a value escape its file). */
export function forbiddenEnv(name: string): boolean {
  return ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'IFS', 'ENV', 'BASH_ENV', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'].includes(name)
    || /^(MMHUB_|LD_|DYLD_|BUN_)/.test(name)
}

type KindInfo = {
  label: string
  /** Set for every session of the kind. */
  env: Record<string, string>
  /** Non-secret env it needs: one of each group. */
  needsEnv: string[][]
  /** Secrets it needs: one of each group. */
  needsSecret: string[][]
  /** Secrets it knows about (others are allowed too). */
  secrets: string[]
  /** Claude Code delivers channel messages on it. */
  channels: boolean
}

export const KINDS: Record<DefinedKind, KindInfo> = {
  login: { label: 'Claude login in its own config dir', env: {}, needsEnv: [], needsSecret: [], secrets: [], channels: true },
  'oauth-token': { label: 'subscription token from `claude setup-token`', env: {}, needsEnv: [], needsSecret: [['CLAUDE_CODE_OAUTH_TOKEN']], secrets: ['CLAUDE_CODE_OAUTH_TOKEN'], channels: true },
  'api-key': { label: 'Anthropic API key', env: {}, needsEnv: [], needsSecret: [['ANTHROPIC_API_KEY']], secrets: ['ANTHROPIC_API_KEY'], channels: true },
  gateway: { label: 'LLM gateway at ANTHROPIC_BASE_URL', env: {}, needsEnv: [['ANTHROPIC_BASE_URL']], needsSecret: [], secrets: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'], channels: true },
  bedrock: { label: 'Amazon Bedrock', env: { CLAUDE_CODE_USE_BEDROCK: '1' }, needsEnv: [['AWS_REGION']], needsSecret: [], secrets: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK'], channels: false },
  vertex: { label: 'Google Vertex AI', env: { CLAUDE_CODE_USE_VERTEX: '1' }, needsEnv: [['CLOUD_ML_REGION'], ['ANTHROPIC_VERTEX_PROJECT_ID']], needsSecret: [], secrets: [], channels: false },
  foundry: { label: 'Microsoft Foundry', env: { CLAUDE_CODE_USE_FOUNDRY: '1' }, needsEnv: [['ANTHROPIC_FOUNDRY_RESOURCE', 'ANTHROPIC_FOUNDRY_BASE_URL']], needsSecret: [], secrets: ['ANTHROPIC_FOUNDRY_API_KEY'], channels: false },
}

export function isKind(k: string): k is DefinedKind {
  return (PROVIDER_KINDS as readonly string[]).includes(k)
}

// ---------------------------------------------------------------- files

export function providersFile(stateDir: string): string {
  return join(stateDir, 'providers.json')
}

function providerDir(stateDir: string, name: string): string {
  if (!PROVIDER_NAME_RE.test(name)) throw new Error(`invalid provider name: ${name}`)
  return join(stateDir, 'providers', name)
}

export function secretsDir(stateDir: string, name: string): string {
  return join(providerDir(stateDir, name), 'secrets')
}

/** The config dir the hub makes for a login provider. */
export function managedConfigDir(stateDir: string, name: string): string {
  return join(providerDir(stateDir, name), 'config')
}

export function loadProviders(stateDir: string): Record<string, ProviderDef> {
  const raw = readJson<Record<string, ProviderDef>>(providersFile(stateDir), () => ({}))
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

export function saveProviders(stateDir: string, defs: Record<string, ProviderDef>): void {
  writeJsonAtomic(providersFile(stateDir), defs, 0o600)
}

/** Check a definition; returns what is wrong with it. */
export function validateDef(name: string, def: ProviderDef): string[] {
  const errs: string[] = []
  if (!PROVIDER_NAME_RE.test(name)) errs.push(`name "${name}": lowercase letters, digits, . _ - (max 40)`)
  if (name === DEFAULT_PROVIDER || name === HUB_LIST) errs.push(`"${name}" is reserved`)
  if (!isKind(def.kind)) errs.push(`kind must be one of ${PROVIDER_KINDS.join(', ')}`)
  for (const k of Object.keys(def.env ?? {})) {
    if (!ENV_NAME_RE.test(k)) errs.push(`env name ${k}`)
    else if (forbiddenEnv(k)) errs.push(`${k} can't be set by a provider${k === 'CLAUDE_CONFIG_DIR' ? ' (use --config-dir)' : ''}`)
  }
  return errs
}

export function secretNames(stateDir: string, name: string): string[] {
  try {
    return readdirSync(secretsDir(stateDir, name)).filter(n => ENV_NAME_RE.test(n)).sort()
  } catch {
    return []
  }
}

export function secretFile(stateDir: string, name: string, variable: string): string {
  if (!ENV_NAME_RE.test(variable)) throw new Error(`invalid variable name: ${variable}`)
  return join(secretsDir(stateDir, name), variable)
}

export function hasSecret(stateDir: string, name: string, variable: string): boolean {
  try {
    return statSync(secretFile(stateDir, name, variable)).size > 0
  } catch {
    return false
  }
}

function readSecret(stateDir: string, name: string, variable: string): string | undefined {
  try {
    return readFileSync(secretFile(stateDir, name, variable), 'utf8').replace(/\r?\n$/, '') || undefined
  } catch {
    return undefined
  }
}

export function writeSecret(stateDir: string, name: string, variable: string, value: string): void {
  if (forbiddenEnv(variable)) throw new Error(`${variable} can't be set by a provider`)
  const v = value.replace(/\r?\n$/, '')
  if (!v) throw new Error('empty value')
  if (/[\0\r\n]/.test(v)) throw new Error('the value has a line break in it')
  const dir = secretsDir(stateDir, name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const f = secretFile(stateDir, name, variable)
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, v, { mode: 0o600 })
  renameSync(tmp, f)
}

export function deleteSecret(stateDir: string, name: string, variable: string): boolean {
  const f = secretFile(stateDir, name, variable)
  if (!existsSync(f)) return false
  rmSync(f, { force: true })
  return true
}

/** Remove a provider's secrets (and, with purge, its login config dir too). */
export function removeProviderFiles(stateDir: string, name: string, purge: boolean): void {
  rmSync(secretsDir(stateDir, name), { recursive: true, force: true })
  if (purge) rmSync(providerDir(stateDir, name), { recursive: true, force: true })
}

// ---------------------------------------------------------------- config dirs

/** Where Claude Code keeps config and transcripts for the hub's own login. */
export function baseConfigDir(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.CLAUDE_CONFIG_DIR ? expandHome(env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude'))
}

/** The CLAUDE_CONFIG_DIR a provider's sessions run with (undefined: the base one). Absolute and exact: the keychain item is named after it. */
export function configDirOf(stateDir: string, name: string, def: ProviderDef | undefined): string | undefined {
  if (!def) return undefined
  if (def.configDir) return resolve(expandHome(def.configDir)).replace(/\/+$/, '')
  return def.kind === 'login' ? managedConfigDir(stateDir, name) : undefined
}

function isManaged(stateDir: string, name: string, dir: string): boolean {
  return dir === managedConfigDir(stateDir, name)
}

/**
 * Make a login provider's config dir (0700). A dir the hub manages gets
 * projects/ as a link to the base config's projects/, so every provider sees
 * the same transcripts. A dir the user chose is left as it is.
 */
export function ensureConfigDir(stateDir: string, name: string, dir: string, baseDir = baseConfigDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!isManaged(stateDir, name, dir)) return
  const projects = join(dir, 'projects')
  let present = true
  try {
    lstatSync(projects)
  } catch {
    present = false
  }
  if (present) return
  const shared = join(baseDir, 'projects')
  mkdirSync(shared, { recursive: true })
  symlinkSync(shared, projects)
}

/** What a config dir's .claude.json says about signing in (a hint: real failures show at startup). */
export function loginState(configDir: string): 'signed-in' | 'not-signed-in' {
  const j = readJson<Record<string, unknown> | null>(join(configDir, '.claude.json'), () => null)
  if (!j || j.hasCompletedOnboarding !== true) return 'not-signed-in'
  const acct = j.oauthAccount
  return acct && typeof acct === 'object' && Object.keys(acct).length ? 'signed-in' : 'not-signed-in'
}

/** The command a person runs (in their own terminal) to sign a login provider in. */
export function loginCommand(configDir: string, claudeBin = 'claude'): string {
  return `CLAUDE_CONFIG_DIR=${shq(configDir)} ${shq(claudeBin)}`
}

// ---------------------------------------------------------------- usable?

/** Why a provider can't run hub sessions at all, or undefined when it can. */
export function unusableReason(stateDir: string, name: string, def: ProviderDef | undefined): string | undefined {
  if (name === DEFAULT_PROVIDER) return undefined
  if (!def) return 'not defined'
  if (!isKind(def.kind)) return `unknown kind ${String(def.kind)}`
  const info = KINDS[def.kind]
  if (!(def.channels ?? info.channels)) return 'Claude Code has no channels on third-party providers'
  for (const group of info.needsEnv) if (!group.some(k => def.env?.[k])) return `needs ${group.join(' or ')}`
  for (const group of info.needsSecret) if (!group.some(k => hasSecret(stateDir, name, k))) return `needs secret ${group.join(' or ')}`
  if (def.kind === 'login') {
    const dir = configDirOf(stateDir, name, def)!
    if (loginState(dir) !== 'signed-in') return 'not signed in'
  }
  return undefined
}

// ---------------------------------------------------------------- chains

/** The workspace's providers in order: its own list (with "hub" expanded), else the hub's, else ["default"]. */
export function providerChain(hubList: string[] | undefined, wsList: string[] | undefined): string[] {
  const hub = (hubList ?? []).filter(n => n !== HUB_LIST)
  const base = wsList?.length ? wsList : hub.length ? hub : [DEFAULT_PROVIDER]
  const out: string[] = []
  for (const n of base.flatMap(n => (n === HUB_LIST ? (hub.length ? hub : [DEFAULT_PROVIDER]) : [n]))) {
    if (typeof n === 'string' && n && !out.includes(n)) out.push(n)
  }
  return out.length ? out : [DEFAULT_PROVIDER]
}

// ---------------------------------------------------------------- health

/**
 * Why a provider was taken out of rotation for a while:
 * - auth: its credentials failed (or its login screen showed at startup)
 * - quota: out of usage or credit
 * - rate_limit: rate-limited even after Claude Code's own retries
 * - errors: API errors went on after the hub's retries gave up
 * - channels: Claude Code didn't carry channel messages on it (provider or org policy)
 */
export type FaultKind = 'auth' | 'quota' | 'rate_limit' | 'errors' | 'channels'

export type Health = {
  /** Failures in a row without a good turn in between. */
  strikes: number
  coolUntil?: number
  fault?: FaultKind
  /** Short, redacted detail. */
  reason?: string
  at?: number
}

/** Minutes a failed provider rests before it is tried again (doubles with each strike, at most a day). */
export const COOLDOWN_MINUTES: Record<FaultKind, number> = { auth: 60, quota: 60, rate_limit: 10, errors: 15, channels: 360 }
const MAX_COOLDOWN_MS = 24 * 60 * 60_000

export function cooldownMs(fault: FaultKind, strikes: number, overrides?: Partial<Record<FaultKind, number>>): number {
  const base = (overrides?.[fault] ?? COOLDOWN_MINUTES[fault]) * 60_000
  return Math.min(MAX_COOLDOWN_MS, base * 2 ** Math.max(0, Math.min(strikes, 10) - 1))
}

/** "Your limit resets …|1731790800": the epoch (seconds) a usage limit ends, when the error says. */
export function resetTime(error: string | undefined, now: number): number | undefined {
  const m = /\|(\d{10})(?!\d)/.exec(error ?? '')
  if (!m) return undefined
  const at = Number(m[1]) * 1000
  return at > now && at - now <= MAX_COOLDOWN_MS ? at : undefined
}

export function markFailed(h: Health | undefined, fault: FaultKind, reason: string, now: number, o: { overrides?: Partial<Record<FaultKind, number>>; resetAt?: number } = {}): Health {
  const strikes = (h?.strikes ?? 0) + 1
  const until = o.resetAt ?? now + cooldownMs(fault, strikes, o.overrides)
  return { strikes, coolUntil: Math.max(until, h?.coolUntil ?? 0), fault, reason: redact(reason).slice(0, 120), at: now }
}

/** A good turn: the strikes start over (a running cooldown still ends on time). */
export function markOk(h: Health | undefined): Health | undefined {
  if (!h || h.strikes === 0) return h
  return { ...h, strikes: 0 }
}

export function cooling(h: Health | undefined, now: number): boolean {
  return !!h?.coolUntil && h.coolUntil > now
}

/** Whether a failed turn is the provider's fault (so another provider may do better). */
export function providerFault(kind: FailureKind, attempt: number): FaultKind | undefined {
  if (kind === 'auth' || kind === 'quota' || kind === 'rate_limit') return kind
  if (kind === 'transient' && retryDelay('transient', attempt) === undefined) return 'errors'
  return undefined
}

// ---------------------------------------------------------------- choosing

export type Choice = {
  name: string
  /** Position in the chain (0: the primary). */
  index: number
  /** Not the chain's first provider. */
  fallback: boolean
  /** false: every usable provider is cooling down; this one cools down first. */
  healthy: boolean
  /** Set when no provider in the chain can run sessions at all. */
  unusable?: string
}

/** The first usable provider that isn't cooling down; when all are, the one that cools down first. */
export function chooseProvider(chain: string[], now: number, health: (name: string) => Health | undefined, unusable: (name: string) => string | undefined): Choice {
  const usable = chain.map((name, index) => ({ name, index })).filter(c => !unusable(c.name))
  if (!usable.length) {
    const name = chain[0] ?? DEFAULT_PROVIDER
    return { name, index: 0, fallback: false, healthy: false, unusable: unusable(name) ?? 'no provider' }
  }
  const ok = usable.find(c => !cooling(health(c.name), now))
  if (ok) return { ...ok, fallback: ok.index > 0, healthy: true }
  const soonest = [...usable].sort((a, b) => (health(a.name)?.coolUntil ?? 0) - (health(b.name)?.coolUntil ?? 0))[0]!
  return { ...soonest, fallback: soonest.index > 0, healthy: false }
}

// ---------------------------------------------------------------- launching

export type Launch = {
  name: string
  kind: ProviderKind
  /** Env for the session, secrets included: goes into a 0600 file its launch sources, never argv. Empty for default. */
  env: Record<string, string>
  configDir?: string
  /** settings.apiKeyHelper: prints the API key (no env var, so no "use this API key?" dialog). */
  apiKeyHelper?: string
  routerModel?: string
  workerModel?: string
}

export function buildLaunch(stateDir: string, name: string, def: ProviderDef | undefined, baseDir = baseConfigDir()): Launch {
  if (name === DEFAULT_PROVIDER || !def) return { name, kind: DEFAULT_PROVIDER, env: {} }
  const env: Record<string, string> = { ...KINDS[def.kind].env }
  for (const [k, v] of Object.entries(def.env ?? {})) if (ENV_NAME_RE.test(k) && !forbiddenEnv(k)) env[k] = String(v)
  const out: Launch = { name, kind: def.kind, env }
  const dir = configDirOf(stateDir, name, def)
  if (dir) {
    if (def.kind === 'login') ensureConfigDir(stateDir, name, dir, baseDir)
    out.configDir = dir
    env.CLAUDE_CONFIG_DIR = dir
  }
  for (const v of secretNames(stateDir, name)) {
    if (forbiddenEnv(v)) continue
    if (v === 'ANTHROPIC_API_KEY') out.apiKeyHelper = `cat ${shq(secretFile(stateDir, name, v))}`
    else {
      const value = readSecret(stateDir, name, v)
      if (value !== undefined) env[v] = value
    }
  }
  if (def.routerModel) out.routerModel = def.routerModel
  if (def.workerModel) out.workerModel = def.workerModel
  return out
}

/** Every config dir sessions may have written transcripts under. */
export function knownConfigDirs(stateDir: string, defs: Record<string, ProviderDef>, baseDir = baseConfigDir()): string[] {
  const dirs = [baseDir]
  for (const [n, d] of Object.entries(defs)) {
    if (!PROVIDER_NAME_RE.test(n)) continue
    const dir = configDirOf(stateDir, n, d)
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

function same(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/**
 * Make the session's transcript available under the config dir it is about to
 * run with (copied from wherever it is newest), so --resume finds it after a
 * provider switch. Returns whether a transcript exists there now.
 */
export function syncTranscript(cwd: string, sessionId: string, targetDir: string, dirs: string[]): boolean {
  const target = transcriptPath(cwd, sessionId, targetDir)
  const found = [targetDir, ...dirs.filter(d => d !== targetDir)]
    .map(d => transcriptPath(cwd, sessionId, d))
    .filter(f => existsSync(f))
    .map(f => ({ f, mtime: statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  const newest = found[0]
  if (!newest) return false
  if (newest.f === target || same(newest.f, target)) return true
  const mine = found.find(x => x.f === target)
  if (!mine || mine.mtime < newest.mtime) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(newest.f, target)
  }
  return true
}

// ---------------------------------------------------------------- startup screens

/** A provider problem visible on a session's startup screen. */
export function startupProblem(screen: string): { fault: FaultKind; reason: string } | undefined {
  if (/development-channels ignored|Channels are not available on third-party|Channels are not currently available|channels[^\n]{0,60}blocked by org policy|Inbound messages will be silently dropped/i.test(screen)) {
    return { fault: 'channels', reason: /third-party/i.test(screen) ? 'no channels on third-party providers' : /org policy/i.test(screen) ? 'channels blocked by org policy' : 'channels not available' }
  }
  if (/Choose the text style|Select login method/i.test(screen)) return { fault: 'auth', reason: 'not signed in (login screen at startup)' }
  const m = /Not logged in|Please run \/login|Run \/login|Invalid API key|Invalid auth token|OAuth token revoked|Login expired|Login reached its time limit|Authentication required|disabled API key authentication/i.exec(screen)
  if (m) return { fault: 'auth', reason: m[0] }
  return undefined
}

// ---------------------------------------------------------------- redaction

/** Hide anything that looks like a credential in text bound for logs, posts or status.json. */
export function redact(s: string): string {
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, 'AKIA…')
    .replace(/\b(?:Bearer|token|key)[=: ]+[A-Za-z0-9._~+/-]{12,}=*/gi, m => `${m.split(/[=: ]+/)[0]} …`)
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '…')
}

export function kindOf(name: string, defs: Record<string, ProviderDef>): ProviderKind | 'unknown' {
  if (name === DEFAULT_PROVIDER) return DEFAULT_PROVIDER
  const k = defs[name]?.kind
  return k && isKind(k) ? k : 'unknown'
}
