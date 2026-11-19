/**
 * Sessions reaching beyond their own thread:
 *
 * - **Another workspace.** `message_workspace` opens a thread in one of that
 *   workspace's channels ("📨 Request from workspace A"), with a router of its
 *   own, which answers like it would a person. What that workspace's sessions
 *   post there goes back to the asker.
 * - **A private question to a person** (routers only). `send_dm` hands it to that
 *   person's own agent: a new router of their personal workspace (personal-<user id>,
 *   created on first use), in a new thread of their DM with the bot. It asks them in
 *   its own words; their replies reach it, not the asker, and it sends back what was
 *   asked with `answer_request`, in its own words too: the hub refuses an answer that
 *   quotes them (QUOTE_WORDS words of theirs in a row) unless `verbatim` says why it
 *   must. The asker never reads the DM. With config
 *   `personalWorkspaces: false`, `send_dm` posts in the DM itself and the person's
 *   replies go straight back.
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

import { errMsg, fmtAge, log, safeName, shortId } from '../shared/util'
import { EVERYONE } from './access'
import type { Hub } from './hub'
import type { MMPost } from './mattermost'
import { DRAFT, type LinkRow, type ThreadRow } from './store'
import { queueTask, ToolError } from './tools'
import { noteDM } from './trigger'
import { bindChannel, listWorkspaces, loadBindings, type Workspace } from './workspaces'

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
    : l.kind === 'personal'
      ? `- private question thread_id ${l.threadId} (through the person's own agent): ${l.messages} message(s), opened ${fmtAge(now - l.createdAt)} ago`
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

/** send_dm (routers only): a private question to a person, through their own agent; or more on one the session asked. */
export async function sendDM(hub: Hub, key: string, a: { user?: string; text: string; threadId?: string }): Promise<string> {
  if (!key.startsWith('r-')) throw new ToolError("only routers ask people privately: report the question to your thread's router (reply), which can ask them")
  const text = checkText(a.text)
  const mine = workspaceOf(hub, key)

  if (a.threadId) {
    const l = hub.store.link(hub.store.threadId(a.threadId))
    if (!l || (l.kind !== 'dm' && l.kind !== 'personal') || l.fromKey !== key) throw new ToolError(`DM thread ${a.threadId} isn't one of yours — list_workspaces shows yours`)
    checkOpen(l)
    if (l.kind === 'personal') return askAgain(hub, key, mine, l, text)
    const post = await hub.mm.createPost({ channel_id: l.channelId, root_id: l.threadId, message: text, props: { mmhub_dm: key } })
    hub.store.bumpLink(l.threadId)
    return `sent (id ${post.id}, DM thread ${l.threadId})`
  }

  if (!a.user) throw new ToolError('missing "user" (or pass thread_id to continue a DM)')
  const owner = await ownerNamed(hub, a.user)
  checkRate(hub, key)
  const home = homeThread(hub, key)
  if (hub.cfg.personalWorkspaces) {
    let target: Workspace
    try {
      target = await hub.personalWorkspace(owner.id)
    } catch (err) {
      throw new ToolError(`couldn't create @${owner.name}'s personal workspace: ${errMsg(err)}`)
    }
    // A session of that person's own workspace talks to them in the DM directly.
    if (target.name !== mine) return askPrivately(hub, key, mine, home, owner, target, text)
  }
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

/**
 * A private question through the person's own agent: a new router of their personal
 * workspace, in a draft thread of their DM with the bot (its first reply opens it).
 */
async function askPrivately(hub: Hub, key: string, mine: string, home: ThreadRow, person: { id: string; name: string }, target: Workspace, text: string): Promise<string> {
  if (!accepts(target, mine)) throw new ToolError(`@${person.name}'s personal workspace doesn't take requests from ${mine} (its acceptFrom setting)`)
  return hub.enqueue(async () => {
    const ch = await hub.mm.directChannel(hub.bot.id, person.id)
    if (!loadBindings(hub.p.bindings)[ch.id]) bindChannel(hub.p.bindings, ch.id, target.name)
    noteDM(hub, ch.id) // every message in a DM reaches its router
    // Catch-up after a reconnect should look in this DM from here on.
    if (!hub.store.get(`seen:${ch.id}`)) hub.store.set(`seen:${ch.id}`, String(Date.now()))
    const draft = `${DRAFT}${shortId(12)}`
    hub.store.insertLink({ threadId: draft, kind: 'personal', channelId: ch.id, fromKey: key, fromWorkspace: mine, fromThread: home.id, peer: person.id, chain: [mine], createdAt: Date.now() })
    hub.store.bumpLink(draft)
    const rkey = hub.createRouter({ threadId: draft, channelId: ch.id, workspace: target, label: `⇠ ${mine}: ${text.replace(/\s+/g, ' ').slice(0, 48)}` })
    const t = hub.store.thread(draft)!
    log('links', `${key} (${mine}) asks @${person.name} privately through ${target.name}: router ${rkey}`)
    await hub.deliver(rkey, [
      `[Private question from workspace "${mine}" — ${plainWho(hub, key)}. Not a person: a Claude session, which can't see this DM. Ask @${person.name}, the person this DM is with, what it needs: in your own words and their language, saying who asks and why, and ask them to answer in this thread (your first reply opens it). When they have answered, send back what was asked with answer_request: only that reaches workspace "${mine}", so leave out anything they didn't mean to share. If they decline or don't know, send that back. Never share secrets (keys, tokens, passwords).]`,
      '',
      text,
    ].join('\n'), privateMeta(t, mine, hub.label(key)))
    return `asked @${person.name}'s own agent (workspace ${target.name}) to ask them privately in a DM (thread_id ${draft}). Their answer comes back to you as a new message (kind="dm_reply"); ask more with send_dm(thread_id="${draft}", text=…). If you need the answer to go on, end your turn and wait for it.`
  })
}

/** More from the asker on a private question: to the person's agent, which asks them if it must. */
async function askAgain(hub: Hub, key: string, mine: string, l: LinkRow, text: string): Promise<string> {
  const person = safeName(await hub.mm.username(l.peer)) ?? l.peer
  return hub.enqueue(async () => {
    const t = hub.store.thread(l.threadId)
    if (!t) throw new ToolError('that private question is gone')
    hub.store.bumpLink(l.threadId)
    await hub.deliver(t.routerKey, `[Follow-up from workspace "${mine}" (${plainWho(hub, key)}) on its private question — not a person, and it can't see this DM. Ask @${person} with reply if it needs them, then send back what was asked with answer_request.]\n\n${text}`, privateMeta(t, mine, hub.label(key)))
    return `sent to @${person}'s own agent (thread ${l.threadId}). Its answer comes back to you as a new message.`
  })
}

function privateMeta(t: ThreadRow, from: string, fromLabel: string): Record<string, string> {
  return {
    chat_id: t.channelId,
    thread_id: t.id,
    user: `workspace:${from}`,
    kind: 'dm_request',
    from_workspace: from,
    from_session: fromLabel.slice(0, 80),
    workspace: t.workspace,
    ts: new Date().toISOString(),
  }
}

/** answer_request: the person's own agent sends their answer to a private question back to the session that asked. */
export async function answerRequest(hub: Hub, key: string, a: { text: string; verbatim?: string }): Promise<string> {
  const text = checkText(a.text)
  const t = key.startsWith('r-') ? hub.store.threadByRouter(key) : undefined
  const l = t ? hub.store.link(t.id) : undefined
  if (!t || !l || l.kind !== 'personal') throw new ToolError('your thread is no private question from another session, so there is nothing to answer: reply talks to the person')
  checkOpen(l)
  const person = safeName(await hub.mm.username(l.peer)) ?? l.peer
  const verbatim = a.verbatim?.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined
  if (!verbatim) {
    const run = await quoteOf(hub, l, text)
    if (run) throw new ToolError(`"${run}…" is @${person}'s own words. Send back what the asker needs in your words: the decision or facts, not their message. Quote them only when they told you to pass their exact words on and the exact wording matters: then say why in verbatim.`)
  }
  return hub.enqueue(async () => {
    hub.store.bumpLink(l.threadId)
    const content = [
      `[Answer from @${person}'s own agent (workspace ${t.workspace}) to your private question (thread ${l.threadId})]`,
      '',
      text,
      verbatim ? `\n(It quotes @${person}'s own words, as they asked: ${verbatim})` : '',
      `\n(Ask more with send_dm(thread_id="${l.threadId}", text=…), or carry on.)`,
    ].filter(s => s !== '').join('\n')
    await toAsker(hub, l, content, { kind: 'dm_reply', dm_thread: l.threadId, user: person, user_id: l.peer })
    log('links', `${key} answered ${l.fromKey}'s private question ${l.threadId}${verbatim ? ` — quoting them: ${verbatim}` : ''}`)
    return `sent back to workspace ${l.fromWorkspace}. Nothing was posted: tell @${person} only if it helps them.`
  })
}

/** Words in a row that make an answer a quote of the person. */
export const QUOTE_WORDS = 6

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’]\p{L}+)*/gu) ?? []
}

