/**
 * Other bots on the server (another agent, such as Hermes on the same machine, or a
 * CI bot) are not the sessions' helpers. A session that @mentions one hands it work
 * nobody asked it to have. So a post that @mentions another bot is refused, unless a
 * person named that bot in one of the session's threads, or the scheduled job its
 * router runs did: then they asked for it.
 */

import { errMsg, log } from '../shared/util'
import type { Hub } from './hub'
import { isBotPost } from './mattermost'
import { isDraft, type ThreadRow } from './store'
import { ToolError } from './tools'

/** @mentions that aren't users. */
const SPECIAL = new Set(['all', 'channel', 'here'])
/** Names that are no user, for a while (code like `@types/node` would look them up on every post). */
const nobody = new Map<string, number>()
const NOBODY_TTL = 10 * 60_000

/** The usernames a text @mentions, lowercased, without the hub bot's own. */
export function mentions(text: string, own = ''): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/(?:^|[^\w@./-])@([a-z0-9][a-z0-9._-]*)/gi)) {
    const name = m[1]!.replace(/[._-]+$/, '').toLowerCase()
    if (name && !SPECIAL.has(name) && name !== own.toLowerCase()) out.add(name)
  }
  return [...out]
}

/** The bot accounts among the names (not the hub's own). */
async function botsAmong(hub: Hub, names: string[]): Promise<string[]> {
  const bots: string[] = []
  for (const name of names) {
    const until = nobody.get(name)
    if (until && until > Date.now()) continue
    const u = await hub.mm.userByName(name).catch(() => undefined)
    if (!u) {
      nobody.set(name, Date.now() + NOBODY_TTL)
      continue
    }
    if (u.is_bot && u.id !== hub.bot.id) bots.push(u.username.toLowerCase())
  }
  return bots
}

/** What people asked of the session: their posts in its threads (or `threads`), and the scheduled jobs their routers ran. */
export async function askedTexts(hub: Hub, key: string, threads: ThreadRow[] = hub.threadsOf(key)): Promise<string[]> {
  const texts: string[] = []
  for (const t of threads) {
    if (!isDraft(t.id)) {
      try {
        const posts = Object.values((await hub.mm.getThread(t.id)).posts)
        for (const p of posts) {
          if (p.user_id === hub.bot.id || isBotPost(p) || hub.store.postOwner(p.id)) continue
          texts.push(p.message)
        }
      } catch (e) {
        log('threads', `${t.id}: couldn't read the thread to check who asked for a bot: ${errMsg(e)}`)
      }
    }
    for (const m of hub.store.messagesFor(t.routerKey, ['queued', 'delivered', 'interrupted', 'ended'])) {
      if (m.meta.kind === 'scheduled') texts.push(m.content)
    }
  }
  return texts
}

/** Whether a text names `name`, with or without the @. */
export function names(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w.-])@?${esc}(?![\\w-])`, 'i').test(text)
}

/** Refuse a post that @mentions another bot nobody asked the session to involve. */
export async function checkBotMentions(hub: Hub, key: string, text: string): Promise<void> {
  const bots = await botsAmong(hub, mentions(text, hub.bot.username))
  if (!bots.length) return
  const asked = await askedTexts(hub, key)
  const unasked = bots.filter(b => !asked.some(t => names(t, b)))
  if (!unasked.length) return
  const who = unasked.map(b => `@${b}`).join(', ')
  log('threads', `${key}: refused a post that @mentions ${who}, a bot nobody asked for`)
  const yours = key.startsWith('r-') ? 'yourself or with your workers' : 'yourself'
  throw new ToolError(`${who} ${unasked.length > 1 ? 'are bots' : 'is a bot'}, not a person: don't hand it work or ask it things. Do the work ${yours}. Involve another bot or agent only when a person asks you to (nobody here named ${who}).`)
}
