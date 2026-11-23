import { describe, expect, test } from 'bun:test'
import { canRestartNow, classifyFailure, closesAt, dueForIdleClose, holdReason, looksBusy, noticeForRetry, pickEvictee, planStart, RestartBudget, retryDelay, type ReapView } from '../src/hub/lifecycle'

const MIN = 60_000
const T0 = 1_000_000_000

function s(p: Partial<ReapView> & { key: string }): ReapView {
  return { role: p.key.startsWith('r-') ? 'router' : 'worker', workspace: 'demo', status: 'idle', pinned: false, lastActiveAt: T0, attached: 0, pendingPermissions: 0, inFlight: 0, ...p }
}

const idle = (v: ReapView) => (v.role === 'router' ? 30 : 120)

describe('idle reaper (fake clock)', () => {
  test('closes at the threshold, not before', () => {
    const sessions = [s({ key: 'r-a' }), s({ key: 'w-b' })]
    expect(dueForIdleClose(sessions, T0 + 29 * MIN, idle)).toEqual([])
    expect(dueForIdleClose(sessions, T0 + 30 * MIN, idle)).toEqual(['r-a'])
    expect(dueForIdleClose(sessions, T0 + 120 * MIN, idle)).toEqual(['r-a', 'w-b'])
  })

  test('never closes busy, pinned, attached, prompting or in-flight sessions', () => {
    const later = T0 + 1000 * MIN
    const held = [
      s({ key: 'r-busy', status: 'busy' }),
      s({ key: 'r-pin', pinned: true }),
      s({ key: 'r-att', attached: 1 }),
      s({ key: 'w-perm', pendingPermissions: 1 }),
      s({ key: 'w-task', inFlight: 1 }),
      s({ key: 'r-start', status: 'starting' }),
    ]
    expect(dueForIdleClose(held, later, idle)).toEqual([])
    expect(held.map(holdReason)).toEqual(['busy', 'pinned', 'attached', 'waiting on a permission prompt', 'task in flight', 'starting'])
  })

  test('idleMinutes 0 means never', () => {
    expect(dueForIdleClose([s({ key: 'r-a' })], T0 + 10_000 * MIN, () => 0)).toEqual([])
    expect(closesAt(s({ key: 'r-a' }), 0)).toBeUndefined()
    expect(closesAt(s({ key: 'r-a' }), 30)).toBe(T0 + 30 * MIN)
  })

  test('cap pressure evicts the least recently used idle session of that role', () => {
    const sessions = [
      s({ key: 'w-new', lastActiveAt: T0 + 50 }),
      s({ key: 'w-old', lastActiveAt: T0 + 10 }),
      s({ key: 'w-oldest-pinned', lastActiveAt: T0, pinned: true }),
      s({ key: 'w-busy', lastActiveAt: T0 - 5, status: 'busy' }),
      s({ key: 'r-older', lastActiveAt: T0 - 100 }),
    ]
    expect(pickEvictee(sessions, 'worker')).toBe('w-old')
    expect(pickEvictee(sessions, 'worker', ['w-old'])).toBe('w-new')
    expect(pickEvictee(sessions, 'router')).toBe('r-older')
    expect(pickEvictee([s({ key: 'w-x', status: 'busy' })], 'worker')).toBeUndefined()
  })
})

describe('resume plan', () => {
  const newId = () => 'NEW'
  test('transcript present → resume same id', () => {
    expect(planStart({ sessionId: 'S', turns: 3, transcriptExists: true, newId })).toEqual({ mode: 'resume', sessionId: 'S' })
  })
  test('never ran → fresh with the same id', () => {
    expect(planStart({ sessionId: 'S', turns: 0, transcriptExists: false, newId })).toEqual({ mode: 'fresh', sessionId: 'S', lostContext: false })
  })
  test('ran but transcript gone → fresh with a new id, context lost', () => {
    expect(planStart({ sessionId: 'S', turns: 2, transcriptExists: false, newId })).toEqual({ mode: 'fresh', sessionId: 'NEW', lostContext: true })
  })
})

test('looksBusy', () => {
  expect(looksBusy('✻ Thinking… (esc to interrupt)')).toBe(true)
  expect(looksBusy('❯ \n  ? for shortcuts')).toBe(false)
})

