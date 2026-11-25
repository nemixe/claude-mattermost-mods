/**
 * The judge in the hub, for workspaces whose trigger is "laya" or "openrouter"
 * (Laya, or a hosted model through OpenRouter: openrouter.ts).
 *
 * A hub thread is *followed* from the bot's first @mention in it, until its
 * router calls `unfollow` (the request is done, which it decides after each reply:
 * tools.ts followChoice) or an owner sends `!unfollow`. A later mention follows it
 * again. While a thread is followed, `decideInbound` sends each reply without a
 * mention to Laya (`classify`). It is judged off the hub's chain, so a slow or
 * absent Laya never holds up other events, and the hub acts on the verdict back on
 * the chain. Posts of one thread are judged and acted on in the order they came. In
 * a thread that isn't followed, replies without a mention are ignored. DMs never go
 * to Laya: every DM reaches the bot.
 */

import { errMsg, log, readEnvFile } from '../shared/util'
import type { Trigger } from './config'
import type { Hub } from './hub'
import type { InboundAction } from './inbound'
import { judge, loadTrigger, MAX_PARTICIPANTS, mentionedNames, type ChatLine, type LayaCall, type LayaConfig, type Person } from './laya'
import { serveKey, servePaths } from './layaserve'
import type { MMPost } from './mattermost'
import { judgeOpenRouter, OPENROUTER_KEY, type OpenRouterCall } from './openrouter'
import { effective, loadBindings } from './workspaces'

type Classify = Extract<InboundAction, { kind: 'classify' }>

const queues = new WeakMap<Hub, Map<string, Promise<void>>>()
let lastWarnAt = 0

/** Judge the post with Laya, then act: `a.then` when it is meant for the bot. Resolves when done. */
export function classifyLater(hub: Hub, a: Classify, post: MMPost, channelType: string): Promise<void> {
  let q = queues.get(hub)
  if (!q) queues.set(hub, (q = new Map()))
  const prev = q.get(a.threadId) ?? Promise.resolve()
  const next = prev.then(async () => {
    const v = await verdict(hub, a, post)
    await hub.enqueue(() => {
      if (v === true) return hub.act(a.then, post, channelType)
      if (typeof v === 'number') unfollowQuiet(hub, a.threadId, v)
      passOver(hub, a)
    })
  }).catch(err => log('trigger', `${post.id}: ${errMsg(err)}`))
  q.set(a.threadId, next)
  void next.finally(() => {
    if (q.get(a.threadId) === next) q.delete(a.threadId)
  })
  return next
}

/**
 * true: the post is for the bot. false: it isn't. A number: that many posts went by
 * since the bot last posted (hub.cfg.unfollowAfter or more), so the hub stops
 * following the thread and the post isn't judged.
 */
async function verdict(hub: Hub, a: Classify, post: MMPost): Promise<boolean | number> {
  const wsName = hub.store.thread(a.threadId)?.workspace ?? loadBindings(hub.p.bindings)[post.channel_id]
  const w = wsName ? hub.ws(wsName) : undefined
  if (!w) return true
  const viaOpenRouter = effective(hub.cfg, w).trigger === 'openrouter'
  const who = viaOpenRouter ? 'OpenRouter' : 'Laya'
  try {
    const { earlier, people, gap } = await thread(hub, post, viaOpenRouter ? hub.cfg.openrouter.messages : hub.cfg.laya.messages)
    if (hub.cfg.unfollowAfter > 0 && gap >= hub.cfg.unfollowAfter) return gap
    const o = {
      bot: hub.bot.username,
      rules: loadTrigger(w.dir).rules,
      newest: await line(hub, post),
      earlier,
      people,
      mentioned: await mentioned(hub, post.message),
    }
    const v = viaOpenRouter ? await judgeOpenRouter(openRouterCall(hub), o) : await judge(layaCall(hub), o)
    log('trigger', `${post.id} (${w.name}${viaOpenRouter ? `, ${hub.cfg.openrouter.model}` : ''}): ${v.p.toFixed(2)} by ${v.why} → ${v.yes ? 'to the router' : 'not for the bot'}`)
    return v.yes
  } catch (err) {
    if (Date.now() - lastWarnAt > 60_000) {
      lastWarnAt = Date.now()
      log('trigger', `${who} failed (${errMsg(err)}): until it answers, replies in followed threads go to their router`)
    }
    return true
  }
}

/** The hub's OpenRouter settings, with the key from .env (read each time, so a new key needs no restart). */
export function openRouterCall(hub: Pick<Hub, 'cfg' | 'p'>): OpenRouterCall {
  return { ...hub.cfg.openrouter, apiKey: readEnvFile(hub.p.env)[OPENROUTER_KEY] || undefined }
}

/** The hub's Laya settings, with laya-serve's API key when the hub runs it. */
export function layaCall(hub: Pick<Hub, 'cfg' | 'p'>): LayaConfig & LayaCall {
  const cfg = hub.cfg.laya
  return cfg.serve ? { ...cfg, apiKey: serveKey(servePaths(hub.p)) } : cfg
}

