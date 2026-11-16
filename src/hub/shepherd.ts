/**
 * Get a freshly started interactive `claude` past its startup dialogs
 * (folder trust, development-channel warning) without a person, by reading
 * the tmux pane and moving the select-menu cursor (❯).
 */

import type { Tmux } from './tmux'

export type Dialog = { name: string; keys: string[] }

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

export function detectDialog(screen: string): Dialog | null {
  for (const k of KNOWN) {
    if (!screen.includes(k.marker)) continue
    const keys = menuKeys(screen, k.choose)
    if (keys) return { name: k.name, keys }
  }
  return null
}

/** Something on screen is waiting for a person (an unknown dialog). */
export function looksLikePrompt(screen: string): boolean {
  return /Enter to confirm|Esc to cancel|\(y\/n\)/i.test(screen)
}

export type ShepherdOutcome = 'ready' | 'exited' | 'stuck' | 'timeout' | 'problem'

/**
 * Watch `name` until isReady() is true, answering known dialogs (at most 6).
 * `problem`: a screen no answer fixes (a login screen): give up at once.
 */
export async function shepherd(
  tmux: Tmux,
  name: string,
  isReady: () => boolean,
  opts: { timeoutMs?: number; onDialog?: (d: Dialog) => void; problem?: (screen: string) => unknown } = {},
): Promise<ShepherdOutcome> {
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000)
  let answered = 0
  while (Date.now() < deadline) {
    if (isReady()) return 'ready'
    if (!(await tmux.has(name))) return isReady() ? 'ready' : 'exited'
    const screen = await tmux.capture(name)
    if (opts.problem?.(screen)) return 'problem'
    const d = detectDialog(screen)
    if (d && answered < 6) {
      answered++
      opts.onDialog?.(d)
      await tmux.keys(name, d.keys)
      await Bun.sleep(1500)
      continue
    }
    await Bun.sleep(700)
  }
  if (isReady()) return 'ready'
  if (!(await tmux.has(name))) return 'exited'
  return looksLikePrompt(await tmux.capture(name)) ? 'stuck' : 'timeout'
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
