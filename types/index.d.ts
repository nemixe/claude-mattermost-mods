// The Mattermost Hub panel's contract.
//
// HubSnapshot and SessionSnapshot mirror what the hub writes to status.json
// (src/shared/snapshot.ts is the hub's copy); change the two together.

export type SessionStatus =
  | 'starting'
  | 'busy'
  | 'idle'
  | 'closing'
  | 'stopped'
  | 'resuming'
  | 'failed'

export type CloseReason = 'idle' | 'cap' | 'manual' | 'exited' | 'failed' | 'restart'

export type SessionSnapshot = {
  /** ^(r|w)-[a-z0-9]+$ */
  key: string
  role: 'router' | 'worker'
  label: string
  summary?: string
  /** The session's name on `tmux -L mmhub`. */
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
export type ProviderKind =
  | 'default'
  | 'login'
  | 'oauth-token'
  | 'api-key'
  | 'gateway'
  | 'bedrock'
  | 'vertex'
  | 'foundry'

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
  /** Whose personal workspace it is, as `@user` (its name is `personal-<user id>`). */
  label?: string
  /** Why the hub can't read it, when it can't (its repos and settings are not known then). */
  unreadable?: string
  channels: { id: string; name: string; permalink?: string }[]
  repos: { name: string; path: string }[]
  sessions: SessionSnapshot[]
  /** Which provider the workspace's sessions run on. */
  provider?: WorkspaceProvider
}

export type HubSnapshot = {
  schema: 1
  hub: {
    pid: number
    version: string
    startedAt: number
    heartbeatAt: number
    cliPath: string
    bunBin: string
    stateDir: string
  }
  mattermost: { connected: boolean; url: string; bot?: string }
  caps: {
    liveRouters: number
    maxLiveRouters: number
    liveWorkers: number
    maxLiveWorkers: number
  }
  workspaces: WorkspaceSnapshot[]
}

/** Why the panel counts the hub as down. */
export type HubDownReason = 'missing' | 'unparsable' | 'schema' | 'stale'

/**
 * What the panel draws from, written by the poll only when it changed.
 *
 * `unknown` until the first read; `down` keeps a stale snapshot (when there
 * was one) so Start hub can reuse its `bunBin` and `cliPath`.
 */
export type HubView =
  | { state: 'unknown' }
  | { state: 'up'; snapshot: HubSnapshot }
  | { state: 'down'; reason: HubDownReason; snapshot?: HubSnapshot }

declare module 'claude-code' {
  interface PluginState {
    'mattermost-hub': {
      /** The hub as last read from status.json. */
      view: Shaped<HubView>
      /** Whether a workspace's "N stopped" group is expanded, by workspace name. */
      stoppedOpen: StateFamily<boolean>
      /** Set once the pane was opened unasked, so a reload does not reopen it. */
      autoOpened: boolean
    }
  }
}
