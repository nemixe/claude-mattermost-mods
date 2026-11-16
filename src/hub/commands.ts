/**
 * Owner chat commands (`!ws`, `!workers`, `!wake`, …) and the "which
 * workspace?" exchange for channels not bound yet. All run on the hub chain.
 */

import { errMsg, fmtAge, log } from '../shared/util'
import type { Hub } from './hub'
import type { InboundAction } from './inbound'
import { isLive } from './lifecycle'
import type { MMPost } from './mattermost'
import { delegate, ToolError } from './tools'
import { following, inDM, setFollowing } from './trigger'
import { bindChannel, createWorkspace, effective, listWorkspaces, loadBindings, loadWorkspace, removeWorktrees, validName } from './workspaces'

const HELP = `**Mattermost hub commands** (owners)
\`!ws\` workspace, repos, channels and sessions · \`!workers\` the worker pool
\`!wake [id]\` start/resume a session, or retry one waiting after an API error (default: this thread's router) · \`!stop\` close this thread's router now
\`!restart [id|all|workers|routers] [now]\` restart with the current settings, keeping the conversation — after the current turn ends, or right away with \`now\`
\`!pin [id]\` / \`!unpin [id]\` keep a session open / let it auto-close
\`!worker stop <id>\` close a worker · \`!worker rm <id>\` remove it and its clean worktrees
\`!delegate <worker-id|new> <task>\` hand a task to a worker from this thread
\`!unfollow\` / \`!follow\` (workspaces where Laya decides) stop or start passing this thread's messages without a mention to Laya
Permission prompts: \`yes abcde\` / \`no abcde\`, or ✅ / ❌ on the 🔐 post.`

function sessionLine(hub: Hub, key: string): string {
  const s = hub.store.session(key)
  if (!s) return `\`${key}\` (gone)`
  const live = isLive(s.status)
  const extra = [
    s.pinned ? '📌' : '',
    hub.desk.count(key) ? `🔐${hub.desk.count(key)}` : '',
    !live && s.closeReason ? `(${s.closeReason}${s.closedAt ? `, ${fmtAge(Date.now() - s.closedAt)} ago` : ''})` : '',
    hub.queued(key) ? `${hub.queued(key)} queued` : '',
  ].filter(Boolean).join(' ')
  return `${s.role === 'router' ? '🧭' : '🛠'} \`${key}\` **${hub.label(key)}** — ${s.status}${live ? `, active ${fmtAge(Date.now() - s.lastActiveAt)} ago` : ''} ${extra} · ${s.model}`.trim()
}

