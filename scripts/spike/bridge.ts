#!/usr/bin/env bun
/**
 * Spike-only channel bridge. Forwards lines appended to <SPIKE_DIR>/inbox-<key>.jsonl
 * as channel events, logs tool calls and permission requests to events.jsonl, and
 * (worker role) auto-answers permission requests with SPIKE_PERM (allow|deny).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'

const DIR = process.env.SPIKE_DIR!
const ROLE = process.env.MMHUB_ROLE ?? 'router'
const KEY = process.env.MMHUB_SESSION_KEY ?? 'unknown'
const PERM = process.env.SPIKE_PERM ?? 'allow'

function log(o: Record<string, unknown>): void {
  appendFileSync(join(DIR, 'events.jsonl'), JSON.stringify({ at: Date.now(), src: 'bridge', key: KEY, ...o }) + '\n')
}

const mcp = new Server(
  { name: 'mmhub', version: '0.0.1' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
        ...(ROLE === 'worker' ? { 'claude/channel/permission': {} } : {}),
      },
    },
    instructions:
      'Messages arrive as <channel source="mmhub" ...>. The sender cannot see your transcript; anything you want them to see must go through the reply tool.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply to the sender.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  log({ ev: 'tool', tool: req.params.name, args: req.params.arguments })
  return { content: [{ type: 'text', text: 'sent' }] }
})

mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
  }),
  async ({ params }) => {
    log({ ev: 'permission_request', ...params })
    setTimeout(() => {
      void mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: params.request_id, behavior: PERM } })
      log({ ev: 'permission_answer', request_id: params.request_id, behavior: PERM })
    }, 1000)
  },
)

let seen = 0
function poll(): void {
  const file = join(DIR, `inbox-${KEY}.jsonl`)
  if (!existsSync(file)) return
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  for (; seen < lines.length; seen++) {
    const msg = JSON.parse(lines[seen]!) as { content: string; meta?: Record<string, string> }
    void mcp
      .notification({ method: 'notifications/claude/channel', params: { content: msg.content, meta: msg.meta ?? {} } })
      .then(() => log({ ev: 'delivered', n: seen }), err => log({ ev: 'deliver_failed', err: String(err) }))
  }
}

mcp.oninitialized = () => {
  log({ ev: 'initialized' })
  setTimeout(() => setInterval(poll, 300), 1000)
}

await mcp.connect(new StdioServerTransport())
process.stdin.on('end', () => process.exit(0))
