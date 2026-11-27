/**
 * Loaded into the hub's workers (--plugin-dir): the main loop's model requests
 * go at the effort the router chose for the work in hand. The hub writes it to
 * <state>/sessions/<key>/effort when it sends a task that names one; with no
 * file the session runs at its own level. Subagents keep theirs.
 *
 * Claude Code's /effort can't do this: in an interactive session it also saves
 * the level as the default for the person's own new sessions.
 *
 * Everything is inside register, so the test can load it as an inline plugin.
 */

import type { Register } from 'claude-code'

export const register: Register = on => {
  const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
  type Level = (typeof LEVELS)[number]
  const isLevel = (s: string): s is Level => (LEVELS as readonly string[]).includes(s)

  on('turn.step', async function* ($, e, next) {
    // A subagent's request, or a model that takes no effort: as it is.
    if (e.agentId !== undefined || e.effort === undefined) return yield* next(e)
    // The level the hub chose for this session, if any.
    const [dir, key] = await Promise.all([$.env.get('MMHUB_STATE_DIR'), $.env.get('MMHUB_SESSION_KEY')])
    let level: Level | undefined
    if (dir && key && /^w-[\w-]+$/.test(key)) {
      try {
        const text = (await $.fs.read(`${dir.replace(/\/+$/, '')}/sessions/${key}/effort`)).trim()
        if (isLevel(text)) level = text
      } catch {} // none chosen
    }
    return yield* next(level && level !== e.effort ? { ...e, effort: level } : e)
  })
}