export async function runCommand(hub: Hub, a: Extract<InboundAction, { kind: 'command' }>, post: MMPost): Promise<void> {
  const say = (m: string) => hub.replyTo(post, m)
  const bindings = loadBindings(hub.p.bindings)
  const wsName = bindings[post.channel_id] ?? hub.store.thread(a.threadId)?.workspace
  const thread = hub.store.thread(a.threadId)
  const target = (arg?: string) => arg ?? thread?.routerKey

  try {
    switch (a.name) {
      case 'help':
      case '':
        return say(HELP)
      case 'ws': {
        if (!wsName) return say('This channel is not bound to a workspace. Mention me with a request and I will ask which one.')
        const w = loadWorkspace(hub.cfg, wsName)
        if (!w) return say(`Workspace \`${wsName}\` is missing on disk.`)
        const channels = Object.entries(bindings).filter(([, n]) => n === w.name).map(([id]) => `~${hub.channelName(id)}`)
        const sessions = hub.store.sessions({ workspace: w.name })
        const live = sessions.filter(s => isLive(s.status))
        return say([
          `**Workspace ${w.name}**${w.description ? ` — ${w.description}` : ''}`,
          `Folder: \`${w.dir}\``,
          `Channels: ${channels.join(', ') || 'none'}`,
          `Repos: ${w.repos.map(r => `\`${r.name}\``).join(', ') || 'none (add with `mmhub repo add`)'}`,
          `Provider: ${hub.providerLine(w)}`,
          `Sessions: ${live.length} live / ${sessions.length} total`,
          ...live.map(s => `- ${sessionLine(hub, s.key)}`),
        ].join('\n'))
      }
      case 'workers': {
        if (!wsName) return say('This channel is not bound to a workspace.')
        const ws = hub.store.workers(wsName)
        if (!ws.length) return say('No workers yet.')
        return say(ws.map(w => `- ${sessionLine(hub, w.key)}${w.summary ? `\n  ${w.summary}` : ''}`).join('\n'))
      }
      case 'wake': {
        const key = target(a.args[0])
        if (!key || !hub.store.session(key)) return say('Which session? `!wake <id>`')
        const r = await hub.wake(key)
        return say(`${r.ok ? '' : '⚠️ '}${r.message}`)
      }
      case 'restart': {
        const now = a.args.includes('now')
        const which = a.args.find(x => x !== 'now')
        if (which === 'all' || which === 'workers' || which === 'routers') {
          const r = await hub.restartAll(which === 'all' ? undefined : which === 'workers' ? 'worker' : 'router', now)
          return say(`${r.ok ? '↻' : '⚠️'} ${r.message}`)
        }
        const key = target(which)
        if (!key || !hub.store.session(key)) return say('Which session? `!restart <id|all|workers|routers> [now]`')
        const r = await hub.restart(key, now)
        return say(`${r.ok ? '↻' : '⚠️'} ${r.message}`)
      }
      case 'pin':
      case 'unpin': {
        const key = target(a.args[0])
        if (!key || !hub.store.session(key)) return say(`Which session? \`!${a.name} <id>\``)
        hub.patch(key, { pinned: a.name === 'pin' })
        return say(a.name === 'pin' ? `📌 \`${key}\` stays open until unpinned.` : `\`${key}\` may auto-close again.`)
      }
      case 'stop': {
        if (!thread) return say('`!stop` works inside a hub thread.')
        await hub.close(thread.routerKey, 'manual')
        return say(`Closed this thread's router \`${thread.routerKey}\`. Write here again to resume it.`)
      }
      case 'worker': {
        const [sub, key] = a.args
        if (!key || !key.startsWith('w-') || !hub.store.worker(key)) return say('Usage: `!worker stop <id>` or `!worker rm <id>`')
        if (sub === 'stop') {
          await hub.close(key, 'manual')
          return say(`Closed \`${key}\`. Its queued tasks wait until it is woken or delegated to.`)
        }
        if (sub === 'rm') {
          const w = hub.store.worker(key)!
          const ws = loadWorkspace(hub.cfg, w.workspace)
          await hub.close(key, 'manual')
          const kept = ws ? await removeWorktrees(hub.cfg, ws, w.repos) : []
          hub.store.deleteWorker(key)
          hub.status.changed()
          return say(`Removed worker \`${key}\` (${w.title}).${kept.length ? ` Kept worktrees with uncommitted changes:\n${kept.map(p => `- \`${p}\``).join('\n')}` : ''}`)
        }
        return say('Usage: `!worker stop <id>` or `!worker rm <id>`')
      }
      case 'follow':
      case 'unfollow': {
        if (!thread) return say(`\`!${a.name}\` works inside a hub thread.`)
        if (inDM(hub, thread.id)) return say(`Nothing to ${a.name}: this is a DM, and every message here reaches me.`)
        const w = loadWorkspace(hub.cfg, thread.workspace)
        if (!w || effective(hub.cfg, w).trigger !== 'laya') return say(`Workspace \`${thread.workspace}\` takes every reply in its threads (Laya is off), so there is nothing to ${a.name}.`)
        const on = a.name === 'follow'
        if (following(hub, thread.id) !== on) setFollowing(hub, thread.id, on)
        return say(on
          ? '👂 Following this thread: Laya passes me the messages here that are meant for me.'
          : 'Stopped following this thread: only messages that mention me reach me now, and a mention follows it again.')
      }
      case 'delegate': {
        if (!thread) return say('`!delegate` works inside a hub thread.')
        const [who, ...rest] = a.args
        const task = rest.join(' ').trim()
        if (!who || !task) return say('Usage: `!delegate <worker-id|new> <task>`')
        const res = await delegate(hub, {
          thread,
          ...(who === 'new' ? { newWorker: { title: task.split(/\s+/).slice(0, 6).join(' '), summary: task.slice(0, 200) } } : { workerKey: who }),
          task,
          messageIds: [post.id],
        })
        return say(`Task #${res.task_id} → \`${res.worker_id}\`: ${res.state}${res.position ? ` (position ${res.position})` : ''}`)
      }
      default:
        return say(`Unknown command \`!${a.name}\`. \`!help\` lists them.`)
    }
  } catch (err) {
    log('command', `!${a.name}: ${errMsg(err)}`)
    await say(`⚠️ ${err instanceof ToolError ? err.message : errMsg(err)}`)
  }
}

