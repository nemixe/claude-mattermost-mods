/**
 * Get a freshly started interactive `claude` past its startup dialogs
 * (folder trust, development-channel warning, folders added with --add-dir)
 * without a person, by reading the tmux pane and moving the select-menu cursor (❯).
 */

import { realpathSync } from 'fs'
import type { Tmux } from './tmux'

/** `folder`: what an "Adding a new directory" dialog asks about. */
export type Dialog = { name: string; keys: string[]; folder?: string }

/** Keys that move the ❯ cursor onto the line containing `phrase` and confirm. null if not on screen. */
export function menuKeys(screen: string, phrase: string): string[] | null {
  const lines = screen.split('\n')
  const target = lines.findIndex(l => l.includes(phrase))
  if (target < 0) return null
  let cursor = -1
  for (let d = 0; d <= 8 && cursor < 0; d++) {
    for (const i of [target - d, target + d]) {
      if (i >= 0 && i < lines.length && /^\s*❯\s/.test(lines[i]!)) {
        cursor = i
        break
      }
    }
  }
  if (cursor < 0) return null
  const diff = target - cursor
  return [...Array(Math.abs(diff)).fill(diff > 0 ? 'Down' : 'Up'), 'Enter']
}

const KNOWN: { name: string; marker: string; choose: string }[] = [
  { name: 'dev-channels', marker: 'Loading development channels', choose: 'I am using this for local development' },
  { name: 'trust', marker: 'Yes, I trust this folder', choose: 'Yes, I trust this folder' },
]

const ADD_DIR = 'Adding a new directory:'

/**
 * The folder Claude Code asks about: at startup it asks for every --add-dir it
 * doesn't trust yet (a trusted parent counts), under its real path. The answer
 * holds for that session only. undefined when it isn't asking.
 */
export function askedFolder(screen: string): string | undefined {
  const lines = screen.split('\n').map(l => l.replace(/^[\s│]+|[\s│]+$/g, ''))
  const title = lines.lastIndexOf(ADD_DIR)
  if (title < 0) return undefined
  const path: string[] = []
  for (const l of lines.slice(title + 1)) {
    // The path (wrapped when long) ends at a blank line, or at the next sentence when the window is short.
    if (l ? /^This (session|directory) /.test(l) : path.length) break
    if (l) path.push(l)
  }
  return path.join(' ') || undefined
}

/** Paths compared without spaces: the screen wraps long ones. */
const bare = (p: string): string => p.normalize('NFC').replace(/\s+/g, '').replace(/(?<=.)\/+$/, '')

function isOneOf(folder: string, folders: string[]): boolean {
  return folders.some(f => {
    let real = f
    try {
      real = realpathSync.native(f)
    } catch {}
    return bare(folder) === bare(f) || bare(folder) === bare(real)
  })
}

/** `folders`: what this launch passed with --add-dir. Only those are added; any other folder is left for a person. */
export function detectDialog(screen: string, folders: string[] = []): Dialog | null {
  for (const k of KNOWN) {
    if (!screen.includes(k.marker)) continue
    const keys = menuKeys(screen, k.choose)
    if (keys) return { name: k.name, keys }
  }
  const folder = askedFolder(screen)
  if (folder && isOneOf(folder, folders)) {
    const keys = menuKeys(screen, 'Yes, add it')
    if (keys) return { name: 'add-dir', keys, folder }
  }
  return null
}

/** Something on screen is waiting for a person (an unknown dialog). */
export function looksLikePrompt(screen: string): boolean {
  return /Enter to confirm|Esc to cancel|\(y\/n\)/i.test(screen)
}

export type ShepherdOutcome = 'ready' | 'exited' | 'stuck' | 'timeout' | 'problem'

/** "Adding a new directory" drops keys in its first half second, and an Enter that comes too close behind the Down. */
const ARM_MS = 600
const KEY_GAP_MS = 120

/**
 * Watch `name` until isReady() is true, answering known dialogs (at most 6, and
 * 3 more per folder in `folders`: a session can be asked about each of them).
 * `problem`: a screen no answer fixes (a login screen): give up at once.
 */
export async function shepherd(
  tmux: Tmux,
  name: string,
  isReady: () => boolean,
  opts: { timeoutMs?: number; folders?: string[]; onDialog?: (d: Dialog) => void; problem?: (screen: string) => unknown } = {},
): Promise<ShepherdOutcome> {
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000)
  const folders = opts.folders ?? []
  const limit = 6 + 3 * folders.length
  let answered = 0
  while (Date.now() < deadline) {
    if (isReady()) return 'ready'
    if (!(await tmux.has(name))) return isReady() ? 'ready' : 'exited'
    const screen = await tmux.capture(name)
    if (opts.problem?.(screen)) return 'problem'
    let d = detectDialog(screen, folders)
    if (d?.folder) {
      await Bun.sleep(ARM_MS)
      d = detectDialog(await tmux.capture(name), folders) // what's there now gets the keys
    }
    if (d && answered < limit) {
      answered++
      opts.onDialog?.(d)
      for (const k of d.keys) {
        await tmux.keys(name, [k])
        if (d.folder) await Bun.sleep(KEY_GAP_MS)
      }
      await Bun.sleep(1500)
      continue
    }
    await Bun.sleep(700)
  }
  if (isReady()) return 'ready'
  if (!(await tmux.has(name))) return 'exited'
  const screen = await tmux.capture(name)
  return looksLikePrompt(screen) || askedFolder(screen) ? 'stuck' : 'timeout'
}

/** Wait until no known dialog or prompt is on screen (so delivered messages aren't lost). */
export async function waitForCalm(tmux: Tmux, name: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const screen = await tmux.capture(name)
    if (!detectDialog(screen) && !looksLikePrompt(screen)) return
    await Bun.sleep(700)
  }
}
