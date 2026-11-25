/**
 * Small helpers shared by every process. chunk / safeName / PERMISSION_REPLY_RE
 * follow the official Telegram channel plugin's behaviour.
 */

import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { dirname, join, sep } from 'path'

// 5 lowercase letters a-z minus 'l'; case-insensitive for phone autocorrect.
// No bare yes/no and no chatter around it (same as Telegram).
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

/** Mattermost's default MaxPostSize is 16383 runes — leave headroom. */
export const MAX_POST_CHARS = 16000
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024
export const MAX_FILES_PER_POST = 10

export function chunk(text: string, limit: number, mode: 'length' | 'newline' = 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/**
 * User-controlled names (files, display names) land inside <channel> tag
 * attributes — strip delimiter chars so they can't break out of the tag.
 */
export function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;"]/g, '_')
}

/** Meta keys Claude Code accepts on channel events. */
export const META_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Refuse to upload the hub's own state (token, access.json), except inbox downloads. */
export function assertSendable(file: string, stateDir: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(file)
    stateReal = realpathSync(stateDir)
  } catch {
    return
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send hub state: ${file}`)
  }
}

/** Why the system refused a file operation; on a Mac, EPERM is nearly always privacy protection (external disks, Documents…). */
export function denied(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code !== 'EPERM') return code ?? errMsg(err)
  return process.platform === 'darwin' ? 'EPERM: macOS privacy protection keeps this process out, most likely' : 'EPERM: not permitted'
}

/**
 * A file or folder that is there but can't be read. What it holds may be fine,
 * so it is not to be taken for empty: whoever changes such a file must fail.
 */
export class Unreadable extends Error {
  constructor(readonly path: string, readonly why: string) {
    super(`can't read ${path} (${why})`)
  }
}

const reported = new Set<string>()

/** Log that a path can't be read: once, until readable() says it could be again. */
export function logUnreadable(err: Unreadable): void {
  if (reported.has(err.path)) return
  reported.add(err.path)
  log('state', err.message)
}

export function readable(path: string): void {
  if (reported.delete(path)) log('state', `can read ${path} again`)
}

/**
 * A JSON file, or the fallback when there is none. One that isn't valid JSON is
 * moved aside. Throws Unreadable when it can't be read at all (permissions, a
 * disk error): then it is left where it is.
 */
export function readJson<T>(path: string, fallback: () => T): T {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return fallback()
    throw new Unreadable(path, denied(err))
  }
  try {
    return JSON.parse(text) as T
  } catch {
    const aside = `${path}.corrupt-${Date.now()}`
    try {
      renameSync(path, aside)
      log('state', `${path} is not valid JSON: moved to ${aside}`)
    } catch (err) {
      log('state', `${path} is not valid JSON, and could not be moved aside: ${errMsg(err)}`)
    }
    return fallback()
  }
}

/** readJson for files only looked at: the fallback (logged once) when it can't be read. Never to change the file with. */
export function peekJson<T>(path: string, fallback: () => T): T {
  try {
    const v = readJson(path, fallback)
    readable(path)
    return v
  } catch (err) {
    if (!(err instanceof Unreadable)) throw err
    logUnreadable(err)
    return fallback()
  }
}

export function writeJsonAtomic(path: string, data: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode })
  renameSync(tmp, path)
}

/** Set KEY=VALUE in an env file (0600, written atomically), replacing the key's line; other lines are kept. */
export function setEnvVar(path: string, key: string, value: string): void {
  if (!/^\w+$/.test(key) || /[\r\n]/.test(value)) throw new Error(`bad env entry ${key}`)
  let lines: string[] = []
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch {}
  const kept = lines.filter(l => !new RegExp(`^\\s*${key}\\s*=`).test(l))
  while (kept.length && kept.at(-1)!.trim() === '') kept.pop()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, [...kept, `${key}=${value}`].join('\n') + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

/** Load KEY=VALUE lines into process.env (real env wins). Locks the file to 0600. */
export function loadEnvFile(path: string): void {
  try {
    chmodSync(path, 0o600)
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!
    }
  } catch {}
}

export function log(scope: string, msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] mmhub ${scope}: ${msg}\n`)
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function shortId(n = 6): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789'
  let s = ''
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  for (const b of bytes) s += alphabet[b % alphabet.length]
  return s
}

export function slug(s: string, max = 40): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'x'
}

export function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  return `${Math.floor(h / 24)}d`
}

export function fence(s: string): string {
  const longest = Math.max(2, ...[...s.matchAll(/`+/g)].map(m => m[0].length))
  return '`'.repeat(longest + 1)
}

/** Parse KEY=VALUE lines without touching process.env (keeps secrets out of child envs). */
export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    chmodSync(path, 0o600)
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/)
      if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
    }
  } catch {}
  return out
}
