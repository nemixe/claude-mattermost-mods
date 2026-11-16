/**
 * hub.db — runtime state (bun:sqlite, WAL). Only the hub writes it.
 *
 *  sessions  every claude process the hub manages (router or worker), live or stopped
 *  threads   Mattermost threads the hub owns → their router session
 *  workers   worker-specific fields (title, summary, linked threads, worktrees)
 *  tasks     work handed to workers
 *  inbox     messages handed to routers (kept until the turn that read them ends,
 *            so an interrupted router gets them again)
 */

import { Database } from 'bun:sqlite'
import type { CloseReason, SessionStatus } from '../shared/snapshot'

export type Role = 'router' | 'worker'

export type SessionRow = {
  key: string
  role: Role
  workspace: string
  sessionId: string
  status: SessionStatus
  pinned: boolean
  model: string
  cwd: string
  createdAt: number
  lastActiveAt: number
  busySince?: number
  closedAt?: number
  closeReason?: CloseReason
  /** Number of turns completed (0 → no transcript yet, --resume would fail). */
  turns: number
}

export type ThreadRow = {
  id: string
  channelId: string
  workspace: string
  routerKey: string
  label: string
  /** create_at of the newest post the router has been shown (digest cursor). */
  cursor: number
  createdAt: number
}

export type WorktreeInfo = { path: string; branch?: string; shared?: boolean }

export type WorkerRow = {
  key: string
  workspace: string
  title: string
  summary: string
  threads: string[]
  repos: Record<string, WorktreeInfo>
  activeThread?: string
  activeTask?: number
  lastPost?: string
}

export type TaskState = 'queued' | 'delivered' | 'ended' | 'failed' | 'interrupted'

/** A message for a router: queued → delivered → ended, or interrupted (re-delivered). */
export type MessageRow = {
  id: number
  sessionKey: string
  content: string
  meta: Record<string, string>
  state: TaskState
  createdAt: number
}

