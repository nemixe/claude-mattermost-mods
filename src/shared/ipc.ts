/**
 * Hub ⇄ client protocol: newline-delimited JSON over <state>/hub.sock (0600 in
 * a 0700 dir, so only this user can connect). Clients are the per-session
 * bridge, the hook notifier and the `mmhub` CLI (also used by the panel mod).
 */

export const PROTO = 1

export type Role = 'router' | 'worker'

export type HookEvent = 'SessionStart' | 'Stop' | 'StopFailure' | 'SessionEnd' | 'PreToolUse'

export type ClientMsg =
  | { t: 'hello'; proto: number; role: Role; key: string; pid: number; claudePid?: number }
  | { t: 'call'; id: number; tool: string; args: Record<string, unknown> }
  | { t: 'permission_request'; request_id: string; tool_name: string; description: string; input_preview: string }
  /** spawn: the launch the hook came from (MMHUB_SPAWN), so a late hook of a replaced process is ignored. */
  /** stop_hook_active / text (Stop): Claude Code's flag that a Stop hook already sent this turn back, and the turn's last text. */
  /** tool / command (PreToolUse): the shell command a session is about to run. */
  | { t: 'hook'; key: string; event: HookEvent; session_id?: string; source?: string; error?: string; spawn?: string; stop_hook_active?: boolean; text?: string; tool?: string; command?: string }
  | { t: 'control'; id: number; op: string; args: Record<string, unknown> }

export type HubMsg =
  | { t: 'welcome'; proto: number; ok: boolean; reason?: string }
  | { t: 'inbound'; content: string; meta: Record<string, string> }
  | { t: 'permission'; request_id: string; behavior: 'allow' | 'deny' }
  | { t: 'result'; id: number; ok: boolean; text?: string; error?: string; data?: unknown }
  /** block (Stop): send the turn back to the session with this reason instead of ending it. */
  /** deny (PreToolUse): refuse the tool call, with this reason for the session. */
  | { t: 'hook_result'; additionalContext?: string; block?: string; deny?: string }

export function encode(msg: ClientMsg | HubMsg): string {
  return JSON.stringify(msg) + '\n'
}

/** Accumulates socket data and yields complete JSON lines. */
export class LineDecoder<T> {
  private buf = ''

  push(chunk: string | Buffer | Uint8Array): T[] {
    this.buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const out: T[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      try {
        out.push(JSON.parse(line) as T)
      } catch {
        // malformed line — ignore
      }
    }
    return out
  }
}

/** One request/response round trip (hook notifier, CLI). */
export async function roundTrip(sockPath: string, msg: ClientMsg, timeoutMs = 10_000): Promise<HubMsg> {
  const net = await import('net')
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath)
    const dec = new LineDecoder<HubMsg>()
    const timer = setTimeout(() => {
      s.destroy()
      reject(new Error('timed out waiting for the hub'))
    }, timeoutMs)
    s.once('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    s.once('connect', () => s.write(encode(msg)))
    s.on('data', d => {
      for (const m of dec.push(d)) {
        if (m.t === 'welcome') continue
        clearTimeout(timer)
        s.end()
        resolve(m)
        return
      }
    })
  })
}
