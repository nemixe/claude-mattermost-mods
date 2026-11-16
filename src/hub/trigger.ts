/**
 * Laya in the hub, for workspaces whose trigger is "laya".
 *
 * A hub thread is *followed* from the bot's first @mention in it, until its
 * router calls `unfollow` (the request is done) or an owner sends `!unfollow`.
 * A later mention follows it again. While a thread is followed, `decideInbound`
 * sends each reply without a mention to Laya (`classify`). It is judged off the
 * hub's chain, so a slow or absent Laya never holds up other events, and the
 * hub acts on the verdict back on the chain. Posts of one thread are judged and
 * acted on in the order they came. In a thread that isn't followed, replies
 * without a mention are ignored. DMs never go to Laya: every DM reaches the bot.
 */

import { errMsg, log } from '../shared/util'
import type { Hub } from './hub'
import type { InboundAction } from './inbound'
import { judge, loadTrigger, type ChatLine } from './laya'
import type { MMPost } from './mattermost'
import { loadBindings } from './workspaces'

type Classify = Extract<InboundAction, { kind: 'classify' }>

const queues = new WeakMap<Hub, Map<string, Promise<void>>>()
let lastWarnAt = 0

/** Judge the post with Laya, then act: `a.then` when it is meant for the bot. Resolves when done. */
export function classifyLater(hub: Hub, a: Classify, post: MMPost, channelType: string): Promise<void> {
  let q = queues.get(hub)
  if (!q) queues.set(hub, (q = new Map()))
  const prev = q.get(a.threadId) ?? Promise.resolve()
  const next = prev.then(async () => {
    const yes = await verdict(hub, a, post)
    await hub.enqueue(() => (yes ? hub.act(a.then, post, channelType) : passOver(hub, a)))
  }).catch(err => log('trigger', `${post.id}: ${errMsg(err)}`))
  q.set(a.threadId, next)
  void next.finally(() => {
    if (q.get(a.threadId) === next) q.delete(a.threadId)
  })
  return next
}

async function verdict(hub: Hub, a: Classify, post: MMPost): Promise<boolean> {
  const wsName = hub.store.thread(a.threadId)?.workspace ?? loadBindings(hub.p.bindings)[post.channel_id]
  const w = wsName ? hub.ws(wsName) : undefined
  if (!w) return true
  const cfg = hub.cfg.laya
  try {
    const v = await judge(cfg, {
      bot: hub.bot.username,
      rules: loadTrigger(w.dir).rules,
      newest: { who: await who(hub, post), text: post.message },
      earlier: await before(hub, post, cfg.messages),
    })
    log('trigger', `${post.id} (${w.name}): ${v.p.toFixed(2)} by ${v.why} → ${v.yes ? 'to the router' : 'not for the bot'}`)
    return v.yes
  } catch (err) {
    if (Date.now() - lastWarnAt > 60_000) {
      lastWarnAt = Date.now()
      log('trigger', `Laya failed (${errMsg(err)}): until it answers, replies in followed threads go to their router`)
    }
    return true
  }
}

/** Not for the bot: the router learns how many it missed when the next message reaches it. */
function passOver(hub: Hub, a: Classify): void {
  const k = `skipped:${a.threadId}`
  hub.store.set(k, String(Number(hub.store.get(k) ?? 0) + 1))
}

/** Whether the bot follows a hub thread (trigger "laya"): from its first mention until unfollowed. */
export function following(hub: Hub, threadId: string): boolean {
  return hub.store.get(`follow:${threadId}`) !== 'off'
}

export function setFollowing(hub: Hub, threadId: string, on: boolean): void {
  if (on) hub.store.del(`follow:${threadId}`)
  else hub.store.set(`follow:${threadId}`, 'off')
  log('trigger', `${threadId}: ${on ? 'following' : 'no longer following'}`)
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

/** Posts before this one in its thread (Laya judges replies only). */
async function before(hub: Hub, post: MMPost, n: number): Promise<ChatLine[]> {
  if (n <= 0 || !post.root_id) return []
  const res = await hub.mm.getThread(post.root_id)
  const posts = Object.values(res.posts)
    .filter(p => p.id !== post.id && !p.type && p.create_at <= post.create_at)
    .sort((x, y) => x.create_at - y.create_at)
    .slice(-n)
  const out: ChatLine[] = []
  for (const p of posts) out.push({ who: await who(hub, p), text: p.message })
  return out
}

async function who(hub: Hub, p: { user_id: string }): Promise<string> {
  return p.user_id === hub.bot.id ? `@${hub.bot.username} (AI assistant)` : `@${await hub.mm.username(p.user_id)}`
}

/** "(N messages … not for you)" for a router, once; empty when there were none. */
export function takeSkipped(hub: Hub, threadId: string): string {
  const k = `skipped:${threadId}`
  const n = Number(hub.store.get(k) ?? 0)
  if (!n) return ''
  hub.store.set(k, '0')
  return `(${n} earlier message(s) in this thread were judged not meant for you, so you didn't get them; fetch_thread shows them.)`
}
