/**
 * Workspaces: a folder under config.workspacesDir with its own CLAUDE.md,
 * knowledge/, permission settings and a list of repos. Channels bind to a
 * workspace through bindings.json ({channelId: workspaceName}, many → one).
 *
 *   <ws>/workspace.json          manifest
 *   <ws>/CLAUDE.md               workspace instructions (loaded by every session: routers run in <ws>,
 *                                workers in <ws>/.worktrees/<id>, so it is a parent-folder CLAUDE.md)
 *   <ws>/knowledge/              shared notes (routers read, workers read/write)
 *   <ws>/TRIGGER.md              optional: when the bot answers without an @mention (trigger "laya"; laya.ts)
 *   <ws>/.claude/settings.json   workspace permission rules (merged into each session's --settings)
 *   <ws>/.mcp.json               optional extra MCP servers
 *   <ws>/repos/<name>            clones made by `mmhub repo add <git-url>`
 *   <ws>/.worktrees/<id>/<repo>  per-worker git worktrees (hidden → routers' Grep/Glob skip them)
 *   <ws>/inbox/                  downloaded attachments
 *
 * New workspaces are copied from <workspacesDir>/workspace-template/ (see ensureTemplate).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { expandHome } from '../shared/paths'
import { readJson, slug, writeJsonAtomic } from '../shared/util'
import { isTrigger, type HubConfig, type IdleMinutes, type Trigger } from './config'

export type RepoRef = { name: string; path: string }

export type WorkspaceManifest = {
  name: string
  description?: string
  /** Base for worker branches (default: the repo's current HEAD). */
  baseRef?: string
  repos: RepoRef[]
  routerModel?: string
  workerModel?: string
  workerPermissionMode?: string
  idleMinutes?: Partial<IdleMinutes>
  /**
   * Providers for this workspace's sessions, in fallback order (providers.json
   * names, "default" for the hub's own login, "hub" for the hub-wide list).
   * Unset: the hub-wide list.
   */
  providers?: string[]
  /**
   * Workspaces whose sessions may send this one requests (message_workspace),
   * answered by a router of this workspace. Unset or "*": every workspace; []: none.
   */
  acceptFrom?: string[]
  /**
   * Which replies in the bot's threads reach it: "mention" (all of them), or "laya"
   * (in threads it follows, those Laya judges meant for it by TRIGGER.md). Unset: config.json `trigger`.
   */
  trigger?: Trigger
}

export type Workspace = WorkspaceManifest & { dir: string }

export const WORKSPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function validName(name: string): boolean {
  return WORKSPACE_NAME_RE.test(name) && !name.includes('..') && name !== TEMPLATE_DIR
}

export function workspaceDir(cfg: HubConfig, name: string): string {
  if (!validName(name)) throw new Error(`invalid workspace name: ${name}`)
  return join(resolve(cfg.workspacesDir), name)
}

export function loadWorkspace(cfg: HubConfig, name: string): Workspace | undefined {
  if (!validName(name)) return undefined
  const dir = workspaceDir(cfg, name)
  const file = join(dir, 'workspace.json')
  if (!existsSync(file)) return undefined
  const m = readJson<WorkspaceManifest>(file, () => ({ name, repos: [] }))
  return { ...m, name, repos: m.repos ?? [], dir }
}

export function listWorkspaces(cfg: HubConfig): Workspace[] {
  const root = resolve(cfg.workspacesDir)
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => loadWorkspace(cfg, d.name))
    .filter((w): w is Workspace => !!w)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function saveManifest(w: Workspace): void {
  const { dir, ...m } = w
  writeJsonAtomic(join(dir, 'workspace.json'), m, 0o644)
}

// ---------------------------------------------------------------- template

/**
 * <workspacesDir>/workspace-template/ — copied into every new workspace, so
 * its CLAUDE.md, knowledge/, .claude/settings.json, .mcp.json and other files
 * are reused. {{name}} and {{description}} are filled in. Its workspace.json
 * gives default manifest settings (models, idle minutes, baseRef…).
 */
export const TEMPLATE_DIR = 'workspace-template'

/** Template files that describe the template itself (not copied). */
const TEMPLATE_ONLY = new Set(['_TEMPLATE.md', 'workspace.json'])
/** Never copied from the template (top level): per-workspace runtime folders. */
const TEMPLATE_SKIP_TOP = new Set(['repos', '.worktrees', 'inbox'])
/** Never copied at any depth. */
const TEMPLATE_SKIP_ANY = new Set(['.git', '.DS_Store'])

