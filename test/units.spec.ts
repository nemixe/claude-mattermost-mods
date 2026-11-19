import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { paths } from '../src/shared/paths'
import { chunk, PERMISSION_REPLY_RE } from '../src/shared/util'
import { classifySender, defaultAccess, isOwner, issuePairingCode, ownerNeedsBotCheck, pruneExpired } from '../src/hub/access'
import { buildDigest } from '../src/hub/digest'
import { instructionsFor, toolsFor } from '../src/bridge/tools'
import { PermissionDesk, promptText } from '../src/hub/permissions'
import { buildSettings, claudeArgs, sessionFiles, shq, tmuxName, transcriptPath, type LaunchSpec } from '../src/hub/spawn'
import { Store } from '../src/hub/store'
import { cleanEnv } from '../src/hub/tmux'

const tmp = () => mkdtempSync(join(tmpdir(), 'mmhub-test-'))

describe('launch argv', () => {
  const base: Omit<LaunchSpec, 'role'> = {
    claudeBin: '/bin/claude', sessionId: 'S1', resume: false, displayName: 'mm:r:demo:abc', model: 'sonnet', permissionMode: 'acceptEdits',
    addDirs: ['/ext'], extraArgs: ['--effort', 'low'], files: sessionFiles(paths('/state'), 'r-abc'),
  }
  test('router: read-only lockdown', () => {
    expect(claudeArgs({ ...base, role: 'router' })).toEqual([
      '/bin/claude', '--session-id', 'S1', '-n', 'mm:r:demo:abc', '--model', 'sonnet',
      '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__mmhub',
      '--append-system-prompt-file', '/state/sessions/r-abc/prompt.md', '--mcp-config', '/state/sessions/r-abc/mcp.json', '--strict-mcp-config',
      '--settings', '/state/sessions/r-abc/settings.json', '--setting-sources', 'project,local', '--add-dir', '/ext', '--effort', 'low',
      '--dangerously-load-development-channels', 'server:mmhub',
    ])
  })
  test('worker: resume, its permission mode, no tool restriction', () => {
    const a = claudeArgs({ ...base, role: 'worker', resume: true, model: 'opus', extraArgs: [] })
    expect(a.slice(0, 3)).toEqual(['/bin/claude', '--resume', 'S1'])
    expect(a).toContain('acceptEdits')
    expect(a).not.toContain('--tools')
    expect(a).not.toContain('dontAsk')
    expect(a.slice(-2)).toEqual(['--dangerously-load-development-channels', 'server:mmhub'])
  })
  test('names and paths', () => {
    expect(tmuxName('w-ab12')).toBe('mmw-ab12')
    expect(transcriptPath('/Users/x/ws/.worktrees/w-1', 'ID', '/cfg')).toBe('/cfg/projects/-Users-x-ws--worktrees-w-1/ID.jsonl')
    expect(shq('/plain/path')).toBe('/plain/path')
    expect(shq("/with space/it's")).toBe(`'/with space/it'\\''s'`)
  })
  test('settings: hub hooks appended to workspace hooks', () => {
    const s = buildSettings({
      workspaceSettings: { permissions: { allow: ['Bash(npm test)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } },
      hookCommand: 'bun hook.ts r-abc', carry: {}, disablePlugins: ['telegram@x'],
    })
    expect((s.hooks!.Stop as unknown[]).length).toBe(2)
    expect(Object.keys(s.hooks!).sort()).toEqual(['PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'StopFailure'])
    expect(s.hooks!.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bun hook.ts r-abc', timeout: 15 }] }])
    expect(s.permissions).toEqual({ allow: ['Bash(npm test)'] })
    expect(s.enabledPlugins).toEqual({ 'telegram@x': false })
  })
})

test('cleanEnv drops session and secret vars', () => {
  const e = cleanEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', MATTERMOST_BOT_TOKEN: 't', TMUX: 'x', HOME: '/h' })
  expect(e).toEqual({ PATH: '/bin', HOME: '/h' })
})

describe('access', () => {
  test('pairing codes: resend once, max 3 pending, expire', () => {
    const a = defaultAccess()
    const first = issuePairingCode(a, 'U1', 'D1', 0)!
    expect(first.isResend).toBe(false)
    expect(issuePairingCode(a, 'U1', 'D1', 1)!.isResend).toBe(true)
    expect(issuePairingCode(a, 'U1', 'D1', 2)).toBeNull()
    issuePairingCode(a, 'U2', 'D2', 0)
    issuePairingCode(a, 'U3', 'D3', 0)
    expect(issuePairingCode(a, 'U4', 'D4', 0)).toBeNull()
    expect(pruneExpired(a, 2 * 60 * 60_000)).toBe(true)
    expect(Object.keys(a.pending)).toEqual([])
  })
  test('classifySender', () => {
    const a = { ...defaultAccess(), allowFrom: ['O'], channels: { C: { allowFrom: ['M'] } } }
    expect(classifySender(a, 'O', 'C', 'O', false)).toBe('owner')
    expect(classifySender(a, 'M', 'C', 'O', false)).toBe('member')
    expect(classifySender(a, 'X', 'C', 'O', false)).toBe('blocked')
    expect(classifySender(a, 'O', 'OTHER', 'O', false)).toBe('blocked')
    expect(classifySender(a, 'O', 'OTHER', 'O', true)).toBe('owner')
  })

  test('classifySender with "*": every person is an owner, bots are not', () => {
    const a = { ...defaultAccess(), allowFrom: ['*', 'LISTED_BOT'], channels: { C: { allowFrom: ['M'] } } }
    expect(classifySender(a, 'X', 'C', 'O', false)).toBe('owner')
    expect(classifySender(a, 'X', 'D1', 'D', false)).toBe('owner') // a DM needs no pairing
    expect(classifySender(a, 'X', 'OTHER', 'O', false)).toBe('blocked') // still only where the bot listens
    expect(classifySender(a, 'B', 'C', 'O', false, true)).toBe('blocked') // a bot, not on the channel's member list
    expect(classifySender(a, 'B', 'D1', 'D', false, true)).toBe('unknown')
    expect(classifySender(a, 'LISTED_BOT', 'C', 'O', false, true)).toBe('owner') // listed by id
    expect(classifySender({ ...a, dmPolicy: 'disabled' }, 'X', 'C', 'O', false)).toBe('blocked')
    expect(isOwner(a, 'X')).toBe(true)
    expect(isOwner(a, 'B', true)).toBe(false)
    expect(ownerNeedsBotCheck(a, 'X')).toBe(true)
    expect(ownerNeedsBotCheck(a, 'LISTED_BOT')).toBe(false)
    expect(ownerNeedsBotCheck({ ...a, allowFrom: ['O'] }, 'X')).toBe(false)
  })
})

describe('digest', () => {
  const post = (id: string, at: number, msg: string, key = 'w-1') => ({ id, threadId: 'T', sessionKey: key, createAt: at, message: msg })
  test('empty → nothing', () => {
    expect(buildDigest([], {}, 0)).toEqual({ text: '', cursor: 0 })
  })
  test('header stripped, cursor = newest, titles used', () => {
    const d = buildDigest([post('a', 1000, '**🛠 Login fixes**\nFixed it on mm/w-1'), post('b', 2000, 'Tests pass')], { 'w-1': 'Login fixes' }, 62_000)
    expect(d.cursor).toBe(2000)
    expect(d.text).toContain('Login fixes (w-1), 1m ago, post a:\nFixed it on mm/w-1')
    expect(d.text).not.toContain('**🛠')
  })
  test('caps: long posts cut, oldest dropped first', () => {
    const d = buildDigest([post('old', 1, 'x'.repeat(900)), post('new', 2, 'y'.repeat(5000))], {}, 3, { perPost: 1000, total: 1200 })
    expect(d.text).toContain('…[cut]')
    expect(d.text).toContain('1 older post not shown')
    expect(d.text).not.toContain('post old')
  })
})

describe('permissions', () => {
  test('desk add / codeForPost / drain', () => {
    const desk = new PermissionDesk()
    const p = { code: 'abcde', key: 'w-1', title: 'T', toolName: 'Bash', description: 'run', inputPreview: 'ls', threadId: 'T', channelId: 'C', createdAt: 0 }
    expect(desk.add(p)).toBe(true)
    expect(desk.add(p)).toBe(false)
    desk.get('ABCDE')!.postId = 'POST'
    expect(desk.codeForPost('POST')).toBe('abcde')
    expect(desk.count('w-1')).toBe(1)
    expect(desk.drain('w-1').length).toBe(1)
    expect(desk.count('w-1')).toBe(0)
  })
  test('prompt text carries the code and survives backticks', () => {
    const t = promptText({ code: 'abcde', title: 'W', toolName: 'Bash', description: 'd', inputPreview: 'echo ```x```' })
    expect(t).toContain('yes abcde')
    expect(t).toContain('````')
    expect(PERMISSION_REPLY_RE.test('y abcde')).toBe(true)
  })
})

test('chunk prefers paragraph breaks', () => {
  const text = 'a'.repeat(60) + '\n\n' + 'b'.repeat(60)
  expect(chunk(text, 100)).toEqual(['a'.repeat(60), 'b'.repeat(60)])
})

describe('store', () => {
  test('pending tasks: interrupted before queued, oldest first', () => {
    const st = new Store(join(tmp(), 'hub.db'))
    const add = (state: 'queued' | 'interrupted') => st.insertTask({ workerKey: 'w-1', threadId: 'T', channelId: 'C', text: state, state, createdAt: 0 })
    const q1 = add('queued')
    const i1 = add('interrupted')
    const q2 = add('queued')
    expect(st.pendingTasks('w-1').map(t => t.id)).toEqual([i1, q1, q2])
    st.setTaskState(i1, 'delivered', 5)
    expect(st.task(i1)!.deliveredAt).toBe(5)
    expect(st.tasksFor('w-1', ['delivered']).length).toBe(1)
  })
  test('posts since cursor filtered by role; kv', () => {
    const st = new Store(join(tmp(), 'hub.db'))
    st.insertPost({ id: 'p1', threadId: 'T', sessionKey: 'w-1', createAt: 10, message: 'w' })
    st.insertPost({ id: 'p2', threadId: 'T', sessionKey: 'r-1', createAt: 20, message: 'r' })
    st.insertPost({ id: 'p3', threadId: 'T', sessionKey: 'w-1', createAt: 30, message: 'w2' })
    expect(st.postsSince('T', 10, 'w-').map(p => p.id)).toEqual(['p3'])
    expect(st.postOwner('p2')).toBe('r-1')
    st.set('seen:C', '42')
    expect(st.get('seen:C')).toBe('42')
    st.insertThread({ id: 'T', channelId: 'C', workspace: 'demo', routerKey: 'r-1', label: 'x', cursor: 0, createdAt: 0 })
    st.setCursor('T', 30)
    st.setCursor('T', 10)
    expect(st.thread('T')!.cursor).toBe(30)
    st.del('seen:C')
    expect(st.get('seen:C')).toBeUndefined()
  })
  test('router inbox survives in the db: pending order, interrupt and end', () => {
    const file = join(tmp(), 'hub.db')
    const st = new Store(file)
    const add = (content: string) => st.insertMessage({ sessionKey: 'r-1', content, meta: { thread_id: 'T', user: 'alice' }, state: 'queued', createdAt: 0 })
    const m1 = add('first')
    const m2 = add('second')
    st.setMessageState(m1, 'delivered')
    st.insertTask({ workerKey: 'w-1', threadId: 'T', channelId: 'C', text: 't', state: 'delivered', createdAt: 0 })
    expect(st.messagesFor('r-1', ['delivered']).map(m => m.content)).toEqual(['first'])
    // The router's process died mid-turn: what it was reading goes back first.
    expect(st.moveDelivered('r-1', 'interrupted')).toBe(1)
    expect(st.tasksFor('w-1', ['delivered']).length).toBe(1) // other sessions untouched
    st.close()
    const again = new Store(file) // a hub restart keeps them
    const pending = again.pendingMessages('r-1')
    expect(pending.map(m => [m.id, m.state])).toEqual([[m1, 'interrupted'], [m2, 'queued']])
    expect(pending[0]!.meta).toEqual({ thread_id: 'T', user: 'alice' })
    again.setMessageState(m1, 'delivered')
    again.setMessageState(m2, 'delivered')
    expect(again.moveDelivered('r-1', 'ended')).toBe(2)
    expect(again.pendingMessages('r-1')).toEqual([])
    again.pruneMessages(Date.now() + 1)
    expect(again.messagesFor('r-1', ['ended'])).toEqual([])
  })
})

test('tmp dir sanity', () => {
  expect(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')).toContain('mattermost-hub')
})

describe('bridge tools per reporting mode', () => {
  const names = (t: { name: string }[]) => t.map(x => x.name)
  test('reporting through the router: workers report, routers hear back', () => {
    const w = toolsFor('worker', 'router')
    expect(w.find(t => t.name === 'reply')!.description).toContain("thread's router")
    expect(names(w)).not.toContain('edit_message') // no posts of its own to edit
    expect(toolsFor('router', 'router').find(t => t.name === 'delegate')!.description).toContain('kind="worker_report"')
    expect(instructionsFor('router', 'router')).toContain('kind="worker_report"')
    expect(instructionsFor('worker', 'router')).toContain("goes to the thread's router")
  })
  test('workers posting in the thread themselves', () => {
    const w = toolsFor('worker', 'thread')
    expect(w.find(t => t.name === 'reply')!.description).toContain('Your title is added as a header')
    expect(names(w)).toContain('edit_message')
    expect(toolsFor('router', 'thread').find(t => t.name === 'delegate')!.description).toContain('posts its results in this thread itself')
    expect(instructionsFor('router', 'thread')).not.toContain('worker_report')
  })
})
