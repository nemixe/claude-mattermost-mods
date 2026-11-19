/**
 * new_thread: a router starts a new thread for the person it serves, a new top-level
 * post in a channel of its workspace (an introduction, an announcement, a summary for
 * everyone). Every thread has its own router, so the new one gets a router of its own.
 * That router starts only when someone replies there; its first message tells it what
 * was posted, for whom and from which thread. The router that posted stays with its
 * own thread.
 *
 * Guards: routers only; only on a person's request (message_id: a person's message in
 * the router's thread); only channels bound to the router's workspace, which that
 * person is a member of; MAX_NEW_THREADS_PER_HOUR per router; no @mention of another
 * bot nobody asked for (bots.ts).
 */

import { log, MAX_POST_CHARS } from '../shared/util'
import { checkBotMentions } from './bots'
import { channelLabel, isMember, resolveChannel } from './explore'
import type { Hub } from './hub'
import { isBotPost } from './mattermost'
import { postInScope, ToolError } from './tools'
import { loadBindings } from './workspaces'

export const MAX_NEW_THREADS_PER_HOUR = 5
const HOUR = 3_600_000

/** The note a new thread's router gets in front of its first message. */
export function originKey(routerKey: string): string {
  return `origin:${routerKey}`
}

export async function newThread(hub: Hub, key: string, a: { text: string; messageId: string; channel?: string }): Promise<string> {
  if (!key.startsWith('r-')) throw new ToolError("routers only: report it to your thread's router, which can post it")
  const thread = hub.store.threadByRouter(key)
  if (!thread) throw new ToolError('this router has no thread')
  const text = a.text.trim()
  if (!text) throw new ToolError('empty post')
  if (text.length > MAX_POST_CHARS) throw new ToolError(`too long: ${text.length} characters, at most ${MAX_POST_CHARS} in one post`)

  const asked = await postInScope(hub, key, a.messageId)
  if (asked.user_id === hub.bot.id || isBotPost(asked)) throw new ToolError(`message ${a.messageId} is not a person's: pass the message of the person who asked for the post`)
  const person = await hub.mm.username(asked.user_id)

  const ch = a.channel ? await resolveChannel(hub, key, a.channel) : await hub.mm.channel(thread.channelId)
  const where = channelLabel(ch)
  if (loadBindings(hub.p.bindings)[ch.id] !== thread.workspace) throw new ToolError(`${where} is not a channel of workspace ${thread.workspace}: you start threads only in its own channels`)
  if (!(await isMember(hub, ch.id, asked.user_id).catch(() => false))) throw new ToolError(`@${person} is not a member of ${where}, so you may not post there for them`)

  const k = `newthreads:${key}`
  const recent = (JSON.parse(hub.store.get(k) ?? '[]') as number[]).filter(at => at > Date.now() - HOUR)
  if (recent.length >= MAX_NEW_THREADS_PER_HOUR) throw new ToolError(`you started ${recent.length} threads in the last hour, the most there may be: post it in your thread, or later`)

  await checkBotMentions(hub, key, text)
  const w = hub.ws(thread.workspace)
  if (!w) throw new ToolError(`workspace ${thread.workspace} is gone`)

  return hub.enqueue(async () => {
    const post = await hub.mm.createPost({ channel_id: ch.id, message: text, props: { mmhub_session: key, mmhub_from_thread: thread.id } })
    hub.store.insertPost({ id: post.id, threadId: post.id, sessionKey: key, createAt: post.create_at, message: post.message })
    const label = text.split('\n').find(l => l.trim())!.trim().replace(/^#+\s*/, '').slice(0, 60)
    const rkey = hub.createRouter({ threadId: post.id, channelId: ch.id, workspace: w, label })
    const quote = text.length > 1500 ? `${text.slice(0, 1500)}…` : text
    hub.store.set(originKey(rkey), [
      `[You are the router of a thread the hub started: the router of thread ${thread.id} ("${thread.label}") posted its first post in ${where}, because @${person} asked for it there. Replies here come to you; that thread carries on without you. What was posted:]`,
      quote.split('\n').map(l => `> ${l}`).join('\n'),
      `(fetch_thread(thread_id="${thread.id}") reads the thread it came from, when you need more of the background.)`,
    ].join('\n'))
    hub.store.set(k, JSON.stringify([...recent, Date.now()]))
    hub.status.changed()
    log('threads', `${key} started thread ${post.id} in ${where} for @${person} (its router: ${rkey})`)
    return `posted: ${hub.mm.permalink(post.id)}, a new thread in ${where}. A router of its own answers replies there; you stay with this thread. Tell @${person} where it is, in a line.`
  })
}
