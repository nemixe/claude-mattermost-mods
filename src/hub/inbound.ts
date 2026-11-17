/**
 * What to do with a Mattermost post or reaction. Pure: everything it needs is
 * passed in, so the whole decision table is unit-tested (test/inbound.test.ts).
 */

import { PERMISSION_REPLY_RE } from '../shared/util'
import { classifySender, isOwner, requiresMention, type Access, type SenderRole } from './access'
import { judged, type Trigger } from './config'
import { isBotPost } from './mattermost'

export type InboundPost = { id: string; root_id: string; user_id: string; channel_id: string; message: string; type?: string; props?: Record<string, unknown> }

export type InboundInput = {
  post: InboundPost
  channelType: string
  bot: { id: string; username: string }
  access: Access
  /** Workspace bound to the post's channel. */
  workspace?: string
  /** The post's thread (root_id || id) already belongs to the hub. */
  knownThread: boolean
  /** The hub asked "which workspace?" (in this thread, or in this chat for a top-level post) and waits for this owner's answer. */
  awaitingWorkspace: boolean
  /** The post's thread is a DM a session sent (send_dm): replies in it go back to that session. */
  linkedDM?: boolean
  /**
   * The trigger of the workspace the post belongs to (its thread's, else its channel's).
   * With "laya", a reply without a mention in a hub thread the bot follows goes to Laya;
   * in a thread it no longer follows, only a mention reaches it (and follows it again).
   * With "mention-only", only a post that @mentions the bot reaches it, in its threads too.
   * DMs ignore it: every DM reaches the bot.
   */
  trigger?: Trigger
  /** The hub thread is followed: the bot was mentioned in it and its router hasn't called unfollow since. Default true. */
  followed?: boolean
}

export type InboundAction =
  /** `passOver`: a reply in that hub thread the router didn't get; it learns how many with the next one it does. */
  | { kind: 'ignore'; reason: string; passOver?: string }
  | { kind: 'pair' }
  | { kind: 'permission'; behavior: 'allow' | 'deny'; code: string }
  | { kind: 'command'; name: string; args: string[]; threadId: string; role: SenderRole }
  | { kind: 'ask_workspace'; threadId: string }
  | { kind: 'workspace_answer'; threadId: string; text: string }
  | { kind: 'start'; threadId: string; workspace: string; text: string }
  /** `follow`: the post mentions the bot in a thread it may not follow (trigger "laya"): follow it again. */
  | { kind: 'message'; threadId: string; text: string; role: SenderRole; follow?: true }
  | { kind: 'dm_reply'; threadId: string }
  /**
   * A reply without a mention in a followed hub thread (trigger "laya"): ask Laya
   * whether it is meant for the bot. Yes, or Laya can't answer → `then` (the
   * router gets it, as without Laya); no → it is passed over.
   */
  | { kind: 'classify'; threadId: string; then: Extract<InboundAction, { kind: 'message' }> }

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function mentionRe(username: string): RegExp {
  return new RegExp(`(^|[^\\w.-])@${escapeRe(username)}(?![\\w-])`, 'i')
}

export function isMentioned(text: string, username: string, patterns: string[] = []): boolean {
  if (mentionRe(username).test(text)) return true
  for (const p of patterns) {
    try {
      if (new RegExp(p, 'i').test(text)) return true
    } catch {}
  }
  return false
}

/** Drop a leading "@bot" (and punctuation after it) so commands and answers read cleanly. */
export function stripLeadingMention(text: string, username: string): string {
  return text.replace(new RegExp(`^\\s*@${escapeRe(username)}[\\s,:]*`, 'i'), '').trim()
}

