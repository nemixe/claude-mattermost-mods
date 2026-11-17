/**
 * Sessions reaching beyond their own thread:
 *
 * - **Another workspace.** `message_workspace` opens a thread in one of that
 *   workspace's channels ("📨 Request from workspace A"), with a router of its
 *   own, which answers like it would a person. What that workspace's sessions
 *   post there goes back to the asker.
 * - **A DM to an owner.** `send_dm` starts a DM thread; the owner's replies in it
 *   go back to the session.
 *
 * Either way the hub keeps a *link* from that thread to the session (store
 * `links`). Answers reach a router as a message for its thread, and a worker as
 * work for the thread it was busy with when it asked.
 *
 * Guards: a workspace may limit who asks it (workspace.json `acceptFrom`); a
 * request never goes back to a workspace it came through, nor further than
 * MAX_CHAIN workspaces; MAX_NEW_LINKS_PER_HOUR per session; MAX_LINK_MESSAGES
 * per link. DMs go to owners only: theirs are the only DM replies the hub takes.
 */

import { fmtAge, log, safeName } from '../shared/util'
import type { Hub } from './hub'
import type { MMPost } from './mattermost'
import type { LinkRow, ThreadRow } from './store'
import { queueTask, ToolError } from './tools'
import { noteDM } from './trigger'
import { listWorkspaces, loadBindings, type Workspace } from './workspaces'

/** New requests and DMs one session may open per hour. */
export const MAX_NEW_LINKS_PER_HOUR = 10
/** Messages through one link, both ways. */
export const MAX_LINK_MESSAGES = 60
/** Workspaces a request may pass through before the last may no longer ask another. */
export const MAX_CHAIN = 2
export const MAX_LINK_TEXT = 8000

/** Who may ask `target`: its workspace.json `acceptFrom` (unset: every workspace; "*" too). */
export function accepts(target: Pick<Workspace, 'acceptFrom'>, from: string): boolean {
  return !target.acceptFrom || target.acceptFrom.includes('*') || target.acceptFrom.includes(from)
}

/**
 * The workspaces a request has come through if `from` passes it on to `to`, or
 * why it may not: `to` is already in it (it would loop), or it is long enough.
 */
export function nextChain(parent: string[] | undefined, from: string, to: string): { chain: string[] } | { refused: string } {
  const chain = [...(parent ?? []), from]
  if (chain.includes(to)) return { refused: `workspace ${to} is already part of this request (${[...chain, to].join(' → ')}): answer it in your thread instead` }
  if (chain.length > MAX_CHAIN) return { refused: `this request already came through ${chain.join(' → ')}; don't pass it on further — answer with what you have` }
  return { chain }
}

function workspaceOf(hub: Hub, key: string): string {
  const ws = hub.store.session(key)?.workspace
  if (!ws) throw new ToolError('unknown session')
  return ws
}

/** The thread a session works for: a router's own; a worker's current one, or the one it names. */
function homeThread(hub: Hub, key: string, threadId?: string): ThreadRow {
  const threads = hub.threadsOf(key)
  if (threadId) {
    const t = threads.find(x => x.id === threadId)
    if (!t) throw new ToolError(`thread ${threadId} is not linked to you (your threads: ${threads.map(x => x.id).join(', ') || 'none'})`)
    return t
  }
  const t = hub.activeThreadOf(key) ?? threads.at(-1)
  if (!t) throw new ToolError('you have no thread to work for yet')
  return t
}

/** How the asker is shown: "🛠 **Fixer** (worker `w-…`)" / "🧭 the router of thread “…”". */
function who(hub: Hub, key: string): string {
  return key.startsWith('w-') ? `🛠 **${hub.label(key)}** (worker \`${key}\`)` : `🧭 the router of thread “${hub.label(key)}”`
}

function plainWho(hub: Hub, key: string): string {
  return key.startsWith('w-') ? `worker "${hub.label(key)}" (${key})` : `the router of thread "${hub.label(key)}" (${key})`
}

function checkText(text: string): string {
  const t = text.trim()
  if (!t) throw new ToolError('empty message')
  if (t.length > MAX_LINK_TEXT) throw new ToolError(`at most ${MAX_LINK_TEXT} characters; put long material in a file in the workspace knowledge/ folder and point to it`)
  return t
}

function checkRate(hub: Hub, key: string): void {
  const n = hub.store.linksFrom(key, Date.now() - 3_600_000).length
  if (n >= MAX_NEW_LINKS_PER_HOUR) {
    throw new ToolError(`you opened ${n} requests/DMs in the last hour (max ${MAX_NEW_LINKS_PER_HOUR}): continue an open one (request_id / thread_id), or wait`)
  }
}

