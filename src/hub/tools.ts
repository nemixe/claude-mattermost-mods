/**
 * Tool calls from bridges. Routers are scoped to their own thread; workers to
 * the threads linked to them. Anything that changes hub state (delegate,
 * prepare_repo, update_summary) runs on the hub's chain.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { isAbsolute, join } from 'path'
import { assertSendable, chunk, errMsg, fmtAge, log, MAX_ATTACHMENT_BYTES, MAX_FILES_PER_POST, MAX_POST_CHARS, safeName } from '../shared/util'
import { judged, judgeName } from './config'
import type { Hub } from './hub'
import { isLive } from './lifecycle'
import { loadTrigger, MAX_RULES, RULE_MAX_CHARS, saveTrigger, triggerFile, usableRules } from './laya'
import { listSchedulesTool, scheduleTool, unscheduleTool } from './jobs'
import { answerRequest, forwardAnswer, linkedTo, listWorkspacesText, messageWorkspace, sendDM } from './links'
import { inDM, setFollowing } from './trigger'
import type { MMPost } from './mattermost'
import { checkBotMentions } from './bots'
import { newThread } from './newthread'
import { addRepoTool } from './addrepo'
import { isDraft, type ThreadRow } from './store'
import { effective, prepareWorktree } from './workspaces'
import { listChannels, ownThread, postIdOf, readChannel, readOtherThread, searchMessages, threadText } from './explore'

export class ToolError extends Error {}

type Args = Record<string, unknown>

function str(a: Args, k: string, required = true): string | undefined {
  const v = a[k]
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`missing "${k}"`)
    return undefined
  }
  if (typeof v !== 'string') throw new ToolError(`"${k}" must be a string`)
  return v
}

/** A whole number (also given as "3" or "#3"). */
function int(a: Args, k: string, required = true): number | undefined {
  const v = a[k]
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`missing "${k}"`)
    return undefined
  }
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/^#/, '')) : NaN
  if (!Number.isInteger(n)) throw new ToolError(`"${k}" must be a whole number`)
  return n
}

function strList(a: Args, k: string): string[] {
  const v = a[k]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new ToolError(`"${k}" must be a list of strings`)
  return v as string[]
}

/** Threads this session may act in; the first is the default. */
function scope(hub: Hub, key: string): ThreadRow[] {
  return hub.threadsOf(key)
}

function threadFor(hub: Hub, key: string, a: Args): ThreadRow {
  const threads = scope(hub, key)
  if (key.startsWith('r-')) {
    if (!threads[0]) throw new ToolError('this router has no thread')
    return threads[0]
  }
  const id = hub.store.threadId(str(a, 'thread_id')!)
  const t = threads.find(x => x.id === id)
  if (!t) throw new ToolError(`thread ${id} is not linked to you (your threads: ${threads.map(x => x.id).join(', ') || 'none'})`)
  return t
}

/** The post must live in one of the session's threads, or in a request or DM thread it opened. */
export async function postInScope(hub: Hub, key: string, messageId: string): Promise<MMPost> {
  const post = await hub.mm.getPost(messageId)
  const tid = post.root_id || post.id
  if (!scope(hub, key).some(t => t.id === tid) && !linkedTo(hub, key, tid)) throw new ToolError(`message ${messageId} is not in your thread(s)`)
  return post
}

/** A thread the session may read: its own, or a request or DM thread it opened. */
function readableThread(hub: Hub, key: string, a: Args): string {
  const raw = str(a, 'thread_id', key.startsWith('w-'))
  const id = raw && hub.store.threadId(raw)
  if (id && linkedTo(hub, key, id)) return id
  const t = threadFor(hub, key, a)
  if (id && id !== t.id) throw new ToolError(`thread ${id} is not yours to read`)
  return t.id
}

/** Files a post (or a report the router may attach) can carry. */
function checkFiles(hub: Hub, files: string[]): void {
  if (files.length > MAX_FILES_PER_POST) throw new ToolError(`at most ${MAX_FILES_PER_POST} files per reply`)
  for (const f of files) {
    if (!isAbsolute(f)) throw new ToolError(`not an absolute path: ${f}`)
    assertSendable(f, hub.p.dir)
    let st
    try {
      st = statSync(f)
    } catch {
      throw new ToolError(`no such file: ${f}`)
    }
    if (st.size > MAX_ATTACHMENT_BYTES) throw new ToolError(`file too large: ${f} (${(st.size / 1048576).toFixed(1)}MB, max 50MB)`)
  }
}

