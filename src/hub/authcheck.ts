/**
 * Is a provider signed in, as the hub's sessions see it? `claude auth status` run
 * where sessions run: a throwaway tmux session in the hub's own tmux server, with a
 * session's environment and the provider's launch wrapper.
 *
 * A shell of the user's own can see another login than the hub's sessions. On macOS
 * Claude Code keeps a login in the keychain and in ~/.claude/.credentials.json; a
 * claude that can't reach the keychain (over SSH, say) uses the file, while one
 * under the hub's tmux reads the keychain item first. When the two drift apart,
 * `claude auth status` in the user's shell says "signed in" while every session
 * says "Not logged in".
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { shortId } from '../shared/util'
import { redact } from './providers'
import { providerEnvText, wrapArgv } from './spawn'
import type { Tmux } from './tmux'

export type AuthStatus = { loggedIn?: boolean; text: string }

/** How long `claude auth status` may take. */
export const AUTH_CHECK_MS = 30_000

/** One line from `claude auth status --json` (loggedIn undefined: it gave no answer). */
export function readAuthStatus(stdout: string, stderr: string, code: number): AuthStatus {
  try {
    const s = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string; email?: string; orgName?: string; subscriptionType?: string }
    const text = `${s.loggedIn ? 'signed in' : 'not signed in'} · auth ${s.authMethod ?? '?'} · API ${s.apiProvider ?? '?'}${s.email ? ` · ${s.email}` : ''}${s.orgName ? ` (${s.orgName})` : ''}${s.subscriptionType ? ` · ${s.subscriptionType}` : ''}`
    return { loggedIn: s.loggedIn === true, text }
  } catch {
    const last = (stderr.trim() || stdout.trim()).split('\n').pop()
    return { text: `claude auth status failed: ${redact(last || `exit ${code}`)}` }
  }
}

/** Runs its argv with stdout, stderr and the exit code in files under $1 (code last, so its presence means done). */
const CAPTURE_SH = 'd=$1; shift; "$@" >"$d/out" 2>"$d/err"; echo $? >"$d/code.tmp"; mv "$d/code.tmp" "$d/code"'

export async function authStatusInTmux(
  tmux: Pick<Tmux, 'newSession' | 'kill'>,
  o: {
    claudeBin: string
    cwd: string
    /** The environment a session gets (PATH, CLAUDE_CONFIG_DIR). */
    env: Record<string, string>
    /** A non-default provider's env: through a 0600 file the launch wrapper sources and deletes, as for a session. */
    providerEnv?: Record<string, string>
    timeoutMs?: number
  },
): Promise<AuthStatus> {
  const dir = mkdtempSync(join(tmpdir(), 'mmhub-auth-')) // 0700
  const name = `mmhub-auth-${shortId(6)}`
  try {
    let argv = [o.claudeBin, 'auth', 'status', '--json']
    if (o.providerEnv) {
      const envFile = join(dir, 'provider.env')
      writeFileSync(envFile, providerEnvText(o.providerEnv), { mode: 0o600 })
      argv = wrapArgv(argv, envFile)
    }
    await tmux.newSession({ name, cwd: o.cwd, argv: ['/bin/sh', '-c', CAPTURE_SH, 'mmhub-auth', dir, ...argv], env: o.env })
    const end = Date.now() + (o.timeoutMs ?? AUTH_CHECK_MS)
    const done = join(dir, 'code')
    while (!existsSync(done)) {
      if (Date.now() > end) return { text: `claude auth status gave no answer within ${Math.ceil((o.timeoutMs ?? AUTH_CHECK_MS) / 1000)} s` }
      await Bun.sleep(100)
    }
    const read = (f: string) => readFileSync(join(dir, f), 'utf8')
    return readAuthStatus(read('out'), read('err'), parseInt(read('code'), 10))
  } finally {
    await tmux.kill(name).catch(() => false)
    rmSync(dir, { recursive: true, force: true })
  }
}
