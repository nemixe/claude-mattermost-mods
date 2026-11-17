/**
 * Control ops from `mmhub` (and so from the panel mod): session stop / wake /
 * restart / pin / unpin, status, reload, shutdown. Answers are `{ok, message}`.
 */

import { SESSION_KEY_RE } from '../shared/snapshot'
import type { Hub } from './hub'
import { isLive } from './lifecycle'

export type ControlResult = { ok: boolean; message: string; data?: unknown }

export async function control(hub: Hub, op: string, args: Record<string, unknown>, shutdown: () => void): Promise<ControlResult> {
  switch (op) {
    case 'ping':
      return { ok: true, message: `hub ${hub.deps.version} running (pid ${process.pid})` }
    case 'status':
      return { ok: true, message: 'ok', data: hub.snapshot() }
    case 'reload': {
      hub.reloadConfig()
      // Changed provider chains: live sessions move over (after their current turn).
      const moved = await hub.enqueue(() => hub.rebalanceProviders())
      await hub.enqueue(() => hub.keepLaya()) // laya-serve switched on, or its port changed
      hub.status.write()
      return { ok: true, message: `config reloaded${moved ? `; ${moved} session${moved === 1 ? '' : 's'} moving to another provider` : ''}` }
    }
    case 'provider': {
      // reset: forget a provider's failures (it was fixed) · changed: providers.json or a chain changed
      const sub = String(args.op ?? '')
      const name = String(args.name ?? '')
      if (sub !== 'reset' && sub !== 'changed') return { ok: false, message: `unknown provider op ${sub.slice(0, 20)} (reset|changed)` }
      const res = await hub.enqueue(async (): Promise<ControlResult> => {
        hub.reloadConfig()
        const had = sub === 'reset' ? hub.resetProvider(name) : false
        const moved = await hub.rebalanceProviders()
        const what = sub === 'reset' ? (had ? `${name}: failures forgotten` : `${name} had no failures`) : 'providers re-read'
        return { ok: true, message: `${what}${moved ? `; ${moved} session${moved === 1 ? '' : 's'} moving to another provider` : ''}` }
      })
      hub.status.write()
      return res
    }
    case 'shutdown':
      setTimeout(shutdown, 100)
      return { ok: true, message: 'hub stopping (sessions keep running and are adopted at next start)' }
    case 'session': {
      const sub = String(args.op ?? '')
      const key = String(args.key ?? '')
      const now = args.now === true
      if (sub === 'restart' && (key === 'all' || key === 'workers' || key === 'routers')) {
        const res = await hub.enqueue(() => hub.restartAll(key === 'all' ? undefined : key === 'workers' ? 'worker' : 'router', now))
        hub.status.write()
        return res
      }
      if (!SESSION_KEY_RE.test(key)) return { ok: false, message: `malformed session key ${key.slice(0, 40)}` }
      const res = await hub.enqueue(async (): Promise<ControlResult> => {
        const row = hub.store.session(key)
        if (!row) return { ok: false, message: `no session ${key}` }
        const label = `${key} (${hub.label(key)})`
        switch (sub) {
          case 'stop':
            if (!isLive(row.status)) return { ok: true, message: `${label} is already ${row.status}` }
            await hub.close(key, 'manual')
            return { ok: true, message: `closed ${label}` }
          case 'wake':
            return hub.wake(key)
          case 'restart': {
            const r = await hub.restart(key, now)
            return { ok: r.ok, message: r.message, data: { state: r.state } }
          }
          case 'pin':
          case 'unpin':
            hub.patch(key, { pinned: sub === 'pin' })
            return { ok: true, message: `${sub === 'pin' ? 'pinned' : 'unpinned'} ${label}` }
          default:
            return { ok: false, message: `unknown session op ${sub} (stop|wake|restart|pin|unpin)` }
        }
      })
      hub.status.write() // the panel re-reads right after the CLI answers
      return res
    }
    default:
      return { ok: false, message: `unknown op ${op}` }
  }
}