/** Posts to a draft thread, one after another: the first opens it, the rest go under it. */
const drafts = new Map<string, Promise<unknown>>()

export async function postAs(hub: Hub, key: string, thread: ThreadRow, text: string, files: string[] = []): Promise<string[]> {
  if (!text.trim() && !files.length) throw new ToolError('empty reply')
  checkFiles(hub, files)
  await checkBotMentions(hub, key, text)
  if (!isDraft(thread.id)) return postIn(hub, key, thread, text, files)
  const id = thread.id
  const run = (drafts.get(id) ?? Promise.resolve()).catch(() => {}).then(() => postIn(hub, key, hub.store.thread(id) ?? thread, text, files))
  drafts.set(id, run)
  void run.catch(() => {}).finally(() => {
    if (drafts.get(id) === run) drafts.delete(id)
  })
  return run
}

/**
 * Post in the thread, in chunks. In a draft thread (a scheduled run's) nothing is
 * posted yet: the first chunk is a new post in the channel, which opens the thread.
 */
async function postIn(hub: Hub, key: string, thread: ThreadRow, text: string, files: string[]): Promise<string[]> {
  const access = hub.accessStore.load()
  const limit = Math.max(500, Math.min(access.textChunkLimit ?? MAX_POST_CHARS, MAX_POST_CHARS))
  const isWorker = key.startsWith('w-')
  const header = isWorker ? `**🛠 ${hub.label(key)}**\n` : ''
  const parts = chunk(text, limit - header.length, access.chunkMode ?? 'newline')
  const fileIds = files.length ? (await hub.mm.uploadFiles(thread.channelId, files)).map(f => f.id) : []
  const ids: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1
    const opens = isDraft(thread.id)
    const post = await hub.mm.createPost({
      channel_id: thread.channelId,
      ...(opens ? {} : { root_id: thread.id }),
      message: (i === 0 ? header : '') + parts[i]!,
      props: { mmhub_session: key },
      ...(last && fileIds.length ? { file_ids: fileIds } : {}),
    })
    if (opens) {
      hub.store.openDraft(thread.id, post.id)
      log('threads', `${thread.id} opened by ${key}'s first post: thread ${post.id}`)
      thread = hub.store.thread(post.id)!
      hub.status.changed()
    }
    ids.push(post.id)
    hub.store.insertPost({ id: post.id, threadId: thread.id, sessionKey: key, createAt: post.create_at, message: post.message })
  }
  if (isWorker) hub.store.patchWorker(key, { lastPost: text.slice(0, 300) })
  hub.store.patchSession(key, { lastActiveAt: Date.now() })
  // An answer to another workspace's request: the asker gets it too.
  void forwardAnswer(hub, key, thread, text, ids, files.length).catch(err => log('links', `forwarding from ${thread.id}: ${errMsg(err)}`))
  return ids
}

/**
 * A worker's report goes to its thread's router (kept in the router's inbox like any
 * message, so a stopped or crashed router still gets it), never straight to the thread.
 */
export async function reportToRouter(hub: Hub, key: string, thread: ThreadRow, text: string, files: string[] = []): Promise<void> {
  if (!text.trim() && !files.length) throw new ToolError('empty report')
  checkFiles(hub, files)
  const worker = hub.store.worker(key)
  const taskId = worker?.activeThread === thread.id ? worker.activeTask : undefined
  // What was asked, in a line: the router may not have given the task itself (an owner's !delegate) or may have compacted it away.
  const asked = taskId ? hub.store.task(taskId)?.text.split('\n').find(l => l.trim())?.trim() : undefined
  const content = [
    `[Report from worker "${hub.label(key)}" (${key})${taskId ? ` on task #${taskId}` : ''} — for you, not posted in the thread]`,
    asked ? `(The task: ${asked.length > 400 ? `${asked.slice(0, 400)}…` : asked})` : '',
    text.trim(),
    files.length ? `\nFiles you can attach (reply's files): ${files.join(', ')}` : '',
  ].filter(Boolean).join('\n')
  const meta: Record<string, string> = {
    chat_id: thread.channelId,
    thread_id: thread.id,
    workspace: thread.workspace,
    kind: 'worker_report',
    worker_id: key,
    ...(taskId ? { task_id: String(taskId) } : {}),
  }
  await hub.enqueue(async () => {
    await hub.deliver(thread.routerKey, content, meta)
    hub.store.patchWorker(key, { lastPost: text.slice(0, 300) })
    hub.store.patchSession(key, { lastActiveAt: Date.now() })
  })
}

