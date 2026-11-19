/**
 * Reading Mattermost beyond a session's own threads: any thread (from a link or a
 * post id), a channel's latest posts, a search, the channels the bot is in.
 *
 * A session reads only what the person it acts for can read: the hub checks that
 * they are a member of the channel. That person is the author of `message_id` (a
 * message in the session's threads), by default whoever last wrote to the session.
 * The channels of the session's own threads, and those bound to its workspace, are
 * open to it anyway: it serves them. A session with no person behind it (a
 * scheduled run) reads only those.
 *
 * The bot must be able to read the channel too: public channels of its teams, and
 * private channels, DMs and group messages it is a member of. Search covers only
 * channels the bot is a member of.
 */

import { errMsg, safeName } from '../shared/util'
import type { Hub } from './hub'
import { linkedTo } from './links'
import { isBotPost, type MMChannel, type MMPost, type MMTeam } from './mattermost'
import { postInScope, ToolError } from './tools'
import { loadBindings } from './workspaces'

/** Characters of output a tool returns at most. */
const MAX_OUT = 40_000
/** Characters of one post in a channel view or search results. */
const POST_CHARS = 1500
const POST_ID = /^[a-z0-9]{26}$/

function fail(msg: string): never {
  throw new ToolError(msg)
}

/** A post id from a permalink (…/pl/<id>, …/_redirect/pl/<id>) or a bare id. */
export function postIdOf(ref: string): string | undefined {
  const t = ref.trim().replace(/^<|>$/g, '')
  if (POST_ID.test(t)) return t
  return /\/pl\/([a-z0-9]{26})(?=$|[/?#])/.exec(t)?.[1]
}

/** A channel reference: a channel URL (…/<team>/channels/<name>), "~name", a name, a display name or an id. */
export function channelRefOf(ref: string): { team?: string; name: string } {
  const t = ref.trim().replace(/^<|>$/g, '')
  const url = /\/([^/?#]+)\/channels\/([^/?#]+)/.exec(t)
  if (url) return { team: decodeURIComponent(url[1]!), name: decodeURIComponent(url[2]!) }
  return { name: t.replace(/^~/, '') }
}

// ---------------------------------------------------------------- who may read what

/** Who the session reads for: the author of `messageId` (a person's message in its threads), else whoever last wrote to it. */
async function readerFor(hub: Hub, key: string, messageId?: string): Promise<string | undefined> {
  if (messageId) {
    const post = await postInScope(hub, key, messageId)
    if (post.user_id === hub.bot.id || isBotPost(post)) fail(`message ${messageId} is not a person's: pass the message of the person you are reading for`)
    return post.user_id
  }
  return hub.store.latestSender(key)
}

const memberCache = new Map<string, { yes: boolean; at: number }>()
const MEMBER_TTL = 60_000

export async function isMember(hub: Hub, channelId: string, userId: string): Promise<boolean> {
  const k = `${channelId} ${userId}`
  const hit = memberCache.get(k)
  if (hit && Date.now() - hit.at < MEMBER_TTL) return hit.yes
  const yes = await hub.mm.isMember(channelId, userId)
  memberCache.set(k, { yes, at: Date.now() })
  return yes
}

/** Undefined when the session may read the channel, else why not. */
async function why(hub: Hub, key: string, channelId: string, reader: string | undefined): Promise<string | undefined> {
  if (hub.threadsOf(key).some(t => t.channelId === channelId)) return undefined
  const ws = hub.store.session(key)?.workspace
  if (ws && loadBindings(hub.p.bindings)[channelId] === ws) return undefined
  if (!reader) return 'no person to read for: pass message_id, the message of the person asking'
  if (await isMember(hub, channelId, reader).catch(() => false)) return undefined
  return `@${await hub.mm.username(reader)} is not a member of that channel, so you may not read it for them`
}

async function mustRead(hub: Hub, key: string, ch: MMChannel, reader: string | undefined): Promise<void> {
  const no = await why(hub, key, ch.id, reader)
  if (no) fail(`${channelLabel(ch)}: ${no}`)
}

// ---------------------------------------------------------------- showing

export function channelLabel(ch: MMChannel): string {
  if (ch.type === 'D') return 'a direct message'
  if (ch.type === 'G') return `a group message (${ch.display_name})`
  return `~${ch.name}${ch.display_name && ch.display_name !== ch.name ? ` (${ch.display_name})` : ''}`
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s
}

/** One post: when, who, its id (and thread), files, then the text. */
async function postLine(hub: Hub, p: MMPost, o: { chars?: number; channel?: string; thread?: boolean } = {}): Promise<string> {
  const who = p.user_id === hub.bot.id ? `@${hub.bot.username}${p.props?.mmhub_session ? ` [${String(p.props.mmhub_session)}]` : ''}` : `@${await hub.mm.username(p.user_id)}`
  const files = p.metadata?.files?.length ? ` [files: ${p.metadata.files.map(f => safeName(f.name)).join(', ')}]` : ''
  const where = [
    `id ${p.id}`,
    o.thread && p.root_id ? `reply in thread ${p.root_id}` : '',
    o.thread && !p.root_id && p.reply_count ? `${p.reply_count} repl${p.reply_count === 1 ? 'y' : 'ies'}` : '',
    o.channel ?? '',
  ].filter(Boolean).join(', ')
  return `--- ${new Date(p.create_at).toISOString()} ${who} (${where})${files}\n${o.chars ? clip(p.message, o.chars) : p.message}`
}

/** Lines under a heading, cut to MAX_OUT characters. */
function cap(head: string, lines: string[]): string {
  let out = head
  for (let i = 0; i < lines.length; i++) {
    if (out.length + lines[i]!.length + 1 > MAX_OUT) return `${out}\n(… ${lines.length - i} more cut: ask for fewer)`
    out += `\n${lines[i]}`
  }
  return out
}

/** A thread, oldest first, its last `limit` posts. */
export async function threadText(hub: Hub, rootId: string, limit: number, where = ''): Promise<string> {
  const res = await hub.mm.getThread(rootId)
  const posts = Object.values(res.posts).sort((a, b) => a.create_at - b.create_at).slice(-Math.max(1, Math.min(limit, 200)))
  const lines = await Promise.all(posts.map(p => postLine(hub, p)))
  return cap(`Thread ${rootId}${where} (${hub.permalink(rootId)}), ${posts.length} post(s), oldest first:`, lines)
}

// ---------------------------------------------------------------- the tools

/** fetch_thread for a thread that isn't the session's own: any post in it, by id or link. */
export async function readOtherThread(hub: Hub, key: string, postId: string, limit: number, messageId?: string): Promise<string> {
  const post = await hub.mm.getPost(postId).catch(err => fail(`can't read post ${postId}: ${errMsg(err)} (a private channel the bot isn't in?)`))
  const ch = await hub.mm.channel(post.channel_id)
  await mustRead(hub, key, ch, await readerFor(hub, key, messageId))
  return threadText(hub, post.root_id || post.id, limit, ` in ${channelLabel(ch)}`)
}

/** Whether a thread is the session's own or one it opened (fetch_thread reads those as before). */
export function ownThread(hub: Hub, key: string, id: string): boolean {
  const t = hub.store.threadId(id)
  return hub.threadsOf(key).some(x => x.id === t) || linkedTo(hub, key, t)
}

/** The teams to look in: the one of the session's own thread first, then the bot's others. */
async function teams(hub: Hub, key: string): Promise<MMTeam[]> {
  const all = await hub.mm.myTeams()
  const own = hub.threadsOf(key)[0]
  const first = own ? await hub.mm.channel(own.channelId).then(c => c.team_id, () => undefined) : undefined
  return [...all.filter(t => t.id === first), ...all.filter(t => t.id !== first)]
}

export async function resolveChannel(hub: Hub, key: string, ref: string): Promise<MMChannel> {
  const r = channelRefOf(ref)
  if (POST_ID.test(r.name)) {
    const c = await hub.mm.channel(r.name).catch(() => undefined)
    if (c) return c
  }
  const ts = (await teams(hub, key)).filter(t => !r.team || t.name === r.team)
  for (const t of ts) {
    const c = await hub.mm.channelByName(t.id, r.name.toLowerCase())
    if (c) return c
  }
  // A display name ("Payroll Module"), among the channels the bot is in.
  const want = r.name.toLowerCase()
  for (const t of ts) {
    const c = (await hub.mm.myChannels(t.id)).find(x => x.display_name.toLowerCase() === want)
    if (c) return c
  }
  fail(`no channel "${ref}" the bot can see (list_channels shows the ones it is in)`)
}

/** read_channel: a channel's latest posts, oldest first; `before` pages back. */
export async function readChannel(hub: Hub, key: string, a: { channel: string; limit?: number; before?: string; messageId?: string }): Promise<string> {
  const ch = await resolveChannel(hub, key, a.channel)
  await mustRead(hub, key, ch, await readerFor(hub, key, a.messageId))
  const n = Math.max(1, Math.min(a.limit ?? 50, 200))
  const before = a.before ? (postIdOf(a.before) ?? fail(`"before" must be a post id or link`)) : undefined
  const res = await hub.mm.channelPosts(ch.id, n, before)
  const posts = res.order.map(id => res.posts[id]!).filter(Boolean).reverse()
  const lines = await Promise.all(posts.map(p => postLine(hub, p, { chars: POST_CHARS, thread: true })))
  const more = posts.length === n ? `\n(Older posts: read_channel with before="${posts[0]!.id}". A thread in full: fetch_thread with a post id.)` : ''
  return cap(`${channelLabel(ch)}: ${posts.length} latest post(s)${before ? ` before ${before}` : ''}, oldest first:`, lines) + more
}

/** search_messages: Mattermost search over the bot's channels, only results in channels the person may read. */
export async function searchMessages(hub: Hub, key: string, a: { terms: string; limit?: number; messageId?: string }): Promise<string> {
  const terms = a.terms.trim() || fail('missing "terms"')
  const n = Math.max(1, Math.min(a.limit ?? 20, 100))
  const reader = await readerFor(hub, key, a.messageId)
  const found: { p: MMPost; ch: MMChannel }[] = []
  let hidden = 0
  const allowed = new Map<string, boolean>()
  for (const t of await teams(hub, key)) {
    const res = await hub.mm.searchPosts(t.id, terms, n)
    for (const id of res.order) {
      const p = res.posts[id]
      if (!p || found.some(f => f.p.id === p.id)) continue
      let ok = allowed.get(p.channel_id)
      if (ok === undefined) allowed.set(p.channel_id, (ok = !(await why(hub, key, p.channel_id, reader))))
      if (!ok) {
        hidden++
        continue
      }
      found.push({ p, ch: await hub.mm.channel(p.channel_id) })
      if (found.length >= n) break
    }
    if (found.length >= n) break
  }
  const lines = await Promise.all(found.map(f => postLine(hub, f.p, { chars: POST_CHARS, thread: true, channel: channelLabel(f.ch) })))
  const left = hidden ? `\n(${hidden} more result(s) are in channels you may not read for this person.)` : ''
  if (!found.length) return `Nothing found for "${terms}" in channels you may read.${left}`
  return cap(`${found.length} result(s) for "${terms}", best first (fetch_thread with an id reads its thread):`, lines) + left
}

/** list_channels: the channels the bot is in that the session may read. */
export async function listChannels(hub: Hub, key: string, a: { messageId?: string }): Promise<string> {
  const reader = await readerFor(hub, key, a.messageId)
  const bindings = loadBindings(hub.p.bindings)
  const out: string[] = []
  for (const t of await teams(hub, key)) {
    const chans = (await hub.mm.myChannels(t.id)).filter(c => c.type === 'O' || c.type === 'P' || c.type === 'G')
    const lines: string[] = []
    for (const c of chans.sort((x, y) => x.name.localeCompare(y.name))) {
      if (await why(hub, key, c.id, reader)) continue
      const kind = c.type === 'P' ? 'private' : c.type === 'G' ? 'group' : 'public'
      const ws = bindings[c.id] ? `, workspace ${bindings[c.id]}` : ''
      lines.push(`- ${channelLabel(c)}: ${kind}${ws}${c.purpose ? ` — ${clip(c.purpose.replace(/\s+/g, ' '), 120)}` : ''}`)
    }
    if (lines.length) out.push(`Team ${t.display_name || t.name}:`, ...lines)
  }
  return out.length ? cap('Channels you may read (read_channel reads one):', out) : 'No channels you may read.'
}