function runs(texts: string[]): Set<string> {
  const out = new Set<string>()
  for (const t of texts) {
    const w = words(t)
    for (let i = 0; i + QUOTE_WORDS <= w.length; i++) out.add(w.slice(i, i + QUOTE_WORDS).join(' '))
  }
  return out
}

/**
 * The first QUOTE_WORDS words in a row of `text` that are also in one of `theirs`, if any.
 * Runs that are in `ours` too don't count: the person echoing the question isn't theirs to keep.
 */
export function quoted(text: string, theirs: string[], ours: string[] = []): string | undefined {
  const their = runs(theirs)
  const mine = runs(ours)
  const w = words(text)
  for (let i = 0; i + QUOTE_WORDS <= w.length; i++) {
    const run = w.slice(i, i + QUOTE_WORDS).join(' ')
    if (their.has(run) && !mine.has(run)) return run
  }
  return undefined
}

/** Whether `text` quotes what the person wrote in a private question's DM thread. */
async function quoteOf(hub: Hub, l: LinkRow, text: string): Promise<string | undefined> {
  if (l.threadId.startsWith(DRAFT)) return undefined // not asked yet: nothing of theirs to quote
  try {
    const posts = Object.values((await hub.mm.getThread(l.threadId)).posts)
    return quoted(text, posts.filter(p => p.user_id === l.peer).map(p => p.message), posts.filter(p => p.user_id !== l.peer).map(p => p.message))
  } catch (e) {
    log('links', `${l.threadId}: couldn't read the DM thread to check the answer for quotes: ${errMsg(e)}`)
    return undefined
  }
}

