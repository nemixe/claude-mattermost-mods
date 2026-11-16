/**
 * Thin wrapper over a private tmux server (`tmux -L <socket>`), so hub
 * sessions never mix with the user's own tmux and inherit a clean env.
 */

export type RunResult = { code: number; stdout: string; stderr: string }

/** Env vars that tie a process to the Claude Code session that started it. */
const DROP_EXACT = new Set([
  'CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_ENV_FILE',
  'MCP_CONNECTION_NONBLOCKING', 'MCP_SERVER_CONNECTION_BATCH_SIZE', 'TMUX', 'TMUX_PANE',
])
const DROP_PREFIX = ['CLAUDE_CODE_', 'CLAUDE_AGENT_', 'CLAUDE_PLUGIN_', 'CLAUDE_PREVIEW_', 'MMHUB_', 'SPIKE_', 'MATTERMOST_']

export function cleanEnv(src: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || DROP_EXACT.has(k) || DROP_PREFIX.some(p => k.startsWith(p))) continue
    out[k] = v
  }
  return out
}

export type NewSession = {
  name: string
  cwd: string
  argv: string[]
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export class Tmux {
  constructor(
    readonly socket: string,
    private readonly baseEnv: Record<string, string> = cleanEnv(),
    private readonly bin = 'tmux',
  ) {}

  async run(args: string[]): Promise<RunResult> {
    const p = Bun.spawn([this.bin, '-L', this.socket, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: this.baseEnv,
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    return { code, stdout, stderr }
  }

  /** argv for new-session; tmux ≥3 execs a multi-arg command directly (no shell). */
  newSessionArgs(o: NewSession): string[] {
    const envArgs = Object.entries(o.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`])
    return [
      'new-session', '-d', '-s', o.name, '-x', String(o.cols ?? 200), '-y', String(o.rows ?? 50),
      '-c', o.cwd, ...envArgs, ...o.argv,
    ]
  }

  async newSession(o: NewSession): Promise<void> {
    const r = await this.run(this.newSessionArgs(o))
    if (r.code !== 0) throw new Error(`tmux new-session failed: ${r.stderr.trim() || `exit ${r.code}`}`)
  }

  async has(name: string): Promise<boolean> {
    return (await this.run(['has-session', '-t', `=${name}`])).code === 0
  }

  async kill(name: string): Promise<boolean> {
    return (await this.run(['kill-session', '-t', `=${name}`])).code === 0
  }

  async capture(name: string): Promise<string> {
    const r = await this.run(['capture-pane', '-p', '-t', `=${name}:`])
    return r.code === 0 ? r.stdout : ''
  }

  /** Named keys (Enter, Down, Escape, C-c) — one send-keys call per key. */
  async keys(name: string, keys: string[]): Promise<void> {
    for (const k of keys) await this.run(['send-keys', '-t', `=${name}:`, k])
  }

  /** Literal text (no key-name lookup). */
  async text(name: string, text: string): Promise<void> {
    await this.run(['send-keys', '-t', `=${name}:`, '-l', text])
  }

  async list(): Promise<string[]> {
    const r = await this.run(['list-sessions', '-F', '#{session_name}'])
    return r.code === 0 ? r.stdout.split('\n').map(s => s.trim()).filter(Boolean) : []
  }

  /** Number of clients (people) attached to the session. */
  async clients(name: string): Promise<number> {
    const r = await this.run(['list-clients', '-t', `=${name}`, '-F', '#{client_name}'])
    return r.code === 0 ? r.stdout.split('\n').filter(Boolean).length : 0
  }

  /** pid of the pane's process (the claude CLI). */
  async panePid(name: string): Promise<number | undefined> {
    const r = await this.run(['list-panes', '-t', `=${name}:`, '-F', '#{pane_pid}'])
    const pid = parseInt(r.stdout.trim().split('\n')[0] ?? '', 10)
    return Number.isFinite(pid) ? pid : undefined
  }
}
