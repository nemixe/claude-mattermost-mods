// The Mattermost Hub pane: reading status.json, drawing it, and the row
// actions that call the hub's CLI. register.tsx wires these to events.

import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  RenderInput,
  RenderSurface,
  RenderViewport,
} from 'claude-code'

import type {
  HubSnapshot,
  HubView,
  SessionSnapshot,
  WorkspaceProvider,
  WorkspaceSnapshot,
} from '../types'

export const PANE_ID = 'mm-hub'
export const PANE_TITLE = 'Mattermost Hub'

/** The hub counts as down once its heartbeat is older than this. */
export const STALE_MS = 15_000
/** Session keys the CLI accepts; anything else never reaches argv. */
export const KEY_RE = /^(r|w)-[a-z0-9]+$/
/** How many stopped sessions an expanded group lists before "+N more". */
const STOPPED_SHOWN = 20

// Bump the shape when HubView changes: a reload then declines what the old
// code stored instead of drawing it with the new code.
export const view = atom(
  { plugin: 'mattermost-hub', key: 'view' } as const,
  { state: 'unknown' },
  { shape: 'view-1' },
)
export const autoOpened = atom(
  { plugin: 'mattermost-hub', key: 'autoOpened' } as const,
  false,
)
/** A family keyed by workspace name: is its "N stopped" group expanded? */
const stoppedOpen = { plugin: 'mattermost-hub', key: 'stoppedOpen' } as const

export type SessionOp = 'stop' | 'wake' | 'restart' | 'pin' | 'unpin'

// 🛠 and 👁 default to text presentation; the selector asks for the emoji
// (two cells) so a row's width is measured as the terminal draws it.
const WORKER_ICON = '🛠\uFE0F'
const ATTACHED_ICON = '👁\uFE0F'

// ---------------------------------------------------------------------------
// Reading the snapshot