export function decideInbound(i: InboundInput): InboundAction {
  const { post, bot, access } = i
  if (post.user_id === bot.id) return { kind: 'ignore', reason: 'own post' }
  if (post.type) return { kind: 'ignore', reason: `system post ${post.type}` }

  const role = classifySender(access, post.user_id, post.channel_id, i.channelType, !!i.workspace, isBotPost(post))
  if (role === 'blocked') return { kind: 'ignore', reason: 'sender not allowed here' }
  if (role === 'unknown') return { kind: 'pair' }

  const threadId = post.root_id || post.id
  const raw = post.message ?? ''
  const text = stripLeadingMention(raw, bot.username)

  if (role === 'owner') {
    const m = PERMISSION_REPLY_RE.exec(raw)
    if (m) return { kind: 'permission', behavior: m[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny', code: m[2]!.toLowerCase() }
  }

  const isDM = i.channelType === 'D'
  // An answer to a session's DM (in its thread) goes back to that session.
  if (isDM && post.root_id && i.linkedDM) return { kind: 'dm_reply', threadId }

  const mentioned = isDM || isMentioned(raw, bot.username, access.mentionPatterns)

  if (text.startsWith('!') && role === 'owner' && (i.knownThread || mentioned)) {
    const [name = '', ...args] = text.slice(1).trim().split(/\s+/)
    return { kind: 'command', name: name.toLowerCase(), args, threadId, role }
  }

  // The hub decides whether this post can answer an open question (same thread, or a plain message in the same chat).
  if (i.awaitingWorkspace && role === 'owner') return { kind: 'workspace_answer', threadId, text }

  // mention-only: outside DMs a post reaches the bot only when it @mentions it, in the bot's threads too.
  // (Prompt answers and ! commands are taken above.)
  if (i.trigger === 'mention-only' && !isDM && !mentioned) {
    return { kind: 'ignore', reason: 'no mention (trigger mention-only)', ...(i.knownThread ? { passOver: threadId } : {}) }
  }

  if (i.knownThread) {
    const message = { kind: 'message' as const, threadId, text: raw, role }
    // A DM always reaches the bot: no mention needed, no Laya, no follow state.
    if (!judged(i.trigger) || isDM) return message
    // Laya: a mention follows the thread; while it is followed, Laya judges the rest.
    if (mentioned) return { ...message, follow: true }
    if (i.followed === false) return { kind: 'ignore', reason: 'thread not followed (a mention follows it again)' }
    return { kind: 'classify', threadId, then: message }
  }

  // A new thread (a top-level post, or a mention inside someone else's thread).
  if (!mentioned && (requiresMention(access, post.channel_id) || post.root_id)) return { kind: 'ignore', reason: 'no mention' }
  if (role !== 'owner') return { kind: 'ignore', reason: 'only owners start threads' }
  if (!i.workspace) return { kind: 'ask_workspace', threadId }
  return { kind: 'start', threadId, workspace: i.workspace, text: raw }
}

const ALLOW = new Set(['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check', '+1', 'thumbsup'])
const DENY = new Set(['x', 'no_entry', 'no_entry_sign', 'negative_squared_cross_mark', '-1', 'thumbsdown'])

/** An owner's ✅/❌ on a 🔐 post answers that prompt. `reactorIsBot`: the reacting account is a bot (it matters under `"*"`). */
export function decideReaction(
  r: { user_id: string; post_id: string; emoji_name: string },
  bot: { id: string },
  access: Access,
  promptCodeForPost: (postId: string) => string | undefined,
  reactorIsBot = false,
): InboundAction {
  if (r.user_id === bot.id) return { kind: 'ignore', reason: 'own reaction' }
  const code = promptCodeForPost(r.post_id)
  if (!code) return { kind: 'ignore', reason: 'not a permission prompt' }
  if (!isOwner(access, r.user_id, reactorIsBot)) return { kind: 'ignore', reason: 'only owners answer prompts' }
  const behavior = ALLOW.has(r.emoji_name) ? 'allow' : DENY.has(r.emoji_name) ? 'deny' : undefined
  if (!behavior) return { kind: 'ignore', reason: `emoji ${r.emoji_name}` }
  return { kind: 'permission', behavior, code }
}
