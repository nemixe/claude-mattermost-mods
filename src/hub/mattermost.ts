/**
 * Minimal Mattermost API v4 client: REST over fetch, events over Bun's
 * native WebSocket (reconnects with backoff, pings, reports reconnects so the
 * hub can catch up on posts it missed).
 */

import { basename } from 'path'
import { errMsg, log } from '../shared/util'

export type MMFileInfo = { id: string; name: string; extension?: string; size: number; mime_type?: string }

export type MMPost = {
  id: string
  create_at: number
  update_at?: number
  user_id: string
  channel_id: string
  root_id: string
  message: string
  type?: string
  props?: Record<string, unknown>
  file_ids?: string[]
  metadata?: { files?: MMFileInfo[] }
}

export type MMUser = { id: string; username: string; is_bot?: boolean }
export type MMChannel = { id: string; type: string; name: string; display_name: string; team_id: string }
export type MMReaction = { user_id: string; post_id: string; emoji_name: string }

export type MMEvent =
  | { kind: 'posted'; post: MMPost; channelType: string }
  | { kind: 'reaction_added'; reaction: MMReaction }

export class MattermostError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export class Mattermost {
  readonly baseUrl: string
  private users = new Map<string, MMUser>()
  private channels = new Map<string, MMChannel>()
  private ws: WebSocket | null = null
  private seq = 1
  private stopped = false
  connected = false

