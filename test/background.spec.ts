// Background work read from a session's transcript: launches (Bash run_in_background,
// async Agent, Monitor), their ends (a <task-notification> with a status, TaskStop),
// and the turn Claude Code starts with a notice. The entries are shaped like Claude
// Code's own (field names and order as it writes them).

import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BACKGROUND_MAX_MS, BackgroundTasks } from '../src/hub/background'

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
