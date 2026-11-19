/**
 * Other AI agents on this machine (Hermes, Codex, Gemini CLI…) are not the sessions'
 * helpers: a worker that runs one, often in the background, hands it the work nobody
 * asked it to have. Every Bash command a session is about to run reaches the hub
 * through its PreToolUse hook. One that runs another agent's command (config
 * `otherAgents`) is denied, unless a person in the worker's thread named that agent,
 * or the scheduled job its router runs did: then they asked for it.
 *
 * The command is read like a shell would, roughly: each command of a list or pipeline
 * (`a && b | c; d`, `$(…)` even in double quotes), past env assignments and wrappers (`nohup`, `timeout 60`,
 * `npx`, `uv run`…), into `bash -c '…'`, `eval` and tmux/screen command strings. An
 * agent's name as an argument (`git commit -m "hermes support"`) is not running it.
 */

import { log } from '../shared/util'
import { askedTexts, names } from './bots'
import type { Hub } from './hub'

/** Commands that run the command after them (with their options and arguments skipped). */
const WRAPPERS = new Set([
  'nohup', 'env', 'sudo', 'exec', 'time', 'nice', 'setsid', 'caffeinate', 'command', 'builtin', 'stdbuf', 'timeout', 'gtimeout', 'xargs', 'watch',
  'npx', 'bunx', 'pnpx', 'uvx', 'pipx', 'uv', 'pnpm', 'yarn', 'npm', 'bun', 'deno', 'poetry', 'pdm', 'hatch', 'rye', 'mise', 'asdf', 'arch',
])
/** A wrapper's subcommands that run what follows (`uv run`, `npm exec`, `pnpm dlx`, `bun x`). */
const RUNS = new Set(['run', 'exec', 'dlx', 'x', 'tool'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh'])
/** Commands whose quoted arguments are commands too. */
const NESTS = new Set(['eval', 'tmux', 'screen', 'script', 'ssh'])

/** The commands of a command line: split at unquoted ; & | newlines ( ) ` and $(, each as its words, quotes removed. */
export function commandsOf(line: string): string[][] {
  const out: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  let quote: '"' | "'" | undefined
  const endWord = () => {
    if (inWord) words.push(word)
    word = ''
    inWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) out.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]
      else word += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
      inWord = true
    } else if (c === ' ' || c === '\t') endWord()
    else if (';&|\n()`'.includes(c) || (c === '$' && line[i + 1] === '(')) endCommand()
    else {
      word += c
      inWord = true
    }
  }
  endCommand()
  return out
}

/** `/usr/local/bin/hermes` → hermes, `@openai/codex@latest` → codex. */
function baseName(word: string): string {
  return (word.split('/').pop() ?? word).replace(/@[^@]*$/, '').toLowerCase()
}

/** The agent a command line runs, if it runs one of `agents`. */
export function agentIn(line: string, agents: string[], depth = 0): string | undefined {
  if (!agents.length || depth > 3) return undefined
  for (const words of commandsOf(line)) {
    let i = 0
    // Env assignments, wrappers with their options and arguments, "run"-like subcommands.
    while (i < words.length) {
      const w = words[i]!
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w.startsWith('-') || /^\d+[smhd]?$/.test(w)) i++
      else if (WRAPPERS.has(baseName(w)) || (i > 0 && RUNS.has(w))) i++
      else break
    }
    const first = words[i]
    if (!first) continue
    const name = baseName(first)
    if (agents.includes(name)) return name
    const rest = words.slice(i + 1)
    // bash -c '…', bash -lc '…'
    if (SHELLS.has(name)) {
      const c = rest.findIndex(w => /^-[a-z]*c[a-z]*$/.test(w))
      const inner = c >= 0 ? rest[c + 1] : undefined
      const hit = inner ? agentIn(inner, agents, depth + 1) : undefined
      if (hit) return hit
    }
    // eval '…', tmux new -d '…', screen -dm …, ssh host '…'
    if (NESTS.has(name)) {
      const hit = agentIn(rest.filter(w => !w.startsWith('-')).join(' ; '), agents, depth + 1)
      if (hit) return hit
    }
  }
  // $(…) and `…` run inside double quotes too (not inside single ones).
  const unquoted = line.replace(/'[^']*'/g, "''")
  for (const m of unquoted.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const hit = agentIn(m[1] ?? m[2] ?? '', agents, depth + 1)
    if (hit) return hit
  }
  return undefined
}

/** A PreToolUse hook's command: the reason to deny it, or undefined to let it run. */
export async function otherAgentCheck(hub: Hub, key: string, command: string): Promise<string | undefined> {
  const agent = agentIn(command, hub.cfg.otherAgents)
  if (!agent) return undefined
  const thread = hub.activeThreadOf(key)
  const asked = await askedTexts(hub, key, thread ? [thread] : [])
  const preview = command.replace(/\s+/g, ' ').slice(0, 160)
  if (asked.some(t => names(t, agent))) {
    log('perm', `${key}: runs ${agent}, which a person asked for: ${preview}`)
    return undefined
  }
  log('perm', `${key}: denied ${agent}, another agent nobody asked for: ${preview}`)
  return `${agent} is another AI agent: don't hand it this work, in the background or not, and don't ask it things. Do the task yourself. Run another agent only when the person asked for that one (nobody in this thread named ${agent}).`
}