const CLAUDE_MD = `# Workspace: {{name}}

{{description}}

## How sessions work here

- Messages come from Mattermost threads. Each thread has a **router** (read-only) that answers
  questions and hands work to **workers**. Workers do the changes, each in its own git worktree.
- The repo map (names → paths) and your worktree paths are given to you when the session starts.
- \`knowledge/\` holds this workspace's shared notes. Read \`knowledge/README.md\` first.
  Workers: record durable facts there (decisions, how-tos, gotchas) — not task chatter.

## Conventions

- (Add coding conventions, branch/PR rules, test commands, people to ask…)
`

const KNOWLEDGE_README = `# {{name}} — knowledge

Shared, durable notes for every session in this workspace. One topic per file, short and dated.
Index the files here:

- (none yet)
`

const TEMPLATE_README = `# workspace-template

Everything in this folder is copied into each **new** workspace created under this
folder (\`mmhub ws create\`, \`/mattermost-hub:workspace create\`, or "create <name>" in
Mattermost). Existing workspaces are not changed.

- Edit \`CLAUDE.md\`, \`knowledge/\`, \`.claude/settings.json\` (permission rules),
  \`.mcp.json\` (extra MCP servers) — or add any other files and folders.
- \`{{name}}\` and \`{{description}}\` in text files are replaced with the new workspace's
  name and description.
- Add a \`ROUTER.md\` to give new workspaces' routers their own persona (how they work
  with people); without one they use config.json \`routerPersona\` or the built-in
  project manager.
- Add a \`TRIGGER.md\` to give new workspaces starter rules for when the bot answers
  without an @mention (used when their trigger is "laya").
- \`workspace.json\` here holds default settings for new workspaces, e.g.
  \`{"workerModel": "opus", "idleMinutes": {"router": 10, "worker": 60}, "baseRef": "origin/main"}\`.
  Its \`name\`, \`description\` and \`repos\` are ignored.
- Not copied: this file, \`workspace.json\`, \`repos/\`, \`.worktrees/\`, \`inbox/\`, \`.git\`.
`

const DEFAULT_SETTINGS = JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2) + '\n'
const DEFAULT_MCP = JSON.stringify({ mcpServers: {} }, null, 2) + '\n'
const DEFAULT_GITIGNORE = '.worktrees/\ninbox/\nrepos/\n'

export function templateDir(cfg: HubConfig): string {
  return join(resolve(cfg.workspacesDir), TEMPLATE_DIR)
}

function putIfMissing(file: string, text: string): void {
  if (existsSync(file)) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/**
 * Create the template folder with the default files the first time the
 * workspaces folder is used. Once it exists it is the user's: edits and
 * deletions stick. Returns its path.
 */
export function ensureTemplate(cfg: HubConfig): string {
  const dir = templateDir(cfg)
  if (existsSync(dir)) return dir
  mkdirSync(join(dir, 'knowledge'), { recursive: true })
  putIfMissing(join(dir, '_TEMPLATE.md'), TEMPLATE_README)
  putIfMissing(join(dir, 'CLAUDE.md'), CLAUDE_MD)
  putIfMissing(join(dir, 'knowledge', 'README.md'), KNOWLEDGE_README)
  putIfMissing(join(dir, '.claude', 'settings.json'), DEFAULT_SETTINGS)
  putIfMissing(join(dir, '.mcp.json'), DEFAULT_MCP)
  putIfMissing(join(dir, '.gitignore'), DEFAULT_GITIGNORE)
  putIfMissing(join(dir, 'workspace.json'), '{}\n')
  return dir
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m)
}

/** Copy src → dst recursively without overwriting; fill {{vars}} in text files. */
function copyTemplateTree(src: string, dst: string, vars: Record<string, string>, top = true): void {
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (TEMPLATE_SKIP_ANY.has(e.name)) continue
    if (top && (TEMPLATE_ONLY.has(e.name) || TEMPLATE_SKIP_TOP.has(e.name))) continue
    const from = join(src, e.name)
    const to = join(dst, e.name)
    if (e.isDirectory()) {
      mkdirSync(to, { recursive: true })
      copyTemplateTree(from, to, vars, false)
    } else if (e.isFile() && !existsSync(to)) {
      const buf = readFileSync(from)
      const isText = buf.length < 1024 * 1024 && !buf.subarray(0, 8192).includes(0)
      writeFileSync(to, isText ? fill(buf.toString('utf8'), vars) : buf, { mode: statSync(from).mode })
    }
  }
}

