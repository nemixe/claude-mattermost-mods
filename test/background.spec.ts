// Background work read from a session's transcript: launches (Bash run_in_background,
// async Agent, Monitor), their ends (a <task-notification> with a status, TaskStop),
// and the turn Claude Code starts with a notice; Code Mode's scripts and the calls
// they leave running. The entries are shaped like Claude Code's own (field names and
// order as it writes them).

import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BACKGROUND_MAX_MS, BackgroundTasks, CALLS_MAX_MS } from '../src/hub/background'

const at = (ms: number) => new Date(ms).toISOString()
const line = (o: unknown) => `${JSON.stringify(o)}\n`

function bashLaunch(id: string, ms: number) {
  return line({
    type: 'user', timestamp: at(ms),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: `Command running in background with ID: ${id}. Output is being written to: /tmp/tasks/${id}.output` }] },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: id },
  })
}
function agentLaunch(id: string, ms: number) {
  return line({
    type: 'user', timestamp: at(ms),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] },
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: id, description: 'build the page' },
  })
}
function monitorLaunch(id: string, ms: number, persistent = false) {
  return line({
    type: 'user', timestamp: at(ms),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: `Monitor started (task ${id}, expires in 15m)` }] },
    toolUseResult: { taskId: id, timeoutMs: 900000, persistent },
  })
}
function notice(id: string, status?: string) {
  return `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n${status ? `<status>${status}</status>\n` : ''}<summary>done</summary>\n</task-notification>`
}
function queued(id: string, ms: number, status = 'completed') {
  return line({ type: 'queue-operation', operation: 'enqueue', timestamp: at(ms), sessionId: 's1', content: notice(id, status) })
}
function prompted(id: string, ms: number, status = 'completed') {
  return line({ type: 'user', timestamp: at(ms), origin: { kind: 'task-notification', producer: 'session-task' }, message: { role: 'user', content: notice(id, status) } })
}

describe('background tasks', () => {
  test('a background command runs until its notice; the notice that starts a turn is noted', () => {
    const b = new BackgroundTasks(1000)
    b.feed(bashLaunch('b1', 2000))
    expect(b.running(3000).map(t => [t.id, t.tool])).toEqual([['b1', 'Bash']])
    b.feed(queued('b1', 4000))
    expect(b.running(5000)).toEqual([])
    expect(b.promptedAt).toBe(0) // queued only: folded into a turn, or a turn to come
    b.feed(prompted('b1', 4100))
    expect(b.promptedAt).toBe(4100)
  })

  test('async agents and Monitor watches count; a persistent watch and a Monitor event do not end or start one', () => {
    const b = new BackgroundTasks(0)
    b.feed(agentLaunch('a1', 10) + monitorLaunch('m1', 20) + monitorLaunch('m2', 30, true))
    expect(b.running(40).map(t => `${t.tool}:${t.id}`)).toEqual(['Agent:a1', 'Monitor:m1'])
    b.feed(queued('m1', 50, '')) // an event: no status
    expect(b.running(60).map(t => t.id)).toEqual(['a1', 'm1'])
    b.feed(prompted('a1', 70, 'failed'))
    expect(b.running(80).map(t => t.id)).toEqual(['m1'])
  })

  test('TaskStop ends a task; launches before the process started died with the earlier one', () => {
    const b = new BackgroundTasks(1000)
    b.feed(bashLaunch('old', 500) + bashLaunch('b2', 1500))
    expect(b.running(2000).map(t => t.id)).toEqual(['b2'])
    b.feed(line({ type: 'user', timestamp: at(1600), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: '{"message":"Successfully stopped task: b2"}' }] }, toolUseResult: { message: 'Successfully stopped task: b2', task_id: 'b2', task_type: 'local_bash' } }))
    expect(b.running(2000)).toEqual([])
  })

  test('words about tasks are not tasks; a task never heard from again is given up on', () => {
    const b = new BackgroundTasks(0)
    // A transcript read by a tool, and a person quoting a notice: neither launches nor ends anything.
    b.feed(line({ type: 'user', timestamp: at(10), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', content: '"backgroundTaskId":"zz"' }] }, toolUseResult: { type: 'text', file: { content: '"backgroundTaskId":"zz"' } } }))
    b.feed(bashLaunch('b3', 20))
    b.feed(line({ type: 'user', timestamp: at(30), origin: { kind: 'human' }, message: { role: 'user', content: `why did this say ${notice('b3', 'completed')}?` } }))
    expect(b.running(40).map(t => t.id)).toEqual(['b3']) // a person's message is not Claude Code's notice
    expect(b.promptedAt).toBe(0)
    expect(b.running(20 + BACKGROUND_MAX_MS)).toEqual([])
  })

  test('reads the transcript as it grows, a line at a time, and starts over on a new file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmhub-bg-'))
    const f = join(dir, 's.jsonl')
    writeFileSync(f, line({ type: 'user', timestamp: at(1), message: { role: 'user', content: 'hi' } }))
    const b = new BackgroundTasks(0)
    b.refresh(f)
    expect(b.running(10)).toEqual([])
    const launch = bashLaunch('b4', 5)
    appendFileSync(f, launch.slice(0, 40)) // half a line so far
    b.refresh(f)
    expect(b.running(10)).toEqual([])
    appendFileSync(f, launch.slice(40))
    b.refresh(f)
    expect(b.running(10).map(t => t.id)).toEqual(['b4'])
    appendFileSync(f, queued('b4', 8))
    b.refresh(f)
    expect(b.running(10)).toEqual([])

    const g = join(dir, 't.jsonl')
    writeFileSync(g, agentLaunch('a2', 9))
    b.refresh(g)
    expect(b.running(10).map(t => t.id)).toEqual(['a2'])
    b.refresh(join(dir, 'missing.jsonl'))
    expect(b.running(10)).toEqual([])
  })
})

