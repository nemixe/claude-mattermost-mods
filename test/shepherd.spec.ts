// Getting a session past Claude Code's startup dialogs: what is read off the
// screen, which folders the hub agrees to add, and the keys in a real tmux pane.

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { askedFolder, detectDialog, looksLikePrompt, menuKeys, shepherd, type Dialog } from '../src/hub/shepherd'
import { cleanEnv, Tmux } from '../src/hub/tmux'

/** Claude Code 2.1.330's prompt, as a 200-column pane shows it (`path`: its lines). */
const prompt = (path: string[], extra: string[] = []) => [
  '─'.repeat(200),
  ' Adding a new directory:',
  '',
  ...path.map(l => ` ${l}`),
  '',
  ...extra.flatMap(l => [` ${l}`, '']),
  " This session hasn't worked here before. Is this a directory you created or one you trust?",
  '',
  " Claude Code'll be able to read, edit, and execute files here. Its skills, commands, and agents load and can run commands, and so can the git settings of its repository. Your answer holds for this",
  ' session. Starting Claude Code in this directory and trusting it there lasts, and covers its whole repository or everything below it.',
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, add it',
  '',
  ' Enter to confirm · Esc to cancel',
  '',
].join('\n')

const KNOWLEDGE = '/Volumes/DOT External Storage/claude-workspaces/project_pama-cms/knowledge'

describe('the startup dialogs', () => {
  test('the ones there were', () => {
    expect(detectDialog(' Do you trust the files in this folder?\n\n ❯ 1. Yes, I trust this folder\n   2. No, exit')).toEqual({ name: 'trust', keys: ['Enter'] })
    expect(detectDialog(' WARNING: Loading development channels\n\n ❯ 1. No, exit\n   2. I am using this for local development')).toEqual({ name: 'dev-channels', keys: ['Down', 'Enter'] })
    expect(menuKeys('   Yes\n   No', 'Yes')).toBeNull()
  })

  test('a folder the launch passed with --add-dir is added', () => {
    expect(askedFolder(prompt([KNOWLEDGE]))).toBe(KNOWLEDGE)
    expect(detectDialog(prompt([KNOWLEDGE]), ['/x/inbox', KNOWLEDGE])).toEqual({ name: 'add-dir', keys: ['Down', 'Enter'], folder: KNOWLEDGE })
    expect(detectDialog(prompt([KNOWLEDGE]), [`${KNOWLEDGE}/`])?.name).toBe('add-dir')
  })

  test('no other folder is: not its parent, not one inside it, not one whose name starts the same', () => {
    for (const folder of ['/Volumes/DOT External Storage', `${KNOWLEDGE}/sub`, `${KNOWLEDGE}-2`, '/', '/Users/macdev']) {
      expect(detectDialog(prompt([folder]), [KNOWLEDGE])).toBeNull()
    }
    expect(detectDialog(prompt([KNOWLEDGE]))).toBeNull()
    expect(detectDialog(prompt([KNOWLEDGE]), [])).toBeNull()
    // It is left for a person, and counts as a screen that waits for one.
    expect(looksLikePrompt(prompt([KNOWLEDGE]))).toBe(true)
  })

  test('a long path is wrapped, at a space or inside a name', () => {
    const long = `/Volumes/DOT External Storage/${'a'.repeat(120)}/some rather long name/knowledge`
    const at = long.indexOf(' rather')
    expect(detectDialog(prompt([long.slice(0, at), long.slice(at + 1)]), [long])?.name).toBe('add-dir')
    expect(detectDialog(prompt([long.slice(0, 100), long.slice(100)]), [long])?.name).toBe('add-dir')
    expect(detectDialog(prompt([long.slice(0, 100), long.slice(100), '/more']), [long])).toBeNull()
  })

  test('the path ends where the next sentence starts, blank line or not', () => {
    const repo = 'This directory is part of the repository at /Volumes/x. Trusting it trusts that whole repository, including its other worktrees and subdirectories.'
    expect(detectDialog(prompt([KNOWLEDGE], [repo]), [KNOWLEDGE])?.name).toBe('add-dir')
    const short = prompt([KNOWLEDGE], [repo]).split('\n').filter(Boolean).join('\n')
    expect(askedFolder(short)).toBe(KNOWLEDGE)
    expect(detectDialog(short, [KNOWLEDGE])?.keys).toEqual(['Down', 'Enter'])
  })

  test('Claude Code shows the real path of a folder reached through a link', () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'mmhub-link-')))
    mkdirSync(join(dir, 'real'))
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    expect(detectDialog(prompt([join(dir, 'real')]), [join(dir, 'link')])?.name).toBe('add-dir')
  })

  test('not on screen: nothing to answer', () => {
    expect(askedFolder('❯ what does "Adding a new directory:" mean?\n/x')).toBeUndefined()
    expect(detectDialog(`⏺ Adding a new directory: ${KNOWLEDGE}\n ❯ Yes, add it`, [KNOWLEDGE])).toBeNull()
    // Nothing to choose from yet (the prompt is still being drawn).
    expect(detectDialog(prompt([KNOWLEDGE]).split('Security guide')[0]!, [KNOWLEDGE])).toBeNull()
  })
})