/** Manifest defaults from the template's workspace.json (identity fields ignored). */
function templateDefaults(tpl: string): Partial<WorkspaceManifest> {
  const raw = readJson<Partial<WorkspaceManifest>>(join(tpl, 'workspace.json'), () => ({}))
  const { name: _n, description: _d, repos: _r, ...rest } = raw && typeof raw === 'object' ? raw : {}
  return rest
}

/** Create a workspace from <workspacesDir>/workspace-template. Idempotent for existing files. */
export function createWorkspace(cfg: HubConfig, name: string, description?: string): Workspace {
  const dir = workspaceDir(cfg, name)
  const tpl = ensureTemplate(cfg)
  for (const d of [dir, join(dir, 'knowledge'), join(dir, '.claude'), join(dir, 'repos'), join(dir, '.worktrees'), join(dir, 'inbox')]) {
    mkdirSync(d, { recursive: true })
  }
  const vars = { name, description: description ?? 'Describe what this workspace is for: the product, the team, the goals.' }
  copyTemplateTree(tpl, dir, vars)
  // Anything the template lacks (deleted on purpose or not) still gets a default.
  putIfMissing(join(dir, 'CLAUDE.md'), fill(CLAUDE_MD, vars))
  putIfMissing(join(dir, 'knowledge', 'README.md'), fill(KNOWLEDGE_README, vars))
  putIfMissing(join(dir, '.claude', 'settings.json'), DEFAULT_SETTINGS)
  putIfMissing(join(dir, '.gitignore'), DEFAULT_GITIGNORE)
  const existing = loadWorkspace(cfg, name)
  const w: Workspace = existing ?? { ...templateDefaults(tpl), name, ...(description ? { description } : {}), repos: [], dir }
  if (!existing) saveManifest(w)
  return w
}

async function run(argv: string[], cwd?: string): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, out: (o + e).trim() }
}

function looksLikeUrl(s: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(s)
}

/** Add a local folder, or clone a git URL into <ws>/repos/<name>. */
export async function addRepo(cfg: HubConfig, wsName: string, source: string, name?: string): Promise<RepoRef> {
  const w = loadWorkspace(cfg, wsName)
  if (!w) throw new Error(`no workspace named ${wsName}`)
  let repo: RepoRef
  if (looksLikeUrl(source)) {
    const n = name ?? basename(source).replace(/\.git$/, '')
    if (!REPO_NAME_RE.test(n)) throw new Error(`invalid repo name: ${n}`)
    const dest = join(w.dir, 'repos', n)
    if (existsSync(dest)) throw new Error(`${dest} already exists`)
    const r = await run([cfg.gitBin ?? 'git', 'clone', source, dest])
    if (r.code !== 0) throw new Error(`git clone failed: ${r.out}`)
    repo = { name: n, path: dest }
  } else {
    const p = resolve(expandHome(source))
    if (!isAbsolute(p) || !existsSync(p) || !statSync(p).isDirectory()) throw new Error(`not a folder: ${p}`)
    const n = name ?? slug(basename(p), 64)
    if (!REPO_NAME_RE.test(n)) throw new Error(`invalid repo name: ${n}`)
    repo = { name: n, path: p }
  }
  if (w.repos.some(r => r.name === repo.name)) throw new Error(`workspace ${wsName} already has a repo named ${repo.name}`)
  w.repos.push(repo)
  saveManifest(w)
  return repo
}

/** Set what makes the bot take posts in a workspace's channels; undefined goes back to config.json's. */
export function setWorkspaceTrigger(cfg: HubConfig, wsName: string, trigger: Trigger | undefined): Workspace {
  const w = loadWorkspace(cfg, wsName)
  if (!w) throw new Error(`no workspace named ${wsName}`)
  if (trigger) w.trigger = trigger
  else delete w.trigger
  saveManifest(w)
  return w
}

/** Set a workspace's provider chain; an empty list goes back to the hub-wide one. */
export function setWorkspaceProviders(cfg: HubConfig, wsName: string, providers: string[]): Workspace {
  const w = loadWorkspace(cfg, wsName)
  if (!w) throw new Error(`no workspace named ${wsName}`)
  if (providers.length) w.providers = providers
  else delete w.providers
  saveManifest(w)
  return w
}

