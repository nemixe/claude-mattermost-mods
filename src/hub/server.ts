/**
 * The hub's unix socket: bridges (long-lived, `hello` first), hook notifiers
 * and the CLI / panel (`control`, one round trip each).
 */

import { chmodSync, existsSync, unlinkSync } from 'fs'
import net from 'net'
import { encode, LineDecoder, PROTO, type ClientMsg, type HubMsg } from '../shared/ipc'
import { SESSION_KEY_RE } from '../shared/snapshot'
import { errMsg, log } from '../shared/util'
import type { BridgeConn, Hub } from './hub'
import { handleCall, ToolError } from './tools'

export type ControlHandler = (op: string, args: Record<string, unknown>) => Promise<{ ok: boolean; message: string; data?: unknown }>

export function listen(hub: Hub, sockPath: string, control: ControlHandler): net.Server {
  if (existsSync(sockPath)) unlinkSync(sockPath)
  const server = net.createServer(sock => {
    const dec = new LineDecoder<ClientMsg>()
    const send = (m: HubMsg) => {
      if (!sock.destroyed) sock.write(encode(m))
    }
    let bridge: { key: string; conn: BridgeConn } | undefined

    sock.on('data', chunk => {
      for (const m of dec.push(chunk)) void handle(m)
    })
    sock.on('error', () => {})
    sock.on('close', () => {
      if (bridge) hub.onBridgeGone(bridge.key, bridge.conn)
    })

    async function handle(m: ClientMsg): Promise<void> {
      try {
        switch (m.t) {
          case 'hello': {
            if (m.proto !== PROTO) return send({ t: 'welcome', proto: PROTO, ok: false, reason: `protocol ${m.proto} ≠ hub ${PROTO} — restart the hub` })
            const row = SESSION_KEY_RE.test(m.key) ? hub.store.session(m.key) : undefined
            if (!row || row.role !== m.role) return send({ t: 'welcome', proto: PROTO, ok: false, reason: `unknown session ${m.key}` })
            const conn: BridgeConn = { send, end: () => sock.end(), role: m.role, pid: m.pid }
            bridge = { key: m.key, conn }
            send({ t: 'welcome', proto: PROTO, ok: true })
            hub.onBridgeHello(m.key, conn)
            log('bridge', `${m.key} connected (pid ${m.pid})`)
            return
          }
          case 'call': {
            if (!bridge) return send({ t: 'result', id: m.id, ok: false, error: 'say hello first' })
            try {
              const text = await handleCall(hub, bridge.key, m.tool, m.args ?? {})
              send({ t: 'result', id: m.id, ok: true, text })
            } catch (err) {
              if (!(err instanceof ToolError)) log('tool', `${bridge.key} ${m.tool}: ${errMsg(err)}`)
              send({ t: 'result', id: m.id, ok: false, error: errMsg(err) })
            }
            return
          }
          case 'permission_request': {
            if (!bridge || bridge.conn.role !== 'worker') return
            const key = bridge.key
            await hub.enqueue(() => hub.onPermissionRequest(key, m))
            return
          }
          case 'hook': {
            if (!SESSION_KEY_RE.test(m.key)) return send({ t: 'hook_result' })
            const additionalContext = m.event === 'SessionStart' ? hub.hookContext(m.key) : undefined
            // A turn sent back goes on: its Stop isn't the end of it.
            const block = hub.unpostedStop(m)
            send({ t: 'hook_result', ...(additionalContext ? { additionalContext } : {}), ...(block ? { block } : {}) })
            if (!block) void hub.enqueue(() => hub.applyHook(m))
            return
          }
          case 'control': {
            try {
              const r = await control(m.op, m.args ?? {})
              send({ t: 'result', id: m.id, ok: r.ok, text: r.message, data: r.data })
            } catch (err) {
              send({ t: 'result', id: m.id, ok: false, error: errMsg(err) })
            }
            return
          }
        }
      } catch (err) {
        log('socket', `${m.t}: ${errMsg(err)}`)
      }
    }
  })
  server.listen(sockPath, () => {
    try {
      chmodSync(sockPath, 0o600)
    } catch {}
  })
  return server
}
