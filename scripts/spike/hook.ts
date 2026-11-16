#!/usr/bin/env bun
/** Spike-only hook: logs the event; on SessionStart injects the token from token-<key>.txt. */
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'

const DIR = process.env.SPIKE_DIR!
const KEY = process.env.MMHUB_SESSION_KEY ?? 'unknown'
const input = JSON.parse(await Bun.stdin.text()) as Record<string, unknown>
const { transcript_path: _t, ...rest } = input
appendFileSync(join(DIR, 'events.jsonl'), JSON.stringify({ at: Date.now(), src: 'hook', key: KEY, ...rest }) + '\n')

if (input.hook_event_name === 'SessionStart') {
  const f = join(DIR, `token-${KEY}.txt`)
  const token = existsSync(f) ? readFileSync(f, 'utf8').trim() : 'none'
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `SPIKE_CONTEXT_TOKEN=${token}` } }),
  )
}
