/**
 * Pure lifecycle rules: when an idle session closes, which session gives way
 * under cap pressure, and how a stopped session comes back. The Hub applies
 * them (src/hub/hub.ts); tests drive them with a fake clock.
 */

import type { Role } from '../shared/ipc'
import type { SessionStatus } from '../shared/snapshot'

export type ReapView = {
  key: string
  role: Role
  workspace: string
  status: SessionStatus
  pinned: boolean
  lastActiveAt: number
  /** People attached with `tmux attach`. */
  attached: number
  pendingPermissions: number
  /** Worker tasks delivered and not ended. */
  inFlight: number
}

export const LIVE_STATUSES: SessionStatus[] = ['starting', 'resuming', 'busy', 'idle', 'closing']

export function isLive(status: SessionStatus): boolean {
  return LIVE_STATUSES.includes(status)
}

/** Why a session must stay open right now, or undefined when it may close. */
export function holdReason(s: ReapView): string | undefined {
  if (s.status !== 'idle') return s.status
  if (s.pinned) return 'pinned'
  if (s.attached > 0) return 'attached'
  if (s.pendingPermissions > 0) return 'waiting on a permission prompt'
  if (s.inFlight > 0) return 'task in flight'
  return undefined
}

/** When an idle session will auto-close (undefined: never / not idle). */
export function closesAt(s: ReapView, idleMinutes: number): number | undefined {
  if (idleMinutes <= 0 || holdReason(s)) return undefined
  return s.lastActiveAt + idleMinutes * 60_000
}

/** Keys of sessions whose idle time has run out. */
export function dueForIdleClose(sessions: ReapView[], now: number, idleMinutes: (s: ReapView) => number): string[] {
  return sessions.filter(s => {
    const at = closesAt(s, idleMinutes(s))
    return at !== undefined && now >= at
  }).map(s => s.key)
}

/** Least recently used session of `role` that may be closed to make room. */
export function pickEvictee(sessions: ReapView[], role: Role, exclude: string[] = []): string | undefined {
  return sessions
    .filter(s => s.role === role && !exclude.includes(s.key) && !holdReason(s))
    .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]?.key
}

export type ResumePlan =
  | { mode: 'resume'; sessionId: string }
  | { mode: 'fresh'; sessionId: string; lostContext: boolean }

/**
 * Resume when the transcript exists; otherwise start fresh. A brand-new session
 * keeps its id; one that had turns but lost its transcript gets a new id (and
 * the router is told to re-read the thread).
 */
export function planStart(o: { sessionId: string; turns: number; transcriptExists: boolean; newId: () => string }): ResumePlan {
  if (o.transcriptExists) return { mode: 'resume', sessionId: o.sessionId }
  if (o.turns === 0) return { mode: 'fresh', sessionId: o.sessionId, lostContext: false }
  return { mode: 'fresh', sessionId: o.newId(), lostContext: true }
}

/**
 * A graceful restart may happen now: the session sits at its prompt with no
 * work in flight and no 🔐 prompt open. (Pinned or attached sessions may
 * restart; only work in progress makes it wait.)
 */
export function canRestartNow(s: Pick<ReapView, 'status' | 'inFlight' | 'pendingPermissions'>): boolean {
  return s.status === 'idle' && s.inFlight === 0 && s.pendingPermissions === 0
}

/**
 * What kind of API failure ended a turn (from the StopFailure hook's error text,
 * which starts with Claude Code's error type: authentication_failed, billing_error,
 * rate_limit, overloaded, server_error, invalid_request, model_not_found, …).
 *
 * - auth: the provider's credentials don't work (login expired, bad key, account on hold)
 * - quota: out of usage or credit (subscription usage limit, billing)
 * - rate_limit: too many requests (Claude Code already retried before giving up)
 * - transient: overloaded, 5xx, timeouts, network, unknown
 * - fatal: the request itself is wrong (prompt too long, unknown model): no retry helps
 */
export type FailureKind = 'rate_limit' | 'quota' | 'auth' | 'transient' | 'max_output' | 'fatal'

export function classifyFailure(error: string | undefined): FailureKind {
  const e = error ?? ''
  if (/authenticat|unauthori[sz]ed|invalid.?(api.?key|auth.?token|x-api-key)|\b40[13]\b|oauth|not logged in|\/login|login expired|account.?on.?hold|verification.?required|cloud.?credential|permission_error|forbidden/i.test(e)) return 'auth'
  if (/billing|credit|payment|quota|usage limit|limit reached|out of (extra )?usage|spend limit/i.test(e)) return 'quota'
  if (/rate.?limit|\b429\b|too many requests/i.test(e)) return 'rate_limit'
  if (/prompt is too long|context.?(window|length)|invalid.?request|\b400\b|unrecognized_model|model.?not.?found|not_found_error|\b404\b/i.test(e)) return 'fatal'
  if (/max.?output|max_tokens/i.test(e)) return 'max_output'
  return 'transient' // overloaded, 5xx, timeouts, network, unknown
}

/** Waits before automatic retry 1, 2, … of a failed turn; past the end, give up. */
export const RETRY_DELAYS: Record<FailureKind, number[]> = {
  transient: [20_000, 60_000, 180_000, 600_000],
  rate_limit: [300_000, 900_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000],
  // Usage limits reset after hours; credit can be topped up: keep trying, slowly.
  quota: [300_000, 900_000, 1_800_000, 3_600_000, 3_600_000, 3_600_000, 3_600_000],
  max_output: [3_000],
  // Credentials don't fix themselves: a person has to log in again (or the hub falls back to another provider).
  auth: [],
  fatal: [],
}

/** Delay before retry number `attempt` (1-based), or undefined: don't retry. */
export function retryDelay(kind: FailureKind, attempt: number): number | undefined {
  return attempt >= 1 ? RETRY_DELAYS[kind][attempt - 1] : undefined
}

/** Claude Code shows "esc to interrupt" while a turn runs. */
export function looksBusy(screen: string): boolean {
  return /esc to interrupt/i.test(screen)
}

/** Crash-loop guard: allow `max` automatic restarts per `windowMs`. */
export class RestartBudget {
  private hits = new Map<string, number[]>()
  constructor(private max = 2, private windowMs = 10 * 60_000) {}
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs)
    if (recent.length >= this.max) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }
}

/**
 * Whether a retry is worth telling the thread about. Short blips fix themselves and
 * stay quiet; a rate limit (a wait of minutes to hours) is said once; other API
 * errors only once they persist (the third try in a row).
 */
export function noticeForRetry(kind: FailureKind, attempt: number): 'rate_limit' | 'quota' | 'persistent' | undefined {
  if (kind === 'rate_limit' || kind === 'quota') return attempt === 1 ? kind : undefined
  if (kind === 'transient') return attempt === 3 ? 'persistent' : undefined
  return undefined
}
