/**
 * The router's view of what workers posted in its thread since its last turn.
 * Prepended (capped) to the next message the router gets.
 */

import { fmtAge } from '../shared/util'
import type { PostRow } from './store'

export type DigestCaps = { perPost: number; total: number }
export const DEFAULT_DIGEST_CAPS: DigestCaps = { perPost: 1500, total: 6000 }

/** Returns the digest text ('' when nothing new) and the cursor to store afterwards. */
export function buildDigest(
  posts: PostRow[],
  titles: Record<string, string>,
  now: number,
  caps: DigestCaps = DEFAULT_DIGEST_CAPS,
): { text: string; cursor: number } {
  if (!posts.length) return { text: '', cursor: 0 }
  const sorted = [...posts].sort((a, b) => a.createAt - b.createAt)
  const cursor = sorted[sorted.length - 1]!.createAt
  const parts: string[] = []
  let used = 0
  let dropped = 0
  // Newest first when trimming: the latest results matter most.
  for (const p of [...sorted].reverse()) {
    let body = p.message.replace(/^\*\*🛠[^\n]*\*\*\n?/, '').trim()
    if (body.length > caps.perPost) body = body.slice(0, caps.perPost) + ' …[cut]'
    const head = `— ${titles[p.sessionKey] ?? p.sessionKey} (${p.sessionKey}), ${fmtAge(now - p.createAt)} ago, post ${p.id}:`
    const block = `${head}\n${body}`
    if (used + block.length > caps.total && parts.length) {
      dropped++
      continue
    }
    parts.unshift(block)
    used += block.length
  }
  const more = dropped ? `\n(${dropped} older post${dropped > 1 ? 's' : ''} not shown — fetch_thread has everything)` : ''
  return { text: `[Workers posted in this thread since your last turn:]\n${parts.join('\n\n')}${more}\n[End of worker posts]`, cursor }
}