/** Where the hub writes status.json, per the hub's own paths.ts. */
export async function statusPath($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const expand = (p: string) =>
    p === '~' ? home : p.startsWith('~/') ? `${home}/${p.slice(2)}` : p
  const stateDir = await $.env.get('MMHUB_STATE_DIR')
  if (stateDir) return `${trimSlash(expand(stateDir))}/status.json`
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const base = configDir ? expand(configDir) : `${home}/.claude`
  return `${trimSlash(base)}/channels/mattermost-hub/status.json`
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

/** Turns the file's text (undefined: missing) into what the pane draws. */
export function toView(text: string | undefined, now: number): HubView {
  if (text === undefined) return { state: 'down', reason: 'missing' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { state: 'down', reason: 'unparsable' }
  }
  if (!isRecord(raw)) return { state: 'down', reason: 'unparsable' }
  if (raw.schema !== 1) return { state: 'down', reason: 'schema' }
  if (!looksLikeSnapshot(raw)) return { state: 'down', reason: 'unparsable' }
  const snapshot = raw as HubSnapshot
  if (now - snapshot.hub.heartbeatAt > STALE_MS) {
    return { state: 'down', reason: 'stale', snapshot }
  }
  return { state: 'up', snapshot }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function looksLikeSnapshot(raw: Record<string, unknown>): boolean {
  const { hub, mattermost, caps, workspaces } = raw
  return (
    isRecord(hub) &&
    typeof hub.heartbeatAt === 'number' &&
    isRecord(mattermost) &&
    isRecord(caps) &&
    Array.isArray(workspaces) &&
    workspaces.every(
      w =>
        isRecord(w) &&
        typeof w.name === 'string' &&
        Array.isArray(w.sessions) &&
        w.sessions.every(s => isRecord(s) && typeof s.key === 'string'),
    )
  )
}

// ---------------------------------------------------------------------------
// Words

const isLive = (s: SessionSnapshot) => s.status !== 'stopped' && s.status !== 'failed'

/** `45s`, `12m`, `3h`, `2d`. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/**
 * `busy`, `idle 12m · closes in 18m`, `starting`, … for a live session.
 * `active`: the workspace's provider; a session still on another one says so.
 */
export function liveStatusText(s: SessionSnapshot, now: number, active?: string): string {
  const parts: string[] = []
  if (s.status === 'idle') {
    parts.push(`idle ${span(now - s.lastActiveAt)}`)
    if (s.closesAt !== undefined && !s.pinned) {
      parts.push(
        s.closesAt > now ? `closes in ${span(s.closesAt - now)}` : 'closing soon',
      )
    }
  } else {
    parts.push(s.status)
  }
  if (s.queuedTasks > 0) parts.push(`${s.queuedTasks} queued`)
  if (s.retryAt !== undefined) parts.push(`retry in ${span(s.retryAt - now)}`)
  if (s.restartPending) parts.push('restart after this turn')
  if (s.provider && active && s.provider !== active) parts.push(`on ${s.provider}`)
  return parts.join(' · ')
}

const FAULT_WORDS: Record<string, string> = {
  auth: 'sign-in',
  quota: 'quota',
  rate_limit: 'rate limit',
  errors: 'API errors',
  channels: 'no channels',
}

/**
 * The workspace's provider line, when there is something to say: which one
 * runs (`provider backup · fallback`) and why the others don't
 * (`acme sign-in, back in 42m`). Nothing for a workspace on the hub's own
 * login with no chain.
 */
export function providerText(
  p: WorkspaceProvider | undefined,
  now: number,
): { head: string; rest: string; tone: 'error' | 'warning' | 'subtle' } | undefined {
  if (!p) return undefined
  if (p.chain.length <= 1 && p.active === 'default' && p.healthy) return undefined
  const state = !p.healthy
    ? p.chain.every(c => c.unusable)
      ? 'no usable provider'
      : 'all resting'
    : p.fallback
      ? 'fallback'
      : ''
  const rest = p.chain
    .filter(c => (c.name !== p.active || !p.healthy) && (c.unusable || c.coolingUntil !== undefined))
    .map(c => {
      if (c.unusable) return `${c.name}: ${c.unusable}`
      const fault = c.reason?.split(':')[0] ?? ''
      const words = FAULT_WORDS[fault] ?? fault
      return `${c.name} ${words ? `${words}, ` : ''}back in ${span((c.coolingUntil ?? now) - now)}`
    })
    .join(' · ')
  return {
    head: `provider ${p.active}${state ? ` · ${state}` : ''}`,
    rest,
    tone: !p.healthy ? 'error' : p.fallback ? 'warning' : 'subtle',
  }
}

/** `stopped 2h ago (idle)` / `failed 5m ago (exited)`. */
export function stoppedStatusText(s: SessionSnapshot, now: number): string {
  const when = s.closedAt ?? s.lastActiveAt
  const why = s.closeReason ? ` (${s.closeReason})` : ''
  return `${s.status} ${span(now - when)} ago${why}`
}

/** The status line: `mm ● 2🧭 1🛠 · 🔐1`, or undefined while the hub is down. */
export function statusLine(v: HubView): string | undefined {
  if (v.state !== 'up') return undefined
  const { caps, mattermost, workspaces } = v.snapshot
  const pending = workspaces
    .flatMap(w => w.sessions)
    .reduce((n, s) => n + (s.pendingPermissions ?? 0), 0)
  let line = `mm ● ${caps.liveRouters}🧭 ${caps.liveWorkers}${WORKER_ICON}`
  if (pending > 0) line += ` · 🔐${pending}`
  if (!mattermost.connected) line += ' · offline'
  return line
}

const DOWN_WORDS: Record<string, string> = {
  missing: 'no status.json',
  unparsable: 'status.json unreadable',
  schema: 'unknown status.json schema',
}

// ---------------------------------------------------------------------------
// Actions

type CliAnswer = { ok: boolean; message: string }

/** Runs the hub CLI and reads its one JSON line; never throws. */
async function runCli(
  $: EngineInterface,
  argv: string[],
  timeoutMs: number,
): Promise<CliAnswer> {
  try {
    const ran = await $.process.run(argv, { timeoutMs })
    const line = ran.stdout.trim().split('\n').filter(Boolean).pop()
    if (line !== undefined) {
      try {
        const parsed: unknown = JSON.parse(line)
        if (isRecord(parsed) && typeof parsed.message === 'string') {
          return { ok: parsed.ok === true && ran.exitCode === 0, message: parsed.message }
        }
      } catch {
        // Not JSON: fall through to the raw output.
      }
    }
    const said = (ran.stderr.trim() || ran.stdout.trim()).split('\n').pop()
    return { ok: ran.exitCode === 0, message: said || `exited ${ran.exitCode}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function toastAnswer($: EngineInterface, answer: CliAnswer): void {
  $.ui.toast(answer.ok ? `mm: ${answer.message}` : `mm failed: ${answer.message}`)
}

/**
 * `mmhub session <op> <key> --json`, the key checked before it is passed.
 * `now` (restart only): restart right away instead of after the current turn.
 */
export async function sessionOp(
  $: EngineInterface,
  snapshot: HubSnapshot,
  op: SessionOp,
  key: string,
  now = false,
): Promise<boolean> {
  if (!KEY_RE.test(key)) {
    $.ui.toast(`mm: refused a malformed session key (${key.slice(0, 40)})`)
    return false
  }
  const { bunBin, cliPath } = snapshot.hub
  const argv = [bunBin, cliPath, 'session', op, key, ...(op === 'restart' && now ? ['--now'] : []), '--json']
  const answer = await runCli($, argv, 90_000)
  toastAnswer($, answer)
  return answer.ok
}

let isSelecting = false

/**
 * Replaces the open Claude Code session with a new one in the workspace folder:
 * `/clear` (the old conversation stays in its own folder's `/resume`, and isn't
 * moved along), `/cd`, and `/clear` again inside. They wait for the running turn,
 * and `/cd` asks before it enters a folder for the first time, so this can
 * outlast a press's 10 s: call it without awaiting it.
 *
 * Only the terminal has `/cd`. Elsewhere the session is left alone and the command
 * that starts one there goes on the clipboard.
 */
export async function selectWorkspace(
  $: EngineInterface,
  w: WorkspaceSnapshot,
  surface: RenderSurface,
): Promise<void> {
  if (isSelecting) {
    $.ui.toast('mm: still switching sessions')
    return
  }
  isSelecting = true
  try {
    // A path that isn't one plain absolute line is never handed to a command.
    if (!/^\/[^\x00-\x1f\x7f]*$/.test(w.path)) {
      $.ui.toast(`mm: refused a malformed workspace folder (${w.name.slice(0, 40)})`)
      return
    }
    const stat = await $.fs.stat(w.path, { resolve: true }).catch(() => undefined)
    if (stat?.kind !== 'dir') {
      $.ui.toast(`mm: no folder ${w.path} on this machine`)
      return
    }
    const offered = (await $.command.list()).map(c => c.name)
    if (!offered.includes('clear') || !offered.includes('cd')) {
      const text = `cd '${w.path.replace(/'/g, `'\\''`)}' && claude`
      const copied = await $.ui.copy({ text, surface })
      $.ui.toast(`mm: this app can't move a session to another folder. ${copied.isCopied ? 'Copied' : 'Run'}: ${text}`)
      return
    }
    $.ui.toast(`mm: new session in ${w.label ?? w.name}…`)
    await $.command.run({ command: 'clear' })
    const isThere = (root: string) => root === w.path || root === stat.realPath
    if (!isThere(await $.session.root())) {
      await $.command.run({ command: 'cd', args: w.path })
      // Started over once more inside: the session the move carried along has
      // neither the folder's CLAUDE.md nor its SessionStart hooks' context.
      if (isThere(await $.session.root())) await $.command.run({ command: 'clear' })
    }
    $.ui.invalidate('ui.render')
  } catch (error) {
    $.ui.toast(`mm failed: ${error instanceof Error ? error.message : error}`)
  } finally {
    isSelecting = false
  }
}

