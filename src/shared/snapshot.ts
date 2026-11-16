/**
 * status.json — the snapshot the hub writes for the panel mod (and `mmhub status`).
 * This shape is a contract with hooks/ (the mod); change it only together.
 */

export type SessionStatus = 'starting' | 'busy' | 'idle' | 'closing' | 'stopped' | 'resuming' | 'failed'
export type CloseReason = 'idle' | 'cap' | 'manual' | 'exited' | 'failed' | 'restart'

export type SessionSnapshot = {
  /** ^(r|w)-[a-z0-9]+$ */
  key: string
  role: 'router' | 'worker'
  label: string
  summary?: string
  /** Session name on `tmux -L mmhub`. */
  tmux: string
  model: string
  status: SessionStatus
  pinned: boolean
  attached: boolean
  lastActiveAt: number
  closesAt?: number
  closedAt?: number
  closeReason?: CloseReason
  pendingPermissions: number
  queuedTasks: number
  threadPermalinks: string[]
  /** A graceful restart waits for the current turn to end. */
  restartPending?: boolean
  /** An automatic retry after an API error is scheduled for this time. */
  retryAt?: number
  /** The provider a live session was launched with (it moves to the workspace's active one when it restarts). */
  provider?: string
}

/** How a provider authenticates: "default" is the hub's own environment and login. */
export type ProviderKind = 'default' | 'login' | 'oauth-token' | 'api-key' | 'gateway' | 'bedrock' | 'vertex' | 'foundry'

/** One provider in a workspace's fallback chain. Never holds a secret. */
export type ProviderLink = {
  name: string
  kind: ProviderKind | 'unknown'
  /** Resting after a failure; tried again after this time. */
  coolingUntil?: number
  /** Why it last failed: `auth`, `quota`, `rate_limit`, `errors` or `channels`, with a short detail. */
  reason?: string
  /** Why it can't run sessions at all (not defined, not signed in, a missing secret…). */
  unusable?: string
}

export type WorkspaceProvider = {
  /** The provider new and restarted sessions use. */
  active: string
  kind: ProviderKind | 'unknown'
  /** The active provider is not the first in the chain. */
  fallback: boolean
  /** false: every usable provider is resting; the active one is the first back. */
  healthy: boolean
  /** The chain, in fallback order. */
  chain: ProviderLink[]
}

export type WorkspaceSnapshot = {
  name: string
  path: string
  description?: string
  channels: { id: string; name: string; permalink?: string }[]
  repos: { name: string; path: string }[]
  sessions: SessionSnapshot[]
  /** Which provider the workspace's sessions run on. */
  provider?: WorkspaceProvider
}

export type HubSnapshot = {
  schema: 1
  hub: { pid: number; version: string; startedAt: number; heartbeatAt: number; cliPath: string; bunBin: string; stateDir: string }
  mattermost: { connected: boolean; url: string; bot?: string }
  caps: { liveRouters: number; maxLiveRouters: number; liveWorkers: number; maxLiveWorkers: number }
  workspaces: WorkspaceSnapshot[]
}

export const SESSION_KEY_RE = /^(r|w)-[a-z0-9]+$/