async function ownerNamed(hub: Hub, user: string): Promise<{ id: string; name: string }> {
  const want = user.trim().replace(/^@/, '').toLowerCase()
  const owners = hub.accessStore.load().allowFrom
  const names: string[] = []
  for (const id of owners) {
    if (id === EVERYONE) continue
    const name = await hub.mm.username(id)
    if (name.toLowerCase() === want || id === user.trim()) return { id, name }
    names.push(`@${name}`)
  }
  if (owners.includes(EVERYONE)) {
    // "*": every person is an owner, so any person may be DMed. Not bot accounts, and never the hub's own.
    const u = await hub.mm.userByName(want)
    if (u && !u.is_bot && u.id !== hub.bot.id) return { id: u.id, name: u.username }
    throw new ToolError(`@${want} is not a person on this Mattermost server. Sessions can DM people only, not bots.`)
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
    `[DM reply from @${user} to your message (DM thread ${l.threadId}). Private: in your thread pass on only what is needed, in your own words]`,
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

/** Linked threads a session may read and download from: the requests and DMs it opened (not a private question's DM). */
export function linkedTo(hub: Hub, key: string, threadId: string): boolean {
  const l = hub.store.link(threadId)
  return !!l && l.fromKey === key && l.kind !== 'personal' // a private question's DM is between the person and their agent
}