/** `mmhub start --json`, from the last snapshot's paths when there is one. */
export async function startHub(
  $: EngineInterface,
  snapshot: HubSnapshot | undefined,
): Promise<boolean> {
  const bun = snapshot?.hub.bunBin ?? 'bun'
  const cli = snapshot?.hub.cliPath ?? `${$.plugin.root}/bin/mmhub`
  $.ui.toast('mm: starting the hub…')
  const answer = await runCli($, [bun, cli, 'start', '--json'], 60_000)
  toastAnswer($, answer)
  return answer.ok
}

export function attachCommand(s: SessionSnapshot): string {
  return `tmux -L mmhub attach -t ${s.tmux}`
}

async function copyAttach(
  $: EngineInterface,
  s: SessionSnapshot,
  surface: RenderSurface,
): Promise<void> {
  const text = attachCommand(s)
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(copied.isCopied ? `Copied: ${text}` : `Copy failed (${copied.reason}): ${text}`)
}

// ---------------------------------------------------------------------------
// Polling
//
// Module state starts over on every reload; what a drawing reads lives in
// $.state (the atoms above). `$` is never kept: each caller hands its own.

let path: string | undefined
let isPolling = false
let lastStatus: string | undefined | null = null // null: not set since load
let wantsAutoOpen = false
let isAutoOpenSettled = false

/**
 * Reads status.json, writes `view` only when it changed, keeps the status
 * line in step, and opens the pane unasked once a surface said it docks.
 */
