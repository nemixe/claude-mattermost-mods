/**
 * The hub's runtime: Mattermost events in, sessions spawned / closed / resumed
 * on a private tmux server, messages and tasks delivered through each
 * session's bridge, hooks tracking turns. Every state change runs on one
 * serialized chain (enqueue); slow waits (startup dialogs) run beside it.
 */

import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isEffort, type ClientMsg, type Effort, type HookEvent, type HubMsg, type Role } from '../shared/ipc'
import type { Paths } from '../shared/paths'
import { ROOT } from '../shared/paths'
import type { HubSnapshot, CloseReason, ProviderLink, WorkspaceProvider } from '../shared/snapshot'
import { chunk, errMsg, fmtAge, log, logUnreadable, MAX_POST_CHARS, safeName, shortId, Unreadable } from '../shared/util'
import { AccessStore, issuePairingCode, ownerNeedsBotCheck, pruneExpired } from './access'
import { authStatusInTmux, type AuthStatus } from './authcheck'
import { BackgroundTasks, type BackgroundTask } from './background'
import type { HubConfig } from './config'
import { loadConfig } from './config'
import { answerWorkspace, askWorkspace, runCommand } from './commands'
import { buildDigest } from './digest'
import { decideInbound, decideReaction, type InboundAction } from './inbound'
import { pruneJobRuns, runDueJobs } from './jobs'
import { dmReply } from './links'
import { originKey } from './newthread'
import { workerSkills } from './skills'
import { keepServing, serveKey, servePaths, warmUp, type Keeper } from './layaserve'
import { classifyLater, countSkipped, following, inDM, noteDM, setFollowing, takeSkipped } from './trigger'
import { canRestartNow, classifyFailure, dueForIdleClose, isLive, looksBusy, noticeForRetry, pickEvictee, planStart, RestartBudget, retryDelay, type ReapView } from './lifecycle'
import type { Mattermost, MMPost, MMReaction } from './mattermost'
import { answeredText, PermissionDesk, promptText, staleText } from './permissions'
import { cleanupJob, directContext, directPrompt, routerContext, routerPersona, routerPrompt, workerContext, workerPrompt } from './prompts'
import {
  baseConfigDir, buildLaunch, chooseProvider, configDirOf, cooling, DEFAULT_PROVIDER, kindOf, knownConfigDirs, loadProviders, markFailed, markOk,
  providerChain, providerFault, readSecret, redact, resetTime, startupProblem, syncTranscript, unusableReason,
  type Choice, type FaultKind, type Health, type ProviderDef,
} from './providers'
import { addedDirs, claudeArgs, sessionFiles, tmuxName, transcriptPath, wrapArgv, writeProviderEnv, writeSessionFiles } from './spawn'
import { askedFolder, shepherd, waitForCalm } from './shepherd'
import { buildSnapshot, StatusWriter } from './status'
import { isDraft, Store, type MessageRow, type SessionRow, type TaskRow, type ThreadRow, type WorkerRow } from './store'
import { Ticker } from './ticker'
import type { Tmux } from './tmux'
import { bindChannel, createWorkspace, effective, ensureTemplate, externalRepoPaths, listWorkspaces, loadBindings, loadWorkspace, personalName, workerDir, type Workspace } from './workspaces'

export type BridgeConn = { send: (m: HubMsg) => void; end: () => void; role: Role; pid: number }

type Outgoing = { content: string; meta: Record<string, string> }

type Live = {
  conn?: BridgeConn
  /** When the current bridge said hello. */
  helloAt: number
  /** Bridge connected and the screen is calm: messages flow. */
  ready: boolean
  /** A start is in progress (dialogs being answered). */
  starting: boolean
  spawnedAt: number
  /** Id of the current launch (MMHUB_SPAWN in its environment; hooks carry it back). */
  spawnId?: string
  /** Meta flag for the first message after a start. */
  startFlag?: 'spawned' | 'resumed' | 'fresh'
  /** Why the work being re-delivered was cut off (prepended to it). */
  resumeNote?: string
  /** Turns in a row that ended with an API error. */
  failures: number
  /** An automatic retry after an API error is due then; new work waits until it. */
  retryAt?: number
  retryTimer?: ReturnType<typeof setTimeout>
  /** A StopFailure that raced a delivery; recheckBusy decides. */
  pendingFailure?: string
  lastDeliveredAt: number
  lastHookAt: number
  attached: number
  /** Couldn't start because its workspace can't be read (its threads were told). */
  blocked?: boolean
  /** A failed --resume already fell back to a fresh session once. */
  triedFresh: boolean
  /** Bridge gone since (watchdog). */
  goneSince?: number
  recheck?: ReturnType<typeof setTimeout>
  /** The provider the current process was launched with. */
  provider?: string
  /**
   * A message went in and the session hasn't reached anyone since (reply, react,
   * delegate, …). A turn that ends like this with text wrote that text to its
   * terminal, where nobody reads it: its Stop hook sends it back once to post it.
   */
  unposted?: boolean
  /** The turn running is a cleanup job: no typing, no unposted check, its permission prompts allowed, and the session closes after it. */
  cleaning?: boolean
  /** The config dir the current process runs with (where its transcript is). */
  configDir?: string
  /** Work the current process left running in the background (backgroundOf). */
  background?: BackgroundTasks
}

/** Ticks (every 5 s) further apart than this, or hub timers quiet this long: re-arm everything. */
const WAKE_GAP_MS = 30_000

const FAULT_WORDS: Record<FaultKind, string> = {
  auth: 'a sign-in error',
  quota: 'its usage or credit limit',
  rate_limit: 'rate limits',
  errors: 'API errors that outlasted the retries',
  channels: 'no channel messages',
}

export type HubDeps = {
  paths: Paths
  mm: Mattermost
  tmux: Tmux
  claudeBin: string
  bunBin: string
  version: string
  cliPath: string
}

const STOP_RACE_MS = 2500

export class Hub {
  readonly p: Paths
  cfg: HubConfig
  readonly store: Store
  readonly accessStore: AccessStore
  readonly mm: Mattermost
  readonly tmux: Tmux
  readonly desk = new PermissionDesk()
  readonly status: StatusWriter
  readonly startedAt = Date.now()
  bot = { id: '', username: '' }
  /** Threads where the hub asked "which workspace?" → the post that started it. */
  readonly awaiting = new Map<string, { channelId: string; channelType: string; post: MMPost; askedAt: number }>()

  private live = new Map<string, Live>()
  private chain: Promise<unknown> = Promise.resolve()
  private seen: string[] = []
  private seenSet = new Set<string>()
  private restarts = new RestartBudget()
  private locks = new Map<string, Promise<unknown>>()
  private timers: ReturnType<typeof setInterval>[] = []
  private layaKeeper: Keeper = {}
  /** When the hub's own 3 s timer last ran (the ticker checks it still does). */
  private timerAt = Date.now()
  private ticker?: Ticker
  /** A check for due scheduled jobs is on the chain already. */
  private jobsQueued = false
  private channelNames = new Map<string, string>()
  /** Provider failures and rest times, by provider name (kept in hub.db). */
  private health: Record<string, Health> = {}
  /** Each workspace's active provider when last looked at (for the log). */
  private activeSeen = new Map<string, string>()
  stopping = false

  constructor(readonly deps: HubDeps) {
    this.p = deps.paths
    this.cfg = loadConfig(this.p.config)
    this.store = new Store(this.p.db)
    this.accessStore = new AccessStore(this.p.access)
    this.mm = deps.mm
    this.tmux = deps.tmux
    this.status = new StatusWriter(this.p.status, () => this.snapshot())
    this.health = this.loadHealth()
  }

  // ------------------------------------------------------------------ plumbing