export function removeRepo(cfg: HubConfig, wsName: string, name: string): boolean {
  const w = loadWorkspace(cfg, wsName)
  if (!w) throw new Error(`no workspace named ${wsName}`)
  const before = w.repos.length
  w.repos = w.repos.filter(r => r.name !== name)
  if (w.repos.length === before) return false
  saveManifest(w)
  return true
}

/** Repo folders outside the workspace folder (routers need --add-dir for these). */
export function externalRepoPaths(w: Workspace): string[] {
  const root = resolve(w.dir) + '/'
  return w.repos.map(r => resolve(r.path)).filter(p => !(p + '/').startsWith(root))
}

// ---------------------------------------------------------------- worktrees

export function workerDir(w: Workspace, workerKey: string): string {
  return join(w.dir, '.worktrees', workerKey)
}

export type Worktree = { path: string; branch?: string; shared?: boolean }

async function isGitRepo(git: string, path: string): Promise<boolean> {
  return (await run([git, '-C', path, 'rev-parse', '--is-inside-work-tree'])).out === 'true'
}

/**
 * <ws>/.worktrees/<workerKey>/<repo> on branch mm/<workerKey>, from baseRef or HEAD.
 * Reuses an existing worktree or branch. Non-git folders are shared in place.
 */
export async function prepareWorktree(cfg: HubConfig, w: Workspace, workerKey: string, repoName: string): Promise<Worktree> {
  const repo = w.repos.find(r => r.name === repoName)
  if (!repo) throw new Error(`workspace ${w.name} has no repo named ${repoName} (repos: ${w.repos.map(r => r.name).join(', ') || 'none'})`)
  const git = cfg.gitBin ?? 'git'
  if (!(await isGitRepo(git, repo.path))) return { path: repo.path, shared: true }
  const path = join(workerDir(w, workerKey), repo.name)
  const branch = `mm/${workerKey}`
  if (existsSync(join(path, '.git'))) return { path, branch }
  mkdirSync(workerDir(w, workerKey), { recursive: true })
  const hasBranch = (await run([git, '-C', repo.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
  const args = hasBranch
    ? [git, '-C', repo.path, 'worktree', 'add', path, branch]
    : [git, '-C', repo.path, 'worktree', 'add', '-b', branch, path, w.baseRef ?? 'HEAD']
  const r = await run(args)
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.out}`)
  return { path, branch }
}

/** Remove a worker's clean worktrees. Returns the paths kept because they have changes. */
export async function removeWorktrees(cfg: HubConfig, w: Workspace, trees: Record<string, Worktree>): Promise<string[]> {
  const git = cfg.gitBin ?? 'git'
  const kept: string[] = []
  for (const [name, t] of Object.entries(trees)) {
    if (t.shared) continue
    const repo = w.repos.find(r => r.name === name)
    if (!repo || !existsSync(t.path)) continue
    const dirty = (await run([git, '-C', t.path, 'status', '--porcelain'])).out
    if (dirty) {
      kept.push(t.path)
      continue
    }
    const r = await run([git, '-C', repo.path, 'worktree', 'remove', t.path])
    if (r.code !== 0) kept.push(t.path)
  }
  return kept
}

// ---------------------------------------------------------------- bindings

export function loadBindings(file: string): Record<string, string> {
  return readJson<Record<string, string>>(file, () => ({}))
}

export function bindChannel(file: string, channelId: string, workspace: string): void {
  const b = loadBindings(file)
  b[channelId] = workspace
  writeJsonAtomic(file, b)
}

export function unbindChannel(file: string, channelId: string): boolean {
  const b = loadBindings(file)
  if (!(channelId in b)) return false
  delete b[channelId]
  writeJsonAtomic(file, b)
  return true
}

export function channelsOf(bindings: Record<string, string>, workspace: string): string[] {
  return Object.entries(bindings).filter(([, w]) => w === workspace).map(([c]) => c)
}

/** Effective per-role settings for a workspace. */
export function effective(cfg: HubConfig, w: Workspace) {
  return {
    routerModel: w.routerModel ?? cfg.routerModel,
    workerModel: w.workerModel ?? cfg.workerModel,
    workerPermissionMode: w.workerPermissionMode ?? cfg.workerPermissionMode,
    idleMinutes: { ...cfg.idleMinutes, ...(w.idleMinutes ?? {}) } as IdleMinutes,
    trigger: (isTrigger(w.trigger) ? w.trigger : cfg.trigger) as Trigger,
  }
}
