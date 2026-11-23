/**
 * add_repo: a router adds a repo to its workspace when a hub owner asks for it in
 * its thread: a folder on this machine, or a git URL the hub clones into
 * <ws>/repos/<name> with the machine's git login (never waiting on a prompt).
 *
 * A folder outside the workspace folder is read through --add-dir, which a session
 * gets when it starts: the workspace's live routers (and its workers, for a folder
 * that isn't a git repo; they use it as it is) restart gracefully to get it, the
 * asking router after its turn, with its memory. A clone lands inside the workspace
 * folder, which every session reads already.
 *
 * A clone that outlasts what a tool call may wait (the bridge gives up at 180 s)
 * goes on: the router hears how it ended as a kind="repo_added" message.
 *
 * Guards: routers only; owners only (message_id, as for schedule); not a folder
 * that is, holds or is inside the hub's state, a Claude config dir or ~/.ssh, nor
 * one that holds every workspace or is inside another workspace.
 */

import { existsSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { errMsg, log } from '../shared/util'
import type { Hub } from './hub'
import { ownerAsked } from './jobs'
import { isLive } from './lifecycle'
import { knownConfigDirs } from './providers'
import { ToolError } from './tools'
import { addRepo, isExternal, localRepoPath, redactUrl, type RepoRef, type Workspace } from './workspaces'

/** How long the tool waits for a clone before it goes on in the background (under the bridge's 180 s). */
export const CLONE_WAIT_MS = 150_000
/** A clone taking longer than this is stopped. */
export const CLONE_MAX_MS = 20 * 60_000

function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

const within = (p: string, dir: string) => (p + '/').startsWith(dir + '/')

/** Why a folder may not be added from a thread (undefined: it may). */
export function refusedFolder(hub: Hub, w: Workspace, path: string): string | undefined {
  const p = real(path)
  const guarded: [string, string][] = [
    [hub.p.dir, "the hub's own state (its tokens and settings)"],
    ...knownConfigDirs(hub.p.dir, hub.providerDefs()).map((d): [string, string] => [d, "Claude Code's settings and logins"]),
    [join(homedir(), '.ssh'), 'ssh keys'],
  ]
  for (const [dir, what] of guarded) {
    const d = real(dir)
    if (within(p, d) || within(d, p)) return `${path} ${within(p, d) ? 'is part of' : 'holds'} ${what}: not a repo to add from a thread. An owner can add it on the machine with \`mmhub repo add\`.`
  }
  const root = real(hub.cfg.workspacesDir)
  if (within(root, p)) return `${path} holds every workspace: add the repo's own folder.`
  if (within(p, root) && !within(p, real(w.dir))) return `${path} is inside another workspace: ask that workspace with message_workspace instead.`
  return undefined
}

export async function addRepoTool(hub: Hub, key: string, a: { source: string; name?: string; messageId?: string }, waitMs = CLONE_WAIT_MS): Promise<string> {
  if (!key.startsWith('r-')) throw new ToolError("routers only: report it to your thread's router, which can add it")
  const { thread, who } = await ownerAsked(hub, key, a.messageId, 'add repos to the workspace')
  const w = hub.ws(thread.workspace)
  if (!w) throw new ToolError(`workspace ${thread.workspace} is gone`)
  const source = a.source.trim()
  if (!source) throw new ToolError('pass source: a folder on this machine or a git URL')
  const local = localRepoPath(source)
  if (local && !/^(\/|~\/|~$)/.test(source)) throw new ToolError(`${source}: pass the folder's full path (/… or ~/…), or a git URL`)
  if (local) {
    const why = existsSync(local) ? refusedFolder(hub, w, local) : undefined
    if (why) throw new ToolError(why)
  }
  const shown = redactUrl(source)

  const job = hub.withLock(`repos:${w.name}`, () => addRepo(hub.cfg, w.name, source, a.name, { unattended: true, timeoutMs: CLONE_MAX_MS }))
  const first = await Promise.race([
    job.then(r => ({ r }), (e: unknown) => ({ e })),
    Bun.sleep(waitMs).then(() => undefined),
  ])
  if (first && 'e' in first) throw new ToolError(errMsg(first.e))
  if (first) return added(hub, key, w, first.r, who)

  // Still cloning: it goes on, and the router hears how it ended.
  log('repos', `${key}: cloning ${shown} into workspace ${w.name} goes on in the background`)
  const tell = (content: string) => hub.enqueue(async () => {
    if (!hub.store.session(key)) return
    await hub.deliver(key, content, { chat_id: thread.channelId, thread_id: thread.id, workspace: w.name, kind: 'repo_added', ts: new Date().toISOString() })
  })
  void job.then(
    async r => {
      await tell(`[The repo ${who} asked for is cloned: "${r.name}" at ${r.path}, in workspace ${w.name} now. You can read it (Read/Grep/Glob); workers get their own checkout with prepare_repo(repo="${r.name}"). Tell the person in a line, in their language.]`)
    },
    async (e: unknown) => {
      log('repos', `${key}: cloning ${shown} failed: ${errMsg(e)}`)
      await tell(`[Cloning ${shown} for ${who} failed, so workspace ${w.name} has no new repo: ${errMsg(e)}. Tell the person what went wrong in a line, in their language (a private repo needs this machine's git login to reach it).]`)
    },
  ).catch(err => log('repos', `${key}: ${errMsg(err)}`))
  return `cloning ${shown} into workspace ${w.name} for ${who}: it takes longer than a tool call may wait, so it goes on, and you get a message (kind="repo_added") when it is done or fails. Tell the person it is on its way, in a line, and end your turn.`
}

/** The repo is in the workspace: sessions that need --add-dir for it restart (on the chain). */
async function added(hub: Hub, key: string, w: Workspace, r: RepoRef, who: string): Promise<string> {
  log('repos', `${key}: added repo ${r.name} (${r.path}) to workspace ${w.name} for ${who}`)
  const external = isExternal(w, r.path)
  const git = existsSync(join(r.path, '.git'))
  let others = 0
  if (external) {
    await hub.enqueue(async () => {
      for (const s of hub.store.sessions()) {
        if (s.workspace !== w.name || !isLive(s.status)) continue
        if (s.role !== 'router' && git) continue // a git repo: workers work in their own checkout, inside their folder
        const res = await hub.restart(s.key)
        if (s.key !== key && res.ok) others++
      }
      hub.status.changed()
    })
  }
  return [
    `added repo "${r.name}" (${r.path}) to workspace ${w.name} for ${who}.`,
    external
      ? `It is outside the workspace folder, so sessions read it only after a restart: you restart after this turn, with your memory${others ? `, and so ${others === 1 ? 'does 1 other live session' : `do ${others} other live sessions`} of the workspace` : ''}.`
      : 'You can read it now (Read/Grep/Glob).',
    git
      ? `Workers get their own checkout with prepare_repo(repo="${r.name}"): name the repo in the task when you delegate.`
      : `It isn't a git repo: workers share the folder as it is (prepare_repo(repo="${r.name}") gives them its path).`,
    'Nothing was posted: tell the person yourself with reply, in a line.',
  ].join(' ')
}