function checkOpen(l: LinkRow): void {
  if (l.messages >= MAX_LINK_MESSAGES) throw new ToolError(`that conversation reached ${MAX_LINK_MESSAGES} messages; open a new one only if you must`)
}

/** The channel a workspace takes requests in: its first bound channel, real channels before DMs. */
export async function requestChannel(hub: Hub, w: Workspace): Promise<string | undefined> {
  const ids = Object.entries(loadBindings(hub.p.bindings)).filter(([, n]) => n === w.name).map(([id]) => id)
  let fallback: string | undefined
  for (const id of ids) {
    try {
      const type = (await hub.mm.channel(id)).type
      if (type === 'O' || type === 'P') return id
    } catch {}
    fallback ??= id
  }
  return fallback
}

// ---------------------------------------------------------------------------- tools

export function listWorkspacesText(hub: Hub, key: string): string {
  const mine = workspaceOf(hub, key)
  const bound = new Set(Object.values(loadBindings(hub.p.bindings)))
  const lines = listWorkspaces(hub.cfg).filter(w => w.name !== mine).map(w => {
    const why = !accepts(w, mine) ? ' — does not take requests from your workspace' : !bound.has(w.name) ? ' — has no channel, so it cannot take requests' : ''
    const repos = w.repos.length ? ` (repos: ${w.repos.map(r => r.name).join(', ')})` : ''
    return `- ${w.name}${w.description ? `: ${w.description}` : ''}${repos}${why}`
  })
  const now = Date.now()
  const open = hub.store.linksFrom(key).slice(0, 10).map(l => l.kind === 'workspace'
    ? `- request_id ${l.threadId} → workspace ${l.peer}: ${l.messages} message(s), opened ${fmtAge(now - l.createdAt)} ago`
    : `- DM thread_id ${l.threadId}: ${l.messages} message(s), opened ${fmtAge(now - l.createdAt)} ago`)
  return [
    `Your workspace: ${mine}. Other workspaces — ask one with message_workspace; its router answers:`,
    ...(lines.length ? lines : ['- (none)']),
    ...(open.length ? ['', 'Your open requests and DMs:', ...open] : []),
  ].join('\n')
}

/** message_workspace: a new request to another workspace, or a follow-up on one. */
export async function messageWorkspace(hub: Hub, key: string, a: { workspace?: string; text: string; requestId?: string; threadId?: string }): Promise<string> {
  const text = checkText(a.text)
  const mine = workspaceOf(hub, key)

  if (a.requestId) {
    const l = hub.store.link(a.requestId)
    if (!l || l.kind !== 'workspace' || l.fromKey !== key) throw new ToolError(`request ${a.requestId} isn't one of yours — list_workspaces shows them`)
    if (a.workspace && a.workspace !== l.peer) throw new ToolError(`request ${a.requestId} is with workspace ${l.peer}, not ${a.workspace}`)
    checkOpen(l)
    return hub.enqueue(async () => {
      const t = hub.store.thread(l.threadId)
      if (!t) throw new ToolError('that request thread is gone')
      const post = await hub.mm.createPost({ channel_id: l.channelId, root_id: l.threadId, message: `📨 ${who(hub, key)}\n\n${text}`, props: { mmhub_request: key } })
      hub.store.bumpLink(l.threadId)
      await hub.deliver(t.routerKey, `[Follow-up from workspace "${mine}" (${plainWho(hub, key)}) on its request — not a person; your replies in this thread go back to it]\n\n${text}`, {
        ...requestMeta(t, mine, hub.label(key)),
        message_id: post.id,
      })
      return `sent to workspace ${l.peer} (request ${l.threadId}). Answers come back to you as new messages.`
    })
  }

  if (!a.workspace) throw new ToolError('missing "workspace" (or pass request_id to follow up)')
  const target = hub.ws(a.workspace)
  if (!target) throw new ToolError(`no workspace "${a.workspace}" — list_workspaces shows them`)
  if (target.name === mine) throw new ToolError(`"${mine}" is your own workspace${key.startsWith('w-') ? ': ask through your thread\'s router instead' : ': delegate to its workers instead'}`)
  if (!accepts(target, mine)) throw new ToolError(`workspace ${target.name} doesn't take requests from ${mine} (its acceptFrom setting)`)
  const home = homeThread(hub, key, a.threadId)
  const parent = hub.store.link(home.id)
  const next = nextChain(parent?.kind === 'workspace' ? parent.chain : undefined, mine, target.name)
  if ('refused' in next) throw new ToolError(next.refused)
  checkRate(hub, key)
  const channelId = await requestChannel(hub, target)
  if (!channelId) throw new ToolError(`workspace ${target.name} has no channel bound, so it can't take requests (an owner binds one with /mattermost-hub:workspace bind)`)

  return hub.enqueue(async () => {
    const root = await hub.mm.createPost({ channel_id: channelId, message: `📨 **Request from workspace ${mine}** — ${who(hub, key)}\n\n${text}`, props: { mmhub_request: key } })
    const now = Date.now()
    hub.store.insertLink({ threadId: root.id, kind: 'workspace', channelId, fromKey: key, fromWorkspace: mine, fromThread: home.id, peer: target.name, chain: next.chain, createdAt: now })
    hub.store.bumpLink(root.id)
    // A request in a DM: the new router must know every message there reaches it (no Laya). The lookup is cached.
    if ((await hub.mm.channel(channelId).catch(() => undefined))?.type === 'D') noteDM(hub, channelId)
    const rkey = hub.createRouter({ threadId: root.id, channelId, workspace: target, label: `⇠ ${mine}: ${text.replace(/\s+/g, ' ').slice(0, 48)}` })
    const t = hub.store.thread(root.id)!
    log('links', `${key} (${mine}) asked workspace ${target.name}: request ${root.id}, router ${rkey}`)
    await hub.deliver(rkey, [
      `[Request from workspace "${mine}" — ${plainWho(hub, key)}. Not a person: a Claude session working for that workspace. Your replies in this thread go back to it; people in this channel can read them too. Handle it like a person's request: answer yourself when reading is enough, delegate work that changes things. Never share secrets (keys, tokens, passwords).]`,
      '',
      text,
    ].join('\n'), { ...requestMeta(t, mine, hub.label(key)), message_id: root.id })
    return `sent to workspace ${target.name} (request_id ${root.id}, ${hub.permalink(root.id)}). Its router answers there, and each answer comes back to you as a new message for thread ${home.id}. Follow up with message_workspace(request_id="${root.id}", text=…). If you need the answer to go on, end your turn and wait for it.`
  })
}

