/** config.json — hub-wide defaults. Edited by /mattermost-hub:configure; re-read on use. */

import { expandHome } from '../shared/paths'
import { DEFAULT_LAYA, type LayaConfig } from './laya'
import { DEFAULT_OPENROUTER, type OpenRouterConfig } from './openrouter'
import { readJson } from '../shared/util'

export type IdleMinutes = { router: number; worker: number }

/**
 * What makes the bot take a post in a workspace's channels (DMs always reach it):
 * - `mention` (default): an @mention starts a thread; every reply in the bot's threads reaches it.
 * - `mention-only`: only posts that @mention the bot reach it, replies in its threads too.
 * - `laya`: a mention starts or follows a thread; Laya judges the replies without one (laya.ts).
 * - `openrouter`: the same, with a hosted model through OpenRouter as the judge (openrouter.ts).
 */
export const TRIGGERS = ['mention', 'mention-only', 'laya', 'openrouter'] as const
export type Trigger = (typeof TRIGGERS)[number]

export function isTrigger(x: unknown): x is Trigger {
  return (TRIGGERS as readonly unknown[]).includes(x)
}

/** Triggers where the bot follows threads and a model judges the replies without a mention. */
export function judged(t: Trigger | undefined): t is 'laya' | 'openrouter' {
  return t === 'laya' || t === 'openrouter'
}

/** The judge's name, for people and sessions. */
export function judgeName(t: Trigger | undefined): string {
  return t === 'openrouter' ? 'the OpenRouter model' : 'Laya'
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
  /**
   * Hours a worker may go without activity before it gets a cleanup job: its own
   * session stops what it left running and removes containers, images, build output
   * and dependencies from its worktrees. 0 = never.
   */
  cleanupHours: number
  /**
   * A DM from a chat not connected to a workspace gets the person a workspace of their
   * own, personal-<user id>, instead of the "which workspace?" question. Default true.
   */
  personalWorkspaces: boolean
  /**
   * Other AI agents' commands on this machine (lowercase). A worker's Bash command that
   * runs one is denied unless a person in its thread named that agent. [] allows them.
   */
  otherAgents: string[]
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
   * mention until it is unfollowed; meanwhile Laya judges replies without one).
   */
  trigger: Trigger
  /**
   * Triggers "laya" and "openrouter": the hub stops following a thread by itself once
   * this many posts went by since the bot's last post there. A mention follows it
   * again. 0 (default): never; only when a person asks its router to, or an owner sends !unfollow.
   */
  unfollowAfter: number
  /** Where Laya runs and how it decides (laya.ts DEFAULT_LAYA). */
  laya: LayaConfig
  /** The OpenRouter judge for trigger "openrouter" (openrouter.ts DEFAULT_OPENROUTER); its key is OPENROUTER_API_KEY in .env. */
  openrouter: OpenRouterConfig
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
  cleanupHours: 24,
  personalWorkspaces: true,
  otherAgents: ['hermes', 'hermes-agent', 'codex', 'gemini', 'opencode', 'aider', 'openclaw', 'cursor-agent', 'qwen'],
  busyWatchdogMinutes: 30,
  disablePlugins: [],
  tmuxSocket: 'mmhub',
  trigger: 'mention',
  unfollowAfter: 0,
  laya: DEFAULT_LAYA,
  openrouter: DEFAULT_OPENROUTER,
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
    unfollowAfter: typeof raw.unfollowAfter === 'number' && raw.unfollowAfter >= 0 ? Math.floor(raw.unfollowAfter) : DEFAULT_CONFIG.unfollowAfter,
    cleanupHours: hours(raw.cleanupHours) ?? DEFAULT_CONFIG.cleanupHours,
    personalWorkspaces: raw.personalWorkspaces !== false,
    otherAgents: Array.isArray(raw.otherAgents)
      ? raw.otherAgents.filter((n): n is string => typeof n === 'string' && !!n.trim()).map(n => n.trim().toLowerCase())
      : DEFAULT_CONFIG.otherAgents,
    laya: { ...DEFAULT_LAYA, ...(raw.laya ?? {}) },
    openrouter: { ...DEFAULT_OPENROUTER, ...(raw.openrouter ?? {}) },
  }
}

/** A number of hours ≥ 0 (cleanupHours), else undefined. */
export function hours(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}