  /** Run `fn` after every earlier state change has finished. */
  enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(err => log('hub', `chain: ${errMsg(err)}`))
    return run
  }

  /** Serialize work per resource (e.g. git worktree add on one repo). */
  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.locks.set(name, run.catch(() => undefined))
    return run
  }

  liveOf(key: string): Live {
    let l = this.live.get(key)
    if (!l) {
      l = { helloAt: 0, ready: false, starting: false, spawnedAt: 0, failures: 0, lastDeliveredAt: 0, lastHookAt: 0, attached: 0, triedFresh: false }
      this.live.set(key, l)
    }
    return l
  }

  /** Re-read config.json. Returns why it couldn't be (the settings from before stay). */
  reloadConfig(): string | undefined {
    try {
      this.cfg = loadConfig(this.p.config)
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err
      logUnreadable(err)
      return err.message
    }
    try {
      ensureTemplate(this.cfg)
    } catch {}
    return undefined
  }

  ws(name: string): Workspace | undefined {
    return loadWorkspace(this.cfg, name)
  }

  /** The workspaces on disk; none (logged) while their folder can't be read. */
  workspaces(): Workspace[] {
    try {
      return listWorkspaces(this.cfg)
    } catch (err) {
      if (!(err instanceof Unreadable)) throw err
      logUnreadable(err)
      return []
    }
  }

  patch(key: string, p: Parameters<Store['patchSession']>[1]): void {
    this.store.patchSession(key, p)
    this.status.changed()
  }

  permalink(postId: string): string {
    const id = this.store.threadId(postId)
    return isDraft(id) ? '(not posted yet)' : this.mm.permalink(id)
  }

  /** Hours a worker may go without work before its cleanup job (0 = never). */
  cleanupHoursFor(workspace: string): number {
    const w = this.ws(workspace)
    if (w?.unreadable) return 0 // it may say never
    return w ? effective(this.cfg, w).cleanupHours : this.cfg.cleanupHours
  }

  /**
   * Workers without work for cleanupHours (24 by default) get a cleanup job: their
   * own session stops what it left running and removes its containers, images,
   * build output and dependencies (prompts.ts cleanupJob). Once per stretch without
   * work; not for pinned or failed workers, nor ones with work waiting. A closed
   * worker is resumed for it and closed again after. Call on the chain.
   */
  async cleanupDue(now = Date.now()): Promise<void> {
    for (const s of this.store.sessions({ role: 'worker' })) {
      const hours = this.cleanupHoursFor(s.workspace)
      if (hours <= 0 || s.pinned || s.status === 'failed' || s.status === 'busy' || now - s.lastActiveAt < hours * 3_600_000) continue
      if (Number(this.store.get(`cleaned:${s.key}`) ?? 0) >= s.lastActiveAt) continue
      if (this.queued(s.key) > 0 || this.inFlight(s.key) > 0 || this.backgroundOf(s.key).length > 0) continue
      // A closed worker waits for a free slot rather than closing another for its cleanup.
      if (!isLive(s.status) && this.liveCount('worker') >= this.cap('worker')) continue
      const w = this.store.worker(s.key)
      if (!w || w.direct) continue // a direct session works in the original checkouts: nothing of its own to clear
      this.store.set(`cleaned:${s.key}`, String(now))
      const worktrees = Object.entries(w.repos).map(([name, t]) => ({ name, ...t }))
      log('lifecycle', `${s.key}: no work for ${fmtAge(now - s.lastActiveAt)} — cleanup job`)
      await this.deliver(s.key, cleanupJob({ hours, worktrees }), { kind: 'cleanup', workspace: s.workspace })
    }
  }

  idleMinutesFor(s: { role: Role; workspace: string }): number {
    const w = this.ws(s.workspace)
    const idle = w ? effective(this.cfg, w).idleMinutes : this.cfg.idleMinutes
    return idle[s.role]
  }

  /** Work handed to the session whose turn hasn't ended (worker tasks, router messages). */
  inFlight(key: string): number {
    const messages = this.store.messagesFor(key, ['delivered']).length
    return key.startsWith('w-') ? this.store.tasksFor(key, ['delivered']).length + messages : messages
  }

  /**
   * Work the session left running in the background (a Bash command, an async
   * agent, a Monitor watch), read from its transcript (background.ts). Its turn
   * ended, but it is still at work: typing… stays up, and it isn't closed for
   * being idle, cleaned up, evicted or gracefully restarted meanwhile.
   */
  backgroundOf(key: string): BackgroundTask[] {
    const row = this.store.session(key)
    if (!row || !isLive(row.status) || !row.sessionId) return []
    const l = this.liveOf(key)
    // A session adopted after a hub restart: when its process started, and the config dir its provider runs with.
    l.background ??= new BackgroundTasks(l.spawnedAt || Number(this.store.get(`spawned:${key}`) ?? 0))
    if (!l.configDir) {
      const name = this.providerOf(key)
      l.configDir = configDirOf(this.p.dir, name, name === DEFAULT_PROVIDER ? undefined : this.providerDefs()[name]) ?? baseConfigDir()
    }
    l.background.refresh(transcriptPath(row.cwd, row.sessionId, l.configDir))
    return l.background.running()
  }

  /** Work waiting for the session (queued, or interrupted and to be re-delivered). */
  queued(key: string): number {
    const messages = this.store.pendingMessages(key).length
    return key.startsWith('w-') ? this.store.pendingTasks(key).length + messages : messages
  }

  /** New work waits: an automatic retry after an API error is scheduled. */
  held(key: string): boolean {
    const at = this.live.get(key)?.retryAt
    return at !== undefined && Date.now() < at
  }

  retryAt(key: string): number | undefined {
    return this.held(key) ? this.live.get(key)?.retryAt : undefined
  }

  /** A graceful restart waits for the session's turn to end (kept in hub.db). */
  restartPending(key: string): boolean {
    return this.store.get(`restart:${key}`) === '1'
  }

  /**
   * New work waits for a pending restart (the restarted session has the new
   * settings). Not while work the session runs in the background holds the
   * restart off: that may take long, and new work doesn't delay it more.
   */
  restartWaits(key: string): boolean {
    return this.restartPending(key) && this.backgroundOf(key).length === 0
  }

  private setRestartPending(key: string, on: boolean): void {
    if (on === this.restartPending(key)) return
    if (on) this.store.set(`restart:${key}`, '1')
    else this.store.del(`restart:${key}`)
    this.status.changed()
  }

  reapView(s: SessionRow): ReapView {
    return {
      key: s.key, role: s.role, workspace: s.workspace, status: s.status, pinned: s.pinned, lastActiveAt: s.lastActiveAt,
      attached: this.liveOf(s.key).attached, pendingPermissions: this.desk.count(s.key), inFlight: this.inFlight(s.key),
      background: this.backgroundOf(s.key).length,
    }
  }

  /** Display label of a session (thread label or worker title). */
  label(key: string): string {
    if (key.startsWith('w-')) return this.store.worker(key)?.title ?? key
    return this.store.threadByRouter(key)?.label ?? key
  }

  /** Threads a session posts in. */
  threadsOf(key: string): ThreadRow[] {
    if (key.startsWith('r-')) {
      const t = this.store.threadByRouter(key)
      return t ? [t] : []
    }
    return (this.store.worker(key)?.threads ?? []).map(id => this.store.thread(id)).filter((t): t is ThreadRow => !!t)
  }

  /** The thread a worker is serving now (for permission prompts and notices). */
  activeThreadOf(key: string): ThreadRow | undefined {
    if (key.startsWith('r-')) return this.store.threadByRouter(key)
    const w = this.store.worker(key)
    const id = w?.activeThread ?? w?.threads[w.threads.length - 1]
    return id ? this.store.thread(id) : undefined
  }

  /** A hub notice in a thread (not attributed to a session). */
  async notice(thread: { id: string; channelId: string } | undefined, message: string): Promise<MMPost | undefined> {
    if (!thread) return undefined
    try {
      return await this.mm.createPost({ channel_id: thread.channelId, root_id: thread.id, message, props: { mmhub_notice: true } })
    } catch (err) {
      log('mm', `notice failed: ${errMsg(err)}`)
      return undefined
    }
  }

  async replyTo(post: { id: string; root_id: string; channel_id: string }, message: string): Promise<void> {
    await this.notice({ id: post.root_id || post.id, channelId: post.channel_id }, message)
  }

  // ------------------------------------------------------------------ providers

  private loadHealth(): Record<string, Health> {
    try {
      const raw = JSON.parse(this.store.get('provider-health') ?? '{}') as unknown
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, Health>) : {}
    } catch {
      return {}
    }
  }

  private saveHealth(): void {
    this.store.set('provider-health', JSON.stringify(this.health))
    this.status.changed()
  }

  /** providers.json, re-read on use (the CLI edits it). */
  providerDefs(): Record<string, ProviderDef> {
    return loadProviders(this.p.dir)
  }

  /** The environment every claude the hub starts gets (the provider's own comes on top, through the launch wrapper). */
  private claudeEnv(): Record<string, string> {
    const env: Record<string, string> = { PATH: this.cfg.path ?? process.env.PATH ?? '/usr/bin:/bin' }
    if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
    return env
  }

  /** `claude auth status` for a provider, run where its sessions run: in the hub's tmux, launched as a session is. */
  async authStatus(name: string): Promise<AuthStatus> {
    const defs = this.providerDefs()
    if (name !== DEFAULT_PROVIDER && !defs[name]) throw new Error(`no provider ${name}`)
    const launch = buildLaunch(this.p.dir, name, defs[name])
    let providerEnv: Record<string, string> | undefined
    if (launch.kind !== DEFAULT_PROVIDER) {
      providerEnv = { ...launch.env }
      // Sessions get the key through apiKeyHelper; auth status only reports what it would use, so it gets it in its env.
      const key = launch.apiKeyHelper ? readSecret(this.p.dir, name, 'ANTHROPIC_API_KEY') : undefined
      if (key) providerEnv.ANTHROPIC_API_KEY = key
    }
    return authStatusInTmux(this.tmux, { claudeBin: this.deps.claudeBin, cwd: this.p.dir, env: this.claudeEnv(), providerEnv })
  }

  chainOf(w: Workspace): string[] {
    return providerChain(this.cfg.providers, w.providers)
  }

  /** The provider the workspace's new and restarted sessions use now. */
  activeProvider(w: Workspace, defs = this.providerDefs()): Choice {
    return chooseProvider(this.chainOf(w), Date.now(), n => this.health[n], n => unusableReason(this.p.dir, n, defs[n]))
  }

  /** The provider a session was last launched with (sessions from before providers: default). */
  providerOf(key: string): string {
    return this.live.get(key)?.provider ?? this.store.get(`provider:${key}`) ?? DEFAULT_PROVIDER
  }

  providerHealth(name: string): Health | undefined {
    return this.health[name]
  }

  /** A provider failed: it rests for a while (longer with each failure in a row). */
  providerFailed(name: string, fault: FaultKind, reason: string, error?: string): void {
    const now = Date.now()
    const h = markFailed(this.health[name], fault, reason, now, {
      overrides: this.cfg.providerCooldownMinutes,
      resetAt: fault === 'quota' ? resetTime(error, now) : undefined,
    })
    this.health[name] = h
    log('provider', `${name}: ${fault} (${h.reason}), strike ${h.strikes} — resting ${fmtAge((h.coolUntil ?? now) - now)}`)
    this.saveHealth()
  }

  private providerOk(name: string): void {
    const h = markOk(this.health[name])
    if (!h || h === this.health[name]) return
    this.health[name] = h
    this.saveHealth()
  }

  /** Forget a provider's failures (it was fixed). Returns whether it had any. */
  resetProvider(name: string): boolean {
    if (!this.health[name]) return false
    delete this.health[name]
    this.saveHealth()
    return true
  }

  /** The workspace's provider state for status.json: names, kinds, rest times and reasons — never a secret. */
  providerSnapshot(w: Workspace, defs = this.providerDefs()): WorkspaceProvider {
    const now = Date.now()
    const choice = this.activeProvider(w, defs)
    return {
      active: choice.name,
      kind: kindOf(choice.name, defs),
      fallback: choice.fallback,
      healthy: choice.healthy && !choice.unusable,
      chain: this.chainOf(w).map(name => {
        const h = this.health[name]
        const link: ProviderLink = { name, kind: kindOf(name, defs) }
        if (cooling(h, now)) {
          link.coolingUntil = h!.coolUntil
          if (h!.fault) link.reason = `${h!.fault}${h!.reason ? `: ${h!.reason}` : ''}`
        }
        const why = unusableReason(this.p.dir, name, defs[name])
        if (why) link.unusable = why
        return link
      }),
    }
  }

  /** For `!ws` and posts: "`backup` (fallback) — `acme`: auth, back in 42m". */
  providerLine(w: Workspace): string {
    const p = this.providerSnapshot(w)
    const now = Date.now()
    const others = p.chain
      .filter(c => c.name !== p.active && (c.coolingUntil || c.unusable))
      .map(c => `\`${c.name}\` ${c.unusable ?? `${c.reason ?? 'resting'}, back in ${fmtAge((c.coolingUntil ?? now) - now)}`}`)
    const state = !p.healthy ? (p.chain.every(c => c.unusable) ? ' (no usable provider)' : ' (resting; every provider failed)') : p.fallback ? ' (fallback)' : ''
    return `\`${p.active}\`${state}${others.length ? ` — ${others.join('; ')}` : ''}`
  }

  private switchText(label: string, from: string, to: string, fault: FaultKind, reason: string): string {
    const back = this.health[from]?.coolUntil
    return `⇄ **${label}** hit ${FAULT_WORDS[fault]} on provider \`${from}\` (${reason}). This workspace now runs on \`${to}\`, and the work carries on there; \`${from}\` is tried again${back ? ` in ${fmtAge(back - Date.now())}` : ' later'}.`
  }

  /**
   * Move live sessions onto their workspace's active provider — after a
   * provider failed, a rest ran out, or a chain changed. Idle sessions restart
   * now and busy ones after their current turn; --resume keeps each
   * conversation. Returns how many were moved. Call on the chain.
   */
  async rebalanceProviders(): Promise<number> {
    const defs = this.providerDefs()
    let moved = 0
    for (const s of this.store.sessions()) {
      if (s.status !== 'idle' && s.status !== 'busy') continue
      if (this.liveOf(s.key).starting || this.restartPending(s.key)) continue
      const w = this.ws(s.workspace)
      if (!w || w.unreadable) continue // which chain is its own isn't known
      const a = this.activeProvider(w, defs)
      const from = this.providerOf(s.key)
      if (!a.healthy || a.unusable || a.name === from) continue
      log('provider', `${s.key}: moving from ${from} to ${a.name}`)
      this.clearRetry(s.key) // a wait for the old provider doesn't apply to the new one
      await this.restart(s.key)
      moved++
    }
    for (const w of this.workspaces()) {
      if (w.unreadable) continue
      const a = this.activeProvider(w, defs).name
      const before = this.activeSeen.get(w.name)
      if (before !== undefined && before !== a) log('provider', `workspace ${w.name}: ${before} → ${a}`)
      this.activeSeen.set(w.name, a)
    }
    return moved
  }

  /**
   * The provider is to blame for a failed turn (sign-in, quota, rate limit, or
   * errors that outlasted the retries): it rests. When the workspace has
   * another provider ready, the turn's work is re-delivered there: this
   * session restarts on it as soon as the turn has ended, resuming its
   * conversation, and the workspace's other sessions follow. Returns whether it
   * switched. Call on the chain.
   */
  private async switchProvider(key: string, kind: ReturnType<typeof classifyFailure>, attempt: number, what: string, error?: string): Promise<boolean> {
    const fault = providerFault(kind, attempt)
    const row = this.store.session(key)
    const w = row ? this.ws(row.workspace) : undefined
    if (!fault || !w) return false
    const from = this.providerOf(key)
    const before = this.activeProvider(w).name
    this.providerFailed(from, fault, what, error)
    const after = this.activeProvider(w)
    if (!after.healthy || after.unusable || after.name === from) return false
    const l = this.liveOf(key)
    l.failures = 0
    if (this.store.moveDelivered(key, 'interrupted')) {
      l.resumeNote = `(Re-delivered: your last turn on this stopped with an API error — ${what}. The hub switched you to another provider; carry on where you left off, without repeating anything you already posted or reported.)`
    }
    this.setRestartPending(key, true) // turnEnded restarts it right away, on the new provider
    log('provider', `${key}: ${fault} on ${from} — switching to ${after.name}`)
    if (before !== after.name) await this.notice(this.activeThreadOf(key), this.switchText(this.label(key), from, after.name, fault, what))
    await this.rebalanceProviders()
    return true
  }

  /** A start showed a provider problem (login screen, no channels): rest it and start on the next one. Call on the chain. */
  private async providerStartFailed(key: string, problem: { fault: FaultKind; reason: string }): Promise<boolean> {
    const row = this.store.session(key)
    const w = row ? this.ws(row.workspace) : undefined
    if (!w) return false
    const from = this.providerOf(key)
    const before = this.activeProvider(w).name
    this.providerFailed(from, problem.fault, problem.reason)
    const after = this.activeProvider(w)
    if (!after.healthy || after.unusable || after.name === from) return false
    log('provider', `${key}: couldn't start on ${from} (${problem.reason}) — trying ${after.name}`)
    if (before !== after.name) {
      for (const t of this.threadsNeeding(key)) await this.notice(t, this.switchText(this.label(key), from, after.name, problem.fault, problem.reason))
    }
    await this.rebalanceProviders()
    return this.startSession(key)
  }

  // ------------------------------------------------------------------ sessions

  createRouter(o: { threadId: string; channelId: string; workspace: Workspace; label: string }): string {
    const key = `r-${shortId(8)}`
    const now = Date.now()
    const eff = effective(this.cfg, o.workspace)
    this.store.insertSession({
      key, role: 'router', workspace: o.workspace.name, sessionId: randomUUID(), status: 'stopped', pinned: false,
      model: eff.routerModel, cwd: o.workspace.dir, createdAt: now, lastActiveAt: now, turns: 0,
    })
    this.store.insertThread({ id: o.threadId, channelId: o.channelId, workspace: o.workspace.name, routerKey: key, label: o.label, cursor: 0, createdAt: now })
    this.status.changed()
    return key
  }

  /** `direct`: a direct session (store.ts WorkerRow.direct), in the workspace folder itself. */
  createWorker(o: { workspace: Workspace; title: string; summary: string; direct?: boolean }): string {
    const key = `w-${shortId(8)}`
    const now = Date.now()
    const eff = effective(this.cfg, o.workspace)
    const cwd = o.direct ? o.workspace.dir : workerDir(o.workspace, key)
    mkdirSync(cwd, { recursive: true })
    this.store.insertSession({
      key, role: 'worker', workspace: o.workspace.name, sessionId: randomUUID(), status: 'stopped', pinned: false,
      model: eff.workerModel, cwd, createdAt: now, lastActiveAt: now, turns: 0,
    })
    this.store.insertWorker({
      key, workspace: o.workspace.name, title: o.title.slice(0, 60), summary: o.summary.slice(0, 300), threads: [], repos: {},
      ...(o.direct ? { direct: true } : {}),
    })
    this.status.changed()
    return key
  }

  private liveCount(role: Role): number {
    return this.store.sessions({ role }).filter(s => isLive(s.status)).length
  }

  private cap(role: Role): number {
    return role === 'router' ? this.cfg.maxLiveRouters : this.cfg.maxLiveWorkers
  }

  /**
   * Make sure a session is running (spawn or resume it). Returns 'live' when it
   * already runs or is starting, 'waiting' when every slot is held.
   * Call on the chain.
   */
  async ensureStarted(key: string): Promise<'live' | 'waiting' | 'failed'> {
    const row = this.store.session(key)
    if (!row) return 'failed'
    const l = this.liveOf(key)
    if (l.starting) return 'live'
    const name = tmuxName(key)
    if (isLive(row.status) && row.status !== 'closing' && (await this.tmux.has(name))) return 'live'
    if (await this.tmux.has(name)) {
      // Running but we thought it stopped (e.g. hub restarted mid-close): adopt it.
      this.patch(key, { status: 'idle', closedAt: undefined, closeReason: undefined })
      return 'live'
    }
    // Don't close another session for one that can't start.
    if (await this.workspaceBlocked(key)) return 'failed'
    if (this.liveCount(row.role) >= this.cap(row.role)) {
      const views = this.store.sessions({ role: row.role }).filter(s => isLive(s.status)).map(s => this.reapView(s))
      const victim = pickEvictee(views, row.role, [key])
      if (!victim) {
        log('lifecycle', `${key} waits for a free ${row.role} slot (${this.cap(row.role)} live)`)
        return 'waiting'
      }
      await this.close(victim, 'cap')
    }
    return (await this.startSession(key)) ? 'live' : 'failed'
  }

  /**
   * Whether a session can't start because the hub can't read its workspace (a disk
   * macOS keeps this process from, say). Its threads are told once; what it has
   * waiting stays queued, and pump tries again until it can. Call on the chain.
   */
  private async workspaceBlocked(key: string): Promise<boolean> {
    const l = this.liveOf(key)
    const w = this.ws(this.store.session(key)?.workspace ?? '')
    if (!w?.unreadable) {
      l.blocked = false
      return false
    }
    if (!l.blocked) {
      l.blocked = true
      log('lifecycle', `${key}: not started: ${w.unreadable}`)
      const msg = `⚠️ **${this.label(key)}** can't start: the hub can't read workspace **${w.name}** right now (\`mmhub logs\` says why). What it was sent is kept, and it starts by itself once the hub can.`
      for (const t of this.threadsNeeding(key)) await this.notice(t, msg)
    }
    return true
  }

  /** Spawn the tmux session; dialogs are handled by watchStartup beside the chain. */
  private async startSession(key: string, forceFresh = false): Promise<boolean> {
    const row = this.store.session(key)!
    const w = this.ws(row.workspace)
    if (!w) {
      log('lifecycle', `${key}: workspace ${row.workspace} is gone`)
      this.patch(key, { status: 'failed', closeReason: 'failed', closedAt: Date.now() })
      return false
    }
    if (await this.workspaceBlocked(key)) return false
    this.reloadConfig()
    const l = this.liveOf(key)

    // The workspace's active provider: the first usable one in its chain that isn't resting.
    const defs = this.providerDefs()
    const choice = this.activeProvider(w, defs)
    if (choice.unusable) {
      log('provider', `${key}: workspace ${w.name} has no usable provider (${choice.name}: ${choice.unusable})`)
      this.patch(key, { status: 'failed', closeReason: 'failed', closedAt: Date.now() })
      const msg = `⚠️ **${this.label(key)}** can't start: workspace **${w.name}** has no usable provider (\`${choice.name}\`: ${choice.unusable}). An owner can fix it in Claude Code with \`/mattermost-hub:workspace providers ${w.name}\`, then \`!wake ${key}\`.`
      for (const t of this.threadsNeeding(key)) await this.notice(t, msg)
      return false
    }
    const launch = buildLaunch(this.p.dir, choice.name, defs[choice.name])
    // Another provider may run with another config dir: bring the transcript along so --resume finds it.
    const transcriptExists = !forceFresh && syncTranscript(row.cwd, row.sessionId, launch.configDir ?? baseConfigDir(), knownConfigDirs(this.p.dir, defs))
    const plan = forceFresh
      ? { mode: 'fresh' as const, sessionId: randomUUID(), lostContext: row.turns > 0 }
      : planStart({ sessionId: row.sessionId, turns: row.turns, transcriptExists, newId: randomUUID })
    if (plan.sessionId !== row.sessionId) this.store.patchSession(key, { sessionId: plan.sessionId, turns: 0 })

    const eff = effective(this.cfg, w)
    const worker = row.role === 'worker' ? this.store.worker(key) : undefined
    const title = worker?.title ?? key
    const files = writeSessionFiles({
      paths: this.p, key, role: row.role, workspace: w, bunBin: this.deps.bunBin, root: ROOT,
      prompt: row.role === 'router' ? routerPrompt(w.name, routerPersona(this.cfg, w).text) : worker?.direct ? directPrompt(w.name, title, key) : workerPrompt(w.name, title, key),
      permissionMode: row.role === 'router' ? 'dontAsk' : eff.workerPermissionMode,
      disablePlugins: this.cfg.disablePlugins,
      reports: this.cfg.workerReports,
      ...(worker?.direct ? { direct: true } : {}),
      ...(launch.apiKeyHelper ? { apiKeyHelper: launch.apiKeyHelper } : {}),
    })
    const model = (row.role === 'router' ? launch.routerModel : launch.workerModel) ?? row.model
    const thread = this.store.threadByRouter(key)
    // Routers and direct sessions run in the workspace folder (knowledge/ and inbox/ inside it) and use the repos where they are.
    const addDirs = row.role === 'router' || worker?.direct
      ? externalRepoPaths(w)
      : [join(w.dir, 'knowledge'), join(w.dir, 'inbox'), ...externalRepoPaths(w).filter(p => !existsSync(join(p, '.git')))]
    for (const d of [join(w.dir, 'inbox'), row.cwd]) mkdirSync(d, { recursive: true })
    let argv = claudeArgs({
      claudeBin: this.deps.claudeBin,
      role: row.role,
      sessionId: plan.sessionId,
      resume: plan.mode === 'resume',
      displayName: row.role === 'router' ? `mm:r:${w.name}:${(thread?.id ?? key).slice(0, 8)}` : `mm:w:${w.name}:${title}`,
      model,
      permissionMode: eff.workerPermissionMode,
      addDirs,
      extraArgs: row.role === 'router' ? this.cfg.routerArgs : this.cfg.workerArgs,
      files,
      autocompact: row.role === 'router' ? this.cfg.routerAutocompact : undefined,
      ...(row.role === 'worker' ? { workerMod: join(ROOT, 'session-mod') } : {}),
    })
    const folders = addedDirs(argv, row.cwd)
    // A provider's env (secrets included) goes through a 0600 file the launch sources and deletes — never argv.
    if (launch.kind !== DEFAULT_PROVIDER) argv = wrapArgv(argv, writeProviderEnv(files, launch.env))
    l.provider = choice.name
    l.configDir = launch.configDir ?? baseConfigDir()
    this.store.set(`provider:${key}`, choice.name)
    l.spawnId = shortId(6)
    const env: Record<string, string> = {
      MMHUB_SESSION_KEY: key,
      MMHUB_SPAWN: l.spawnId,
      MMHUB_ROLE: row.role,
      MMHUB_STATE_DIR: this.p.dir,
      ...this.claudeEnv(),
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    }

    l.starting = true
    l.ready = false
    l.helloAt = 0
    l.spawnedAt = Date.now()
    l.background = new BackgroundTasks(l.spawnedAt)
    this.store.set(`spawned:${key}`, String(l.spawnedAt))
    l.startFlag = plan.mode === 'resume' ? 'resumed' : plan.lostContext ? 'fresh' : 'spawned'
    this.patch(key, { status: plan.mode === 'resume' ? 'resuming' : 'starting', closedAt: undefined, closeReason: undefined, lastActiveAt: Date.now() })
    try {
      await this.tmux.newSession({ name: tmuxName(key), cwd: row.cwd, argv, env })
    } catch (err) {
      l.starting = false
      log('lifecycle', `${key}: ${errMsg(err)}`)
      this.patch(key, { status: 'failed', closeReason: 'failed', closedAt: Date.now() })
      return false
    }
    log('lifecycle', `${key}: ${plan.mode === 'resume' ? 'resuming' : 'starting'} (${row.role}, ${model}, ${w.name}, provider ${choice.name}${choice.fallback ? ' — fallback' : ''})`)
    void this.watchStartup(key, plan.mode === 'resume', folders)
    return true
  }

  /** `folders`: what the launch passed with --add-dir (the only ones the hub lets it add). */
  private async watchStartup(key: string, resuming: boolean, folders: string[]): Promise<void> {
    const l = this.liveOf(key)
    const name = tmuxName(key)
    const since = l.spawnedAt
    // No "resuming…" post: "typing…" shows once the session runs (keepTyping).
    let outcome = await shepherd(this.tmux, name, () => l.helloAt >= since, {
      folders,
      onDialog: d => log('lifecycle', `${key}: answered startup dialog "${d.name}"${d.folder ? ` (${d.folder})` : ''}`),
      problem: startupProblem,
    })
    let problem: ReturnType<typeof startupProblem>
    if (outcome === 'ready') {
      await waitForCalm(this.tmux, name)
      await Bun.sleep(800)
      // The bridge connects even where Claude Code drops channel messages (third-party
      // providers, org policy) or wants a sign-in first: the screen tells.
      problem = startupProblem(await this.tmux.capture(name))
      if (!problem) {
        await this.enqueue(async () => {
          l.starting = false
          if (this.store.session(key)?.status === 'stopped') return // closed while starting
          this.markReady(key)
        })
        return
      }
      outcome = 'problem'
    }
    const screen = await this.tmux.capture(name)
    problem ??= startupProblem(screen)
    const asked = askedFolder(screen)
    if (asked) log('lifecycle', `${key}: it asks to add ${asked}; this launch passed ${folders.join(', ') || 'no folders'}`)
    log('lifecycle', `${key}: startup ${outcome}${problem ? ` (${problem.reason})` : ''}\n${redact(screen.split('\n').filter(Boolean).slice(-15).join('\n'))}`)
    await this.tmux.kill(name)
    await this.enqueue(async () => {
      l.starting = false
      if (this.store.session(key)?.status === 'stopped') return // closed while starting: not a failure
      // The provider's fault: rest it and start on the next one in the chain.
      if (problem && (await this.providerStartFailed(key, problem))) return
      if (resuming && !l.triedFresh && !problem) {
        l.triedFresh = true
        log('lifecycle', `${key}: resume failed — starting a fresh session`)
        if (await this.startSession(key, true)) return
      }
      this.patch(key, { status: 'failed', closeReason: 'failed', closedAt: Date.now() })
      const why = problem ? `on provider \`${this.providerOf(key)}\`: ${problem.reason}` : outcome
      const msg = `⚠️ Couldn't start **${this.label(key)}** (${why}), so this is on hold. An owner can retry with \`!wake ${key}\`.`
      for (const t of this.threadsNeeding(key)) await this.notice(t, msg)
    })
  }

  /** Threads waiting on a session (its pending messages or tasks). */
  threadsNeeding(key: string): ThreadRow[] {
    if (key.startsWith('r-')) return this.threadsOf(key)
    const ids = new Set(this.store.pendingTasks(key).map(t => t.threadId))
    const active = this.activeThreadOf(key)
    if (active) ids.add(active.id)
    return [...ids].map(id => this.store.thread(id)).filter((t): t is ThreadRow => !!t)
  }

  /** Bridge connected and dialogs done: deliver what waited. Call on the chain. */
  markReady(key: string): void {
    const row = this.store.session(key)
    const l = this.liveOf(key)
    if (!row || !l.conn) return
    l.ready = true
    l.goneSince = undefined
    l.triedFresh = false
    this.deliverPending(key)
    const now = this.store.session(key)!
    if (now.status === 'starting' || now.status === 'resuming') this.patch(key, { status: 'idle', lastActiveAt: Date.now() })
  }

  private send(key: string, m: Outgoing): void {
    const l = this.liveOf(key)
    if (l.startFlag) {
      m.meta[l.startFlag] = 'true'
      l.startFlag = undefined
    }
    l.conn!.send({ t: 'inbound', content: m.content, meta: m.meta })
    l.lastDeliveredAt = Date.now()
    l.cleaning = m.meta.kind === 'cleanup'
    if (l.cleaning) this.setEffort(key, undefined) // its default: the job names none, and the next task starts from there
    l.unposted = !l.cleaning
    this.patch(key, { status: 'busy', busySince: this.store.session(key)?.busySince ?? Date.now(), lastActiveAt: Date.now() })
    if (key.startsWith('r-') && m.meta.chat_id && m.meta.thread_id && !isDraft(m.meta.thread_id)) this.mm.typing(m.meta.chat_id, m.meta.thread_id)
  }

  /**
   * Hand a message to a router: it is kept in the inbox until the turn that
   * reads it ends, so an interrupted router gets it again. Sent now when the
   * session is ready, otherwise queued and the session started. Call on the chain.
   */
  async deliver(key: string, content: string, meta: Record<string, string>): Promise<{ state: 'delivered' | 'queued'; id: number }> {
    const l = this.liveOf(key)
    // A thread another router started (new_thread): its router learns how with its first message.
    const origin = key.startsWith('r-') ? this.store.get(originKey(key)) : undefined
    if (origin) {
      content = `${origin}\n\n${content}`
      this.store.del(originKey(key))
    }
    const id = this.store.insertMessage({ sessionKey: key, content, meta, state: 'queued', createdAt: Date.now() })
    this.status.changed()
    if (this.held(key)) return { state: 'queued', id } // goes in with the scheduled retry
    if (l.ready && l.conn) {
      this.deliverPending(key)
      return { state: 'delivered', id }
    }
    await this.ensureStarted(key)
    return { state: 'queued', id }
  }

  /** Give a ready session the work that waited: a router's messages, a worker's next task. */
  deliverPending(key: string): void {
    const l = this.liveOf(key)
    // A pending restart: new work waits for the restarted session, which has the new settings.
    if (!l.ready || !l.conn || this.held(key) || this.restartWaits(key)) return
    if (key.startsWith('w-')) {
      if (this.inFlight(key) > 0) return
      // A task first; a cleanup job only when nothing else waits (a task makes the worker active again).
      const jobs = this.store.pendingMessages(key)
      if (this.deliverNextTask(key)) {
        for (const m of jobs) if (m.meta.kind === 'cleanup') this.store.setMessageState(m.id, 'ended')
        return
      }
      if (jobs[0]) this.sendMessage(key, jobs[0])
      return
    }
    const pending = this.store.pendingMessages(key)
    for (const m of pending) this.sendMessage(key, m)
    if (pending.some(m => m.state === 'interrupted')) l.resumeNote = undefined
  }

  private sendMessage(key: string, m: MessageRow): void {
    const content = m.state === 'interrupted' ? `${this.resumeNote(key)}\n\n${m.content}` : m.content
    this.store.setMessageState(m.id, 'delivered')
    this.send(key, { content, meta: { ...m.meta } })
  }

  /** The note in front of re-delivered work: why it was cut off. */
  private resumeNote(key: string): string {
    const note = this.liveOf(key).resumeNote
    if (note) return note
    return key.startsWith('r-')
      ? '(Re-delivered: your session was interrupted before you finished with this message, and has resumed. Check the thread with fetch_thread for anything you already posted or delegated, then carry on without repeating it.)'
      : '(Re-delivered: your session was interrupted while you worked on this, and has resumed. Check what is already done — files, commits, what you already reported — before continuing, and don\'t report it again.)'
  }

  /** Deliver the worker's next pending task, if it is ready and free. */
  deliverNextTask(key: string): TaskRow | undefined {
    const l = this.liveOf(key)
    if (!l.ready || !l.conn || this.held(key) || this.restartWaits(key)) return undefined
    const next = this.store.pendingTasks(key)[0]
    if (!next) return undefined
    this.sendTask(key, next)
    return next
  }

  sendTask(key: string, task: TaskRow): void {
    const thread = this.store.thread(task.threadId)
    const again = task.state === 'interrupted' ? `\n\n${this.resumeNote(key)}` : ''
    if (task.state === 'interrupted') this.liveOf(key).resumeNote = undefined
    const content = `Task #${task.id} from thread ${thread ? this.permalink(thread.id) : task.threadId}:\n\n${task.text}${again}`
    this.store.setTaskState(task.id, 'delivered')
    this.store.patchWorker(key, { activeThread: task.threadId, activeTask: task.id })
    // Read by session-mod at each model request: the level stays for later tasks that name none.
    if (task.effort && task.effort !== this.effortOf(key)) {
      this.setEffort(key, task.effort)
      log('lifecycle', `${key}: task #${task.id} at ${task.effort} effort`)
    }
    this.send(key, {
      content,
      meta: { chat_id: task.channelId, thread_id: task.threadId, task_id: String(task.id), workspace: this.store.session(key)?.workspace ?? '' },
    })
  }

  /** The effort a worker's model requests go at (session-mod reads it); undefined: its own default. */
  effortOf(key: string): Effort | undefined {
    try {
      const level = readFileSync(sessionFiles(this.p, key).effort, 'utf8').trim()
      return isEffort(level) ? level : undefined
    } catch {
      return undefined
    }
  }

  setEffort(key: string, level: Effort | undefined): void {
    const f = sessionFiles(this.p, key)
    try {
      if (level === undefined) rmSync(f.effort, { force: true })
      else {
        mkdirSync(f.dir, { recursive: true, mode: 0o700 })
        writeFileSync(f.effort, `${level}\n`)
      }
    } catch (err) {
      log('lifecycle', `${key}: effort ${level ?? 'default'} not set: ${errMsg(err)}`)
    }
  }

  /** Close a session gracefully (/exit, then kill). Call on the chain. */
  async close(key: string, reason: CloseReason, announce = true): Promise<void> {
    const row = this.store.session(key)
    if (!row) return
    const name = tmuxName(key)
    const l = this.liveOf(key)
    if (l.recheck) clearTimeout(l.recheck)
    if (await this.tmux.has(name)) {
      this.patch(key, { status: 'closing' })
      if (row.status === 'busy') {
        await this.tmux.keys(name, ['Escape'])
        await Bun.sleep(700)
      }
      await this.tmux.text(name, '/exit')
      await Bun.sleep(300)
      await this.tmux.keys(name, ['Enter'])
      const end = Date.now() + 15_000
      while (Date.now() < end && (await this.tmux.has(name))) await Bun.sleep(400)
      if (await this.tmux.has(name)) await this.tmux.kill(name)
    }
    this.markStopped(key, reason)
    log('lifecycle', `${key}: closed (${reason})`)
    if (reason === 'idle' && announce && this.cfg.announceClose) {
      const t = this.activeThreadOf(key)
      await this.notice(t, `💤 **${this.label(key)}** closed after ${this.idleMinutesFor(row)}m idle — mention me to resume.`)
    }
  }

  /** The process is gone: unfinished work becomes "interrupted" (re-delivered later). Returns how many. */
  private markStopped(key: string, reason: CloseReason): number {
    const l = this.liveOf(key)
    l.ready = false
    l.starting = false
    l.conn = undefined
    l.helloAt = 0
    l.cleaning = false
    const interrupted = this.store.moveDelivered(key, 'interrupted')
    for (const p of this.desk.drain(key)) if (p.postId) void this.mm.patchPost(p.postId, { message: staleText(p) }).catch(() => {})
    if (reason === 'manual') this.clearRetry(key)
    this.setRestartPending(key, false) // the next start uses the current settings anyway
    if (key.startsWith('w-') && interrupted) this.store.patchWorker(key, { activeTask: undefined })
    this.patch(key, { status: 'stopped', closedAt: Date.now(), closeReason: reason, busySince: undefined })
    return interrupted
  }

  // ------------------------------------------------------------------ restart, retry, wake

  /**
   * Restart a session so it picks up new settings, keeping its conversation
   * (--resume). Graceful by default: right away when it is idle, otherwise as
   * soon as its current turn ends — work in progress is never cut off.
   * `now`: interrupt it; its unfinished work is re-delivered after the restart.
   * A stopped session is simply started. Call on the chain.
   */
  async restart(key: string, now = false): Promise<{ ok: boolean; message: string; state: 'restarted' | 'pending' | 'started' | 'unchanged' | 'failed' }> {
    const row = this.store.session(key)
    if (!row) return { ok: false, message: `no session ${key}`, state: 'failed' }
    const label = `${key} (${this.label(key)})`
    if (!isLive(row.status)) {
      this.clearRetry(key)
      const r = await this.ensureStarted(key)
      if (r === 'waiting') return { ok: false, message: `${label} is ${row.status} and waits for a free ${row.role} slot`, state: 'failed' }
      if (r === 'failed') return { ok: false, message: `couldn't start ${label} — see mmhub logs`, state: 'failed' }
      return { ok: true, message: `${label} was ${row.status} — starting it`, state: 'started' }
    }
    if (row.status === 'starting' || row.status === 'resuming') {
      return { ok: true, message: `${label} is ${row.status} with the current settings already`, state: 'unchanged' }
    }
    if (row.status === 'closing') return { ok: false, message: `${label} is closing`, state: 'failed' }
    const unreadable = this.ws(row.workspace)?.unreadable
    if (unreadable) return { ok: false, message: `left ${label} running: it couldn't start again, the hub ${unreadable}`, state: 'failed' }
    if (now) {
      const cut = this.inFlight(key)
      await this.restartNow(key, 'asked to restart now')
      return { ok: true, message: `restarted ${label} now${cut ? ' — its unfinished work is re-delivered' : ''}`, state: 'restarted' }
    }
    if (canRestartNow(this.reapView(row))) {
      await this.restartNow(key, 'idle')
      return { ok: true, message: `restarted ${label} (it was idle)`, state: 'restarted' }
    }
    this.setRestartPending(key, true)
    const background = this.backgroundOf(key).length
    log('lifecycle', `${key}: restart pending until its turn ends${background ? ` and its background work (${background}) is done` : ''}`)
    if (background && row.status === 'idle') {
      return { ok: true, message: `${label} will restart once the work it runs in the background is done (${background} task${background > 1 ? 's' : ''}); restarting it now would stop that work`, state: 'pending' }
    }
    const why = this.desk.count(key) ? ' (a 🔐 prompt is open)' : ''
    return { ok: true, message: `${label} will restart as soon as its current turn ends${why}`, state: 'pending' }
  }

  /** Restart every live session (optionally only one role). Call on the chain. */
  async restartAll(role: Role | undefined, now = false): Promise<{ ok: boolean; message: string }> {
    const keys = this.store.sessions(role ? { role } : undefined).filter(s => isLive(s.status)).map(s => s.key)
    if (!keys.length) return { ok: true, message: `no live ${role ?? 'session'}s to restart` }
    const tally = new Map<string, number>()
    for (const key of keys) {
      const r = await this.restart(key, now)
      tally.set(r.state, (tally.get(r.state) ?? 0) + 1)
    }
    const words: Record<string, string> = { restarted: 'restarted', pending: 'restart after their current turn', started: 'started', unchanged: 'already starting', failed: 'failed' }
    return { ok: !tally.get('failed'), message: [...tally].map(([k, n]) => `${n} ${words[k]}`).join(', ') }
  }

  private async restartNow(key: string, why: string): Promise<void> {
    log('lifecycle', `${key}: restarting (${why})`)
    await this.close(key, 'restart')
    const r = await this.ensureStarted(key)
    if (r !== 'live') log('lifecycle', `${key}: restart → ${r}`)
  }

  /**
   * Opens a direct session (store.ts WorkerRow.direct) in workspace `name` and starts
   * it (`mmhub session new`). Call on the chain.
   */
  async newDirectSession(name: string): Promise<{ ok: boolean; message: string; key?: string }> {
    const w = this.ws(name)
    if (!w) return { ok: false, message: `no workspace ${name.slice(0, 40)}` }
    if (w.unreadable) return { ok: false, message: `the hub ${w.unreadable}` }
    const n = Math.max(0, ...this.store.workers(w.name).map(x => Number(/^Direct session (\d+)$/.exec(x.title)?.[1] ?? 0))) + 1
    const title = `Direct session ${n}`
    const key = this.createWorker({ workspace: w, title, summary: '', direct: true })
    log('lifecycle', `${key}: direct session opened in ${w.name}`)
    const label = `${key} (${title})`
    const r = await this.ensureStarted(key)
    if (r === 'failed') return { ok: false, message: `couldn't start ${label} — see mmhub logs`, key }
    if (r === 'waiting') return { ok: true, message: `opened ${label}; it waits for a free worker slot (${this.cap('worker')} live): Wake it once one frees`, key }
    return { ok: true, message: `starting ${label} in ${w.dir} — attach: tmux -L ${this.cfg.tmuxSocket} attach -t ${tmuxName(key)}`, key }
  }

  /** Start/resume a stopped session, or retry now one that waits after an API error. Call on the chain. */
  async wake(key: string): Promise<{ ok: boolean; message: string }> {
    const row = this.store.session(key)
    if (!row) return { ok: false, message: `no session ${key}` }
    const label = `${key} (${this.label(key)})`
    if (isLive(row.status)) {
      if (this.held(key)) {
        await this.retryDue(key)
        return { ok: true, message: `retrying ${label} now` }
      }
      return { ok: true, message: `${label} is already ${row.status}` }
    }
    this.clearRetry(key)
    const r = await this.ensureStarted(key)
    if (r === 'waiting') return { ok: false, message: `${label} waits for a free ${row.role} slot` }
    if (r === 'failed') return { ok: false, message: `couldn't start ${label} — see mmhub logs` }
    return { ok: true, message: `${row.turns > 0 ? 'resuming' : 'starting'} ${label}` }
  }

  private scheduleRetry(key: string, delay: number): void {
    const l = this.liveOf(key)
    if (l.retryTimer) clearTimeout(l.retryTimer)
    l.retryAt = Date.now() + delay
    l.retryTimer = setTimeout(() => void this.enqueue(() => this.retryDue(key)), delay)
    this.status.changed()
  }

  /** Forget a scheduled retry (it runs now, or the session was stopped by hand). */
  clearRetry(key: string): void {
    const l = this.live.get(key)
    if (!l) return
    if (l.retryTimer) clearTimeout(l.retryTimer)
    l.retryTimer = undefined
    l.retryAt = undefined
    this.status.changed()
  }

  private async retryDue(key: string): Promise<void> {
    this.clearRetry(key)
    const row = this.store.session(key)
    if (!row) return
    const l = this.liveOf(key)
    log('lifecycle', `${key}: retrying after an API error`)
    if (l.ready && l.conn) this.deliverPending(key)
    else if (this.queued(key) > 0 && row.status !== 'failed' && row.closeReason !== 'manual') await this.ensureStarted(key)
  }

  // ------------------------------------------------------------------ bridges & hooks

  onBridgeHello(key: string, conn: BridgeConn): void {
    const l = this.liveOf(key)
    const old = l.conn
    l.conn = conn
    l.helloAt = Date.now()
    l.goneSince = undefined
    if (old && old !== conn) old.end()
    if (!l.starting) {
      // A bridge that came back (hub restart, MCP reconnect): no dialogs to wait for.
      void this.enqueue(() => {
        const row = this.store.session(key)
        if (row && !isLive(row.status)) this.patch(key, { status: 'idle', closedAt: undefined, closeReason: undefined })
        this.markReady(key)
      })
    }
  }

  onBridgeGone(key: string, conn: BridgeConn): void {
    setTimeout(() => {
      const l = this.liveOf(key)
      if (l.conn !== conn) return
      l.conn = undefined
      l.ready = false
      l.goneSince = Date.now()
      if (this.stopping) return
      // The bridge dies with its claude process: if the tmux session went too, it crashed or was killed.
      void this.enqueue(async () => {
        const row = this.store.session(key)
        if (!row || !isLive(row.status) || row.status === 'closing' || l.starting || l.conn) return
        if (await this.tmux.has(tmuxName(key))) return
        log('lifecycle', `${key}: its process is gone`)
        await this.exitedOnItsOwn(key)
      })
    }, 3000)
  }

  /** The session reached someone (a post, a reaction, a worker, …): its turn has said what it had to. */
  acted(key: string): void {
    const l = this.live.get(key)
    if (l) l.unposted = false
  }

  /**
   * A Stop hook, answered right away: the turn goes back to the session when it
   * ends with text but reached no one since a message went in — that text went to
   * its terminal, where nobody reads it. Once a turn (Claude Code sets
   * stop_hook_active on the Stop that follows), so it can never loop.
   */
  unpostedStop(m: Extract<ClientMsg, { t: 'hook' }>): string | undefined {
    const l = this.live.get(m.key)
    const row = this.store.session(m.key)
    if (m.event !== 'Stop' || m.stop_hook_active || !m.text?.trim() || !l?.unposted || l.starting || !row || !isLive(row.status)) return undefined
    if (m.spawn && l.spawnId && m.spawn !== l.spawnId) return undefined
    l.unposted = false
    const t = this.activeThreadOf(m.key)
    log('lifecycle', `${m.key}: turn ended with text but posted nothing — sent back to post it`)
    const to = m.key.startsWith('r-') || this.cfg.workerReports === 'thread' ? 'people read Mattermost' : "the thread's router reads only your reports"
    return `Nothing was posted this turn: ${to}, not this terminal, so the text you just wrote reached no one. If it was meant for them, send it now with reply${t ? ` (thread_id ${t.id})` : ''}: all of it, not a summary or a pointer to it. If you meant to post nothing, end your turn without writing anything.`
  }

  /** SessionStart context — answered right away (read-only). */
  hookContext(key: string): string | undefined {
    const row = this.store.session(key)
    if (!row) return undefined
    const w = this.ws(row.workspace)
    if (!w) return undefined
    if (row.role === 'router') {
      const t = this.store.threadByRouter(key)
      // The persona rides in the context too: the system prompt is fixed when a session is created, the context is re-sent at every resume.
      return routerContext(w, {
        threadId: t?.id ?? '?', permalink: t ? this.permalink(t.id) : '?', workers: this.store.routerWorkers(w.name),
        persona: routerPersona(this.cfg, w).text, reports: this.cfg.workerReports,
        // In a DM every message reaches the router, so it hears nothing about Laya or unfollow.
        trigger: t && inDM(this, t.id) ? 'mention' : effective(this.cfg, w).trigger,
        unfollowAfter: this.cfg.unfollowAfter,
        skills: workerSkills(w),
      })
    }
    const worker = this.store.worker(key)
    if (worker?.direct) return directContext(w)
    return worker ? workerContext(w, { worker, reports: this.cfg.workerReports, trigger: effective(this.cfg, w).trigger }) : undefined
  }

  /** Hook events change state on the chain (the hook itself was answered already). */
  async applyHook(m: Extract<ClientMsg, { t: 'hook' }>): Promise<void> {
    const row = this.store.session(m.key)
    if (!row) return
    const l = this.liveOf(m.key)
    const ev: HookEvent = m.event
    if (m.spawn && l.spawnId && m.spawn !== l.spawnId) {
      // From a process this session has since replaced (a restart): its Stop or SessionEnd isn't about the new one.
      log('hook', `${m.key}: ignoring ${ev} from an earlier launch`)
      return
    }
    if ((ev === 'Stop' || ev === 'StopFailure') && l.starting) return // a process still starting has run no turn
    l.lastHookAt = Date.now()
    if (ev === 'SessionStart') {
      if (m.session_id && m.session_id !== row.sessionId) this.store.patchSession(m.key, { sessionId: m.session_id })
      return
    }
    if (ev === 'Stop' || ev === 'StopFailure') {
      this.store.patchSession(m.key, { turns: row.turns + 1, lastActiveAt: Date.now() })
      if (Date.now() - l.lastDeliveredAt < STOP_RACE_MS) {
        // A message landed right as the turn ended — it likely starts another turn. Check the screen soon.
        if (ev === 'StopFailure') l.pendingFailure = m.error ?? 'unknown error'
        if (l.recheck) clearTimeout(l.recheck)
        l.recheck = setTimeout(() => void this.enqueue(() => this.recheckBusy(m.key)), 8000)
        return
      }
      await this.turnEnded(m.key, ev === 'StopFailure', m.error)
      return
    }
    if (ev === 'SessionEnd') {
      if (row.status === 'closing' || row.status === 'stopped') return
      // Exited on its own (someone typed /exit, a crash): wait for tmux to go, then tidy up.
      setTimeout(() => void this.enqueue(() => this.exitedOnItsOwn(m.key)), 2500)
    }
  }

  private async recheckBusy(key: string): Promise<void> {
    const l = this.liveOf(key)
    const failure = l.pendingFailure
    l.pendingFailure = undefined
    const row = this.store.session(key)
    if (!row || row.status !== 'busy') return
    if (looksBusy(await this.tmux.capture(tmuxName(key)))) return
    await this.turnEnded(key, failure !== undefined, failure)
  }

  /**
   * A turn finished. Its work ends — or, after an API error worth retrying,
   * goes back to "interrupted" with a retry scheduled. The session is idle; a
   * pending graceful restart happens now; otherwise the next work goes in.
   * Call on the chain.
   */
  async turnEnded(key: string, failed: boolean, error?: string): Promise<void> {
    const row = this.store.session(key)
    if (!row || !isLive(row.status)) return
    const l = this.liveOf(key)
    l.unposted = false
    for (const p of this.desk.drain(key)) if (p.postId) void this.mm.patchPost(p.postId, { message: staleText(p) }).catch(() => {})
    if (failed) await this.turnFailed(key, error)
    else {
      l.failures = 0
      this.store.moveDelivered(key, 'ended')
      this.providerOk(this.providerOf(key))
    }
    if (row.role === 'worker') this.store.patchWorker(key, { activeTask: undefined })
    this.patch(key, { status: 'idle', busySince: undefined, lastActiveAt: Date.now() })
    if (l.cleaning) {
      l.cleaning = false
      // Done for this stretch without work: the next one starts at its next activity.
      this.store.set(`cleaned:${key}`, String(Date.now()))
      log('lifecycle', `${key}: cleanup ${failed ? 'stopped with an error' : 'done'}`)
      if (this.queued(key) === 0 && !row.pinned) {
        await this.close(key, 'idle', false)
        return
      }
    }
    // Work left running in the background would die with the process: the restart waits for it (reap checks again).
    if (this.restartPending(key) && this.backgroundOf(key).length === 0) {
      await this.restartNow(key, 'pending restart, its turn ended')
      return
    }
    this.deliverPending(key)
    void this.pump()
  }

  /**
   * A turn ended with an API error. When the provider is to blame and the
   * workspace has another one ready, the work moves there (switchProvider);
   * otherwise it is retried later (with backoff), or given up and said so.
   */
  private async turnFailed(key: string, error?: string): Promise<void> {
    const l = this.liveOf(key)
    const kind = classifyFailure(error)
    const what = redact((error ?? 'unknown error').replace(/\s+/g, ' ').trim()).slice(0, 160)
    const thread = this.activeThreadOf(key)
    const label = this.label(key)
    const attempt = ++l.failures
    if (await this.switchProvider(key, kind, attempt, what, error)) return
    const delay = this.inFlight(key) > 0 ? retryDelay(kind, attempt) : undefined
    if (delay === undefined) {
      this.store.moveDelivered(key, 'failed')
      l.failures = 0
      const why = kind === 'fatal' ? ' Not retrying automatically — this needs a person.'
        : kind === 'auth' ? ` Not retrying automatically — provider \`${this.providerOf(key)}\` needs signing in again (check it with \`mmhub provider check ${this.providerOf(key)}\`), or the workspace needs another provider.`
        : attempt > 1 ? ` Gave up after ${attempt} tries.` : ''
      log('lifecycle', `${key}: turn failed (${kind}): ${what}`)
      await this.notice(thread, `⚠️ **${label}** stopped with an error: ${what}.${why} Ask again to retry.`)
      return
    }
    this.store.moveDelivered(key, 'interrupted')
    l.resumeNote = `(Re-delivered: your last turn on this stopped with an API error — ${what}. Carry on where you left off, without repeating anything you already posted or reported.)`
    this.scheduleRetry(key, delay)
    log('lifecycle', `${key}: turn failed (${kind}), retry ${attempt} in ${fmtAge(delay)}: ${what}`)
    // Short blips fix themselves and aren't worth a post; a long wait is.
    const say = noticeForRetry(kind, attempt)
    if (say === 'rate_limit') await this.notice(thread, `⏸ **${label}** is rate-limited (${what}). It carries on by itself; next try in ${fmtAge(delay)}.`)
    else if (say === 'quota') await this.notice(thread, `⏸ **${label}** is out of usage or credit on provider \`${this.providerOf(key)}\` (${what}), and the workspace has no other provider ready. It carries on by itself; next try in ${fmtAge(delay)}.`)
    else if (say === 'persistent') await this.notice(thread, `⚠️ **${label}** keeps hitting API errors (${what}). Still retrying; next try in ${fmtAge(delay)}.`)
  }

  private async exitedOnItsOwn(key: string): Promise<void> {
    const row = this.store.session(key)
    if (!row || !isLive(row.status) || row.status === 'closing' || this.liveOf(key).starting) return
    const name = tmuxName(key)
    if (await this.tmux.has(name)) {
      const end = Date.now() + 10_000
      while (Date.now() < end && (await this.tmux.has(name))) await Bun.sleep(500)
      if (await this.tmux.has(name)) await this.tmux.kill(name)
    }
    if (this.store.session(key)?.status === 'stopped') return // closed meanwhile
    const interrupted = this.markStopped(key, 'exited')
    log('lifecycle', `${key}: exited on its own${interrupted ? ` with work in flight (${interrupted})` : ''}`)
    if (!interrupted && !this.queued(key)) return
    if (this.held(key)) return // the scheduled retry starts it
    if (this.restarts.take(key)) {
      // Resumed quietly: the work carries on, nobody needs to act.
      await this.ensureStarted(key)
    } else {
      this.patch(key, { status: 'failed', closeReason: 'failed' })
      for (const t of this.threadsNeeding(key)) await this.notice(t, `⚠️ **${this.label(key)}** keeps crashing, so this is on hold. An owner can retry with \`!wake ${key}\`.`)
    }
  }

  async onPermissionRequest(key: string, m: Extract<ClientMsg, { t: 'permission_request' }>): Promise<void> {
    const l = this.live.get(key)
    if (l?.cleaning && l.conn) {
      // A cleanup job runs unattended, as with bypassPermissions: its prompts are allowed, and logged.
      l.conn.send({ t: 'permission', request_id: m.request_id, behavior: 'allow' })
      const what = redact(m.input_preview.replace(/\s+/g, ' ').trim()).slice(0, 300)
      log('perm', `${key}: cleanup — allowed ${m.tool_name}${m.description ? ` (${m.description})` : ''}${what ? `: ${what}` : ''}`)
      return
    }
    const thread = this.activeThreadOf(key)
    const code = m.request_id.toLowerCase()
    if (this.desk.get(code)) return
    const prompt = {
      code, key, title: this.label(key), toolName: m.tool_name, description: m.description, inputPreview: m.input_preview,
      threadId: thread?.id ?? '', channelId: thread?.channelId ?? '', createdAt: Date.now(),
    }
    this.desk.add(prompt)
    this.status.changed()
    if (!thread) {
      log('perm', `${key}: no thread for prompt ${code} — answer it in the terminal`)
      return
    }
    const post = await this.notice(thread, promptText(prompt))
    const p = this.desk.get(code)
    if (p && post) p.postId = post.id
  }

  async answerPermission(code: string, behavior: 'allow' | 'deny', byUserId: string): Promise<boolean> {
    const p = this.desk.take(code)
    if (!p) return false
    const conn = this.liveOf(p.key).conn
    conn?.send({ t: 'permission', request_id: p.code, behavior })
    const by = await this.mm.username(byUserId)
    if (p.postId) await this.mm.patchPost(p.postId, { message: answeredText(p, behavior, by) }).catch(() => {})
    log('perm', `${p.key}: ${p.code} ${behavior} by ${by}${conn ? '' : ' (bridge not connected!)'}`)
    this.status.changed()
    return true
  }

  // ------------------------------------------------------------------ Mattermost events

  private remember(postId: string): boolean {
    if (this.seenSet.has(postId)) return false
    this.seenSet.add(postId)
    this.seen.push(postId)
    if (this.seen.length > 4000) for (const id of this.seen.splice(0, 1000)) this.seenSet.delete(id)
    return true
  }

  async onPosted(post: MMPost, channelType: string): Promise<void> {
    if (!this.remember(post.id)) return
    const prev = Number(this.store.get(`seen:${post.channel_id}`) ?? 0)
    if (post.create_at > prev) this.store.set(`seen:${post.channel_id}`, String(post.create_at))
    if (channelType === 'D') noteDM(this, post.channel_id)
    if (post.user_id === this.bot.id) return

    const access = this.accessStore.load()
    if (pruneExpired(access)) this.accessStore.save(access)
    const bindings = loadBindings(this.p.bindings)
    const threadId = post.root_id || post.id
    const wsName = this.store.thread(threadId)?.workspace ?? bindings[post.channel_id]
    const w = wsName ? this.ws(wsName) : undefined
    const action = decideInbound({
      post, channelType, bot: this.bot, access,
      workspace: bindings[post.channel_id],
      knownThread: !!this.store.thread(threadId),
      awaitingWorkspace: !!this.openWorkspaceQuestion(post),
      linkedDM: channelType === 'D' && !!post.root_id && this.store.link(post.root_id)?.kind === 'dm',
      trigger: w ? effective(this.cfg, w).trigger : 'mention',
      followed: following(this, threadId),
    })
    if (action.kind !== 'ignore') log('inbound', `${post.id} → ${action.kind}`)
    await this.act(action, post, channelType)
  }

  /** Carry out an inbound decision. Call on the chain. */
  async act(a: InboundAction, post: MMPost, channelType: string): Promise<void> {
    switch (a.kind) {
      case 'ignore':
        if (a.passOver) countSkipped(this, a.passOver)
        return
      case 'pair': {
        const access = this.accessStore.load()
        const r = issuePairingCode(access, post.user_id, post.channel_id)
        if (!r) return
        this.accessStore.save(access)
        await this.mm.createPost({
          channel_id: post.channel_id,
          message: `${r.isResend ? 'Still pending' : 'Pairing required'} — ask the owner to run this in Claude Code:\n\n\`/mattermost-hub:access pair ${r.code}\``,
        }).catch(err => log('mm', `pairing reply failed: ${errMsg(err)}`))
        return
      }
      case 'permission': {
        if (!(await this.answerPermission(a.code, a.behavior, post.user_id))) {
          await this.replyTo(post, `No pending permission prompt \`${a.code}\`.`)
        }
        return
      }
      case 'command':
        return runCommand(this, a, post)
      case 'ask_workspace':
        if (channelType === 'D' && this.cfg.personalWorkspaces) return this.startPersonal(a.threadId, post)
        return askWorkspace(this, post, channelType)
      case 'workspace_answer':
        return answerWorkspace(this, a.text, post)
      case 'start': {
        const w = this.ws(a.workspace)
        if (!w) {
          await this.replyTo(post, `⚠️ This channel is bound to workspace \`${a.workspace}\`, which doesn't exist any more. Rebind it with \`mmhub ws bind\`.`)
          return
        }
        await this.startThread(w, a.threadId, post)
        return
      }
      case 'message': {
        const t = this.store.thread(a.threadId)
        if (a.follow && !following(this, a.threadId)) setFollowing(this, a.threadId, true)
        if (t) await this.deliverToRouter(t, post)
        return
      }
      case 'dm_reply':
        return dmReply(this, post)
      case 'classify':
        // Off the chain: Laya may be slow or away. The decision comes back on it.
        void classifyLater(this, a, post, channelType)
        return
    }
  }

  /**
   * The "which workspace?" question a post may answer: the one in its thread,
   * or — for a plain top-level message (DMs) — the latest one asked of the
   * same person in the same channel.
   */
  openWorkspaceQuestion(post: { id: string; root_id: string; channel_id: string; user_id: string }): string | undefined {
    const threadId = post.root_id || post.id
    if (this.awaiting.has(threadId)) return threadId
    if (post.root_id) return undefined
    let found: string | undefined
    let at = 0
    for (const [tid, a] of this.awaiting) {
      if (a.channelId === post.channel_id && a.post.user_id === post.user_id && a.askedAt >= at) {
        found = tid
        at = a.askedAt
      }
    }
    return found
  }

  /** A new hub thread: its router is created and gets the first message. */
  /**
   * A DM from a chat not connected to a workspace (config personalWorkspaces, on by
   * default): the person gets a workspace of their own, personal-<user id>, created from
   * the template the first time and reused after; the chat is bound to it and the
   * thread starts there, without the "which workspace?" question. Call on the chain.
   */
  async startPersonal(threadId: string, post: MMPost): Promise<void> {
    let w: Workspace
    try {
      w = await this.personalWorkspace(post.user_id)
    } catch (err) {
      await this.replyTo(post, `⚠️ Couldn't create your personal workspace \`${personalName(post.user_id)}\`: ${errMsg(err)}`)
      return
    }
    bindChannel(this.p.bindings, post.channel_id, w.name)
    this.status.changed()
    await this.startThread(w, threadId, post)
  }

  /** A person's own workspace, personal-<user id>: created from the template the first time. Throws when it can't be. */
  async personalWorkspace(userId: string): Promise<Workspace> {
    const name = personalName(userId)
    const have = this.ws(name)
    if (have) return have
    const user = await this.mm.username(userId)
    try {
      const w = createWorkspace(this.cfg, name, `Personal workspace of @${user}`)
      log('hub', `created personal workspace ${name} for @${user}`)
      this.status.changed()
      return w
    } catch (err) {
      log('hub', `personal workspace ${name} for @${user}: ${errMsg(err)}`)
      throw err
    }
  }

  async startThread(w: Workspace, threadId: string, post: MMPost): Promise<void> {
    const label = post.message.replace(/@[\w.-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'thread'
    this.createRouter({ threadId, channelId: post.channel_id, workspace: w, label })
    const t = this.store.thread(threadId)!
    await this.deliverToRouter(t, post)
  }

  async deliverToRouter(t: ThreadRow, post: MMPost): Promise<void> {
    const access = this.accessStore.load()
    if (access.ackReaction) void this.mm.addReaction(this.bot.id, post.id, access.ackReaction).catch(() => {})
    const user = await this.mm.username(post.user_id)
    const meta: Record<string, string> = {
      chat_id: post.channel_id,
      thread_id: t.id,
      message_id: post.id,
      user: safeName(user) ?? post.user_id,
      user_id: post.user_id,
      ts: new Date(post.create_at).toISOString(),
      workspace: t.workspace,
    }
    const files = post.metadata?.files ?? []
    if (files.length || post.file_ids?.length) {
      meta.attachment_count = String(files.length || post.file_ids!.length)
      if (files.length) meta.attachments = files.map(f => `${safeName(f.name)} (${Math.ceil(f.size / 1024)}KB)`).join('; ')
    }
    const titles = Object.fromEntries(this.store.workers(t.workspace).map(w => [w.key, w.title]))
    const digest = buildDigest(this.store.postsSince(t.id, t.cursor, 'w-'), titles, Date.now())
    const tw = this.ws(t.workspace)
    const skipped = takeSkipped(this, t.id, tw ? effective(this.cfg, tw).trigger : undefined)
    const content = [digest.text, skipped, post.message].filter(Boolean).join('\n\n')
    if (digest.cursor) this.store.setCursor(t.id, digest.cursor)
    await this.deliver(t.routerKey, content, meta)
  }

  async onReaction(r: MMReaction): Promise<void> {
    const access = this.accessStore.load()
    // Under "*" a bot account isn't an owner. Only then does a lookup decide it; a failed one counts as a bot.
    const reactorIsBot = r.user_id !== this.bot.id && ownerNeedsBotCheck(access, r.user_id)
      ? await this.mm.user(r.user_id).then(u => !!u.is_bot, () => true)
      : false
    const a = decideReaction(r, this.bot, access, id => this.desk.codeForPost(id), reactorIsBot)
    if (a.kind === 'permission') await this.answerPermission(a.code, a.behavior, r.user_id)
  }

  /** After a reconnect (or at startup), fetch posts we missed in every channel we listen in. */
  async catchUp(maxAgeMs = 2 * 60 * 60_000): Promise<void> {
    const channels = new Set<string>([
      ...Object.keys(loadBindings(this.p.bindings)),
      ...Object.keys(this.accessStore.load().channels),
      ...this.store.threads().map(t => t.channelId),
      ...this.store.linkChannels(), // DMs sessions sent: replies may have come meanwhile
    ])
    for (const ch of channels) {
      const stored = this.store.get(`seen:${ch}`)
      if (!stored) {
        // Never listened here before: start from now, don't replay history.
        this.store.set(`seen:${ch}`, String(Date.now()))
        continue
      }
      const since = Math.max(Number(stored), Date.now() - maxAgeMs)
      try {
        const res = await this.mm.postsSince(ch, since)
        const posts = Object.values(res.posts).filter(p => p.create_at > since).sort((a, b) => a.create_at - b.create_at)
        if (!posts.length) continue
        const type = (await this.mm.channel(ch)).type
        log('catchup', `${ch}: ${posts.length} missed post(s)`)
        for (const p of posts) await this.enqueue(() => this.onPosted(p, type))
      } catch (err) {
        log('catchup', `${ch}: ${errMsg(err)}`)
      }
    }
  }

  // ------------------------------------------------------------------ periodic work

  /** Reaper + watchdogs. Call on the chain. */
  /**
   * laya-serve, when the hub runs it (layaserve.ts): start it if a workspace uses
   * Laya and its session is gone, then warm it up off the chain.
   */
  async keepLaya(): Promise<void> {
    if (!this.cfg.laya.serve) return
    const sp = servePaths(this.p)
    const all = this.workspaces()
    if (all.some(w => w.unreadable)) return // what they want isn't known: leave it as it is
    const wanted = all.some(w => effective(this.cfg, w).trigger === 'laya')
    try {
      const r = await keepServing({ tmux: this.tmux, laya: this.cfg.laya, sp, wanted, k: this.layaKeeper, now: Date.now() })
      if (r === 'started') void warmUp(this.cfg.laya, serveKey(sp)).then(m => log('trigger', `laya-serve: ${m}`))
      else if (r === 'not installed' && !this.layaKeeper.warned) {
        this.layaKeeper.warned = true
        log('trigger', `laya-serve is configured but not installed in ${sp.dir}: mmhub laya install`)
      }
    } catch (err) {
      log('trigger', `laya-serve: could not start it: ${errMsg(err)}`)
    }
  }

  async reap(): Promise<void> {
    await this.keepLaya()
    const now = Date.now()
    const liveRows = this.store.sessions().filter(s => isLive(s.status))
    for (const s of liveRows) {
      const l = this.liveOf(s.key)
      if (l.starting || s.status === 'closing') continue
      const name = tmuxName(s.key)
      if (!(await this.tmux.has(name))) {
        log('lifecycle', `${s.key}: tmux session vanished`)
        await this.exitedOnItsOwn(s.key)
        continue
      }
      l.attached = await this.tmux.clients(name)
      // Bridge missing for 2 min with work waiting: restart the session.
      if (!l.conn && l.goneSince && now - l.goneSince > 120_000 && this.queued(s.key) > 0) {
        log('lifecycle', `${s.key}: bridge gone for 2m — restarting`)
        await this.close(s.key, 'failed')
        await this.ensureStarted(s.key)
        continue
      }
      if (s.status === 'busy' && s.busySince && now - Math.max(s.busySince, l.lastHookAt) > this.cfg.busyWatchdogMinutes * 60_000) {
        if (!looksBusy(await this.tmux.capture(name))) {
          log('lifecycle', `${s.key}: busy for ${fmtAge(now - s.busySince)} without a Stop hook but looks idle — marking idle`)
          await this.turnEnded(s.key, false)
          continue
        }
      }
      // A graceful restart whose turn end we missed.
      const fresh = this.store.session(s.key)
      if (fresh && this.restartPending(s.key) && canRestartNow(this.reapView(fresh))) await this.restartNow(s.key, 'pending restart')
    }
    const views = this.store.sessions().filter(s => isLive(s.status)).map(s => this.reapView(s))
    for (const key of dueForIdleClose(views, now, v => this.idleMinutesFor(v))) await this.close(key, 'idle')
    await this.cleanupDue(now)
    // A resting provider's time ran out (or a chain changed): sessions go back to the workspace's first choice.
    await this.rebalanceProviders()
    await this.pump()
    this.jobsDue(Date.now()) // besides the ticker, which may give up
    this.status.changed()
  }

  /**
   * Scheduled jobs whose time has come run on the chain (jobs.ts). Checked on
   * every tick of the sleep-proof clock and by the reaper — never a long timer,
   * which may not fire after the machine slept.
   */
  jobsDue(now: number): void {
    if (this.jobsQueued || this.stopping || !this.store.dueJobs(now).length) return
    this.jobsQueued = true
    void this.enqueue(async () => {
      this.jobsQueued = false
      await runDueJobs(this)
    })
  }

  /**
   * Start stopped sessions that have work waiting (queued, or interrupted by a
   * crash, an idle/cap close or a hub restart), oldest need first. Sessions an
   * owner stopped by hand wait for a new message, a delegate or a wake; ones
   * waiting out an API-error retry wait for it.
   */
  async pump(): Promise<void> {
    const waiting = this.store.sessions()
      .filter(s => !isLive(s.status) && s.status !== 'failed' && s.closeReason !== 'manual' && !this.held(s.key))
      .filter(s => this.queued(s.key) > 0)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)
    for (const s of waiting) {
      const r = await this.ensureStarted(s.key)
      if (r === 'waiting') continue
    }
  }

  /**
   * Keep "typing…" up in every thread a session is working for: a busy router in its
   * thread, a busy worker in the thread of its task. Mattermost drops the indicator
   * after a few seconds, so this runs every 3 s. While a session runs a turn, and
   * while work it left running in the background goes on (its turn ended, but the
   * work didn't): not while it starts or resumes, nor while Laya or OpenRouter
   * judges a reply (no session runs then), nor while it waits on a 🔐 prompt or an
   * API-error retry.
   */
  keepTyping(): void {
    if (!this.mm.connected) return
    const done = new Set<string>()
    for (const s of this.store.sessions()) {
      const l = this.live.get(s.key)
      if (!l || this.desk.count(s.key) > 0 || this.held(s.key)) continue
      if (!l.ready || !l.conn || l.cleaning) continue
      if (s.status === 'idle') {
        const background = this.backgroundOf(s.key).length
        // Claude Code started a turn by itself, with a finished task's notice.
        if ((l.background?.promptedAt ?? 0) > s.lastActiveAt) void this.enqueue(() => this.taskTurn(s.key))
        if (!background) continue
      } else if (s.status !== 'busy') continue
      const t = this.activeThreadOf(s.key)
      // A draft thread (a scheduled run's) has no post yet to show it under.
      if (!t || done.has(t.id) || isDraft(t.id)) continue
      done.add(t.id)
      this.mm.typing(t.channelId, t.id)
    }
  }

  /**
   * A task the session ran in the background ended while it was idle, and Claude
   * Code started a turn with its notice (no message from the hub began it): the
   * session is busy until that turn's Stop. A screen check soon after catches a
   * turn that ended before the hub noticed it began. Call on the chain.
   */
  private taskTurn(key: string): void {
    const row = this.store.session(key)
    const l = this.live.get(key)
    if (!row || row.status !== 'idle' || !l?.background || l.background.promptedAt <= row.lastActiveAt) return
    log('lifecycle', `${key}: a task it ran in the background ended — its turn for it runs`)
    this.patch(key, { status: 'busy', busySince: Date.now(), lastActiveAt: Date.now() })
    if (l.recheck) clearTimeout(l.recheck)
    l.recheck = setTimeout(() => void this.enqueue(() => this.recheckBusy(key)), 20_000)
  }

  /** The access skill drops <approved>/<userId> files; tell those people they're in. */
  async notifyApproved(): Promise<void> {
    let names: string[] = []
    try {
      names = readdirSync(this.p.approved)
    } catch {
      return
    }
    for (const userId of names) {
      const f = join(this.p.approved, userId)
      try {
        const chatId = readFileSync(f, 'utf8').trim()
        rmSync(f, { force: true })
        const ch = chatId || (await this.mm.directChannel(this.bot.id, userId)).id
        await this.mm.createPost({ channel_id: ch, message: '✅ Paired — mention me in a channel connected to a workspace to start a thread.' })
      } catch (err) {
        log('access', `approval note for ${userId}: ${errMsg(err)}`)
      }
    }
  }

  channelName(id: string): string {
    const hit = this.channelNames.get(id)
    if (hit) return hit
    this.channelNames.set(id, id)
    void this.mm.channel(id).then(c => {
      this.channelNames.set(id, c.display_name || c.name)
      this.status.changed()
    }).catch(() => {})
    return id
  }

  snapshot(): HubSnapshot {
    const sessions = this.store.sessions()
    const workspaces = this.workspaces()
    const workers = workspaces.flatMap(w => this.store.workers(w.name))
    const defs = this.providerDefs()
    return buildSnapshot({
      hub: {
        pid: process.pid, version: this.deps.version, startedAt: this.startedAt, heartbeatAt: this.stopping ? 0 : Date.now(),
        cliPath: this.deps.cliPath, bunBin: this.deps.bunBin, stateDir: this.p.dir,
      },
      mattermost: { connected: this.mm.connected, url: this.mm.baseUrl, ...(this.bot.username ? { bot: this.bot.username } : {}) },
      caps: { maxLiveRouters: this.cfg.maxLiveRouters, maxLiveWorkers: this.cfg.maxLiveWorkers },
      workspaces,
      bindings: loadBindings(this.p.bindings),
      channelName: id => this.channelName(id),
      sessions,
      threads: this.store.threads(),
      workers,
      permalink: id => this.permalink(id),
      attached: key => this.liveOf(key).attached,
      pendingPermissions: key => this.desk.count(key),
      queuedTasks: key => this.queued(key),
      inFlight: key => this.inFlight(key),
      restartPending: key => this.restartPending(key),
      background: key => this.backgroundOf(key).length,
      retryAt: key => this.retryAt(key),
      idleMinutes: s => this.idleMinutesFor(s),
      tmuxName,
      provider: w => this.providerSnapshot(w, defs),
      sessionProvider: key => this.providerOf(key),
    })
  }

  // ------------------------------------------------------------------ start / stop

  async start(): Promise<void> {
    const me = await this.mm.me()
    this.bot = { id: me.id, username: me.username }
    log('hub', `bot @${me.username} (${me.id})`)

    // Take over sessions that survived a hub restart; tidy the ones that didn't.
    const running = new Set(await this.tmux.list())
    const interrupted: string[] = []
    const busy: string[] = []
    for (const s of this.store.sessions()) {
      if (!isLive(s.status)) continue
      if (running.has(tmuxName(s.key))) {
        if (s.status === 'starting' || s.status === 'resuming' || s.status === 'closing') this.store.patchSession(s.key, { status: 'idle' })
        if (s.status === 'busy') busy.push(s.key)
        this.liveOf(s.key).goneSince = Date.now()
        // Launched before the hub kept this: background work from before this process started died with the earlier one.
        if (!this.store.get(`spawned:${s.key}`)) {
          const at = await this.tmux.createdAt?.(tmuxName(s.key)).catch(() => undefined)
          if (at) this.store.set(`spawned:${s.key}`, String(at))
        }
        log('hub', `adopting live session ${s.key}`)
      } else if (this.markStopped(s.key, 'exited')) {
        interrupted.push(s.key)
      }
    }
    this.store.pruneMessages(Date.now() - 7 * 86_400_000)
    pruneJobRuns(this)

    this.status.start()
    this.mm.listen({
      onEvent: ev => {
        if (ev.kind === 'posted') void this.enqueue(() => this.onPosted(ev.post, ev.channelType))
        else void this.enqueue(() => this.onReaction(ev.reaction))
      },
      onConnect: () => {
        this.status.changed()
        void this.catchUp()
      },
      onDisconnect: () => this.status.changed(),
    })
    this.armTimers()
    void this.enqueue(() => this.keepLaya())
    // Ticks that keep coming after the machine sleeps (Bun's pending timers may not): see onTick.
    this.ticker = new Ticker((now, gap) => this.onTick(now, gap))
    this.ticker.start()
    mkdirSync(this.p.approved, { recursive: true, mode: 0o700 })

    // Work cut off while the hub was down (sessions died with it, or the machine restarted): carry on with it.
    void this.enqueue(async () => {
      for (const key of interrupted) log('lifecycle', `${key}: was interrupted while the hub was down — resuming`)
      await this.pump()
    })
    // Turns that may have ended while nobody listened for their Stop hook.
    for (const key of busy) setTimeout(() => void this.enqueue(() => this.recheckBusy(key)), 20_000)
  }

  /** The hub's interval timers, made anew (after the machine slept, the old ones can be stuck). */
  private armTimers(): void {
    for (const t of this.timers) clearInterval(t)
    this.timerAt = Date.now()
    this.timers = [
      setInterval(() => void this.enqueue(() => this.reap()), 60_000),
      setInterval(() => void this.notifyApproved(), 5_000),
      setInterval(() => {
        this.timerAt = Date.now()
        this.keepTyping()
      }, 3_000),
    ]
  }

  /**
   * A tick of the sleep-proof clock (Ticker), every 5 s. After a long gap
   * between ticks (the machine slept, or the hub stalled), or when the hub's
   * own timers went quiet, timers pending from before may never fire:
   * recoverTimers makes new ones. Scheduled jobs that are due run from here too.
   */
  onTick(now: number, gapMs: number): void {
    if (this.stopping) return
    const quiet = now - this.timerAt
    if (gapMs > WAKE_GAP_MS) this.recoverTimers(`no ticks for ${fmtAge(gapMs)} (the machine slept, or the hub stalled)`)
    else if (quiet > WAKE_GAP_MS) this.recoverTimers(`the hub's timers stopped ${fmtAge(quiet)} ago`)
    this.jobsDue(now)
  }

  /**
   * New timers for everything that waits: intervals, the status heartbeat,
   * scheduled retries, and a screen check of busy sessions (as when sessions
   * are adopted at start: a turn may have ended unheard). Also a new Mattermost
   * socket: the old one may have died while the machine slept without knowing,
   * and reconnecting catches up on posts missed meanwhile.
   */
  recoverTimers(why: string): void {
    log('hub', `${why}: re-arming timers and reconnecting to Mattermost`)
    this.armTimers()
    this.status.rearm()
    const now = Date.now()
    for (const [key, l] of this.live) {
      if (l.retryAt !== undefined) this.scheduleRetry(key, Math.max(0, l.retryAt - now))
      if (this.store.session(key)?.status === 'busy') {
        if (l.recheck) clearTimeout(l.recheck)
        l.recheck = setTimeout(() => void this.enqueue(() => this.recheckBusy(key)), 5_000)
      }
    }
    this.mm.reconnect(why)
    void this.enqueue(() => this.reap())
  }

  async shutdown(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.ticker?.stop()
    for (const t of this.timers) clearInterval(t)
    this.mm.stop()
    this.status.stop()
    this.status.write()
    for (const l of this.live.values()) l.conn?.end()
    this.store.close()
  }
}

export type { WorkerRow }
