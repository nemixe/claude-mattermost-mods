// The Mattermost Hub pane, drawn from a fixture status.json on the terminal
// and desktop surfaces. Every hook the test registers stands for the engine
// (or the hub): the file read, the CLI run, the toasts and the status line.

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { HubSnapshot } from '../types'

const NOW = 1_800_000_000_000
const MIN = 60_000
const BUN = '/opt/bun/bin/bun'
const CLI = '/repo/bin/mmhub'
const STATUS_FILE = '/state/mmhub/status.json'
const PERMALINK = 'https://mm.example.com/acme/pl/abc123'

const PANE = {
  plugin: 'mattermost-hub',
  component: 'Pane',
  requestId: 'mm-hub',
  props: {
    title: 'Mattermost Hub',
    isFocused: false,
    bodyColumns: 64,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

function fixture(heartbeatAt = NOW - 1_000): HubSnapshot {
  return {
    schema: 1,
    hub: {
      pid: 4242,
      version: '0.1.0',
      startedAt: NOW - 180 * MIN,
      heartbeatAt,
      cliPath: CLI,
      bunBin: BUN,
      stateDir: '/state/mmhub',
    },
    mattermost: { connected: true, url: 'https://mm.example.com', bot: 'claude' },
    caps: { liveRouters: 1, maxLiveRouters: 6, liveWorkers: 1, maxLiveWorkers: 4 },
    workspaces: [
      {
        name: 'acme',
        path: '/work/acme',
        channels: [
          { id: 'c1', name: 'general' },
          { id: 'c2', name: 'eng' },
        ],
        repos: [
          { name: 'api', path: '/work/acme/api' },
          { name: 'web', path: '/work/acme/web' },
        ],
        sessions: [
          {
            key: 'r-abc',
            role: 'router',
            label: 'triage 1234',
            tmux: 'mmr-abc',
            model: 'sonnet',
            status: 'busy',
            pinned: false,
            attached: true,
            lastActiveAt: NOW - 5_000,
            pendingPermissions: 1,
            queuedTasks: 0,
            threadPermalinks: [PERMALINK],
          },
          {
            key: 'w-def',
            role: 'worker',
            label: 'fix login bug',
            summary: 'Patching the OAuth callback',
            tmux: 'mmw-def',
            model: 'opus',
            status: 'idle',
            pinned: false,
            attached: false,
            lastActiveAt: NOW - 12 * MIN,
            closesAt: NOW + 18 * MIN,
            pendingPermissions: 0,
            queuedTasks: 0,
            threadPermalinks: [],
          },
          {
            key: 'w-old',
            role: 'worker',
            label: 'old migration',
            tmux: 'mmw-old',
            model: 'opus',
            status: 'stopped',
            pinned: false,
            attached: false,
            lastActiveAt: NOW - 125 * MIN,
            closedAt: NOW - 120 * MIN,
            closeReason: 'idle',
            pendingPermissions: 0,
            queuedTasks: 0,
            threadPermalinks: [],
          },
          {
            key: 'w-gone',
            role: 'worker',
            label: 'flaky run',
            tmux: 'mmw-gone',
            model: 'opus',
            status: 'failed',
            pinned: true,
            attached: false,
            lastActiveAt: NOW - 6 * MIN,
            closedAt: NOW - 5 * MIN,
            closeReason: 'exited',
            pendingPermissions: 0,
            queuedTasks: 0,
            threadPermalinks: [],
          },
        ],
      },
    ],
  }
}

type World = {
  clock: MockClock
  /** status.json as the hub left it; undefined: no file. */
  file: string | undefined
  runs: string[][]
  toasts: string[]
  statuses: (string | undefined)[]
  copies: { text: string; surface?: string }[]
  opened: string[]
  viewWrites: number
  /** The session's project root, moved by /cd. */
  root: string
  /** Slash commands the session offers, and those it ran. */
  offered: string[]
  commands: string[]
  /** The person answers no when /cd asks about the folder. */
  declines: boolean
}

/** The engine and the hub beneath the plugin. */
function world(on: On, file: string | undefined): World {
  const w: World = {
    clock: mock.clock(on, { now: NOW }),
    file,
    runs: [],
    toasts: [],
    statuses: [],
    copies: [],
    opened: [],
    viewWrites: 0,
    root: '/home/tester',
    offered: ['clear', 'cd'],
    commands: [],
    declines: false,
  }
  mock.env(on, { HOME: '/home/tester', MMHUB_STATE_DIR: '/state/mmhub/' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'mm' } }))
  on('ui.open', (_, e) => {
    w.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('fs.read', (_, e) => {
    if (e.path !== STATUS_FILE || w.file === undefined) {
      throw new Error(`ENOENT: ${e.path}`)
    }
    return { value: w.file }
  })
  on('process.run', (_, e) => {
    w.runs.push([...e.argv])
    const op = e.argv[2] === 'session' ? `${e.argv[3]} ${e.argv[4]}` : 'started'
    return {
      value: {
        exitCode: 0,
        stdout: `${JSON.stringify({ ok: true, message: `${op} ok` })}\n`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('fs.stat', (_, e) => {
    if (!e.path.startsWith('/work/')) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }
  })
  on('session.root', () => ({ value: w.root }))
  on('command.list', () => ({
    value: w.offered.map(name => ({ name, description: '', source: 'builtin' as const })),
  }))
  on('command.run', { command: 'clear' }, () => {
    w.commands.push('/clear')
    return { text: '' }
  })
  on('command.run', { command: 'cd' }, (_, e) => {
    w.commands.push(`/cd ${e.args}`)
    if (!w.declines) w.root = e.args
    return { text: '' }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.copy', (_, e) => {
    w.copies.push({ text: e.text, surface: e.surface })
    return { value: { isCopied: true } }
  })
  on('state.set', { plugin: 'mattermost-hub', key: 'view' }, (_, e, next) => {
    w.viewWrites += 1
    return next(e)
  })
  return w
}

const start = ($: Engine) =>
  $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })

/** Select runs on after the press. */
async function settled(w: World): Promise<void> {
  await w.clock.advance(100)
}

for (const surface of ['terminal', 'desktop'] as const) {
  describe(surface, () => {
    test('workspaces and live sessions render; stopped ones start collapsed', async ($, on) => {
      const w = world(on, JSON.stringify(fixture()))
      await start($)
      const ui = await $.ui.mount({ ...PANE, surface })

      expect(await ui.find({ type: 'Text', text: /hub running/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'routers 1/6 · workers 1/4' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '▌acme' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '#general #eng · 2 repos' })).toBeDefined()

      // The router row: label, model, status and its marks.
      expect(await ui.find({ type: 'Text', text: 'triage 1234' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' sonnet' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'busy' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /🧭.*🔐1 👁\uFE0F/ })).toBeDefined()
      expect((await ui.find({ type: 'Link' }))?.props.href).toBe(PERMALINK)

      // The idle worker.
      expect(await ui.find({ type: 'Text', text: 'fix login bug' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'idle 12m · closes in 18m' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Patching the OAuth callback' })).toBeDefined()

      // Stopped and failed sessions sit in a collapsed group.
      expect((await ui.find({ key: 'stopped:acme' }))?.text).toBe('▸ 2 stopped')
      expect(await ui.find({ text: /stopped 2h ago/ })).toBeUndefined()
      expect(await ui.find({ key: 'wake:w-old' })).toBeUndefined()

      await ui.press({ key: 'stopped:acme' })
      expect((await ui.find({ key: 'stopped:acme' }))?.text).toBe('▾ 2 stopped')
      expect(await ui.find({ type: 'Text', text: 'stopped 2h ago (idle)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'failed 5m ago (exited)' })).toBeDefined()
      expect(await ui.find({ key: 'wake:w-old' })).toBeDefined()
      expect(await ui.find({ key: 'unpin:w-gone' })).toBeDefined()

      expect(w.statuses.at(-1)).toBe('mm ● 1🧭 1🛠\uFE0F · 🔐1')
      await ui.unmount()
    })

    test('Stop runs the hub CLI with the session key', async ($, on) => {
      const w = world(on, JSON.stringify(fixture()))
      await start($)
      const ui = await $.ui.mount({ ...PANE, surface })

      await ui.press({ key: 'stop:w-def' })
      expect(w.runs).toEqual([[BUN, CLI, 'session', 'stop', 'w-def', '--json']])
      expect(w.toasts.at(-1)).toBe('mm: stop w-def ok')

      await ui.press({ key: 'pin:r-abc' })
      expect(w.runs.at(-1)).toEqual([BUN, CLI, 'session', 'pin', 'r-abc', '--json'])

      await ui.press({ key: 'copy:r-abc' })
      expect(w.copies).toEqual([{ text: 'tmux -L mmhub attach -t mmr-abc', surface }])
      await ui.unmount()
    })

    test('Select replaces the open session with a new one in the workspace folder', async ($, on) => {
      const w = world(on, JSON.stringify(fixture()))
      await start($)
      const ui = await $.ui.mount({ ...PANE, surface })

      expect((await ui.find({ key: 'select:acme' }))?.props.label).toBe('Select')
      expect(await ui.find({ type: 'Text', text: '✓ selected' })).toBeUndefined()
      await ui.press({ key: 'select:acme' })
      await settled(w)
      // The old conversation ends first, so it isn't moved along; the second
      // /clear starts the session inside, with the folder's CLAUDE.md and hooks.
      expect(w.commands).toEqual(['/clear', '/cd /work/acme', '/clear'])
      expect(w.toasts).toEqual(['mm: new session in acme…'])
      expect(w.runs).toEqual([]) // nothing is started in the hub

      // Now here: marked, and the button starts over in place.
      expect(await ui.find({ type: 'Text', text: '✓ selected' })).toBeDefined()
      expect((await ui.find({ key: 'select:acme' }))?.props.label).toBe('New session')
      await ui.press({ key: 'select:acme' })
      await settled(w)
      expect(w.commands).toEqual(['/clear', '/cd /work/acme', '/clear', '/clear'])
      await ui.unmount()
    })

    test("a folder the person declines is not entered, and Select works again", async ($, on) => {
      const w = world(on, JSON.stringify(fixture()))
      w.declines = true
      await start($)
      const ui = await $.ui.mount({ ...PANE, surface })

      await ui.press({ key: 'select:acme' })
      await settled(w)
      expect(w.commands).toEqual(['/clear', '/cd /work/acme'])
      expect(await ui.find({ type: 'Text', text: '✓ selected' })).toBeUndefined()

      w.declines = false
      await ui.press({ key: 'select:acme' })
      await settled(w)
      expect(await ui.find({ type: 'Text', text: '✓ selected' })).toBeDefined()
      await ui.unmount()
    })

    test('without /cd (the desktop app) Select leaves the session alone and copies the command', async ($, on) => {
      const snap = fixture()
      snap.workspaces[0]!.path = "/work/it's acme"
      const w = world(on, JSON.stringify(snap))
      w.offered = ['clear']
      await start($)
      const ui = await $.ui.mount({ ...PANE, surface })

      await ui.press({ key: 'select:acme' })
      await settled(w)
      expect(w.commands).toEqual([])
      expect(w.copies).toEqual([{ text: "cd '/work/it'\\''s acme' && claude", surface }])
      expect(w.toasts.at(-1)).toMatch(/can't move a session to another folder\. Copied: cd /)
      await ui.unmount()
    })

    test("a personal workspace is headed by its person's name, then its own", async ($, on) => {
      const snap = fixture()
      const ws = snap.workspaces[0]!
      ws.name = 'personal-u1abc'
      ws.label = '@alice'
      const w = world(on, JSON.stringify(snap))
      await start($)
      const ui = await $.ui.mount({ ...PANE, surface })

      expect((await ui.find({ type: 'Text', text: /^▌@alice$/ }))?.props.color).toBe('claude')
      expect((await ui.find({ type: 'Text', text: /^ personal-u1abc$/ }))?.props.dimColor).toBe(true)
      // The buttons still go by the workspace's name; the toast says whose it is.
      await ui.press({ key: 'select:personal-u1abc' })
      await settled(w)
      expect(w.toasts.at(-1)).toBe('mm: new session in @alice…')
      await ui.unmount()
    })

    test("a workspace the hub can't read says why, instead of repos and provider it doesn't know", async ($, on) => {
      const snap = fixture()
      const ws = snap.workspaces[0]!
      ws.unreadable = "can't read /Volumes/ssd/acme/workspace.json (EPERM)"
      ws.repos = []
      const w = world(on, JSON.stringify(snap))
      await start($)
      const ui = await $.ui.mount({ ...PANE, surface })
      const warning = await ui.find({ type: 'Text', text: /^⚠ the hub can't read \/Volumes\/ssd\/acme\/workspace\.json \(EPERM\)$/ })
      expect(warning?.props.color).toBe('error')
      expect(await ui.find({ type: 'Text', text: /0 repos/ })).toBeUndefined()
      await ui.unmount()
      expect(w.runs).toEqual([])
    })

    test('Restart waits for the turn; a pending one offers Restart now', async ($, on) => {
      const snap = fixture()
      const router = snap.workspaces[0]!.sessions[0]!
      router.restartPending = true
      router.retryAt = NOW + 4 * MIN
      const w = world(on, JSON.stringify(snap))
      await start($)
      const ui = await $.ui.mount({ ...PANE, surface })

      expect(await ui.find({ type: 'Text', text: 'busy · retry in 4m · restart after this turn' })).toBeDefined()
      expect(await ui.find({ key: 'restart:r-abc' })).toBeUndefined()
      await ui.press({ key: 'restart-now:r-abc' })
      expect(w.runs.at(-1)).toEqual([BUN, CLI, 'session', 'restart', 'r-abc', '--now', '--json'])

      await ui.press({ key: 'restart:w-def' })
      expect(w.runs.at(-1)).toEqual([BUN, CLI, 'session', 'restart', 'w-def', '--json'])
      expect(w.toasts.at(-1)).toBe('mm: restart w-def ok')
      // Stopped sessions have nothing to restart (Wake starts them).
      await ui.press({ key: 'stopped:acme' })
      expect(await ui.find({ key: 'restart:w-old' })).toBeUndefined()
      await ui.unmount()
    })

    test('a workspace on a fallback provider says so, and why the others rest', async ($, on) => {
      const snap = fixture()
      const ws = snap.workspaces[0]!
      ws.provider = {
        active: 'backup',
        kind: 'api-key',
        fallback: true,
        healthy: true,
        chain: [
          { name: 'acme', kind: 'login', coolingUntil: NOW + 42 * MIN, reason: 'auth: authentication_failed — OAuth token revoked' },
          { name: 'backup', kind: 'api-key' },
          { name: 'bk', kind: 'bedrock', unusable: 'Claude Code has no channels on third-party providers' },
        ],
      }
      // The router still runs on the old provider until its turn ends.
      ws.sessions[0]!.provider = 'acme'
      ws.sessions[0]!.restartPending = true
      ws.sessions[1]!.provider = 'backup'
      world(on, JSON.stringify(snap))
      await start($)
      const ui = await $.ui.mount({ ...PANE, surface })

      // (A string matches any Text that shows it, the whole line too: anchor to get the colored part.)
      const head = await ui.find({ type: 'Text', text: /^provider backup · fallback$/ })
      expect(head?.props.color).toBe('warning')
      expect(
        await ui.find({
          type: 'Text',
          text: ' · acme sign-in, back in 42m · bk: Claude Code has no channels on third-party providers',
        }),
      ).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'busy · restart after this turn · on acme' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'idle 12m · closes in 18m' })).toBeDefined()
      await ui.unmount()
    })

    test('no provider line for the hub\'s own login alone; an error tone when none is usable', async ($, on) => {
      const snap = fixture()
      snap.workspaces[0]!.provider = {
        active: 'default',
        kind: 'default',
        fallback: false,
        healthy: true,
        chain: [{ name: 'default', kind: 'default' }],
      }
      const w = world(on, JSON.stringify(snap))
      await start($)
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: /^provider / })).toBeUndefined()

      snap.workspaces[0]!.provider = {
        active: 'acme',
        kind: 'login',
        fallback: false,
        healthy: false,
        chain: [{ name: 'acme', kind: 'login', unusable: 'not signed in' }],
      }
      snap.hub.heartbeatAt = NOW + 1_000
      w.file = JSON.stringify(snap)
      await w.clock.advance(2_000)
      const head = await ui.find({ type: 'Text', text: /^provider acme · no usable provider$/ })
      expect(head?.props.color).toBe('error')
      expect(await ui.find({ type: 'Text', text: ' · acme: not signed in' })).toBeDefined()
      await ui.unmount()
    })

    test('a stale heartbeat shows the hub down with Start hub', async ($, on) => {
      const w = world(on, JSON.stringify(fixture(NOW - 20_000)))
      await start($)
      const ui = await $.ui.mount({ ...PANE, surface })

      expect(await ui.find({ type: 'Text', text: /hub down/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'no heartbeat for 20s' })).toBeDefined()
      expect(await ui.find({ text: /acme/ })).toBeUndefined()
      expect(w.statuses.at(-1)).toBeUndefined()

      await ui.press({ key: 'start-hub' })
      expect(w.runs).toEqual([[BUN, CLI, 'start', '--json']])
      await ui.unmount()
    })
  })
}

test('with no status.json, Start hub falls back to bun and the plugin bin', async ($, on) => {
  const w = world(on, undefined)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /hub down/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'no status.json' })).toBeDefined()

  await ui.press({ key: 'start-hub' })
  const [argv] = w.runs
  expect(argv?.[0]).toBe('bun')
  expect(argv?.[1]).toMatch(/\/bin\/mmhub$/)
  expect(argv?.slice(2)).toEqual(['start', '--json'])
  await ui.unmount()
})

test('a malformed session key never reaches the CLI', async ($, on) => {
  const snap = fixture()
  const live = snap.workspaces[0]?.sessions[1]
  if (live) live.key = 'w-def;rm'
  const w = world(on, JSON.stringify(snap))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'stop:w-def;rm' })
  expect(w.runs).toEqual([])
  expect(w.toasts.at(-1)).toMatch(/refused a malformed session key/)
  await ui.unmount()
})

test('Select never hands a malformed or missing folder to a command', async ($, on) => {
  const snap = fixture()
  snap.workspaces[0]!.path = '/work/acme\n/exit'
  snap.workspaces.push({ ...snap.workspaces[0]!, name: 'gone', path: '/gone', sessions: [] })
  const w = world(on, JSON.stringify(snap))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'select:acme' })
  await settled(w)
  expect(w.toasts.at(-1)).toBe('mm: refused a malformed workspace folder (acme)')
  await ui.press({ key: 'select:gone' })
  await settled(w)
  expect(w.toasts.at(-1)).toBe('mm: no folder /gone on this machine')
  expect(w.commands).toEqual([])
  await ui.unmount()
})

test('the poll writes the view only when the snapshot changed', async ($, on) => {
  const w = world(on, JSON.stringify(fixture()))
  const { clock } = w
  await start($)
  expect(w.viewWrites).toBe(1)

  await clock.advance(2_000)
  await clock.advance(2_000)
  expect(w.viewWrites).toBe(1)

  w.file = JSON.stringify(fixture(NOW + 4_000))
  await clock.advance(2_000)
  expect(w.viewWrites).toBe(2)
  expect(w.statuses).toEqual(['mm ● 1🧭 1🛠\uFE0F · 🔐1'])

  // No heartbeat for 16 s: the hub is down and the status line is cleared.
  await clock.advance(16_000)
  expect(w.viewWrites).toBe(3)
  expect(w.statuses.at(-1)).toBeUndefined()
})

test('/mm opens the pane', async ($, on) => {
  const w = world(on, JSON.stringify(fixture()))
  await start($)
  const ran = await $.command.run({
    command: 'mm',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  expect(w.opened).toEqual(['mm-hub'])
  expect(ran.text).toBe('Mattermost Hub pane opened.')
})
