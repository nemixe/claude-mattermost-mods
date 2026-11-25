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
 * Claude Code's Code Mode (the REPL tool runs the model's scripts) adds two kinds:
 *
 * - a script that outlives its call: its result is a receipt (`asyncDispatched` with
 *   an `evalId`), and its end a `repl-eval` event of that number;
 * - the calls a script made without awaiting them, still running when it ended: its
 *   result or its event says so ("still running at script end"), and a later
 *   `repl-eval` event of status "late" says they ended.
 *
 * Such an event is queued when it happens, and reaches the model in a Poll result, or
 * in a `poll_events` attachment: while the session is idle, that starts a turn. What a
 * script's own commands and agents leave in the background is recorded like any
 * other's, but sometimes only as the script ends, after their notice.
 *
 * Tasks launched before the current process started died with the earlier one.
 * A task that never reports is given up on after BACKGROUND_MAX_MS.
 */

import { closeSync, openSync, readSync, statSync } from 'fs'

/** `Script`: a Code Mode script (id `eval:<number>`); `Calls`: the calls one left running (`calls:<number>`). */
export type BackgroundTask = { id: string; tool: 'Bash' | 'Agent' | 'Monitor' | 'Script' | 'Calls'; at: number }

/** The most of a transcript read the first time (tasks started before that are done, or forgotten). */
const FIRST_READ = 16 * 1024 * 1024
/** What a launch's or TaskStop's result has (in the JSON as Claude Code writes it), so other lines go unparsed. */
const MARKS = ['"backgroundTaskId":"', '"isAsync":true', '"timeoutMs":', '"task_type":"', '"evalId":', '"asyncDispatched":true']
/** A task heard nothing of for this long is taken as gone (its notice lost). */
export const BACKGROUND_MAX_MS = 12 * 3_600_000
/** Calls a script left running are stopped by Claude Code 2 hours after it ended. */
export const CALLS_MAX_MS = 130 * 60_000
/** What a script's result says when calls it didn't await still run (and, later, that they don't). */
const LEFT_RUNNING = /\d+ tool call\(s\) still running at script end \(/
const LEFT_ENDED = /tool calls that this script left running have ended|work that this script left running was stopped/

type Entry = {
  type?: string
  operation?: string
  origin?: { kind?: unknown }
  timestamp?: string
  content?: unknown
  message?: { content?: unknown }
  toolUseResult?: Record<string, unknown>
  attachment?: { type?: unknown; envelopes?: unknown; deliveredVia?: unknown }
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

/** The number of the Code Mode script a REPL result is of, and whether it is a receipt (the script runs on). */
function scriptOf(r: Record<string, unknown>): { id: number; receipt: boolean } | undefined {
  const receipt = r.asyncDispatched === true
  // Refused, or cancelled before it ran: nothing runs.
  if (receipt && (r.error !== undefined || r.neverRan !== undefined)) return undefined
  if (r.late === true) return undefined
  if (typeof r.evalId === 'number') return { id: r.evalId, receipt }
  const n = receipt && typeof r.result === 'string' ? /^\(dispatched #(\d+)\)$/.exec(r.result)?.[1] : undefined
  return n ? { id: Number(n), receipt } : undefined
}

type ScriptEvent = { id: number; status: string; text: string }

/**
 * The `repl-eval` events in a text: `<event nonce="…" kind="repl-eval" at="…" eval="3"
 * status="settled"><log>…</log>…</event>`, or with a JSON body that has the number and
 * the status instead of attributes. Their content can't hold a raw `</event`.
 */
function scriptEvents(text: string): ScriptEvent[] {
  const out: ScriptEvent[] = []
  for (const [, attrs, body] of text.matchAll(/<event\b([^>]*)>([\s\S]*?)<\/event\b/g)) {
    if (!/ kind="repl-eval"/.test(attrs!)) continue
    let id: unknown = / eval="(\d+)"/.exec(attrs!)?.[1]
    let status: unknown = / status="([^"]*)"/.exec(attrs!)?.[1]
    if (id === undefined) {
      try {
        ;({ eval: id, status } = JSON.parse(body!) as { eval?: unknown; status?: unknown })
      } catch {
        continue
      }
    }
    if (/^\d+$/.test(String(id))) out.push({ id: Number(id), status: String(status ?? ''), text: body! })
  }
  return out
}

/** A session's background tasks, read from its transcript. One per process: a new launch starts a new one. */
export class BackgroundTasks {
  private file = ''
  private offset = 0
  private partial = ''
  /** The first read started mid-file: drop text up to the first newline. */
  private skipToLine = false
  private open = new Map<string, BackgroundTask>()
  /** Tasks that ended, and when: a launch recorded after its end opens nothing. */
  private ended = new Map<string, number>()
  /** When Claude Code last started a turn with a task's notice or a script's event (0: none seen). */
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
      this.ended.clear()
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

  private start(id: string, tool: BackgroundTask['tool'], at: number): void {
    if (at < this.since) return
    const ended = this.ended.get(id)
    // Every id is used once, but an agent's: the same agent can be launched again.
    if (ended !== undefined && (tool !== 'Agent' || at <= ended)) return
    if (!this.open.has(id) || tool === 'Agent') this.open.set(id, { id, tool, at })
  }

  private end(id: string, at: number): void {
    this.open.delete(id)
    this.ended.set(id, at)
  }

  private line(line: string): void {
    const notice = line.includes('<task-notification>')
    const script = line.includes('kind=\\"repl-eval\\"')
    if (!notice && !script && !MARKS.some(m => line.includes(m))) return
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
      if (task) this.start(task.id, task.tool, at)
      // TaskStop: { message, task_id, task_type }
      if (typeof r.task_id === 'string' && typeof r.task_type === 'string') this.end(r.task_id, at)
      const s = scriptOf(r)
      if (s?.receipt) this.start(`eval:${s.id}`, 'Script', at)
      else if (s) this.scriptEnded(s.id, typeof r.stderr === 'string' ? r.stderr : '', at)
    }
    if (script) this.scriptLine(e, at)
    if (!notice) return
    // The notice is queued (queue-operation "enqueue") when the task ends, then shown to the model as a user message.
    const queuedNotice = e.type === 'queue-operation' && e.operation === 'enqueue'
    const text = queuedNotice ? textOf(e.content) : e.type === 'user' ? textOf(e.message?.content) : ''
    const fromClaudeCode = queuedNotice || (e.type === 'user' && (e.origin?.kind === 'task-notification' || (e.origin === undefined && text.startsWith('<task-notification>'))))
    if (!fromClaudeCode) return // a person quoting one, say
    for (const m of text.matchAll(/<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g)) {
      const body = m[1]!
      const id = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1]?.trim()
      if (id && /<status>[^<]+<\/status>/.test(body)) this.end(id, at) // no status: a Monitor event, the watch goes on
    }
    if (!queuedNotice && at >= this.since) this.promptedAt = Math.max(this.promptedAt, at)
  }

  /** A script ended; `said`: what it printed, with Claude Code's warning of calls still running. */
  private scriptEnded(id: number, said: string, at: number): void {
    if (at < this.since) return
    this.end(`eval:${id}`, at)
    if (LEFT_RUNNING.test(said)) this.start(`calls:${id}`, 'Calls', at)
  }

  /** An entry with `repl-eval` events: queued, in a Poll result, or given to the model between calls or as a turn. */
  private scriptLine(e: Entry, at: number): void {
    if (at < this.since) return // numbers start over with each process
    let text = ''
    let turn = false
    if (e.type === 'queue-operation' && e.operation === 'enqueue') {
      text = textOf(e.content)
      if (!text.startsWith('<event ')) return // a message that quotes one
    } else if (e.type === 'attachment' && e.attachment?.type === 'poll_events') {
      text = Array.isArray(e.attachment.envelopes) ? e.attachment.envelopes.filter(x => typeof x === 'string').join('\n') : ''
      turn = e.attachment.deliveredVia !== 'poll_tool'
    } else if (e.type === 'user' && typeof e.toolUseResult?.eventCount === 'number' && typeof e.toolUseResult.content === 'string') text = e.toolUseResult.content
    else if (e.type === 'user' && e.origin === undefined && e.toolUseResult === undefined) {
      text = textOf(e.message?.content)
      if (!/^<(event |system>authentic event nonces)/.test(text)) return
      turn = true
    }
    // "lost": a script of an earlier process, told of when the session resumes. Its number may be one of this process's too.
    const events = scriptEvents(text).filter(x => x.status !== 'lost')
    for (const x of events) {
      if (x.status !== 'late') this.scriptEnded(x.id, x.text, at)
      else if (LEFT_ENDED.test(x.text)) this.end(`calls:${x.id}`, at)
    }
    if (turn && events.length) this.promptedAt = Math.max(this.promptedAt, at)
  }

  /** The tasks still running (as of the last refresh). */
  running(now = Date.now()): BackgroundTask[] {
    return [...this.open.values()].filter(t => now - t.at < (t.tool === 'Calls' ? CALLS_MAX_MS : BACKGROUND_MAX_MS))
  }
}