async function fetchThread(hub: Hub, threadId: string, limit: number): Promise<string> {
  if (isDraft(threadId)) return `Nothing is posted in thread ${threadId} yet: your first reply opens it in the channel.`
  return threadText(hub, threadId, limit)
}

async function downloadAttachment(hub: Hub, key: string, messageId: string): Promise<string> {
  const post = await postInScope(hub, key, messageId)
  // Into the session's own workspace (a request thread may belong to another one).
  const w = hub.ws(hub.store.session(key)?.workspace ?? '')
  if (!w) throw new ToolError('workspace not found')
  const infos = post.metadata?.files?.length ? post.metadata.files : await Promise.all((post.file_ids ?? []).map(id => hub.mm.fileInfo(id)))
  if (!infos.length) throw new ToolError('that message has no attachments')
  const dir = join(w.dir, 'inbox')
  mkdirSync(dir, { recursive: true })
  const out: string[] = []
  for (const f of infos) {
    if (f.size > MAX_ATTACHMENT_BYTES) {
      out.push(`skipped ${f.name}: too large`)
      continue
    }
    const name = `${post.id}-${(safeName(f.name) ?? 'file').replace(/[/\\]/g, '_')}`
    const path = join(dir, name)
    if (!existsSync(path)) writeFileSync(path, Buffer.from(await hub.mm.downloadFile(f.id)))
    out.push(path)
  }
  return out.join('\n')
}

function listWorkers(hub: Hub, key: string): string {
  const thread = threadFor(hub, key, {})
  const workers = hub.store.workers(thread.workspace)
  if (!workers.length) return 'No workers yet in this workspace. Create one with delegate({new_worker: {title, summary}, task}).'
  const now = Date.now()
  const lines = workers.map(w => {
    const s = hub.store.session(w.key)
    const queued = hub.store.pendingTasks(w.key).length
    const repos = Object.entries(w.repos).map(([n, t]) => `${n}${t.branch ? `@${t.branch}` : ''}`).join(', ') || 'none'
    const threads = w.threads.map(id => (id === thread.id ? `${id} (this thread)` : id)).join(', ') || 'none'
    return [
      `- ${w.key} "${w.title}" — ${s?.status ?? '?'}${queued ? `, ${queued} queued` : ''}, last active ${s ? fmtAge(now - s.lastActiveAt) : '?'} ago`,
      `  summary: ${w.summary || '(none)'}`,
      `  repos: ${repos}; threads: ${threads}`,
      w.lastPost ? `  last report: ${w.lastPost.replace(/\s+/g, ' ').slice(0, 160)}` : '',
    ].filter(Boolean).join('\n')
  })
  const cfg = hub.cfg
  return `Workers in workspace "${thread.workspace}" (${workers.length}/${cfg.maxWorkersPerWorkspace}):\n${lines.join('\n')}`
}

export type DelegateResult = { worker_id: string; task_id: number; state: 'delivered' | 'queued' | 'starting' | 'resuming' | 'waiting_for_slot' | 'failed'; position?: number }

/** Hand a task to a worker (existing or new). Call on the chain. */
export async function delegate(
  hub: Hub,
  o: { thread: ThreadRow; workerKey?: string; newWorker?: { title: string; summary: string }; task: string; messageIds: string[] },
): Promise<DelegateResult> {
  const w = hub.ws(o.thread.workspace)
  if (!w) throw new ToolError(`workspace ${o.thread.workspace} not found`)
  let key: string
  if (o.workerKey) {
    const existing = hub.store.worker(o.workerKey)
    if (!existing || existing.workspace !== w.name) throw new ToolError(`no worker ${o.workerKey} in workspace ${w.name} — call list_workers`)
    key = existing.key
  } else if (o.newWorker) {
    const n = hub.store.workers(w.name).length
    if (n >= hub.cfg.maxWorkersPerWorkspace) {
      throw new ToolError(`workspace ${w.name} already has ${n} workers (max ${hub.cfg.maxWorkersPerWorkspace}). Reuse one (list_workers) or ask an owner to remove one with "!worker rm <id>".`)
    }
    const title = o.newWorker.title.trim()
    if (!title) throw new ToolError('new_worker.title is empty')
    key = hub.createWorker({ workspace: w, title, summary: o.newWorker.summary ?? '' })
  } else {
    throw new ToolError('pass worker_id (an existing worker) or new_worker {title, summary}')
  }

  const worker = hub.store.worker(key)!
  if (!worker.threads.includes(o.thread.id)) hub.store.patchWorker(key, { threads: [...worker.threads, o.thread.id] })

  const quotes: string[] = []
  for (const id of o.messageIds.slice(0, 10)) {
    try {
      const p = await hub.mm.getPost(id)
      if ((p.root_id || p.id) !== o.thread.id) continue
      const who = await hub.mm.username(p.user_id)
      quotes.push(`@${who} (message ${p.id}):\n${p.message.split('\n').map(l => `> ${l}`).join('\n')}`)
    } catch {}
  }
  const text = [
    o.task.trim(),
    '',
    `Thread: ${o.thread.id} — ${hub.permalink(o.thread.id)} (workspace ${w.name}). Reply there with reply(thread_id="${o.thread.id}", …).`,
    quotes.length ? `\nThe person's own words:\n${quotes.join('\n\n')}` : '',
  ].join('\n')

  return queueTask(hub, key, o.thread, text)
}