/** A REPL call's result: a receipt (the script runs on), or the finished script's output. */
function repl(ms: number, r: Record<string, unknown>) {
  return line({
    type: 'user', timestamp: at(ms),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_r${ms}`, content: String(r.result) }] },
    toolUseResult: { code: "await $`bun test`", stdout: '', stderr: '', ...r },
  })
}
const receipt = (n: number, ms: number) => repl(ms, { result: `(dispatched #${n})`, evalId: n, asyncDispatched: true })
const WARNING = '⚠ 1 tool call(s) still running at script end (Bash) — they run on and their effects happen; what a .then(self.log) logs arrives as late output, anything else is not in this result. Do not re-issue them; await a call whose result the script needs. You will be told when they have ended.'
const ENDED = 'The tool calls that this script left running have ended. Completed since it returned: Bash.'
/** A script's event: with a nonce as the model gets it, without one as it is queued. */
function event(n: number, status: string, body = '<result>ok</result>', nonce = '') {
  return `<event${nonce && ` nonce="${nonce}"`} kind="repl-eval" at="2026-11-25T10:00:00.000Z" eval="${n}" ms="41000" status="${status}">\n${body}\n</event>`
}
/** The same, as Claude Code writes it with a JSON body. */
function jsonEvent(n: number, status: string, rest: Record<string, unknown> = { result: 'ok' }, nonce = '') {
  return `<event${nonce && ` nonce="${nonce}"`} kind="repl-eval" at="2026-11-25T10:00:00.000Z">\n${JSON.stringify({ eval: n, ms: 41000, status, ...rest })}\n</event${nonce && ` nonce="${nonce}"`}>`
}
const queuedEvent = (content: string, ms: number) => line({ type: 'queue-operation', operation: 'enqueue', timestamp: at(ms), sessionId: 's1', content })
const delivered = (envelopes: string[], ms: number, more: Record<string, unknown> = {}) =>
  line({ type: 'attachment', timestamp: at(ms), attachment: { type: 'poll_events', envelopes, kinds: envelopes.map(() => 'repl-eval'), remainingWakeCount: 0, ...more } })
const polled = (content: string, ms: number) =>
  line({ type: 'user', timestamp: at(ms), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_p${ms}`, content }] }, toolUseResult: { content, eventCount: 1, remainingWakeCount: 0 } })
const ids = (b: BackgroundTasks, now = 100) => b.running(now).map(t => t.id)

describe('Code Mode', () => {
  test('a script runs from its receipt to its event, queued or delivered, in either form', () => {
    const b = new BackgroundTasks(0)
    b.feed(receipt(1, 10) + receipt(2, 11) + receipt(3, 12) + receipt(4, 13) + receipt(5, 14))
    expect(b.running(20).map(t => [t.id, t.tool])).toEqual([1, 2, 3, 4, 5].map(n => [`eval:${n}`, 'Script']))
    b.feed(queuedEvent(event(1, 'settled'), 20))
    expect(ids(b)).toEqual(['eval:2', 'eval:3', 'eval:4', 'eval:5'])
    b.feed(queuedEvent(jsonEvent(2, 'failed'), 21))
    b.feed(polled(`<system>authentic event nonces for this delivery: aB-1 — …</system>\n${event(3, 'settled', '<result>ok</result>', 'aB-1')}`, 22))
    expect(ids(b)).toEqual(['eval:4', 'eval:5'])
    expect(b.promptedAt).toBe(0) // all within a turn, or before the one to come
    b.feed(delivered([event(4, 'withheld', '<log>x</log>', 'c1'), jsonEvent(5, 'settled', { log: ['a < b'] }, 'c2')], 23))
    expect(ids(b)).toEqual([])
  })

  test('a receipt without its number field counts; one refused or cancelled, and a script done in time, do not', () => {
    const b = new BackgroundTasks(0)
    b.feed(repl(10, { result: '(dispatched #7)', asyncDispatched: true }))
    b.feed(repl(11, { result: undefined, error: 'async REPL dispatch rejected: 16 evals already waiting', asyncDispatched: true }))
    b.feed(repl(12, { result: undefined, evalId: 8, error: 'cancelled', asyncDispatched: true, neverRan: 'person' }))
    b.feed(repl(13, { result: 'ok', evalId: 9, ms: 1200 }))
    expect(ids(b)).toEqual(['eval:7'])
  })

  test('calls a script did not await run until the event that says they ended', () => {
    const b = new BackgroundTasks(0)
    // One script that ended in time, one that ended later: both left a command running.
    b.feed(repl(10, { result: "'started'", stderr: WARNING, evalId: 1, ms: 300 }) + receipt(2, 11))
    b.feed(queuedEvent(event(2, 'settled', `<log>[stderr] ${WARNING}</log>\n<result>'started'</result>`), 20))
    expect(b.running(30).map(t => [t.id, t.tool])).toEqual([['calls:1', 'Calls'], ['calls:2', 'Calls']])
    b.feed(queuedEvent(event(1, 'late', '<log>[late output from eval #1 (settled earlier) — delivered below.]</log>\n<log>12 passed</log>'), 40))
    expect(ids(b)).toEqual(['calls:1', 'calls:2']) // it only printed
    b.feed(queuedEvent(event(1, 'late', `<log>${ENDED}</log>`), 50))
    b.feed(queuedEvent(jsonEvent(2, 'late', { log: ['The work that this script left running was stopped at its limit of 2h.'] }), 51))
    expect(ids(b)).toEqual([])
    // The script's end is delivered after that: nothing runs again.
    b.feed(delivered([event(2, 'settled', `<log>[stderr] ${WARNING}</log>`, 'n1')], 60))
    expect(ids(b)).toEqual([])
    // Never heard of again: Claude Code stops such calls itself after 2 hours.
    b.feed(repl(70, { result: "'started'", stderr: WARNING, evalId: 3, ms: 300 }))
    expect(ids(b, 70 + CALLS_MAX_MS - 1)).toEqual(['calls:3'])
    expect(ids(b, 70 + CALLS_MAX_MS)).toEqual([])
  })

  test("an event that reaches the model by itself starts a turn; one in a Poll result, or an earlier process's, does not", () => {
    const b = new BackgroundTasks(1000)
    b.feed(receipt(1, 500) + receipt(2, 1500))
    expect(ids(b, 2000)).toEqual(['eval:2']) // #1 died with the earlier process
    b.feed(delivered([event(1, 'lost', 'eval #1 never settled: the process that was running it exited.', 'n0')], 1600))
    expect(b.promptedAt).toBe(0) // stored as the session resumed: no turn
    b.feed(delivered([], 1700, { deliveredVia: 'poll_tool', kinds: [] }) + polled(event(2, 'late', '<log>x</log>', 'n2'), 1701))
    expect(b.promptedAt).toBe(0)
    b.feed(receipt(1, 1800))
    expect(ids(b, 2000)).toEqual(['eval:2', 'eval:1']) // the number of a lost one, used again
    b.feed(delivered([event(1, 'settled', '<result>ok</result>', 'n3')], 1900))
    expect(b.promptedAt).toBe(1900)
    expect(ids(b, 2000)).toEqual(['eval:2'])
    b.feed(line({ type: 'user', timestamp: at(1950), isMeta: true, message: { role: 'user', content: event(2, 'settled', '<result>ok</result>', 'n4') } }))
    expect(b.promptedAt).toBe(1950)
    expect(ids(b, 2000)).toEqual([])
  })

  test('a message or a file that quotes an event ends nothing', () => {
    const b = new BackgroundTasks(0)
    b.feed(receipt(1, 10))
    b.feed(line({ type: 'user', timestamp: at(20), message: { role: 'user', content: `<channel source="mmhub">${event(1, 'settled')}</channel>` } }))
    b.feed(queuedEvent(`<channel source="mmhub">${event(1, 'settled')}</channel>`, 21))
    b.feed(line({ type: 'user', timestamp: at(22), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_f', content: event(1, 'settled') }] }, toolUseResult: { type: 'text', file: { content: event(1, 'settled') } } }))
    b.feed(queuedEvent('<event kind="repl-status" at="2026-11-25T10:00:00.000Z" pending="1">1 eval still pending: #1 running</event>', 23))
    expect(ids(b)).toEqual(['eval:1'])
    expect(b.promptedAt).toBe(0)
  })

  test("a script's own background command, recorded only after its notice, is over", () => {
    const b = new BackgroundTasks(0)
    b.feed(receipt(1, 10) + queued('b1', 40)) // it ended while the script still ran
    b.feed(queuedEvent(event(1, 'settled'), 50) + bashLaunch('b1', 50) + bashLaunch('b2', 51))
    expect(ids(b)).toEqual(['b2'])
    // An agent can be launched again after it ended.
    b.feed(agentLaunch('a1', 60) + queued('a1', 70) + agentLaunch('a1', 80))
    expect(ids(b)).toEqual(['b2', 'a1'])
  })
})