  constructor(baseUrl: string, private token: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const isForm = body instanceof FormData
    const res = await fetch(`${this.baseUrl}/api/v4${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Requested-With': 'XMLHttpRequest',
        ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    })
    if (!res.ok) {
      let detail = res.statusText
      try {
        const j = (await res.json()) as { message?: string }
        if (j.message) detail = j.message
      } catch {}
      throw new MattermostError(res.status, `${method} ${path} → HTTP ${res.status}: ${detail}`)
    }
    return res
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.request(method, path, body)).json()) as T
  }

  me(): Promise<MMUser> {
    return this.json('GET', '/users/me')
  }

  async user(id: string): Promise<MMUser> {
    const hit = this.users.get(id)
    if (hit) return hit
    const u = await this.json<MMUser>('GET', `/users/${encodeURIComponent(id)}`)
    this.users.set(id, u)
    return u
  }

  /** A user by username (cached with the others); undefined when there is none. */
  async userByName(name: string): Promise<MMUser | undefined> {
    for (const u of this.users.values()) if (u.username === name) return u
    try {
      const u = await this.json<MMUser>('GET', `/users/username/${encodeURIComponent(name)}`)
      this.users.set(u.id, u)
      return u
    } catch {
      return undefined
    }
  }

  async username(id: string): Promise<string> {
    try {
      return (await this.user(id)).username
    } catch {
      return id
    }
  }

  async channel(id: string): Promise<MMChannel> {
    const hit = this.channels.get(id)
    if (hit) return hit
    const c = await this.json<MMChannel>('GET', `/channels/${encodeURIComponent(id)}`)
    this.channels.set(id, c)
    return c
  }

  directChannel(a: string, b: string): Promise<MMChannel> {
    return this.json('POST', '/channels/direct', [a, b])
  }

  createPost(p: { channel_id: string; message: string; root_id?: string; file_ids?: string[]; props?: Record<string, unknown> }): Promise<MMPost> {
    return this.json('POST', '/posts', p)
  }

  getPost(id: string): Promise<MMPost> {
    return this.json('GET', `/posts/${encodeURIComponent(id)}`)
  }

  patchPost(id: string, patch: { message?: string; props?: Record<string, unknown> }): Promise<MMPost> {
    return this.json('PUT', `/posts/${encodeURIComponent(id)}/patch`, patch)
  }

  getThread(rootId: string): Promise<{ order: string[]; posts: Record<string, MMPost> }> {
    return this.json('GET', `/posts/${encodeURIComponent(rootId)}/thread`)
  }

  /** Posts in a channel created/updated after `since` (ms epoch) — used to catch up after a reconnect. */
  postsSince(channelId: string, since: number): Promise<{ order: string[]; posts: Record<string, MMPost> }> {
    return this.json('GET', `/channels/${encodeURIComponent(channelId)}/posts?since=${since}`)
  }

  addReaction(userId: string, postId: string, emoji: string): Promise<unknown> {
    return this.json('POST', '/reactions', { user_id: userId, post_id: postId, emoji_name: emoji })
  }

  async uploadFiles(channelId: string, files: string[]): Promise<MMFileInfo[]> {
    const form = new FormData()
    form.append('channel_id', channelId)
    for (const f of files) form.append('files', Bun.file(f), basename(f))
    return (await this.json<{ file_infos: MMFileInfo[] }>('POST', '/files', form)).file_infos
  }

  fileInfo(id: string): Promise<MMFileInfo> {
    return this.json('GET', `/files/${encodeURIComponent(id)}/info`)
  }

  async downloadFile(id: string): Promise<ArrayBuffer> {
    return (await this.request('GET', `/files/${encodeURIComponent(id)}`)).arrayBuffer()
  }

  permalink(postId: string): string {
    return `${this.baseUrl}/_redirect/pl/${postId}`
  }

  /** Typing indicator inside a thread (a few seconds). Fire-and-forget. */
  typing(channelId: string, parentId: string): void {
    this.wsSend('user_typing', { channel_id: channelId, parent_id: parentId })
  }

  private wsSend(action: string, data: Record<string, unknown>): void {
    try {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ seq: this.seq++, action, data }))
    } catch {}
  }

  /**
   * Keep the event WebSocket connected. `onConnect(first)` runs after every
   * successful authentication — first=false means a reconnect (catch up).
   */
  listen(h: { onEvent: (ev: MMEvent) => void; onConnect?: (first: boolean) => void; onDisconnect?: () => void }): void {
    const url = this.baseUrl.replace(/^http/i, 'ws') + '/api/v4/websocket'
    let attempt = 0
    let everConnected = false
    /** The socket in charge; one replaced by reconnect() is ignored from then on. */
    let current: WebSocket | undefined
    let retire: (() => void) | undefined

    const connect = () => {
      if (this.stopped) return
      let lastFrame = Date.now()
      let authed = false
      const ws = new WebSocket(url)
      this.ws = ws
      current = ws
      retire = () => clearInterval(ping)
      const ping = setInterval(() => {
        if (Date.now() - lastFrame > 90_000) {
          log('ws', 'no frames for 90s — reconnecting')
          try { ws.close() } catch {}
          return
        }
        this.wsSend('ping', {})
      }, 30_000)

      ws.onopen = () => {
        this.seq = 1
        ws.send(JSON.stringify({ seq: this.seq++, action: 'authentication_challenge', data: { token: this.token } }))
      }
      ws.onmessage = ev => {
        if (current !== ws) return
        lastFrame = Date.now()
        let msg: { event?: string; data?: Record<string, unknown> }
        try {
          msg = JSON.parse(String(ev.data))
        } catch {
          return
        }
        if (msg.event === 'hello') {
          authed = true
          attempt = 0
          this.connected = true
          log('ws', 'connected')
          h.onConnect?.(!everConnected)
          everConnected = true
          return
        }
        if (!msg.event || !msg.data) return
        try {
          if (msg.event === 'posted') {
            h.onEvent({ kind: 'posted', post: JSON.parse(String(msg.data.post)) as MMPost, channelType: String(msg.data.channel_type ?? '') })
          } else if (msg.event === 'reaction_added') {
            h.onEvent({ kind: 'reaction_added', reaction: JSON.parse(String(msg.data.reaction)) as MMReaction })
          }
        } catch (err) {
          log('ws', `bad ${msg.event} payload: ${errMsg(err)}`)
        }
      }
      ws.onerror = () => {}
      ws.onclose = ev => {
        clearInterval(ping)
        if (current !== ws) return // replaced by reconnect(): the new socket is in charge
        this.connected = false
        h.onDisconnect?.()
        if (this.stopped) return
        attempt++
        const delay = Math.min(1000 * attempt, 15_000)
        log('ws', `closed (${ev.code}${authed ? '' : ', before auth'}) — retrying in ${delay / 1000}s`)
        setTimeout(connect, delay)
      }
    }
    this.reconnectNow = why => {
      if (this.stopped) return
      const old = current
      current = undefined
      retire?.()
      log('ws', `reconnecting (${why})`)
      if (this.connected) {
        this.connected = false
        h.onDisconnect?.()
      }
      // A socket that slept through its server closing it may never get a close frame: don't wait for one.
      try { old?.close() } catch {}
      attempt = 0
      connect()
    }
    connect()
  }

  private reconnectNow?: (why: string) => void

  /** Drop the event socket and open a new one now (after the machine slept, it may be dead without knowing). */
  reconnect(why: string): void {
    this.reconnectNow?.(why)
  }

  stop(): void {
    this.stopped = true
    try { this.ws?.close() } catch {}
  }
}
