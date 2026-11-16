/**
 * In-memory Mattermost stand-in for end-to-end runs: the subset of API v4 the
 * hub uses (users, channels, posts, threads, reactions, files) plus the event
 * websocket (hello, posted, reaction_added). Not a general emulator.
 */

import type { ServerWebSocket } from 'bun'

export type FakePost = {
  id: string
  create_at: number
  update_at: number
  user_id: string
  channel_id: string
  root_id: string
  message: string
  type: string
  props: Record<string, unknown>
  file_ids: string[]
  metadata: { files?: { id: string; name: string; size: number }[] }
}

type User = { id: string; username: string; is_bot?: boolean }
type Channel = { id: string; type: string; name: string; display_name: string; team_id: string }

let seq = 0
const id = (prefix: string) => (prefix + (Date.now().toString(36) + (seq++).toString(36)).padStart(24, '0')).slice(0, 26)

export function startFakeMattermost(o: { token: string; bot: User; users: User[]; channels: Channel[]; team?: string }) {
  const users = new Map([o.bot, ...o.users].map(u => [u.id, u]))
  const channels = new Map(o.channels.map(c => [c.id, c]))
  const posts = new Map<string, FakePost>()
  const reactions: { user_id: string; post_id: string; emoji_name: string }[] = []
  /** user_typing actions the hub sent over the websocket. */
  const typing: { channel_id: string; parent_id: string; at: number }[] = []
  const files = new Map<string, { id: string; name: string; size: number; data: Uint8Array }>()
  const sockets = new Set<ServerWebSocket<unknown>>()
  let lastAt = 0
  const now = () => (lastAt = Math.max(Date.now(), lastAt + 1))

  const broadcast = (event: string, data: Record<string, unknown>) => {
    const frame = JSON.stringify({ event, data, broadcast: {}, seq: seq++ })
    for (const s of sockets) s.send(frame)
  }

  function addPost(p: { user_id: string; channel_id: string; message: string; root_id?: string; props?: Record<string, unknown>; file_ids?: string[] }): FakePost {
    const at = now()
    const post: FakePost = {
      id: id('p'), create_at: at, update_at: at, user_id: p.user_id, channel_id: p.channel_id, root_id: p.root_id ?? '',
      message: p.message, type: '', props: p.props ?? {}, file_ids: p.file_ids ?? [],
      metadata: p.file_ids?.length ? { files: p.file_ids.map(f => files.get(f)!).map(f => ({ id: f.id, name: f.name, size: f.size })) } : {},
    }
    posts.set(post.id, post)
    broadcast('posted', { post: JSON.stringify(post), channel_type: channels.get(p.channel_id)?.type ?? 'O' })
    return post
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const notFound = () => json({ message: 'not found' }, 404)

  const server = Bun.serve({
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      const path = url.pathname.replace(/^\/api\/v4/, '')
      if (path === '/websocket') return srv.upgrade(req) ? undefined : new Response('upgrade failed', { status: 400 })
      if (req.headers.get('authorization') !== `Bearer ${o.token}`) return json({ message: 'unauthorized' }, 401)
      const m = req.method
      let r: RegExpExecArray | null
      if (m === 'GET' && path === '/users/me') return json(o.bot)
      if (m === 'GET' && (r = /^\/users\/username\/([^/]+)$/.exec(path))) return json([...users.values()].find(u => u.username === r![1]) ?? null, 200)
      if (m === 'GET' && (r = /^\/users\/([^/]+)$/.exec(path))) return users.has(r[1]!) ? json(users.get(r[1]!)) : notFound()
      if (m === 'GET' && (r = /^\/teams\/name\/[^/]+\/channels\/name\/([^/]+)$/.exec(path))) return json([...channels.values()].find(c => c.name === r![1]) ?? null)
      if (m === 'GET' && (r = /^\/channels\/([^/]+)$/.exec(path))) return channels.has(r[1]!) ? json(channels.get(r[1]!)) : notFound()
      if (m === 'POST' && path === '/channels/direct') {
        const [a, b] = (await req.json()) as string[]
        const cid = `dm${[a, b].sort().join('').slice(0, 24)}`
        if (!channels.has(cid)) channels.set(cid, { id: cid, type: 'D', name: `${a}__${b}`, display_name: '', team_id: '' })
        return json(channels.get(cid))
      }
      if (m === 'GET' && (r = /^\/channels\/([^/]+)\/posts$/.exec(path))) {
        const since = Number(url.searchParams.get('since') ?? 0)
        const list = [...posts.values()].filter(p => p.channel_id === r![1] && p.update_at > since)
        return json({ order: list.map(p => p.id), posts: Object.fromEntries(list.map(p => [p.id, p])) })
      }
      if (m === 'POST' && path === '/posts') {
        const body = (await req.json()) as Parameters<typeof addPost>[0]
        return json(addPost({ ...body, user_id: o.bot.id }), 201)
      }
      if (m === 'GET' && (r = /^\/posts\/([^/]+)\/thread$/.exec(path))) {
        const list = [...posts.values()].filter(p => p.id === r![1] || p.root_id === r![1])
        return json({ order: list.map(p => p.id), posts: Object.fromEntries(list.map(p => [p.id, p])) })
      }
      if (m === 'PUT' && (r = /^\/posts\/([^/]+)\/patch$/.exec(path))) {
        const p = posts.get(r[1]!)
        if (!p) return notFound()
        const body = (await req.json()) as { message?: string; props?: Record<string, unknown> }
        if (body.message !== undefined) p.message = body.message
        if (body.props) p.props = body.props
        p.update_at = now()
        return json(p)
      }
      if (m === 'GET' && (r = /^\/posts\/([^/]+)$/.exec(path))) return posts.has(r[1]!) ? json(posts.get(r[1]!)) : notFound()
      if (m === 'POST' && path === '/reactions') {
        const body = (await req.json()) as { user_id: string; post_id: string; emoji_name: string }
        reactions.push(body)
        return json(body, 201)
      }
      if (m === 'POST' && path === '/files') {
        const form = await req.formData()
        const infos = []
        for (const f of form.getAll('files') as File[]) {
          const data = new Uint8Array(await f.arrayBuffer())
          const info = { id: id('f'), name: f.name, size: data.length, data }
          files.set(info.id, info)
          infos.push({ id: info.id, name: info.name, size: info.size })
        }
        return json({ file_infos: infos }, 201)
      }
      if (m === 'GET' && (r = /^\/files\/([^/]+)\/info$/.exec(path))) {
        const f = files.get(r[1]!)
        return f ? json({ id: f.id, name: f.name, size: f.size }) : notFound()
      }
      if (m === 'GET' && (r = /^\/files\/([^/]+)$/.exec(path))) {
        const f = files.get(r[1]!)
        return f ? new Response(new Blob([f.data as BlobPart])) : notFound()
      }
      return json({ message: `fake: no route ${m} ${path}` }, 501)
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
      },
      message(ws, msg) {
        const m = JSON.parse(String(msg)) as { action?: string; data?: { token?: string; channel_id?: string; parent_id?: string } }
        if (m.action === 'authentication_challenge') {
          if (m.data?.token === o.token) ws.send(JSON.stringify({ event: 'hello', data: { server_version: 'fake' } }))
          else ws.close()
        }
        if (m.action === 'user_typing') typing.push({ channel_id: String(m.data?.channel_id), parent_id: String(m.data?.parent_id ?? ''), at: Date.now() })
      },
      close(ws) {
        sockets.delete(ws)
      },
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    /** A person posts (as if typed in Mattermost). */
    post: (userId: string, channelId: string, message: string, rootId?: string) => addPost({ user_id: userId, channel_id: channelId, message, root_id: rootId }),
    react(userId: string, postId: string, emoji: string) {
      const r = { user_id: userId, post_id: postId, emoji_name: emoji, create_at: now() }
      reactions.push(r)
      broadcast('reaction_added', { reaction: JSON.stringify(r) })
    },
    posts: () => [...posts.values()].sort((a, b) => a.create_at - b.create_at),
    thread: (rootId: string) => [...posts.values()].filter(p => p.id === rootId || p.root_id === rootId).sort((a, b) => a.create_at - b.create_at),
    reactions: () => reactions,
    typing: () => typing,
    /** Drop all websocket connections (the hub should reconnect and catch up). */
    dropSockets() {
      for (const s of sockets) s.close()
    },
    stop: () => server.stop(true),
  }
}