export async function askWorkspace(hub: Hub, post: MMPost, channelType: string): Promise<void> {
  const threadId = post.root_id || post.id
  hub.awaiting.set(threadId, { channelId: post.channel_id, channelType, post, askedAt: Date.now() })
  const names = listWorkspaces(hub.cfg).map(w => `\`${w.name}\``)
  await hub.replyTo(post, [
    `${channelType === 'D' ? 'This chat' : 'This channel'} is not connected to a workspace yet. Answer with one of these (here, or in this thread):`,
    names.length ? `- an existing workspace name: ${names.join(', ')}` : '- (no workspaces yet)',
    '- `create <name> [description]` for a new one, e.g. `create acme Acme web app`',
  ].join('\n'))
}

/** Text that only answers the workspace question (not a request to work on). */
function isWorkspaceAnswer(text: string, hub: Hub): boolean {
  const t = text.replace(/@[\w.-]+/g, '').trim()
  return /^create\s+\S+/i.test(t) || (/^\S+$/.test(t) && !!loadWorkspace(hub.cfg, t))
}

export async function answerWorkspace(hub: Hub, text: string, answer: MMPost): Promise<void> {
  const threadId = hub.openWorkspaceQuestion(answer)
  const pending = threadId ? hub.awaiting.get(threadId) : undefined
  if (!threadId || !pending) return
  const m = /^create\s+(\S+)(?:\s+(.+))?$/is.exec(text.trim())
  const name = (m ? m[1] : text.trim().split(/\s+/)[0]) ?? ''
  if (!validName(name)) {
    await hub.replyTo(answer, `\`${name}\` isn't a valid workspace name (letters, digits, . _ -). Try again, e.g. \`create acme Acme web app\`.`)
    return
  }
  let w = loadWorkspace(hub.cfg, name)
  if (!w) {
    if (!m) {
      await hub.replyTo(answer, `No workspace \`${name}\`. Answer \`create ${name} [description]\` to make it.`)
      return
    }
    w = createWorkspace(hub.cfg, name, m[2]?.trim())
  }
  bindChannel(hub.p.bindings, pending.channelId, w.name)
  for (const [tid, a] of [...hub.awaiting]) if (a.channelId === pending.channelId) hub.awaiting.delete(tid)
  hub.status.changed()
  const where = pending.channelType === 'D' ? 'This chat' : `~${hub.channelName(pending.channelId)}`
  const repos = w.repos.length ? '' : ` Add repos with \`mmhub repo add ${w.name} <path|git-url>\` or \`/mattermost-hub:workspace\`.`
  if (isWorkspaceAnswer(pending.post.message, hub)) {
    // The first message was itself an attempt to answer: nothing to work on yet.
    await hub.replyTo(answer, `🔗 ${where} is now connected to workspace **${w.name}** (\`${w.dir}\`).${repos}\nSend your request${pending.channelType === 'D' ? '' : ' (mention me)'} to start a thread.`)
    return
  }
  await hub.replyTo(answer, `🔗 ${where} is now connected to workspace **${w.name}** (\`${w.dir}\`).${repos}`)
  await hub.startThread(w, threadId, pending.post)
}