export type TaskRow = {
  id: number
  workerKey: string
  threadId: string
  channelId: string
  text: string
  state: TaskState
  createdAt: number
  deliveredAt?: number
  endedAt?: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  key TEXT PRIMARY KEY, role TEXT NOT NULL, workspace TEXT NOT NULL, session_id TEXT NOT NULL,
  status TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, cwd TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL, busy_since INTEGER,
  closed_at INTEGER, close_reason TEXT, turns INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, workspace TEXT NOT NULL, router_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workers (
  key TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
  threads TEXT NOT NULL DEFAULT '[]', repos TEXT NOT NULL DEFAULT '{}',
  active_thread TEXT, active_task INTEGER, last_post TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, worker_key TEXT NOT NULL, thread_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  text TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_worker ON tasks(worker_key, state);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, session_key TEXT NOT NULL, create_at INTEGER NOT NULL, message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS posts_thread ON posts(thread_id, create_at);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, content TEXT NOT NULL, meta TEXT NOT NULL,
  state TEXT NOT NULL, created_at INTEGER NOT NULL, delivered_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_session ON inbox(session_key, state);
CREATE TABLE IF NOT EXISTS links (
  thread_id TEXT PRIMARY KEY, kind TEXT NOT NULL, channel_id TEXT NOT NULL, from_key TEXT NOT NULL,
  from_workspace TEXT NOT NULL, from_thread TEXT, peer TEXT NOT NULL, chain TEXT NOT NULL DEFAULT '[]',
  messages INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_from ON links(from_key, created_at);
`

/**
 * A Mattermost thread the hub opened on a session's behalf, whose answers go
 * back to that session: a request to another workspace (a thread in one of its
 * channels, answered by its router) or a DM to an owner.
 */
export type LinkRow = {
  threadId: string
  kind: 'workspace' | 'dm'
  channelId: string
  /** The session that opened it; answers go to it. */
  fromKey: string
  fromWorkspace: string
  /** The thread the session was working for (answers arrive as work for it). */
  fromThread?: string
  /** The workspace asked, or the user id DMed. */
  peer: string
  /** Workspaces this request already came through, first the original asker's, last fromWorkspace. */
  chain: string[]
  /** Messages exchanged in it, both ways. */
  messages: number
  createdAt: number
}

/** A post the hub made for a session (the router digest reads workers' ones). */
export type PostRow = { id: string; threadId: string; sessionKey: string; createAt: number; message: string }

type Raw = Record<string, unknown>
const n = (v: unknown) => (v === null || v === undefined ? undefined : Number(v))
const s = (v: unknown) => (v === null || v === undefined ? undefined : String(v))

function toSession(r: Raw): SessionRow {
  return {
    key: String(r.key), role: r.role as Role, workspace: String(r.workspace), sessionId: String(r.session_id),
    status: r.status as SessionStatus, pinned: !!r.pinned, model: String(r.model), cwd: String(r.cwd),
    createdAt: Number(r.created_at), lastActiveAt: Number(r.last_active_at), busySince: n(r.busy_since),
    closedAt: n(r.closed_at), closeReason: s(r.close_reason) as CloseReason | undefined, turns: Number(r.turns),
  }
}
function toLink(r: Raw): LinkRow {
  let chain: string[] = []
  try {
    const c = JSON.parse(String(r.chain)) as unknown
    if (Array.isArray(c)) chain = c.map(String)
  } catch {}
  return {
    threadId: String(r.thread_id), kind: r.kind === 'dm' ? 'dm' : 'workspace', channelId: String(r.channel_id), fromKey: String(r.from_key),
    fromWorkspace: String(r.from_workspace), fromThread: s(r.from_thread), peer: String(r.peer), chain, messages: Number(r.messages), createdAt: Number(r.created_at),
  }
}
function toThread(r: Raw): ThreadRow {
  return {
    id: String(r.id), channelId: String(r.channel_id), workspace: String(r.workspace), routerKey: String(r.router_key),
    label: String(r.label), cursor: Number(r.cursor), createdAt: Number(r.created_at),
  }
}
function toWorker(r: Raw): WorkerRow {
  return {
    key: String(r.key), workspace: String(r.workspace), title: String(r.title), summary: String(r.summary ?? ''),
    threads: JSON.parse(String(r.threads ?? '[]')), repos: JSON.parse(String(r.repos ?? '{}')),
    activeThread: s(r.active_thread), activeTask: n(r.active_task), lastPost: s(r.last_post),
  }
}
function toTask(r: Raw): TaskRow {
  return {
    id: Number(r.id), workerKey: String(r.worker_key), threadId: String(r.thread_id), channelId: String(r.channel_id),
    text: String(r.text), state: r.state as TaskState, createdAt: Number(r.created_at),
    deliveredAt: n(r.delivered_at), endedAt: n(r.ended_at),
  }
}

function toMessage(r: Raw): MessageRow {
  let meta: Record<string, string> = {}
  try {
    meta = JSON.parse(String(r.meta))
  } catch {}
  return {
    id: Number(r.id), sessionKey: String(r.session_key), content: String(r.content), meta,
    state: r.state as TaskState, createdAt: Number(r.created_at),
  }
}

/** Unfinished first-in-first-out: interrupted ones (re-delivery) before queued ones. */
function pendingOrder<T extends { id: number; state: TaskState }>(rows: T[]): T[] {
  return rows.sort((a, b) => (a.state === b.state ? a.id - b.id : a.state === 'interrupted' ? -1 : 1))
}

export class Store {
  readonly db: Database

  constructor(file: string) {
    this.db = new Database(file, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;')
    this.db.exec(SCHEMA)
  }

  // ---------------------------------------------------------------- sessions

  session(key: string): SessionRow | undefined {
    const r = this.db.query('SELECT * FROM sessions WHERE key = ?').get(key) as Raw | null
    return r ? toSession(r) : undefined
  }

  sessions(where?: { workspace?: string; role?: Role }): SessionRow[] {
    const conds: string[] = []
    const args: string[] = []
    if (where?.workspace) { conds.push('workspace = ?'); args.push(where.workspace) }
    if (where?.role) { conds.push('role = ?'); args.push(where.role) }
    const sql = `SELECT * FROM sessions${conds.length ? ` WHERE ${conds.join(' AND ')}` : ''} ORDER BY last_active_at DESC`
    return (this.db.query(sql).all(...args) as Raw[]).map(toSession)
  }

  insertSession(r: SessionRow): void {
    this.db.query(`INSERT INTO sessions (key, role, workspace, session_id, status, pinned, model, cwd, created_at, last_active_at, turns)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.key, r.role, r.workspace, r.sessionId, r.status, r.pinned ? 1 : 0, r.model, r.cwd, r.createdAt, r.lastActiveAt, r.turns)
  }

  patchSession(key: string, p: Partial<Omit<SessionRow, 'key' | 'role'>>): void {
    const map: Record<string, string> = {
      workspace: 'workspace', sessionId: 'session_id', status: 'status', pinned: 'pinned', model: 'model', cwd: 'cwd',
      lastActiveAt: 'last_active_at', busySince: 'busy_since', closedAt: 'closed_at', closeReason: 'close_reason', turns: 'turns',
    }
    const sets: string[] = []
    const args: (string | number | null)[] = []
    for (const [k, v] of Object.entries(p)) {
      const col = map[k]
      if (!col) continue
      sets.push(`${col} = ?`)
      args.push(v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number))
    }
    if (!sets.length) return
    this.db.query(`UPDATE sessions SET ${sets.join(', ')} WHERE key = ?`).run(...args, key)
  }

  // ---------------------------------------------------------------- threads

  thread(id: string): ThreadRow | undefined {
    const r = this.db.query('SELECT * FROM threads WHERE id = ?').get(id) as Raw | null
    return r ? toThread(r) : undefined
  }

  threadByRouter(key: string): ThreadRow | undefined {
    const r = this.db.query('SELECT * FROM threads WHERE router_key = ?').get(key) as Raw | null
    return r ? toThread(r) : undefined
  }

  threads(workspace?: string): ThreadRow[] {
    const rows = workspace
      ? this.db.query('SELECT * FROM threads WHERE workspace = ? ORDER BY created_at DESC').all(workspace)
      : this.db.query('SELECT * FROM threads ORDER BY created_at DESC').all()
    return (rows as Raw[]).map(toThread)
  }

  insertThread(t: ThreadRow): void {
    this.db.query('INSERT INTO threads (id, channel_id, workspace, router_key, label, cursor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.channelId, t.workspace, t.routerKey, t.label, t.cursor, t.createdAt)
  }

  setCursor(threadId: string, cursor: number): void {
    this.db.query('UPDATE threads SET cursor = MAX(cursor, ?) WHERE id = ?').run(cursor, threadId)
  }

  // ---------------------------------------------------------------- workers

  worker(key: string): WorkerRow | undefined {
    const r = this.db.query('SELECT * FROM workers WHERE key = ?').get(key) as Raw | null
    return r ? toWorker(r) : undefined
  }

  workers(workspace: string): WorkerRow[] {
    return (this.db.query('SELECT * FROM workers WHERE workspace = ?').all(workspace) as Raw[]).map(toWorker)
  }

  insertWorker(w: WorkerRow): void {
    this.db.query('INSERT INTO workers (key, workspace, title, summary, threads, repos) VALUES (?, ?, ?, ?, ?, ?)')
      .run(w.key, w.workspace, w.title, w.summary, JSON.stringify(w.threads), JSON.stringify(w.repos))
  }

  patchWorker(key: string, p: Partial<Omit<WorkerRow, 'key' | 'workspace'>>): void {
    const sets: string[] = []
    const args: (string | number | null)[] = []
    const put = (col: string, v: string | number | null) => { sets.push(`${col} = ?`); args.push(v) }
    if (p.title !== undefined) put('title', p.title)
    if (p.summary !== undefined) put('summary', p.summary)
    if (p.threads !== undefined) put('threads', JSON.stringify(p.threads))
    if (p.repos !== undefined) put('repos', JSON.stringify(p.repos))
    if ('activeThread' in p) put('active_thread', p.activeThread ?? null)
    if ('activeTask' in p) put('active_task', p.activeTask ?? null)
    if (p.lastPost !== undefined) put('last_post', p.lastPost)
    if (!sets.length) return
    this.db.query(`UPDATE workers SET ${sets.join(', ')} WHERE key = ?`).run(...args, key)
  }

  deleteWorker(key: string): void {
    this.db.query('DELETE FROM workers WHERE key = ?').run(key)
    this.db.query('DELETE FROM sessions WHERE key = ?').run(key)
    this.db.query("UPDATE tasks SET state = 'failed' WHERE worker_key = ? AND state IN ('queued','delivered','interrupted')").run(key)
  }

  // ---------------------------------------------------------------- tasks

  task(id: number): TaskRow | undefined {
    const r = this.db.query('SELECT * FROM tasks WHERE id = ?').get(id) as Raw | null
    return r ? toTask(r) : undefined
  }

  insertTask(t: Omit<TaskRow, 'id'>): number {
    const r = this.db.query('INSERT INTO tasks (worker_key, thread_id, channel_id, text, state, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(t.workerKey, t.threadId, t.channelId, t.text, t.state, t.createdAt)
    return Number(r.lastInsertRowid)
  }

  tasksFor(workerKey: string, states: TaskState[]): TaskRow[] {
    const qs = states.map(() => '?').join(',')
    return (this.db.query(`SELECT * FROM tasks WHERE worker_key = ? AND state IN (${qs}) ORDER BY id`).all(workerKey, ...states) as Raw[]).map(toTask)
  }

  setTaskState(id: number, state: TaskState, at = Date.now()): void {
    const col = state === 'delivered' ? 'delivered_at' : state === 'queued' ? null : 'ended_at'
    if (col) this.db.query(`UPDATE tasks SET state = ?, ${col} = ? WHERE id = ?`).run(state, at, id)
    else this.db.query('UPDATE tasks SET state = ? WHERE id = ?').run(state, id)
  }

  /** Work still open for a thread: queued, in progress, or waiting to be re-delivered. */
  openTasksIn(threadId: string): TaskRow[] {
    return (this.db.query("SELECT * FROM tasks WHERE thread_id = ? AND state IN ('queued', 'delivered', 'interrupted') ORDER BY id").all(threadId) as Raw[]).map(toTask)
  }

  /** Tasks not yet finished, oldest first: interrupted ones (re-delivery) before queued ones. */
  pendingTasks(workerKey: string): TaskRow[] {
    return pendingOrder(this.tasksFor(workerKey, ['interrupted', 'queued']))
  }

  // ---------------------------------------------------------------- inbox (router messages)

  insertMessage(m: { sessionKey: string; content: string; meta: Record<string, string>; state: TaskState; createdAt: number }): number {
    const r = this.db.query('INSERT INTO inbox (session_key, content, meta, state, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(m.sessionKey, m.content, JSON.stringify(m.meta), m.state, m.createdAt)
    return Number(r.lastInsertRowid)
  }

  messagesFor(sessionKey: string, states: TaskState[]): MessageRow[] {
    const qs = states.map(() => '?').join(',')
    return (this.db.query(`SELECT * FROM inbox WHERE session_key = ? AND state IN (${qs}) ORDER BY id`).all(sessionKey, ...states) as Raw[]).map(toMessage)
  }

  setMessageState(id: number, state: TaskState, at = Date.now()): void {
    const col = state === 'delivered' ? 'delivered_at' : state === 'queued' ? null : 'ended_at'
    if (col) this.db.query(`UPDATE inbox SET state = ?, ${col} = ? WHERE id = ?`).run(state, at, id)
    else this.db.query('UPDATE inbox SET state = ? WHERE id = ?').run(state, id)
  }

  /** Messages not yet read to the end of a turn: interrupted ones first, then queued. */
  pendingMessages(sessionKey: string): MessageRow[] {
    return pendingOrder(this.messagesFor(sessionKey, ['interrupted', 'queued']))
  }

  /** Forget finished router messages older than `before`. */
  pruneMessages(before: number): void {
    this.db.query("DELETE FROM inbox WHERE state IN ('ended','failed') AND created_at < ?").run(before)
  }

  /** Work a session was given and had not finished (tasks or messages) → `to`. */
  moveDelivered(key: string, to: TaskState): number {
    const now = Date.now()
    const t = this.db.query("UPDATE tasks SET state = ?, ended_at = ? WHERE worker_key = ? AND state = 'delivered'").run(to, now, key)
    const m = this.db.query("UPDATE inbox SET state = ?, ended_at = ? WHERE session_key = ? AND state = 'delivered'").run(to, now, key)
    return Number(t.changes) + Number(m.changes)
  }

  // ---------------------------------------------------------------- posts

  insertPost(p: PostRow): void {
    this.db.query('INSERT OR REPLACE INTO posts (id, thread_id, session_key, create_at, message) VALUES (?, ?, ?, ?, ?)')
      .run(p.id, p.threadId, p.sessionKey, p.createAt, p.message.slice(0, 4000))
  }

  postsSince(threadId: string, since: number, rolePrefix?: string): PostRow[] {
    const rows = this.db.query('SELECT * FROM posts WHERE thread_id = ? AND create_at > ? ORDER BY create_at').all(threadId, since) as Raw[]
    return rows
      .map(r => ({ id: String(r.id), threadId: String(r.thread_id), sessionKey: String(r.session_key), createAt: Number(r.create_at), message: String(r.message) }))
      .filter(p => !rolePrefix || p.sessionKey.startsWith(rolePrefix))
  }

  postOwner(id: string): string | undefined {
    const r = this.db.query('SELECT session_key FROM posts WHERE id = ?').get(id) as Raw | null
    return r ? String(r.session_key) : undefined
  }

  // ---------------------------------------------------------------- links

  insertLink(l: Omit<LinkRow, 'messages'>): void {
    this.db.query('INSERT INTO links (thread_id, kind, channel_id, from_key, from_workspace, from_thread, peer, chain, messages, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
      .run(l.threadId, l.kind, l.channelId, l.fromKey, l.fromWorkspace, l.fromThread ?? null, l.peer, JSON.stringify(l.chain), l.createdAt)
  }

  link(threadId: string): LinkRow | undefined {
    const r = this.db.query('SELECT * FROM links WHERE thread_id = ?').get(threadId) as Raw | null
    return r ? toLink(r) : undefined
  }

  /** Links a session opened, newest first (since `since`). */
  linksFrom(fromKey: string, since = 0): LinkRow[] {
    return (this.db.query('SELECT * FROM links WHERE from_key = ? AND created_at >= ? ORDER BY created_at DESC').all(fromKey, since) as Raw[]).map(toLink)
  }

  linkChannels(): string[] {
    return (this.db.query('SELECT DISTINCT channel_id FROM links').all() as Raw[]).map(r => String(r.channel_id))
  }

  /** One more message through a link; returns the new count. */
  bumpLink(threadId: string): number {
    this.db.query('UPDATE links SET messages = messages + 1 WHERE thread_id = ?').run(threadId)
    return this.link(threadId)?.messages ?? 0
  }

  // ---------------------------------------------------------------- kv

  get(k: string): string | undefined {
    const r = this.db.query('SELECT v FROM kv WHERE k = ?').get(k) as Raw | null
    return r ? String(r.v) : undefined
  }

  set(k: string, v: string): void {
    this.db.query('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, v)
  }

  del(k: string): void {
    this.db.query('DELETE FROM kv WHERE k = ?').run(k)
  }

  close(): void {
    this.db.close()
  }
}
