/**
 * Permission relay: a worker's prompt becomes a 🔐 post in its active thread;
 * an owner answers with `yes abcde` / `no abcde` or ✅ / ❌ on the post.
 * Kept in memory — the bridge replays unanswered prompts after a hub restart.
 */

import { fence } from '../shared/util'

export type PendingPrompt = {
  code: string
  key: string
  title: string
  toolName: string
  description: string
  inputPreview: string
  threadId: string
  channelId: string
  postId?: string
  createdAt: number
}

export function promptText(p: Pick<PendingPrompt, 'code' | 'title' | 'toolName' | 'description' | 'inputPreview'>): string {
  const preview = p.inputPreview.length > 1500 ? p.inputPreview.slice(0, 1500) + '\n…' : p.inputPreview
  const f = fence(preview)
  return [
    `🔐 **${p.title}** wants to use **${p.toolName}**${p.description ? ` — ${p.description}` : ''}`,
    preview ? `${f}\n${preview}\n${f}` : '',
    `Owners: reply \`yes ${p.code}\` or \`no ${p.code}\`, or react ✅ / ❌ on this post.`,
  ].filter(Boolean).join('\n')
}

export function answeredText(p: PendingPrompt, behavior: 'allow' | 'deny', by: string): string {
  return `${behavior === 'allow' ? '✅ allowed' : '❌ denied'} by @${by}: **${p.title}** → ${p.toolName}${p.description ? ` — ${p.description}` : ''}`
}

export function staleText(p: PendingPrompt): string {
  return `⌛ no longer pending (answered in the terminal or the turn ended): **${p.title}** → ${p.toolName}`
}

export class PermissionDesk {
  private byCode = new Map<string, PendingPrompt>()

  add(p: PendingPrompt): boolean {
    if (this.byCode.has(p.code)) return false
    this.byCode.set(p.code, p)
    return true
  }

  get(code: string): PendingPrompt | undefined {
    return this.byCode.get(code.toLowerCase())
  }

  codeForPost(postId: string): string | undefined {
    for (const p of this.byCode.values()) if (p.postId === postId) return p.code
    return undefined
  }

  take(code: string): PendingPrompt | undefined {
    const p = this.byCode.get(code.toLowerCase())
    if (p) this.byCode.delete(p.code)
    return p
  }

  /** Remove and return every prompt of a session (its turn ended or it exited). */
  drain(key: string): PendingPrompt[] {
    const out = [...this.byCode.values()].filter(p => p.key === key)
    for (const p of out) this.byCode.delete(p.code)
    return out
  }

  count(key: string): number {
    let n = 0
    for (const p of this.byCode.values()) if (p.key === key) n++
    return n
  }
}
