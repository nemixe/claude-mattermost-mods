/** Where the hub keeps its state. Shared by hub, bridge, hook and CLI. */

import { homedir } from 'os'
import { join, resolve } from 'path'

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

export function stateDir(env: Record<string, string | undefined> = process.env): string {
  if (env.MMHUB_STATE_DIR) return resolve(expandHome(env.MMHUB_STATE_DIR))
  return join(env.CLAUDE_CONFIG_DIR ? expandHome(env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude'), 'channels', 'mattermost-hub')
}

export function paths(dir = stateDir()) {
  return {
    dir,
    env: join(dir, '.env'),
    access: join(dir, 'access.json'),
    config: join(dir, 'config.json'),
    bindings: join(dir, 'bindings.json'),
    db: join(dir, 'hub.db'),
    status: join(dir, 'status.json'),
    sock: join(dir, 'hub.sock'),
    lock: join(dir, 'hub.lock'),
    log: join(dir, 'hub.log'),
    approved: join(dir, 'approved'),
    inbox: join(dir, 'inbox'),
    sessions: join(dir, 'sessions'),
  }
}

export type Paths = ReturnType<typeof paths>

/** The plugin/repo root (this file lives in <root>/src/shared). */
export const ROOT = resolve(import.meta.dir, '..', '..')
