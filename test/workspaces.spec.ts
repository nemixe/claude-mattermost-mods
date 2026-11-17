import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_CONFIG, isTrigger, loadConfig, type HubConfig } from '../src/hub/config'
import { DEFAULT_ROUTER_PERSONA, routerContext, routerPersona, routerPrompt, workerContext, workerPrompt } from '../src/hub/prompts'
import { buildSnapshot } from '../src/hub/status'
import type { SessionRow } from '../src/hub/store'
import {
  addRepo, bindChannel, channelsOf, createWorkspace, effective, ensureTemplate, externalRepoPaths, listWorkspaces, loadBindings, loadWorkspace,
  prepareWorktree, removeWorktrees, setWorkspaceTrigger, TEMPLATE_DIR, unbindChannel, validName,
} from '../src/hub/workspaces'

function setup(): { cfg: HubConfig; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'mmhub-ws-'))
  return { root, cfg: { ...DEFAULT_CONFIG, workspacesDir: join(root, 'workspaces') } }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  const out = await new Response(p.stdout).text()
  await p.exited
  return out.trim()
}

async function repo(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true })
  await git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'hi\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-qm', 'init')
  return dir
}

describe('workspaces', () => {
  test('create from templates, idempotent, list', () => {
    const { cfg } = setup()
    const w = createWorkspace(cfg, 'demo', 'Demo things')
    for (const f of ['CLAUDE.md', 'knowledge/README.md', '.claude/settings.json', 'workspace.json', '.gitignore']) expect(existsSync(join(w.dir, f))).toBe(true)
    expect(readFileSync(join(w.dir, 'CLAUDE.md'), 'utf8')).toContain('Demo things')
    writeFileSync(join(w.dir, 'CLAUDE.md'), 'custom')
    createWorkspace(cfg, 'demo')
    expect(readFileSync(join(w.dir, 'CLAUDE.md'), 'utf8')).toBe('custom')
    expect(listWorkspaces(cfg).map(x => x.name)).toEqual(['demo'])
    expect(validName('../x')).toBe(false)
    expect(validName('a..b')).toBe(false)
    expect(loadWorkspace(cfg, 'nope')).toBeUndefined()
  })

  test('repos: local path, duplicates refused, external paths, effective settings', async () => {
    const { cfg, root } = setup()
    createWorkspace(cfg, 'demo')
    const r = await repo(join(root, 'app'))
    expect((await addRepo(cfg, 'demo', r)).name).toBe('app')
    await expect(addRepo(cfg, 'demo', r)).rejects.toThrow('already has')
    const w = loadWorkspace(cfg, 'demo')!
    expect(externalRepoPaths(w)).toEqual([r])
    expect(effective(cfg, { ...w, idleMinutes: { worker: 5 } }).idleMinutes).toEqual({ router: 30, worker: 5 })
  })

  test('worktree per worker on mm/<key>, reused, removed when clean, kept when dirty', async () => {
    const { cfg, root } = setup()
    createWorkspace(cfg, 'demo')
    const r = await repo(join(root, 'app'))
    await addRepo(cfg, 'demo', r)
    mkdirSync(join(root, 'notes'))
    await addRepo(cfg, 'demo', join(root, 'notes'))
    const w = loadWorkspace(cfg, 'demo')!
    const a = await prepareWorktree(cfg, w, 'w-aaa', 'app')
    expect(a).toEqual({ path: join(w.dir, '.worktrees', 'w-aaa', 'app'), branch: 'mm/w-aaa' })
    expect(await git(a.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('mm/w-aaa')
    expect(await prepareWorktree(cfg, w, 'w-aaa', 'app')).toEqual(a)
    const b = await prepareWorktree(cfg, w, 'w-bbb', 'app')
    writeFileSync(join(b.path, 'dirty.txt'), 'x')
    expect(await prepareWorktree(cfg, w, 'w-aaa', 'notes')).toEqual({ path: join(root, 'notes'), shared: true })
    await expect(prepareWorktree(cfg, w, 'w-aaa', 'missing')).rejects.toThrow('no repo named missing')
    expect(await removeWorktrees(cfg, w, { app: a })).toEqual([])
    expect(existsSync(a.path)).toBe(false)
    expect(await removeWorktrees(cfg, w, { app: b })).toEqual([b.path])
    // The original checkout is untouched.
    expect(await git(r, 'status', '--porcelain')).toBe('')
  })

  test('bindings: many channels → one workspace', () => {
    const { root } = setup()
    const f = join(root, 'bindings.json')
    bindChannel(f, 'C1', 'demo')
    bindChannel(f, 'C2', 'demo')
    bindChannel(f, 'C3', 'other')
    expect(channelsOf(loadBindings(f), 'demo').sort()).toEqual(['C1', 'C2'])
    expect(unbindChannel(f, 'C2')).toBe(true)
    expect(unbindChannel(f, 'C2')).toBe(false)
  })
})

describe('trigger setting', () => {
  test('mention-only is kept in workspace.json and config.json; anything unknown falls back', () => {
    const { cfg, root } = setup()
    createWorkspace(cfg, 'acme')
    expect(effective(cfg, setWorkspaceTrigger(cfg, 'acme', 'mention-only')).trigger).toBe('mention-only')
    expect(effective(cfg, setWorkspaceTrigger(cfg, 'acme', undefined)).trigger).toBe('mention')
    const file = join(root, 'config.json')
    writeFileSync(file, JSON.stringify({ trigger: 'mention-only' }))
    expect(loadConfig(file).trigger).toBe('mention-only')
    writeFileSync(file, JSON.stringify({ trigger: 'sometimes' }))
    expect(loadConfig(file).trigger).toBe('mention')
    expect(isTrigger('laya')).toBe(true)
    expect(isTrigger('always')).toBe(false)
  })
})

describe('router persona', () => {
  test('ROUTER.md, then config.json routerPersona, then the built-in project manager', () => {
    const { cfg } = setup()
    const w = createWorkspace(cfg, 'demo')
    expect(routerPersona(cfg, w)).toEqual({ text: DEFAULT_ROUTER_PERSONA, source: 'built-in (project manager)' })
    expect(routerPrompt('demo', routerPersona(cfg, w).text)).toContain('Act as the project manager')
    expect(routerPersona({ ...cfg, routerPersona: '  Be a careful QA lead.  ' }, w)).toEqual({ text: 'Be a careful QA lead.', source: 'config.json routerPersona' })
    writeFileSync(join(w.dir, 'ROUTER.md'), 'Be a friendly support agent.\n')
    expect(routerPersona({ ...cfg, routerPersona: 'Be a careful QA lead.' }, w).text).toBe('Be a friendly support agent.')
    writeFileSync(join(w.dir, 'ROUTER.md'), '   \n')
    expect(routerPersona(cfg, w).source).toBe('built-in (project manager)') // an empty file doesn't count
    // Resumed sessions keep their first system prompt, so the context carries the current persona too.
    const ctx = routerContext(w, { threadId: 'T', permalink: 'http://pl/T', workers: [], persona: 'Be terse.', reports: 'router' })
    expect(ctx).toContain('it replaces any earlier one):\nBe terse.')
  })
  test('what routers post and how workers report ride in the context, per reporting mode', () => {
    const { cfg } = setup()
    const w = createWorkspace(cfg, 'demo')
    const base = { threadId: 'T', permalink: 'http://pl/T', workers: [], persona: 'p' }
    const viaRouter = routerContext(w, { ...base, reports: 'router' })
    expect(viaRouter).toContain('they replace anything earlier about what to post or how workers report')
    expect(viaRouter).toContain("Don't narrate the process")
    expect(viaRouter).toContain('kind="worker_report"')
    expect(viaRouter).not.toContain('Workers post their results')
    const direct = routerContext(w, { ...base, reports: 'thread' })
    expect(direct).toContain('Workers post their results and questions in this thread themselves')
    expect(direct).not.toContain('worker_report')
    // The fixed prompt no longer tells routers to announce hand-offs or that workers post in the thread.
    const prompt = routerPrompt('demo', 'p')
    expect(prompt).not.toMatch(/which worker has it|post progress and results \*\*directly/)
    expect(prompt).toContain('never narrate the process')
    const worker = { key: 'w-1', workspace: 'demo', title: 'Fixer', summary: '', threads: [], repos: {} }
    expect(workerContext(w, { worker, reports: 'router' })).toContain("goes to that thread's router")
    expect(workerContext(w, { worker, reports: 'thread' })).toContain('posts in that thread under your title')
    expect(workerPrompt('demo', 'Fixer', 'w-1')).not.toContain('"starting" note')
  })
  test('a ROUTER.md in the template reaches new workspaces', () => {
    const { cfg } = setup()
    writeFileSync(join(ensureTemplate(cfg), 'ROUTER.md'), 'Persona for {{name}}.\n')
    const w = createWorkspace(cfg, 'acme')
    expect(routerPersona(cfg, w).text).toBe('Persona for acme.')
  })
})

describe('status snapshot', () => {
  test('sessions grouped per workspace, live first, closesAt for idle ones', () => {
    const { cfg } = setup()
    const w = createWorkspace(cfg, 'demo')
    const row = (p: Partial<SessionRow> & { key: string }): SessionRow => ({
      role: p.key.startsWith('r-') ? 'router' : 'worker', workspace: 'demo', sessionId: 'S', status: 'idle', pinned: false, model: 'sonnet',
      cwd: w.dir, createdAt: 0, lastActiveAt: 1000, turns: 1, ...p,
    })
    const snap = buildSnapshot({
      hub: { pid: 1, version: '0.1.0', startedAt: 0, heartbeatAt: 5, cliPath: '/cli.ts', bunBin: '/bun', stateDir: '/s' },
      mattermost: { connected: true, url: 'http://mm', bot: 'claude' },
      caps: { maxLiveRouters: 6, maxLiveWorkers: 4 },
      workspaces: [w],
      bindings: { C1: 'demo', C2: 'other' },
      channelName: id => `name-${id}`,
      sessions: [row({ key: 'w-old', status: 'stopped', closedAt: 900, closeReason: 'idle', lastActiveAt: 2000 }), row({ key: 'r-live' })],
      threads: [{ id: 'T1', channelId: 'C1', workspace: 'demo', routerKey: 'r-live', label: 'fix login', cursor: 0, createdAt: 0 }],
      workers: [{ key: 'w-old', workspace: 'demo', title: 'Login', summary: 'auth stuff', threads: ['T1'], repos: {} }],
      permalink: id => `http://mm/pl/${id}`,
      attached: () => 0,
      pendingPermissions: () => 0,
      queuedTasks: k => (k === 'w-old' ? 2 : 0),
      inFlight: () => 0,
      restartPending: k => k === 'r-live',
      retryAt: k => (k === 'r-live' ? 5000 : undefined),
      idleMinutes: s => (s.role === 'router' ? 30 : 120),
      tmuxName: k => `mm${k}`,
    })
    expect(snap.schema).toBe(1)
    expect(snap.caps).toEqual({ liveRouters: 1, maxLiveRouters: 6, liveWorkers: 0, maxLiveWorkers: 4 })
    const ws = snap.workspaces[0]!
    expect(ws.channels).toEqual([{ id: 'C1', name: 'name-C1' }])
    expect(ws.sessions.map(s => s.key)).toEqual(['r-live', 'w-old'])
    expect(ws.sessions[0]).toMatchObject({ label: 'fix login', tmux: 'mmr-live', closesAt: 1000 + 30 * 60_000, threadPermalinks: ['http://mm/pl/T1'] })
    expect(ws.sessions[1]).toMatchObject({ label: 'Login', summary: 'auth stuff', closedAt: 900, closeReason: 'idle', queuedTasks: 2 })
    expect(ws.sessions[1]!.closesAt).toBeUndefined()
    expect(ws.sessions[0]).toMatchObject({ restartPending: true, retryAt: 5000 })
    expect(ws.sessions[1]!.restartPending).toBeUndefined()
    expect(ws.sessions[1]!.retryAt).toBeUndefined()
  })
})

describe('workspace-template', () => {
  test('created with defaults inside workspacesDir, never overwritten, not a workspace', () => {
    const { cfg } = setup()
    const tpl = ensureTemplate(cfg)
    expect(tpl).toBe(join(cfg.workspacesDir, TEMPLATE_DIR))
    for (const f of ['_TEMPLATE.md', 'CLAUDE.md', 'knowledge/README.md', '.claude/settings.json', '.mcp.json', '.gitignore', 'workspace.json']) {
      expect(existsSync(join(tpl, f))).toBe(true)
    }
    writeFileSync(join(tpl, 'CLAUDE.md'), 'mine')
    ensureTemplate(cfg)
    expect(readFileSync(join(tpl, 'CLAUDE.md'), 'utf8')).toBe('mine')
    expect(listWorkspaces(cfg)).toEqual([])
    expect(validName(TEMPLATE_DIR)).toBe(false)
    expect(() => createWorkspace(cfg, TEMPLATE_DIR)).toThrow('invalid workspace name')
  })

  test('new workspaces copy the template: placeholders filled, extra files, manifest defaults', () => {
    const { cfg } = setup()
    const tpl = ensureTemplate(cfg)
    writeFileSync(join(tpl, 'CLAUDE.md'), '# {{name}}\n\n{{description}}\n\nRun `make test`. {{unknown}} stays.\n')
    writeFileSync(join(tpl, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(make test:*)'] } }))
    writeFileSync(join(tpl, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs-mcp' } } }))
    mkdirSync(join(tpl, 'knowledge', 'howto'), { recursive: true })
    writeFileSync(join(tpl, 'knowledge', 'howto', 'deploy.md'), 'Deploying {{name}}')
    mkdirSync(join(tpl, 'scripts'))
    writeFileSync(join(tpl, 'scripts', 'check.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 })
    writeFileSync(join(tpl, 'logo.bin'), Buffer.from([0, 1, 2, 123, 123]))
    mkdirSync(join(tpl, 'repos', 'x'), { recursive: true })
    writeFileSync(join(tpl, 'workspace.json'), JSON.stringify({ name: 'ignored', repos: [{ name: 'r', path: '/r' }], workerModel: 'opus', idleMinutes: { worker: 15 } }))

    const w = createWorkspace(cfg, 'nemo', 'Nemo product')
    expect(readFileSync(join(w.dir, 'CLAUDE.md'), 'utf8')).toBe('# nemo\n\nNemo product\n\nRun `make test`. {{unknown}} stays.\n')
    expect(JSON.parse(readFileSync(join(w.dir, '.claude', 'settings.json'), 'utf8'))).toEqual({ permissions: { allow: ['Bash(make test:*)'] } })
    expect(JSON.parse(readFileSync(join(w.dir, '.mcp.json'), 'utf8')).mcpServers.docs.command).toBe('docs-mcp')
    expect(readFileSync(join(w.dir, 'knowledge', 'howto', 'deploy.md'), 'utf8')).toBe('Deploying nemo')
    expect(statSync(join(w.dir, 'scripts', 'check.sh')).mode & 0o777).toBe(0o755)
    expect([...readFileSync(join(w.dir, 'logo.bin'))]).toEqual([0, 1, 2, 123, 123])
    for (const f of ['_TEMPLATE.md', 'repos/x']) expect(existsSync(join(w.dir, f))).toBe(false)
    expect(loadWorkspace(cfg, 'nemo')).toMatchObject({ name: 'nemo', description: 'Nemo product', repos: [], workerModel: 'opus', idleMinutes: { worker: 15 } })

    // Re-creating keeps the workspace's own edits.
    writeFileSync(join(w.dir, 'CLAUDE.md'), 'edited')
    createWorkspace(cfg, 'nemo')
    expect(readFileSync(join(w.dir, 'CLAUDE.md'), 'utf8')).toBe('edited')
  })

  test('files removed from the template stay removed; a workspace still gets a CLAUDE.md', () => {
    const { cfg } = setup()
    const tpl = ensureTemplate(cfg)
    const { rmSync } = require('fs') as typeof import('fs')
    rmSync(join(tpl, 'CLAUDE.md'))
    rmSync(join(tpl, '.mcp.json'))
    const w = createWorkspace(cfg, 'bare')
    expect(readFileSync(join(w.dir, 'CLAUDE.md'), 'utf8')).toContain('# Workspace: bare')
    // Deletions in the template stick: nothing is re-seeded, and .mcp.json is optional.
    expect(existsSync(join(tpl, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(w.dir, '.mcp.json'))).toBe(false)
  })
})
