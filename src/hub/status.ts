/**
 * status.json for the panel mod and `mmhub status`: built from the store and
 * the hub's live view, written atomically on change and every 5 s (heartbeat).
 */

import type { HubSnapshot, SessionSnapshot, WorkspaceProvider, WorkspaceSnapshot } from '../shared/snapshot'
import { writeJsonAtomic } from '../shared/util'
import { closesAt, isLive, type ReapView } from './lifecycle'
import type { SessionRow, ThreadRow, WorkerRow } from './store'
import type { Workspace } from './workspaces'

export type SnapshotInput = {
  hub: HubSnapshot['hub']
  mattermost: HubSnapshot['mattermost']
  caps: { maxLiveRouters: number; maxLiveWorkers: number }
  workspaces: Workspace[]
  bindings: Record<string, string>
  channelName: (id: string) => string
  sessions: SessionRow[]
  threads: ThreadRow[]
  workers: WorkerRow[]
  permalink: (postId: string) => string
  attached: (key: string) => number
  pendingPermissions: (key: string) => number
  queuedTasks: (key: string) => number
  inFlight: (key: string) => number
  restartPending: (key: string) => boolean
  retryAt: (key: string) => number | undefined
  idleMinutes: (s: SessionRow) => number
  tmuxName: (key: string) => string
  /** The workspace's provider state (absent: not reported). */
  provider?: (w: Workspace) => WorkspaceProvider | undefined
  /** The provider a live session was launched with. */
  sessionProvider?: (key: string) => string | undefined
}

export function buildSnapshot(i: SnapshotInput): HubSnapshot {
  const threadByRouter = new Map(i.threads.map(t => [t.routerKey, t]))
  const workerByKey = new Map(i.workers.map(w => [w.key, w]))

  const toSession = (s: SessionRow): SessionSnapshot => {
    const view: ReapView = {
      key: s.key, role: s.role, workspace: s.workspace, status: s.status, pinned: s.pinned, lastActiveAt: s.lastActiveAt,
      attached: i.attached(s.key), pendingPermissions: i.pendingPermissions(s.key), inFlight: i.inFlight(s.key),
    }
    const t = threadByRouter.get(s.key)
    const w = workerByKey.get(s.key)
    const threadIds = s.role === 'router' ? (t ? [t.id] : []) : (w?.threads ?? [])
    const out: SessionSnapshot = {
      key: s.key,
      role: s.role,
      label: s.role === 'router' ? (t?.label ?? s.key) : (w?.title ?? s.key),
      tmux: i.tmuxName(s.key),
      model: s.model,
      status: s.status,
      pinned: s.pinned,
      attached: view.attached > 0,
      lastActiveAt: s.lastActiveAt,
      pendingPermissions: view.pendingPermissions,
      queuedTasks: i.queuedTasks(s.key),
      threadPermalinks: threadIds.map(i.permalink),
    }
    if (w?.summary) out.summary = w.summary
    const at = closesAt(view, i.idleMinutes(s))
    if (at !== undefined) out.closesAt = at
    if (s.closedAt !== undefined && !isLive(s.status)) out.closedAt = s.closedAt
    if (s.closeReason && !isLive(s.status)) out.closeReason = s.closeReason
    if (i.restartPending(s.key)) out.restartPending = true
    const retry = i.retryAt(s.key)
    if (retry !== undefined) out.retryAt = retry
    const prov = isLive(s.status) ? i.sessionProvider?.(s.key) : undefined
    if (prov) out.provider = prov
    return out
  }

  const workspaces: WorkspaceSnapshot[] = i.workspaces.map(w => {
    const ws: WorkspaceSnapshot = {
      name: w.name,
      path: w.dir,
      channels: Object.entries(i.bindings).filter(([, n]) => n === w.name).map(([id]) => ({ id, name: i.channelName(id) })),
      repos: w.repos.map(r => ({ name: r.name, path: r.path })),
      sessions: i.sessions.filter(s => s.workspace === w.name).map(toSession)
        .sort((a, b) => Number(isLive(b.status)) - Number(isLive(a.status)) || b.lastActiveAt - a.lastActiveAt),
    }
    if (w.description) ws.description = w.description
    const prov = i.provider?.(w)
    if (prov) ws.provider = prov
    return ws
  })

  const live = (role: string) => i.sessions.filter(s => s.role === role && isLive(s.status)).length
  return {
    schema: 1,
    hub: i.hub,
    mattermost: i.mattermost,
    caps: { liveRouters: live('router'), maxLiveRouters: i.caps.maxLiveRouters, liveWorkers: live('worker'), maxLiveWorkers: i.caps.maxLiveWorkers },
    workspaces,
  }
}

/** Writes status.json when asked (debounced) and on a heartbeat. */
export class StatusWriter {
  private timer: ReturnType<typeof setTimeout> | null = null
  private beat: ReturnType<typeof setInterval> | null = null
  private heartbeatMs = 5000

  constructor(private file: string, private build: () => HubSnapshot) {}

  start(heartbeatMs = 5000): void {
    this.heartbeatMs = heartbeatMs
    this.write()
    this.rearm()
  }

  /** New timers for the heartbeat and a pending write (old ones can be stuck after the machine slept). */
  rearm(): void {
    if (this.beat) clearInterval(this.beat)
    this.beat = setInterval(() => this.write(), this.heartbeatMs)
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.write()
    }
  }

  changed(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.write()
    }, 250)
  }

  write(): void {
    try {
      writeJsonAtomic(this.file, this.build(), 0o600)
    } catch {}
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.beat) clearInterval(this.beat)
  }
}
