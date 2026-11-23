/**
 * Work a session left running in the background: a Bash command run with
 * run_in_background, an Agent launched async, a Monitor watch. The session's turn
 * ends while that work goes on, and when it finishes Claude Code starts a turn by
 * itself to deal with it (a <task-notification>). The hub hears of neither through
 * hooks, so it reads them from the session's transcript as it grows:
 *
 * - a launch is a tool result whose `toolUseResult` names the task: Bash's
 *   `backgroundTaskId`, an async Agent's `agentId`, a Monitor's `taskId` (a
 *   persistent watch is not work under way, and doesn't count);
 * - an end is a <task-notification> for that task id with a <status> (completed,
 *   failed, stopped, killed), or a TaskStop result for it. Monitor events carry no
 *   status: the watch goes on.
 *
 * A notice is queued when its task ends. During a turn it is folded into that turn;
 * otherwise Claude Code starts a turn with it (a user entry from origin
 * "task-notification"): `promptedAt` tells the hub such a turn runs.
 *
 * Tasks launched before the current process started died with the earlier one.
 * A task that never reports is given up on after BACKGROUND_MAX_MS.
 */

import { closeSync, openSync, readSync, statSync } from 'fs'

export type BackgroundTask = { id: string; tool: 'Bash' | 'Agent' | 'Monitor'; at: number }

/** The most of a transcript read the first time (tasks started before that are done, or forgotten). */
const FIRST_READ = 16 * 1024 * 1024
/** What a launch's or TaskStop's result has (in the JSON as Claude Code writes it), so other lines go unparsed. */
const MARKS = ['"backgroundTaskId":"', '"isAsync":true', '"timeoutMs":', '"task_type":"']
/** A task heard nothing of for this long is taken as gone (its notice lost). */
export const BACKGROUND_MAX_MS = 12 * 3_600_000

type Entry = {
  type?: string
  operation?: string
  origin?: { kind?: unknown }
  timestamp?: string
  content?: unknown
  message?: { content?: unknown }
  toolUseResult?: Record<string, unknown>
}

/** The text of a message's content (a string, or its text blocks; not tool results). */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n')
}

/** The task a tool result started in the background, if it did. */
function launched(r: Record<string, unknown>): Pick<BackgroundTask, 'id' | 'tool'> | undefined {
  if (typeof r.backgroundTaskId === 'string' && r.backgroundTaskId) return { id: r.backgroundTaskId, tool: 'Bash' }
  if (r.isAsync === true && typeof r.agentId === 'string' && r.agentId) return { id: r.agentId, tool: 'Agent' }
  if (typeof r.taskId === 'string' && r.taskId && typeof r.timeoutMs === 'number' && r.persistent !== true) return { id: r.taskId, tool: 'Monitor' }
  return undefined
}

/** A session's background tasks, read from its transcript. One per process: a new launch starts a new one. */
export class BackgroundTasks {
  private file = ''
  private offset = 0
  private partial = ''
  /** The first read started mid-file: drop text up to the first newline. */
  private skipToLine = false
  private open = new Map<string, BackgroundTask>()
  /** When Claude Code last started a turn with a task's notice (0: none seen). */
  promptedAt = 0

  /** `since`: when the current process started (earlier launches died with their process). */
  constructor(readonly since: number) {}

  /** Read what the transcript gained since the last call (a new file starts over). */
  refresh(file: string): void {
    if (file !== this.file) {
      this.file = file
      this.offset = -1
      this.partial = ''
      this.open.clear()
    }
    let size: number
    try {
      size = statSync(file).size
    } catch {
      return
    }
    if (this.offset < 0 || size < this.offset) {
      // First read (or the file was rewritten): its end only, from a line start.
      this.offset = Math.max(0, size - FIRST_READ)
      this.partial = ''
      this.skipToLine = this.offset > 0
    }
    if (size === this.offset) return
    let fd: number | undefined
    try {
      fd = openSync(file, 'r')
      const buf = Buffer.alloc(size - this.offset)
      const n = readSync(fd, buf, 0, buf.length, this.offset)
      this.offset += n
      let text = buf.subarray(0, n).toString('utf8')
      if (this.skipToLine) {
        const nl = text.indexOf('\n')
        text = nl >= 0 ? text.slice(nl + 1) : ''
        this.skipToLine = nl < 0
      }
      this.feed(text)
    } catch {
      // Unreadable for now: try again next time.
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  /** Transcript text, as it comes (a last line without its newline waits for the rest). */
  feed(text: string): void {
    const lines = (this.partial + text).split('\n')
    this.partial = lines.pop() ?? ''
    for (const line of lines) this.line(line)
  }

  private line(line: string): void {
    const notice = line.includes('<task-notification>')
    if (!notice && !MARKS.some(m => line.includes(m))) return
    let e: Entry
    try {
      e = JSON.parse(line) as Entry
    } catch {
      return
    }
    const at = Date.parse(e.timestamp ?? '') || 0
    const r = e.toolUseResult
    if (e.type === 'user' && r && typeof r === 'object' && !Array.isArray(r)) {
      const task = launched(r)
      if (task && at >= this.since) this.open.set(task.id, { ...task, at })
      // TaskStop: { message, task_id, task_type }
      if (typeof r.task_id === 'string' && typeof r.task_type === 'string') this.open.delete(r.task_id)
    }
    if (!notice) return
    // The notice is queued (queue-operation "enqueue") when the task ends, then shown to the model as a user message.
    const queuedNotice = e.type === 'queue-operation' && e.operation === 'enqueue'
    const text = queuedNotice ? textOf(e.content) : e.type === 'user' ? textOf(e.message?.content) : ''
    const fromClaudeCode = queuedNotice || (e.type === 'user' && (e.origin?.kind === 'task-notification' || (e.origin === undefined && text.startsWith('<task-notification>'))))
    if (!fromClaudeCode) return // a person quoting one, say
    for (const m of text.matchAll(/<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g)) {
      const body = m[1]!
      const id = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1]?.trim()
      if (id && /<status>[^<]+<\/status>/.test(body)) this.open.delete(id) // no status: a Monitor event, the watch goes on
    }
    if (!queuedNotice && at >= this.since) this.promptedAt = Math.max(this.promptedAt, at)
  }

  /** The tasks still running (as of the last refresh). */
  running(now = Date.now()): BackgroundTask[] {
    return [...this.open.values()].filter(t => now - t.at < BACKGROUND_MAX_MS)
  }
}