const tmuxBin = Bun.which('tmux')

describe.skipIf(!tmuxBin)('in a real pane', () => {
  const socket = `mmhub-shepherdtest-${process.pid}`
  const tmux = new Tmux(socket, cleanEnv(), tmuxBin!)
  afterAll(async () => {
    await tmux.run(['kill-server'])
  })

  const dir = mkdtempSync(join(tmpdir(), 'mmhub-shepherd-'))
  const fake = join(dir, 'fake.ts')
  // A stand-in for claude asking about each folder in turn: the cursor starts on No, keys in the
  // first half second do nothing, and Yes takes an Enter right after a Down, not in one burst with it.
  writeFileSync(fake, `
import { writeFileSync } from 'fs'
const [ready, ...folders] = process.argv.slice(2)
let at = 0, yes = false, opened = 0, down = 0
const draw = () => process.stdout.write('\\x1b[2J\\x1b[H' + [
  ' Adding a new directory:', '', ' ' + folders[at], '',
  " This session hasn't worked here before. Is this a directory you created or one you trust?", '',
  (yes ? '   ' : ' ❯ ') + 'No, exit', (yes ? ' ❯ ' : '   ') + 'Yes, add it', '', ' Enter to confirm · Esc to cancel', '',
].join('\\r\\n'))
const open = () => { yes = false; down = 0; opened = Date.now(); draw() }
process.stdin.setRawMode(true)
process.stdin.on('data', chunk => {
  for (const key of String(chunk).match(/\\x1b\\[.|[^]/g) ?? []) {
    if (Date.now() - opened < 500) { open(); continue }
    if (key === '\\x1b[B' || key === '\\x1bOB') { yes = true; down = Date.now(); draw() }
    else if (key === '\\r') {
      if (!yes) process.exit(1)
      if (Date.now() - down < 20) { open(); continue }
      if (++at < folders.length) open()
      else { writeFileSync(ready, 'ok'); process.stdout.write('\\x1b[2J\\x1b[H❯ ') }
    }
  }
})
open()
`)

  async function run(name: string, asks: string[], folders: string[], timeoutMs: number) {
    const ready = join(dir, `${name}.ready`)
    const answered: Dialog[] = []
    await tmux.newSession({ name, cwd: dir, argv: [process.execPath, fake, ready, ...asks] })
    const outcome = await shepherd(tmux, name, () => existsSync(ready), { timeoutMs, folders, onDialog: d => answered.push(d) })
    return { outcome, answered: answered.map(d => d.folder) }
  }

  test('every folder the launch passed is added, however many', async () => {
    const folders = Array.from({ length: 7 }, (_, i) => `/Volumes/DOT External Storage/ws/folder ${i}`)
    const r = await run('many', folders, folders, 45_000)
    expect(r.outcome).toBe('ready')
    expect([...new Set(r.answered)]).toEqual(folders)
  }, 60_000)

  test('it stops at a folder the launch didn\'t pass, and presses nothing', async () => {
    const r = await run('foreign', ['/ws/knowledge', '/etc'], ['/ws/knowledge', '/ws/inbox'], 6000)
    expect(r.outcome).toBe('stuck')
    expect([...new Set(r.answered)]).toEqual(['/ws/knowledge'])
    const screen = await tmux.capture('foreign')
    expect(askedFolder(screen)).toBe('/etc')
    expect(screen).toContain('❯ No, exit')
  }, 20_000)
})
