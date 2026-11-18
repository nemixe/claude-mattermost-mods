#!/usr/bin/env bun
/**
 * Hook notifier for hub-spawned sessions (SessionStart, Stop, StopFailure,
 * SessionEnd): tells the hub, and on SessionStart prints the hub's fresh
 * context (repo map, workers, worktrees) as additionalContext. On Stop the hub
 * may send the turn back ("decision": "block") when it ended with text but
 * posted nothing: that text went to the terminal, where nobody reads it.
 * Always exits 0 — a hub that is down must never block a session.
 */

import { readFileSync } from 'node:fs'
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
    stop_hook_active?: boolean
    last_assistant_message?: string
    transcript_path?: string
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
      ...(event === 'Stop' ? { stop_hook_active: !!input.stop_hook_active, text: lastText(input).trim().slice(0, 200) } : {}),
    }, 5000)
    if (event === 'SessionStart' && res.t === 'hook_result' && res.additionalContext) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: res.additionalContext } }))
    }
    if (event === 'Stop' && res.t === 'hook_result' && res.block) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: res.block }))
    }
  }
} catch {
  // hub down or bad input: stay silent
}
process.exit(0)

/**
 * The text the turn ended with: Claude Code's last_assistant_message, or (older
 * versions) the text blocks at the end of the transcript, after its last tool call.
 */
function lastText(input: { last_assistant_message?: string; transcript_path?: string }): string {
  if (typeof input.last_assistant_message === 'string') return input.last_assistant_message
  if (!input.transcript_path) return ''
  try {
    const lines = readFileSync(input.transcript_path, 'utf8').trimEnd().split('\n')
    const texts: string[] = []
    for (let i = lines.length - 1; i >= 0; i--) {
      let e: { type?: string; message?: { content?: unknown } }
      try {
        e = JSON.parse(lines[i]!)
      } catch {
        continue
      }
      if (e.type === 'user') break
      if (e.type !== 'assistant') continue
      const blocks = Array.isArray(e.message?.content) ? (e.message.content as { type?: string; text?: string }[]) : []
      if (blocks.some(b => b.type === 'tool_use')) break
      for (const b of blocks.reverse()) if (b.type === 'text' && b.text) texts.unshift(b.text)
    }
    return texts.join('\n')
  } catch {
    return ''
  }
}