/**
 * Queue a task for a worker on a thread and get it going: straight in when the
 * worker is free or already working for that thread, else after its current
 * work; a stopped worker is started. Call on the chain.
 */
export async function queueTask(hub: Hub, key: string, thread: ThreadRow, text: string): Promise<DelegateResult> {
  const taskId = hub.store.insertTask({ workerKey: key, threadId: thread.id, channelId: thread.channelId, text, state: 'queued', createdAt: Date.now() })
  const task = hub.store.task(taskId)!
  const l = hub.liveOf(key)
  const inflight = hub.store.tasksFor(key, ['delivered'])
  hub.status.changed()

  const queuePos = () => hub.store.pendingTasks(key).findIndex(t => t.id === taskId) + 1
  if (hub.held(key) || hub.restartWaits(key)) {
    // Waiting out an API-error retry, or a restart after the running turn: the task goes in after it.
    if (!hub.liveOf(key).ready) await hub.ensureStarted(key)
    return { worker_id: key, task_id: taskId, state: 'queued', position: queuePos() }
  }
  if (l.ready && l.conn) {
    const sameThread = inflight.length > 0 && inflight.every(t => t.threadId === thread.id)
    if (inflight.length === 0 || sameThread) {
      // Free, or already working for this thread: straight through (follow-ups steer the work).
      if (inflight.length === 0) {
        const next = hub.store.pendingTasks(key)[0]
        if (next && next.id !== taskId) {
          hub.sendTask(key, next)
          return { worker_id: key, task_id: taskId, state: 'queued', position: hub.store.pendingTasks(key).findIndex(t => t.id === taskId) + 1 }
        }
      }
      hub.sendTask(key, task)
      return { worker_id: key, task_id: taskId, state: 'delivered' }
    }
    return { worker_id: key, task_id: taskId, state: 'queued', position: hub.store.pendingTasks(key).findIndex(t => t.id === taskId) + 1 }
  }

  const before = hub.store.session(key)!
  const r = await hub.ensureStarted(key)
  if (r === 'waiting') return { worker_id: key, task_id: taskId, state: 'waiting_for_slot', position: hub.store.pendingTasks(key).findIndex(t => t.id === taskId) + 1 }
  if (r === 'failed') return { worker_id: key, task_id: taskId, state: 'failed' }
  const now = hub.store.session(key)!
  const state = now.status === 'resuming' || (before.turns > 0 && !isLive(before.status)) ? 'resuming' : 'starting'
  const position = hub.store.pendingTasks(key).findIndex(t => t.id === taskId) + 1
  return { worker_id: key, task_id: taskId, state, ...(position > 1 ? { position } : {}) }
}

/** Run one tool call for session `key`. Returns the text shown to the model. */
/** Tools that reach someone: a post, a reaction, a worker, another workspace, an owner, or leaving a thread. */
const REACHES = new Set(['reply', 'react', 'edit_message', 'delegate', 'message_workspace', 'send_dm', 'answer_request', 'new_thread', 'unfollow'])

export async function handleCall(hub: Hub, key: string, tool: string, a: Args): Promise<string> {
  const text = await callTool(hub, key, tool, a)
  if (REACHES.has(tool)) hub.acted(key)
  return text
}

