/** config.json — hub-wide defaults. Edited by /mattermost-hub:configure; re-read on use. */

import { expandHome } from '../shared/paths'
import { DEFAULT_LAYA, type LayaConfig } from './laya'
import { readJson } from '../shared/util'

export type IdleMinutes = { router: number; worker: number }

/**
 * What makes the bot take a post in a workspace's channels (DMs always reach it):
 * - `mention` (default): an @mention starts a thread; every reply in the bot's threads reaches it.
 * - `mention-only`: only posts that @mention the bot reach it, replies in its threads too.
 * - `laya`: a mention starts or follows a thread; Laya judges the replies without one (laya.ts).
 */
export const TRIGGERS = ['mention', 'mention-only', 'laya'] as const
export type Trigger = (typeof TRIGGERS)[number]

export function isTrigger(x: unknown): x is Trigger {
  return (TRIGGERS as readonly unknown[]).includes(x)
}

export type HubConfig = {
  workspacesDir: string
  routerModel: string
  workerModel: string
  /** Extra args for routers, e.g. ["--effort","low"]. */
  routerArgs: string[]
  workerArgs: string[]
  workerPermissionMode: string
  idleMinutes: IdleMinutes
  maxLiveRouters: number
  maxLiveWorkers: number
  maxWorkersPerWorkspace: number
  /**
   * Where workers' reports go: "router" (default) — to the thread's router, which tells
   * people what matters; "thread" — workers post in the thread themselves.
   */
  workerReports: 'router' | 'thread'
  /** Post "💤 closed after Nm idle" in the thread when a session auto-closes. */
  announceClose: boolean
  /** Minutes without a hook event before a busy worker is flagged. */
  busyWatchdogMinutes: number
  claudeBin?: string
  bunBin?: string
  gitBin?: string
  /** PATH for spawned sessions (recorded from the login shell at configure/install time). */
  path?: string
  /**
   * How routers work with people (their persona), for workspaces without a ROUTER.md.
   * Default: a project manager who drives requests to done (prompts.ts DEFAULT_ROUTER_PERSONA).
   */
  routerPersona?: string
  /** Router auto-compact window (tokens); undefined = Claude Code default. */
  routerAutocompact?: number
  /** Plugins to switch off in spawned sessions (belt and braces; setting-sources already skips user plugins). */
  disablePlugins: string[]
  /** tmux socket name (`tmux -L <name>`). */
  tmuxSocket: string
  /**
   * Hub-wide provider chain, in fallback order (names from providers.json, or
   * "default": the hub's own login). Workspaces without their own list use it.
   * Unset: ["default"].
   */
  providers?: string[]
  /** Minutes a failed provider rests before it is tried again, by fault (providers.ts COOLDOWN_MINUTES). */
  providerCooldownMinutes?: Partial<Record<'auth' | 'quota' | 'rate_limit' | 'errors' | 'channels', number>>
  /**
   * For workspaces without their own `trigger`: "mention" (a mention starts a thread;
   * every reply in it reaches the bot) or "laya" (the bot follows a thread from a
   * mention until its router unfollows; meanwhile Laya judges replies without one).
   */
  trigger: Trigger
  /** Where Laya runs and how it decides (laya.ts DEFAULT_LAYA). */
  laya: LayaConfig
}

export const DEFAULT_CONFIG: HubConfig = {
  workspacesDir: '~/claude-workspaces',
  routerModel: 'sonnet',
  workerModel: 'opus',
  routerArgs: ['--effort', 'low'],
  workerArgs: [],
  workerPermissionMode: 'acceptEdits',
  idleMinutes: { router: 30, worker: 120 },
  maxLiveRouters: 6,
  maxLiveWorkers: 4,
  maxWorkersPerWorkspace: 6,
  workerReports: 'router',
  announceClose: false,
  busyWatchdogMinutes: 30,
  disablePlugins: [],
  tmuxSocket: 'mmhub',
  trigger: 'mention',
  laya: DEFAULT_LAYA,
}

export function loadConfig(file: string): HubConfig {
  const raw = readJson<Partial<HubConfig>>(file, () => ({}))
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    idleMinutes: { ...DEFAULT_CONFIG.idleMinutes, ...(raw.idleMinutes ?? {}) },
    workspacesDir: expandHome(raw.workspacesDir ?? DEFAULT_CONFIG.workspacesDir),
    workerReports: raw.workerReports === 'thread' ? 'thread' : 'router',
    providers: Array.isArray(raw.providers) ? raw.providers.filter((n): n is string => typeof n === 'string') : undefined,
    trigger: isTrigger(raw.trigger) ? raw.trigger : 'mention',
    laya: { ...DEFAULT_LAYA, ...(raw.laya ?? {}) },
  }
}