export async function poll($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    path ??= await statusPath($)
    let text: string | undefined
    try {
      text = await $.fs.read(path)
    } catch {
      text = undefined
    }
    const next = toView(text, await $.clock.now())
    const before = await read($, view)
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      await update($, view, () => next)
    }
    const line = statusLine(next)
    if (line !== lastStatus) {
      lastStatus = line
      $.ui.status(line)
    }
    if (wantsAutoOpen) {
      wantsAutoOpen = false
      await autoOpen($)
    }
  } catch (error) {
    $.ui.log(`mattermost-hub: poll failed: ${error instanceof Error ? error.message : error}`)
  } finally {
    isPolling = false
  }
}

/** A surface's word on whether a pane would dock (be a sidebar) there. */
export function noteViewport(viewport: RenderViewport | undefined): void {
  if (!isAutoOpenSettled && viewport?.isFullscreen === true) wantsAutoOpen = true
}

// Opened unasked once per session (the atom outlives a reload).
async function autoOpen($: EngineInterface): Promise<void> {
  isAutoOpenSettled = true
  if (await read($, autoOpened)) return
  await update($, autoOpened, () => true)
  if ((await $.ui.panes()).some(pane => pane.id === PANE_ID)) return
  await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
}

// ---------------------------------------------------------------------------
// Drawing