function requestMeta(t: ThreadRow, from: string, fromLabel: string): Record<string, string> {
  return {
    chat_id: t.channelId,
    thread_id: t.id,
    user: `workspace:${from}`,
    kind: 'workspace_request',
    from_workspace: from,
    from_session: fromLabel.slice(0, 80),
    workspace: t.workspace,
    ts: new Date().toISOString(),
  }
}

/** send_dm: a DM to an owner, or more in a DM thread the session started. */
export async function sendDM(hub: Hub, key: string, a: { user?: string; text: string; threadId?: string }): Promise<string> {
  const text = checkText(a.text)
  const mine = workspaceOf(hub, key)

  if (a.threadId) {
    const l = hub.store.link(a.threadId)
    if (!l || l.kind !== 'dm' || l.fromKey !== key) throw new ToolError(`DM thread ${a.threadId} isn't one of yours — list_workspaces shows yours`)
    checkOpen(l)
    const post = await hub.mm.createPost({ channel_id: l.channelId, root_id: l.threadId, message: text, props: { mmhub_dm: key } })
    hub.store.bumpLink(l.threadId)
    return `sent (id ${post.id}, DM thread ${l.threadId})`
  }

  if (!a.user) throw new ToolError('missing "user" (or pass thread_id to continue a DM)')
  const owner = await ownerNamed(hub, a.user)
  checkRate(hub, key)
  const home = homeThread(hub, key)
  return hub.enqueue(async () => {
    const ch = await hub.mm.directChannel(hub.bot.id, owner.id)
    const root = await hub.mm.createPost({
      channel_id: ch.id,
      message: `💬 ${who(hub, key)}, workspace **${mine}**\n\n${text}\n\n_Reply in this thread to answer._`,
      props: { mmhub_dm: key },
    })
    hub.store.insertLink({ threadId: root.id, kind: 'dm', channelId: ch.id, fromKey: key, fromWorkspace: mine, fromThread: home.id, peer: owner.id, chain: [mine], createdAt: Date.now() })
    hub.store.bumpLink(root.id)
    // Catch-up after a reconnect should look in this DM from here on.
    if (!hub.store.get(`seen:${ch.id}`)) hub.store.set(`seen:${ch.id}`, String(root.create_at))
    log('links', `${key} (${mine}) DMed @${owner.name}: thread ${root.id}`)
    return `sent to @${owner.name} (DM thread_id ${root.id}). Their reply in that thread comes back to you as a new message; continue with send_dm(thread_id="${root.id}", text=…).`
  })
}

