#!/usr/bin/env bun
/**
 * Hook notifier for hub-spawned sessions (SessionStart, Stop, StopFailure,
 * SessionEnd): tells the hub, and on SessionStart prints the hub's fresh
 * context (repo map, workers, worktrees) as additionalContext.
 * Always exits 0 — a hub that is down must never block a session.
 */

import { roundTrip, type HookEvent } from './shared/ipc'
import { paths } from './shared/paths'
import { SESSION_KEY_RE } from './shared/snapshot'

const EVENTS: HookEvent[] = ['SessionStart', 'Stop', 'StopFailure', 'SessionEnd']

try {
  const input = JSON.parse((await Bun.stdin.text()) || '{}') as {
    hook_event_name?: string
    session_id?: string
    source?: string
    error?: unknown
    error_type?: unknown
    error_details?: unknown
    message?: unknown
  }
  const key = process.argv[2] ?? process.env.MMHUB_SESSION_KEY ?? ''
  const event = input.hook_event_name as HookEvent
  if (SESSION_KEY_RE.test(key) && EVENTS.includes(event)) {
    // StopFailure: the hub decides from this text whether to retry (rate limit, overloaded, …).
    const text = (v: unknown) => (v === undefined || v === null || v === '' ? '' : typeof v === 'string' ? v : JSON.stringify(v))
    const err = [...new Set([input.error, input.error_type, input.error_details, input.message].map(text).filter(Boolean))].join(' — ')
    const res = await roundTrip(paths().sock, {
      t: 'hook',
      key,
      event,
      ...(input.session_id ? { session_id: input.session_id } : {}),
      ...(process.env.MMHUB_SPAWN ? { spawn: process.env.MMHUB_SPAWN } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(err ? { error: err.slice(0, 500) } : {}),
    }, 5000)
    if (event === 'SessionStart' && res.t === 'hook_result' && res.additionalContext) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: res.additionalContext } }))
    }
  }
} catch {
  // hub down or bad input: stay silent
}
process.exit(0)
