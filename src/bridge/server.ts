#!/usr/bin/env bun
/**
 * The channel bridge: one per Claude Code session, launched from the
 * generated --mcp-config as server "mmhub". Pushes hub messages into the
 * session (notifications/claude/channel), forwards tool calls and permission
 * prompts to the hub. Never starts the hub; reconnects when it restarts and
 * replays unanswered permission prompts.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import net from 'net'
import { z } from 'zod'
import { encode, LineDecoder, PROTO, type ClientMsg, type HubMsg, type Role } from '../shared/ipc'
import { paths } from '../shared/paths'
import { META_KEY_RE } from '../shared/util'
import { instructionsFor, toolsFor, type Reports } from './tools'

const KEY = process.env.MMHUB_SESSION_KEY ?? ''
const ROLE: Role = process.env.MMHUB_ROLE === 'worker' ? 'worker' : 'router'
const REPORTS: Reports = process.env.MMHUB_REPORTS === 'thread' ? 'thread' : 'router'
const DIRECT = process.env.MMHUB_DIRECT === '1'
const SOCK = paths().sock

function log(msg: string): void {
  process.stderr.write(`mmhub bridge ${KEY}: ${msg}\n`)
}

const mcp = new Server(
  { name: 'mmhub', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        ...(ROLE === 'worker' ? { 'claude/channel/permission': {} } : {}),
      },
    },
    instructions: instructionsFor(ROLE, REPORTS, DIRECT),
  },
)

// ---------------------------------------------------------------- hub link

let sock: net.Socket | null = null
let welcomed = false
let nextId = 1
const calls = new Map<number, { resolve: (m: Extract<HubMsg, { t: 'result' }>) => void; timer: ReturnType<typeof setTimeout> }>()
/** Permission prompts not answered yet (replayed after a reconnect). */
const pendingPerms = new Map<string, Extract<ClientMsg, { t: 'permission_request' }>>()

function sendHub(m: ClientMsg): boolean {
  if (!sock || sock.destroyed || !welcomed) return false
  sock.write(encode(m))
  return true
}

function connect(delay = 0): void {
  setTimeout(() => {
    const s = net.createConnection(SOCK)
    const dec = new LineDecoder<HubMsg>()
    sock = s
    welcomed = false
    s.on('connect', () => {
      s.write(encode({ t: 'hello', proto: PROTO, role: ROLE, key: KEY, pid: process.pid, claudePid: process.ppid }))
    })
    s.on('data', d => {
      for (const m of dec.push(d)) onHub(m)
    })
    s.on('error', () => {})
    s.on('close', () => {
      const was = welcomed
      welcomed = false
      if (sock === s) sock = null
      for (const [id, c] of calls) {
        clearTimeout(c.timer)
        c.resolve({ t: 'result', id, ok: false, error: 'lost the connection to the hub — try again in a moment' })
      }
      calls.clear()
      if (was) log('hub connection closed — reconnecting')
      connect(was ? 1000 : 3000)
    })
  }, delay)
}

function onHub(m: HubMsg): void {
  switch (m.t) {
    case 'welcome':
      if (!m.ok) {
        log(`hub refused: ${m.reason ?? '?'}`)
        sock?.destroy()
        return
      }
      welcomed = true
      for (const p of pendingPerms.values()) sendHub(p)
      return
    case 'inbound': {
      const meta: Record<string, string> = {}
      for (const [k, v] of Object.entries(m.meta)) if (META_KEY_RE.test(k)) meta[k] = String(v)
      void mcp.notification({ method: 'notifications/claude/channel', params: { content: m.content, meta } }).catch(err => log(`deliver failed: ${err}`))
      return
    }
    case 'permission':
      pendingPerms.delete(m.request_id)
      void mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: m.request_id, behavior: m.behavior } }).catch(() => {})
      return
    case 'result': {
      const c = calls.get(m.id)
      if (!c) return
      calls.delete(m.id)
      clearTimeout(c.timer)
      c.resolve(m)
      return
    }
  }
}

function call(tool: string, args: Record<string, unknown>): Promise<Extract<HubMsg, { t: 'result' }>> {
  return new Promise(resolve => {
    const id = nextId++
    const timer = setTimeout(() => {
      calls.delete(id)
      resolve({ t: 'result', id, ok: false, error: 'the hub did not answer in time' })
    }, 180_000)
    calls.set(id, { resolve, timer })
    if (!sendHub({ t: 'call', id, tool, args })) {
      clearTimeout(timer)
      calls.delete(id)
      resolve({ t: 'result', id, ok: false, error: 'the hub is not reachable right now — try again in a moment' })
    }
  })
}

// ---------------------------------------------------------------- MCP side

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(ROLE, REPORTS, DIRECT) }))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const r = await call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
  return r.ok
    ? { content: [{ type: 'text', text: r.text ?? 'ok' }] }
    : { content: [{ type: 'text', text: `${req.params.name} failed: ${r.error ?? 'unknown error'}` }], isError: true }
})

if (ROLE === 'worker') {
  mcp.setNotificationHandler(
    z.object({
      method: z.literal('notifications/claude/channel/permission_request'),
      params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
    }),
    async ({ params }) => {
      const m: Extract<ClientMsg, { t: 'permission_request' }> = { t: 'permission_request', ...params }
      pendingPerms.set(params.request_id, m)
      sendHub(m)
    },
  )
}

// Bind to the hub only once Claude Code has finished MCP setup (+1 s), so
// channel events are never pushed before the session can take them.
mcp.oninitialized = () => connect(1000)

if (!/^(r|w)-[a-z0-9]+$/.test(KEY)) log('MMHUB_SESSION_KEY missing or malformed — tools will fail')
await mcp.connect(new StdioServerTransport())
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