test('restart budget', () => {
  const b = new RestartBudget(2, 10 * MIN)
  expect(b.take('w', T0)).toBe(true)
  expect(b.take('w', T0 + 1)).toBe(true)
  expect(b.take('w', T0 + 2)).toBe(false)
  expect(b.take('w', T0 + 11 * MIN)).toBe(true)
})

describe('graceful restart', () => {
  const v = (p: Partial<ReapView>) => ({ status: 'idle' as const, inFlight: 0, pendingPermissions: 0, ...p })
  test('only between turns, with nothing in flight and no 🔐 open', () => {
    expect(canRestartNow(v({}))).toBe(true)
    expect(canRestartNow(v({ status: 'busy' }))).toBe(false)
    expect(canRestartNow(v({ inFlight: 1 }))).toBe(false)
    expect(canRestartNow(v({ pendingPermissions: 1 }))).toBe(false)
    expect(canRestartNow(v({ background: 1 }))).toBe(false) // work left running would die with the process
    expect(holdReason(s({ key: 'w-1', background: 2 }))).toBe('background work running')
    expect(dueForIdleClose([s({ key: 'w-1', background: 1, lastActiveAt: 0 })], 10 * 3_600_000, () => 60)).toEqual([])
    expect(canRestartNow(v({ status: 'starting' }))).toBe(false)
  })
})

describe('API failure retries', () => {
  test('classify StopFailure error text', () => {
    expect(classifyFailure('rate_limit — 429 Too Many Requests')).toBe('rate_limit')
    expect(classifyFailure("Claude usage limit reached. Your limit will reset at 5pm")).toBe('quota')
    expect(classifyFailure('server_error — {"type":"overloaded_error","message":"Overloaded"}')).toBe('transient')
    expect(classifyFailure('API Error: 529 overloaded')).toBe('transient')
    expect(classifyFailure('Request timed out')).toBe('transient')
    expect(classifyFailure('ECONNRESET')).toBe('transient')
    expect(classifyFailure(undefined)).toBe('transient')
    expect(classifyFailure('authentication_failed — invalid x-api-key')).toBe('auth')
    expect(classifyFailure('OAuth token has expired · Please run /login')).toBe('auth')
    expect(classifyFailure('billing_error — credit balance is too low')).toBe('quota')
    expect(classifyFailure("You're out of extra usage · resets 5pm")).toBe('quota')
    expect(classifyFailure('invalid_request — prompt is too long: 210000 tokens > 200000 maximum')).toBe('fatal')
    expect(classifyFailure('max_output_tokens')).toBe('max_output')
  })
  test('backoff grows, then gives up; sign-in and fatal errors never retry', () => {
    expect(retryDelay('transient', 1)).toBe(20_000)
    expect(retryDelay('transient', 2)).toBe(60_000)
    expect(retryDelay('transient', 4)).toBe(600_000)
    expect(retryDelay('transient', 5)).toBeUndefined()
    expect(retryDelay('rate_limit', 1)).toBe(300_000)
    expect(retryDelay('rate_limit', 7)).toBe(3_600_000)
    expect(retryDelay('rate_limit', 8)).toBeUndefined()
    expect(retryDelay('quota', 1)).toBe(300_000)
    expect(retryDelay('auth', 1)).toBeUndefined()
    expect(retryDelay('max_output', 1)).toBe(3_000)
    expect(retryDelay('max_output', 2)).toBeUndefined()
    expect(retryDelay('fatal', 1)).toBeUndefined()
    expect(retryDelay('transient', 0)).toBeUndefined()
  })
})

describe('retry notices', () => {
  test('quiet for blips; a rate limit once; other errors once they persist', () => {
    expect([1, 2, 3, 4].map(a => noticeForRetry('transient', a))).toEqual([undefined, undefined, 'persistent', undefined])
    expect([1, 2, 3].map(a => noticeForRetry('rate_limit', a))).toEqual(['rate_limit', undefined, undefined])
    expect([1, 2].map(a => noticeForRetry('quota', a))).toEqual(['quota', undefined])
    expect(noticeForRetry('auth', 1)).toBeUndefined()
    expect(noticeForRetry('max_output', 1)).toBeUndefined()
    expect(noticeForRetry('fatal', 1)).toBeUndefined() // fatal errors are reported as failures, not retries
  })
})