export async function renderPane($: EngineInterface, e: RenderInput<'Pane'>) {
  const { Box, Text, Button, Link } = $.ui.resolve(e)
  const v = await read($, view)
  const now = await $.clock.now()
  const cols = Math.max(1, e.props.bodyColumns)

  if (v.state === 'unknown') {
    return (
      <Box flexDirection="column" width={cols}>
        <Text dimColor>Reading the hub's status…</Text>
      </Box>
    )
  }

  if (v.state === 'down') {
    const age =
      v.reason === 'stale' && v.snapshot
        ? `no heartbeat for ${span(now - v.snapshot.hub.heartbeatAt)}`
        : (DOWN_WORDS[v.reason] ?? v.reason)
    return (
      <Box flexDirection="column" width={cols}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text color="error" bold>
            ○ hub down
          </Text>
          <Text dimColor>{age}</Text>
        </Box>
        <Box marginTop={1}>
          <Button
            key="start-hub"
            label="Start hub"
            variant="primary"
            onPress={async () => {
              await startHub($, v.snapshot)
              await poll($)
            }}
          />
        </Box>
      </Box>
    )
  }

  const snap = v.snapshot
  const { mattermost: mm, caps } = snap
  const root = await $.session.root()

  const header = (
    <Box flexDirection="column">
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text color="success" bold>
          ● hub running
        </Text>
        <Text dimColor>{`v${snap.hub.version} · up ${span(now - snap.hub.startedAt)}`}</Text>
      </Box>
      <Text wrap="truncate-end">
        {mm.connected ? (
          <Text color="success">● Mattermost</Text>
        ) : (
          <Text color="warning">○ Mattermost disconnected</Text>
        )}
        {mm.connected && mm.bot ? <Text dimColor>{` as @${mm.bot}`}</Text> : null}
      </Text>
      <Text>
        {`routers ${caps.liveRouters}/${caps.maxLiveRouters} · workers ${caps.liveWorkers}/${caps.maxLiveWorkers}`}
      </Text>
    </Box>
  )

  const sessionRow = (s: SessionSnapshot, isStopped: boolean, active?: string) => {
    const icon = s.role === 'router' ? '🧭' : WORKER_ICON
    const marks = [
      s.pendingPermissions > 0 ? `🔐${s.pendingPermissions}` : '',
      s.pinned ? '📌' : '',
      s.attached ? ATTACHED_ICON : '',
    ]
      .filter(Boolean)
      .join(' ')
    const status = isStopped ? stoppedStatusText(s, now) : liveStatusText(s, now, active)
    const statusColor =
      s.status === 'failed'
        ? 'error'
        : s.status === 'busy'
          ? 'warning'
          : s.status === 'idle' || isStopped
            ? 'subtle'
            : 'suggestion'
    const thread = s.threadPermalinks?.[0]
    const wakes = isStopped
    return (
      <Box flexDirection="column" marginTop={isStopped ? 0 : 1}>
        <Text wrap="truncate-end">
          {`${icon} `}
          <Text bold={!isStopped}>{s.label}</Text>
          <Text dimColor>{` ${s.model}`}</Text>
          {marks ? ` ${marks}` : null}
        </Text>
        <Box paddingLeft={3} flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text color={statusColor}>{status}</Text>
        </Box>
        {s.summary && !isStopped ? (
          <Box paddingLeft={3}>
            <Text dimColor wrap="truncate-end">
              {s.summary}
            </Text>
          </Box>
        ) : null}
        <Box paddingLeft={3} flexDirection="row" flexWrap="wrap" columnGap={1}>
          {wakes ? (
            <Button
              key={`wake:${s.key}`}
              label="Wake"
              onPress={async () => {
                await sessionOp($, snap, 'wake', s.key)
                await poll($)
              }}
            />
          ) : (
            <Button
              key={`stop:${s.key}`}
              label="Stop"
              onPress={async () => {
                await sessionOp($, snap, 'stop', s.key)
                await poll($)
              }}
            />
          )}
          <Button
            key={`${s.pinned ? 'unpin' : 'pin'}:${s.key}`}
            label={s.pinned ? 'Unpin' : 'Pin'}
            dimColor
            onPress={async () => {
              await sessionOp($, snap, s.pinned ? 'unpin' : 'pin', s.key)
              await poll($)
            }}
          />
          {isStopped || s.status === 'starting' || s.status === 'resuming' || s.status === 'closing' ? null : (
            <Button
              key={`${s.restartPending ? 'restart-now' : 'restart'}:${s.key}`}
              label={s.restartPending ? 'Restart now' : 'Restart'}
              dimColor
              onPress={async () => {
                await sessionOp($, snap, 'restart', s.key, !!s.restartPending)
                await poll($)
              }}
            />
          )}
          {isStopped ? null : (
            <Button
              key={`copy:${s.key}`}
              label="Copy attach"
              dimColor
              onPress={press => copyAttach($, s, press.surface)}
            />
          )}
          {thread ? <Link href={thread} label="Thread" /> : null}
        </Box>
      </Box>
    )
  }

  const workspaceBlock = async (w: WorkspaceSnapshot) => {
    const sessions = w.sessions ?? []
    const live = sessions
      .filter(isLive)
      .sort(
        (a, b) =>
          (a.role === b.role ? 0 : a.role === 'router' ? -1 : 1) ||
          b.lastActiveAt - a.lastActiveAt,
      )
    const stopped = sessions
      .filter(s => !isLive(s))
      .sort((a, b) => (b.closedAt ?? b.lastActiveAt) - (a.closedAt ?? a.lastActiveAt))
    const isOpen = (await read($, { ...stoppedOpen, id: w.name })) ?? false
    const channels = (w.channels ?? []).map(c => `#${c.name}`).join(' ')
    const repos = (w.repos ?? []).length
    const shown = stopped.slice(0, STOPPED_SHOWN)
    const provider = providerText(w.provider, now)

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text wrap="truncate-end">
          <Text bold color="claude">
            {`▌${w.label ?? w.name}`}
          </Text>
          {w.label ? <Text dimColor>{` ${w.name}`}</Text> : null}
        </Text>
        <Text dimColor wrap="truncate-end">
          {`${channels || 'no channels'} · ${repos} ${repos === 1 ? 'repo' : 'repos'}`}
        </Text>
        {provider ? (
          <Text wrap="truncate-end">
            <Text color={provider.tone}>{provider.head}</Text>
            {provider.rest ? <Text dimColor>{` · ${provider.rest}`}</Text> : null}
          </Text>
        ) : null}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Button
            key={`select:${w.name}`}
            label={w.path === root ? 'New session' : 'Select'}
            onPress={press => {
              void selectWorkspace($, w, press.surface)
            }}
          />
          {w.path === root ? <Text color="success">✓ selected</Text> : null}
        </Box>
        {live.length === 0 ? <Text dimColor>No live sessions.</Text> : null}
        {live.map(s => sessionRow(s, false, w.provider?.active))}
        {stopped.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            <Button
              key={`stopped:${w.name}`}
              plain
              dimColor
              onPress={() => update($, { ...stoppedOpen, id: w.name }, open => !open)}
            >
              {`${isOpen ? '▾' : '▸'} ${stopped.length} stopped`}
            </Button>
            {isOpen ? shown.map(s => sessionRow(s, true)) : null}
            {isOpen && stopped.length > shown.length ? (
              <Text dimColor>{`+${stopped.length - shown.length} more`}</Text>
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  }

  const blocks = await Promise.all(snap.workspaces.map(workspaceBlock))

  return (
    <Box flexDirection="column" width={cols}>
      {header}
      {snap.workspaces.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No workspaces bound yet.</Text>
        </Box>
      ) : null}
      {blocks}
    </Box>
  )
}