async function callTool(hub: Hub, key: string, tool: string, a: Args): Promise<string> {
  const role = key.startsWith('r-') ? 'router' : 'worker'
  switch (tool) {
    case 'reply': {
      const t = threadFor(hub, key, a)
      if (role === 'worker' && hub.cfg.workerReports === 'router') {
        await reportToRouter(hub, key, t, str(a, 'text')!, strList(a, 'files'))
        return "reported to the thread's router — it tells the person what matters. Their answers come back to you as new messages for this thread."
      }
      const ids = await postAs(hub, key, t, str(a, 'text')!, strList(a, 'files'))
      return `sent (${ids.length > 1 ? `${ids.length} posts: ` : 'id: '}${ids.join(', ')})`
    }
    case 'react': {
      const post = await postInScope(hub, key, str(a, 'message_id')!)
      const emoji = str(a, 'emoji')!.replace(/^:|:$/g, '')
      await hub.mm.addReaction(hub.bot.id, post.id, emoji)
      return 'reacted'
    }
    case 'edit_message': {
      const id = str(a, 'message_id')!
      if (hub.store.postOwner(id) !== key) throw new ToolError('you can only edit your own posts')
      const text = str(a, 'text')!
      await checkBotMentions(hub, key, text)
      const header = role === 'worker' ? `**🛠 ${hub.label(key)}**\n` : ''
      await hub.mm.patchPost(id, { message: header + text })
      return 'edited'
    }
    case 'download_attachment':
      return downloadAttachment(hub, key, str(a, 'message_id')!)
    case 'fetch_thread': {
      const limit = typeof a.limit === 'number' ? a.limit : 50
      // Any other thread, by a link or the id of a post in it: read for the person asking (explore.ts).
      const ref = str(a, 'thread_id', false)
      const id = ref ? (postIdOf(ref) ?? ref) : undefined
      if (id && !ownThread(hub, key, id)) return readOtherThread(hub, key, id, limit, str(a, 'message_id', false))
      return fetchThread(hub, readableThread(hub, key, id ? { ...a, thread_id: id } : a), limit)
    }
    case 'read_channel':
      return readChannel(hub, key, { channel: str(a, 'channel')!, limit: typeof a.limit === 'number' ? a.limit : undefined, before: str(a, 'before', false), messageId: str(a, 'message_id', false) })
    case 'search_messages':
      return searchMessages(hub, key, { terms: str(a, 'terms')!, limit: typeof a.limit === 'number' ? a.limit : undefined, messageId: str(a, 'message_id', false) })
    case 'list_channels':
      return listChannels(hub, key, { messageId: str(a, 'message_id', false) })
    case 'list_workspaces':
      return listWorkspacesText(hub, key)
    case 'message_workspace':
      return messageWorkspace(hub, key, {
        workspace: str(a, 'workspace', false),
        text: str(a, 'text')!,
        requestId: str(a, 'request_id', false),
        threadId: str(a, 'thread_id', false),
      })
    case 'send_dm':
      return sendDM(hub, key, { user: str(a, 'user', false), text: str(a, 'text')!, threadId: str(a, 'thread_id', false) })
    case 'new_thread':
      return newThread(hub, key, { text: str(a, 'text')!, messageId: str(a, 'message_id')!, channel: str(a, 'channel', false) })
    case 'add_repo':
      return addRepoTool(hub, key, { source: str(a, 'source')!, name: str(a, 'name', false), messageId: str(a, 'message_id', false) })
    case 'answer_request':
      return answerRequest(hub, key, { text: str(a, 'text')!, verbatim: str(a, 'verbatim', false) })
    case 'schedule':
      return scheduleTool(hub, key, {
        schedule: str(a, 'schedule')!,
        text: str(a, 'text')!,
        messageId: str(a, 'message_id', false),
        name: str(a, 'name', false),
        tz: str(a, 'timezone', false),
        inThisThread: a.in_this_thread === true,
        graceMinutes: int(a, 'grace_minutes', false),
      })
    case 'unschedule':
      return unscheduleTool(hub, key, { jobId: int(a, 'job_id')!, messageId: str(a, 'message_id', false) })
    case 'list_schedules':
      return listSchedulesTool(hub, key)
    case 'list_workers':
      if (role !== 'router') throw new ToolError('routers only')
      return listWorkers(hub, key)
    case 'delegate': {
      if (role !== 'router') throw new ToolError('routers only')
      const thread = threadFor(hub, key, a)
      const nw = a.new_worker as { title?: unknown; summary?: unknown } | undefined
      const res = await hub.enqueue(() => delegate(hub, {
        thread,
        workerKey: str(a, 'worker_id', false),
        newWorker: nw && typeof nw === 'object' ? { title: String(nw.title ?? ''), summary: String(nw.summary ?? '') } : undefined,
        task: str(a, 'task')!,
        messageIds: strList(a, 'message_ids'),
      }))
      return JSON.stringify(res)
    }
    case 'prepare_repo': {
      if (role !== 'worker') throw new ToolError('workers only')
      const repo = str(a, 'repo')!
      const row = hub.store.session(key)!
      const w = hub.ws(row.workspace)
      if (!w) throw new ToolError('workspace not found')
      const wt = await hub.withLock(`repo:${w.name}:${repo}`, () => prepareWorktree(hub.cfg, w, key, repo))
      await hub.enqueue(() => {
        const cur = hub.store.worker(key)!
        hub.store.patchWorker(key, { repos: { ...cur.repos, [repo]: wt } })
        hub.status.changed()
      })
      return wt.shared
        ? `${wt.path}\n(not a git repo — shared folder, edit with care: other workers see your changes)`
        : `${wt.path}\nbranch ${wt.branch} — work and commit here; never edit the original checkout.`
    }
    case 'update_summary': {
      if (role !== 'worker') throw new ToolError('workers only')
      const summary = str(a, 'summary')!.replace(/\s+/g, ' ').trim().slice(0, 300)
      await hub.enqueue(() => {
        hub.store.patchWorker(key, { summary })
        hub.status.changed()
      })
      return 'summary updated'
    }
    case 'unfollow': {
      if (role !== 'router') throw new ToolError('routers only')
      const t = threadFor(hub, key, a)
      const w = hub.ws(t.workspace)
      if (inDM(hub, t.id)) return 'Nothing to do: this thread is a DM, and every message in a DM reaches you.'
      const trig = w ? effective(hub.cfg, w).trigger : 'mention'
      if (trig === 'mention-only') return 'Nothing to do: in this workspace only messages that @mention you reach you (trigger mention-only).'
      if (!judged(trig)) return 'Nothing to do: this workspace takes every reply in your threads (no judge is on).'
      const open = hub.store.openTasksIn(t.id)
      if (open.length) {
        throw new ToolError(`work for this thread is still open (${open.map(x => `task #${x.id}, ${x.workerKey}: ${x.state}`).join('; ')}): unfollow once it is done and the person has the result`)
      }
      await hub.enqueue(() => setFollowing(hub, t.id, false))
      return 'No longer following this thread: only messages that @mention you reach you now, and a mention follows it again.'
    }
    case 'trigger_rules': {
      if (role !== 'worker') throw new ToolError('workers only')
      const w = hub.ws(hub.store.session(key)?.workspace ?? '')
      if (!w) throw new ToolError('workspace not found')
      const trig = effective(hub.cfg, w).trigger
      const state = judged(trig)
        ? `${judgeName(trig)} judges replies for this workspace by these rules`
        : `No judge is on for this workspace (trigger ${trig}); the rules apply once an owner sets the trigger to laya or openrouter`
      const content = str(a, 'content', false)
      if (content === undefined) {
        const t = loadTrigger(w.dir)
        return `${state}. ${t.own ? `TRIGGER.md (${triggerFile(w.dir)})` : 'No TRIGGER.md yet; the built-in rules'}:\n\n${t.text}`
      }
      let rules
      try {
        rules = saveTrigger(w.dir, content)
      } catch (err) {
        throw new ToolError(errMsg(err))
      }
      const fit = usableRules(rules)
      log('trigger', `${key} updated TRIGGER.md of ${w.name}: ${rules.answer.length} answer, ${rules.ignore.length} don't-answer rule(s)`)
      return [
        `saved: ${rules.answer.length} "answer" and ${rules.ignore.length} "don't answer" rule(s).`,
        fit.dropped ? `The judge is asked about ${MAX_RULES} rules at most ("don't answer" first): ${fit.dropped} rule(s) are left out, so merge or drop some.` : '',
        fit.clipped ? `${fit.clipped} rule(s) are longer than ${RULE_MAX_CHARS} characters and get cut; shorten them.` : '',
        `${state}${judged(trig) ? '; it judges new messages with these rules from now on' : ''}.`,
      ].filter(Boolean).join(' ')
    }
    default:
      throw new ToolError(`unknown tool ${tool}`)
  }
}