async function ownerNamed(hub: Hub, user: string): Promise<{ id: string; name: string }> {
  const want = user.trim().replace(/^@/, '').toLowerCase()
  const names: string[] = []
  for (const id of hub.accessStore.load().allowFrom) {
    const name = await hub.mm.username(id)
    if (name.toLowerCase() === want || id === user.trim()) return { id, name }
    names.push(`@${name}`)
  }
  throw new ToolError(`@${want} is not a hub owner. Sessions can DM owners only (${names.join(', ') || 'none set'}) — theirs are the only DM replies the hub takes. Ask anyone else in your thread.`)
}

// ---------------------------------------------------------------------------- answers

/**
 * A session posted in a thread. When the thread is another workspace's request
 * and the post comes from that workspace's side, the asker gets it.
 */
export async function forwardAnswer(hub: Hub, key: string, thread: ThreadRow, text: string, postIds: string[], files: number): Promise<void> {
  const l = hub.store.link(thread.id)
  if (!l || l.kind !== 'workspace' || l.fromKey === key || hub.store.session(key)?.workspace !== l.peer) return
  if (l.messages >= MAX_LINK_MESSAGES) {
    log('links', `${l.threadId}: message limit reached — not forwarding`)
    return
  }
  hub.store.bumpLink(l.threadId)
  const from = key.startsWith('r-') ? 'its router' : `its worker "${hub.label(key)}"`
  const last = postIds.at(-1) ?? ''
  const content = [
    `[Answer from workspace "${l.peer}" (${from}) to your request ${l.threadId} — ${hub.permalink(l.threadId)}]`,
    '',
    text.trim(),
    files ? `\n(${files} file(s) attached there: download_attachment(message_id="${last}"))` : '',
    `\n(Follow up with message_workspace(request_id="${l.threadId}", text=…).)`,
  ].filter(s => s !== '').join('\n')
  await hub.enqueue(() => toAsker(hub, l, content, { kind: 'workspace_answer', from_workspace: l.peer, request_id: l.threadId, message_id: last }))
}

/** An owner replied in a DM thread a session started. Call on the chain. */
export async function dmReply(hub: Hub, post: MMPost): Promise<void> {
  const l = hub.store.link(post.root_id)
  if (!l || l.kind !== 'dm' || post.user_id !== l.peer) return
  if (l.messages >= MAX_LINK_MESSAGES) {
    await hub.replyTo(post, `This conversation reached its ${MAX_LINK_MESSAGES}-message limit, so this didn't reach the session. Answer in its Mattermost thread instead.`)
    return
  }
  hub.store.bumpLink(l.threadId)
  const access = hub.accessStore.load()
  if (access.ackReaction) void hub.mm.addReaction(hub.bot.id, post.id, access.ackReaction).catch(() => {})
  const user = safeName(await hub.mm.username(post.user_id)) ?? post.user_id
  const files = post.metadata?.files ?? []
  const content = [
    `[DM reply from @${user} to your message (DM thread ${l.threadId})]`,
    '',
    post.message,
    files.length || post.file_ids?.length ? `\n(${files.length || post.file_ids!.length} file(s) attached: download_attachment(message_id="${post.id}"))` : '',
    `\n(Answer with send_dm(thread_id="${l.threadId}", text=…), or carry on with your work.)`,
  ].filter(s => s !== '').join('\n')
  await toAsker(hub, l, content, { kind: 'dm_reply', dm_thread: l.threadId, user, user_id: post.user_id, message_id: post.id })
}

/** Hand an answer to the session that opened the link. Call on the chain. */
async function toAsker(hub: Hub, l: LinkRow, content: string, meta: Record<string, string>): Promise<void> {
  if (!hub.store.session(l.fromKey)) {
    log('links', `${l.threadId}: ${l.fromKey} is gone — answer dropped`)
    return
  }
  if (l.fromKey.startsWith('r-')) {
    const t = hub.store.threadByRouter(l.fromKey)
    if (!t) return
    await hub.deliver(l.fromKey, content, { ...meta, chat_id: t.channelId, thread_id: t.id, workspace: t.workspace, ts: new Date().toISOString() })
    return
  }
  const t = (l.fromThread ? hub.store.thread(l.fromThread) : undefined) ?? hub.activeThreadOf(l.fromKey)
  if (!t) {
    log('links', `${l.threadId}: ${l.fromKey} has no thread — answer dropped`)
    return
  }
  await queueTask(hub, l.fromKey, t, content)
}

/** Linked threads a session may read and download from: the requests and DMs it opened. */
export function linkedTo(hub: Hub, key: string, threadId: string): boolean {
  return hub.store.link(threadId)?.fromKey === key
}