/** Not for the bot: the router learns how many it missed when the next message reaches it. */
function passOver(hub: Hub, a: Classify): void {
  countSkipped(hub, a.threadId)
}

/** `gap` posts went by without one from the bot: stop following the thread (a mention follows it again). Call on the chain. */
function unfollowQuiet(hub: Hub, threadId: string, gap: number): void {
  if (!following(hub, threadId)) return
  setFollowing(hub, threadId, false, `${gap} messages went by without a post from you, so the hub stopped following this thread`)
}

/** One more reply in this hub thread its router didn't get (Laya said no, or it lacked a mention under mention-only). */
export function countSkipped(hub: Pick<Hub, 'store'>, threadId: string): void {
  const k = `skipped:${threadId}`
  hub.store.set(k, String(Number(hub.store.get(k) ?? 0) + 1))
}

/** Whether the bot follows a hub thread (trigger "laya"): from its first mention until unfollowed. */
export function following(hub: Hub, threadId: string): boolean {
  return hub.store.get(`follow:${threadId}`) !== 'off'
}

/**
 * Follow a thread, or stop. `why` it stopped is told to its router, with how many
 * messages it missed, when a mention follows the thread again (takeSkipped).
 */
export function setFollowing(hub: Hub, threadId: string, on: boolean, why = 'you unfollowed it'): void {
  if (on) hub.store.del(`follow:${threadId}`)
  else {
    hub.store.set(`follow:${threadId}`, 'off')
    hub.store.set(`unfollowed:${threadId}`, why)
  }
  log('trigger', `${threadId}: ${on ? 'following' : `no longer following (${why})`}`)
}

/** Remember that a channel is a DM (posted events say so; threads don't). Call on the chain. */
export function noteDM(hub: Hub, channelId: string): void {
  const k = `dm-channel:${channelId}`
  if (hub.store.get(k) !== '1') hub.store.set(k, '1')
}

/** A hub thread in a DM: every message in it reaches the bot, so Laya and follow state don't apply. */
export function inDM(hub: Hub, threadId: string): boolean {
  const t = hub.store.thread(threadId)
  return !!t && hub.store.get(`dm-channel:${t.channelId}`) === '1'
}

/**
 * The last `n` posts before this one in its thread, everyone who wrote any post before
 * it (Laya judges replies only), and the gap: posts since the bot's last one there,
 * this one included.
 */
async function thread(hub: Hub, post: MMPost, n: number): Promise<{ earlier: ChatLine[]; people: Person[]; gap: number }> {
  if (!post.root_id) return { earlier: [], people: [], gap: 0 }
  const res = await hub.mm.getThread(post.root_id)
  const posts = Object.values(res.posts)
    .filter(p => p.id !== post.id && !p.type && p.create_at <= post.create_at)
    .sort((x, y) => x.create_at - y.create_at)
  const people: Person[] = []
  const ids = new Set<string>()
  for (const p of posts) {
    if (ids.has(p.user_id)) continue
    ids.add(p.user_id)
    people.push(await author(hub, p.user_id))
  }
  const earlier: ChatLine[] = []
  for (const p of n > 0 ? posts.slice(-n) : []) earlier.push(await line(hub, p))
  const gap = posts.length - posts.findLastIndex(p => p.user_id === hub.bot.id)
  return { earlier, people, gap }
}

/** A post with its author's username, and whether a bot account wrote it. */
async function line(hub: Hub, p: { user_id: string; message: string }): Promise<ChatLine> {
  return { ...(await author(hub, p.user_id)), text: p.message }
}

async function author(hub: Hub, userId: string): Promise<Person> {
  if (userId === hub.bot.id) return { user: hub.bot.username, bot: true }
  const u = await hub.mm.user(userId).catch(() => undefined)
  return { user: u?.username ?? userId, bot: !!u?.is_bot }
}

/** Users the post @mentions that exist (they are among Laya's answers). */
async function mentioned(hub: Hub, text: string): Promise<Person[]> {
  const out: Person[] = []
  for (const name of mentionedNames(text).slice(0, MAX_PARTICIPANTS)) {
    const u = await hub.mm.userByName(name)
    if (u) out.push({ user: u.username, bot: !!u.is_bot })
  }
  return out
}

/** "(N messages … not for you)" for a router, once; empty when there were none. */
export function takeSkipped(hub: Hub, threadId: string, trigger?: Trigger): string {
  const k = `skipped:${threadId}`
  const n = Number(hub.store.get(k) ?? 0)
  const unfollowed = hub.store.get(`unfollowed:${threadId}`)
  if (unfollowed !== undefined) hub.store.del(`unfollowed:${threadId}`)
  if (!n) return ''
  hub.store.set(k, '0')
  if (trigger === 'mention-only') return `(${n} earlier message(s) in this thread didn't @mention you, so you didn't get them; fetch_thread shows them.)`
  if (unfollowed) return `(${n} earlier message(s) in this thread didn't reach you: ${unfollowed}, and they didn't @mention you. You follow it again now. fetch_thread shows them.)`
  return `(${n} earlier message(s) in this thread were judged not meant for you, so you didn't get them; fetch_thread shows them.)`
}
