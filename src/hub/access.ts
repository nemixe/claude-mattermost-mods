/**
 * access.json — who may reach Claude through Mattermost. Same model as the
 * official Telegram plugin (pairing → allowlist), with `groups` → `channels`.
 *
 * Only the /mattermost-hub:access skill edits this file; the hub writes it
 * for one reason: adding and pruning `pending` pairing codes.
 */

import { randomBytes } from 'crypto'
import { log, readJson, writeJsonAtomic } from '../shared/util'

export type PendingEntry = { senderId: string; chatId: string; createdAt: number; expiresAt: number; replies: number }

export type ChannelPolicy = {
  /** Overrides the global requireMention for this channel. */
  requireMention?: boolean
  /** Users (besides owners) who may talk in existing threads here. Empty = any channel member. */
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  /** Owners: may start threads, answer permission prompts, run `!` commands. */
  allowFrom: string[]
  channels: Record<string, ChannelPolicy>
  pending: Record<string, PendingEntry>
  /** Default true — top-level posts must @mention the bot. Replies in a bot-owned thread never need one. */
  requireMention?: boolean
  mentionPatterns?: string[]
  /** Emoji name to react with on receipt (e.g. "eyes"). Unset disables. */
  ackReaction?: string
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export function defaultAccess(): Access {
  return { dmPolicy: 'pairing', allowFrom: [], channels: {}, pending: {} }
}

export function normalizeAccess(p: Partial<Access>): Access {
  return { ...p, dmPolicy: p.dmPolicy ?? 'pairing', allowFrom: p.allowFrom ?? [], channels: p.channels ?? {}, pending: p.pending ?? {} }
}

export class AccessStore {
  private boot: Access | null = null

  constructor(private file: string, private staticMode = process.env.MMHUB_ACCESS_MODE === 'static') {}

  load(): Access {
    if (this.staticMode) {
      if (!this.boot) {
        const a = normalizeAccess(readJson<Partial<Access>>(this.file, defaultAccess))
        if (a.dmPolicy === 'pairing') {
          log('access', 'static mode — dmPolicy "pairing" downgraded to "allowlist"')
          a.dmPolicy = 'allowlist'
        }
        a.pending = {}
        this.boot = a
      }
      return this.boot
    }
    return normalizeAccess(readJson<Partial<Access>>(this.file, defaultAccess))
  }

  save(a: Access): void {
    if (!this.staticMode) writeJsonAtomic(this.file, a)
  }
}

export function pruneExpired(a: Access, now = Date.now()): boolean {
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

/** Mattermost channel types: D = direct, G = group DM, O = public, P = private. */
export type ChannelType = 'D' | 'G' | 'O' | 'P' | string

/**
 * owner   — in allowFrom and posting where the bot listens.
 * member  — allowed in this channel only; may talk in existing threads.
 * unknown — DM from someone not yet paired while dmPolicy is 'pairing'.
 * blocked — drop silently.
 */
export type SenderRole = 'owner' | 'member' | 'unknown' | 'blocked'

/** A channel the bot listens in: listed in access.channels, or bound to a workspace. */
export function classifySender(a: Access, senderId: string, channelId: string, channelType: ChannelType, isBound: boolean): SenderRole {
  if (a.dmPolicy === 'disabled') return 'blocked'
  const owner = a.allowFrom.includes(senderId)
  if (channelType === 'D') {
    if (owner) return 'owner'
    return a.dmPolicy === 'pairing' ? 'unknown' : 'blocked'
  }
  const policy = a.channels[channelId] ?? (isBound ? { allowFrom: [] } : undefined)
  if (!policy) return 'blocked'
  if (owner) return 'owner'
  const list = policy.allowFrom ?? []
  return list.length === 0 || list.includes(senderId) ? 'member' : 'blocked'
}

export function requiresMention(a: Access, channelId: string): boolean {
  return a.channels[channelId]?.requireMention ?? a.requireMention ?? true
}

/** Issue (or re-send) a pairing code. Mutates `a`. 2 replies per code, max 3 pending, 1h expiry. */
export function issuePairingCode(a: Access, senderId: string, chatId: string, now = Date.now()): { code: string; isResend: boolean } | null {
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.senderId === senderId) {
      if ((p.replies ?? 1) >= 2) return null
      p.replies = (p.replies ?? 1) + 1
      return { code, isResend: true }
    }
  }
  if (Object.keys(a.pending).length >= 3) return null
  const code = randomBytes(3).toString('hex')
  a.pending[code] = { senderId, chatId, createdAt: now, expiresAt: now + 60 * 60 * 1000, replies: 1 }
  return { code, isResend: false }
}
