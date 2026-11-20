/**
 * The skills a workspace's workers can use, for its routers to know about. Routers
 * run with Read/Grep/Glob only, so they can't use a skill; without this list they
 * try a link themselves (no login: 401) and tell the person it can't be done, when
 * a worker could do it with the machine's accounts.
 *
 * Skills come from the machine's Claude config (`<config>/skills/<name>/SKILL.md`,
 * loaded by every session) and the workspace (`<workspace>/.claude/skills/…`, which
 * wins on the same name). A skill with `disable-model-invocation: true` is left
 * out: only a person can start it.
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { baseConfigDir } from './providers'

export type Skill = { name: string; description: string }

/** Skills listed at most, and characters of a description. */
const MAX_SKILLS = 40
const MAX_DESCRIPTION = 240

/** The frontmatter fields of a SKILL.md (single-line values, and folded or literal blocks). */
export function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const out: Record<string, string> = {}
  const lines = m[1]!.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!)
    if (!kv) continue
    let value = kv[2]!.trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-' || value === '') {
      const block: string[] = []
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim())
      value = block.join(' ')
    }
    out[kv[1]!] = value.replace(/^(["'])([\s\S]*)\1$/, '$2')
  }
  return out
}

function skillsIn(dir: string): Skill[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: Skill[] = []
  for (const n of names.sort()) {
    let text: string
    try {
      text = readFileSync(join(dir, n, 'SKILL.md'), 'utf8')
    } catch {
      continue
    }
    const f = frontmatter(text)
    if (f['disable-model-invocation'] === 'true') continue
    const description = (f.description ?? '').replace(/\s+/g, ' ').trim()
    out.push({ name: f.name || n, description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION)}…` : description })
  }
  return out
}

/** The skills a workspace's workers can use: the machine's, then the workspace's own (which win on the same name). */
export function workerSkills(w: { dir: string }, configDir = baseConfigDir()): Skill[] {
  const byName = new Map<string, Skill>()
  for (const s of [...skillsIn(join(configDir, 'skills')), ...skillsIn(join(w.dir, '.claude', 'skills'))]) byName.set(s.name, s)
  return [...byName.values()].slice(0, MAX_SKILLS)
}
