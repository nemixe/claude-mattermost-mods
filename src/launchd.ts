/**
 * The hub's launchd agent (macOS): starts it at login and restarts it when it
 * crashes. `mmhub start` goes through it too, because macOS decides by who
 * started a process which disks and folders it may read (privacy protection):
 * a hub started from a terminal or over SSH can be kept out of an external
 * disk that the agent's hub reads.
 */

import { existsSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { paths, stateDir } from './shared/paths'

export const AGENT_LABEL = 'com.claude.mmhub'

export type Agent = {
  file: string
  /** ProgramArguments. */
  args: string[]
  env: Record<string, string>
  cwd?: string
  /** Where the hub's log goes (hub.log, unless the plist was changed). */
  log?: string
  runAtLoad: boolean
}

export function agentFile(): string {
  return join(process.env.HOME ?? homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`)
}

const target = () => `gui/${process.getuid?.() ?? 0}/${AGENT_LABEL}`

async function sh(...argv: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const [out, err, code] = await Promise.all([new Response(r.stdout).text(), new Response(r.stderr).text(), r.exited])
    return { ok: code === 0, out, err: err.trim() || out.trim() || `exit ${code}` }
  } catch (err) {
    return { ok: false, out: '', err: String(err) }
  }
}

/** The installed agent; undefined when there is none (or this isn't a Mac). Throws when its plist can't be read. */
export async function readAgent(file = agentFile()): Promise<Agent | undefined> {
  if (process.platform !== 'darwin' || !existsSync(file)) return undefined
  const r = await sh('plutil', '-convert', 'json', '-o', '-', file)
  if (!r.ok) throw new Error(`can't read the hub's launchd agent ${file}: ${r.err}`)
  const j = JSON.parse(r.out) as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const args = Array.isArray(j.ProgramArguments) ? j.ProgramArguments.map(String) : []
  const program = text(j.Program)
  const env = (j.EnvironmentVariables ?? {}) as Record<string, string>
  return {
    file,
    args: program && !args.length ? [program] : args,
    env,
    cwd: text(j.WorkingDirectory),
    log: text(j.StandardErrorPath) ?? text(j.StandardOutPath),
    runAtLoad: j.RunAtLoad === true,
  }
}

/** The agent runs a program of the user's own, not the plain `bun …/src/hub/main.ts` that `mmhub agent install` writes. */
export function isCustom(a: Agent): boolean {
  return a.args.length !== 2 || !a.args[1]!.endsWith('/src/hub/main.ts')
}

/** The agent's hub is the one with this state dir (a test's or a second hub's is not). */
export function servesState(a: Agent, dir: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  const same = (p: string) => real(p) === real(dir)
  if (a.env.MMHUB_STATE_DIR || a.env.CLAUDE_CONFIG_DIR) return same(stateDir(a.env))
  return same(stateDir({})) || (!!a.cwd && same(a.cwd))
}

/** The launchd agent that runs this state dir's hub. */
export async function agentFor(dir: string = paths().dir): Promise<Agent | undefined> {
  const a = await readAgent()
  return a && servesState(a, dir) ? a : undefined
}

/**
 * Have launchd run the agent now (loading it first if need be). Returns what went
 * wrong, once launchd has run it: kickstart waits until the agent's
 * ThrottleInterval (30 s) since its last start is over.
 */
export async function launch(a: Agent): Promise<string | undefined> {
  let loaded = false
  if (!(await sh('launchctl', 'print', target())).ok) {
    const r = await sh('launchctl', 'bootstrap', target().replace(/\/[^/]+$/, ''), a.file)
    if (!r.ok) return `launchctl bootstrap failed: ${r.err}`
    if (a.runAtLoad) return undefined
    loaded = true
  }
  const r = await sh('launchctl', 'kickstart', target())
  return r.ok ? undefined : `launchctl kickstart failed${loaded ? ' (the agent was loaded)' : ''}: ${r.err}`
}

/** Unload the agent (its hub is stopped). Waits until it is gone, so it can be loaded anew. */
export async function unload(): Promise<boolean> {
  await sh('launchctl', 'bootout', target())
  for (let i = 0; i < 40; i++) {
    if (!(await sh('launchctl', 'print', target())).ok) return true
    await Bun.sleep(250)
  }
  return false
}
