// Sleep recovery: the ticker's child keeps ticking through I/O and reports the
// gap since the last tick; the Mattermost client drops a socket that may have
// died while the machine slept and opens a new one, ignoring the old one after.

import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { Mattermost } from '../src/hub/mattermost'
import { Ticker } from '../src/hub/ticker'

async function until(what: string, fn: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out: ${what}`)
}

describe('ticker', () => {
  test('ticks come from a child process; stop ends them', async () => {
    let ticks = 0
    const t = new Ticker(() => { ticks++ }, 0.05)
    t.start()
    await until('3 ticks', () => ticks >= 3)
    t.stop()
    const after = ticks
    await Bun.sleep(300)
    expect(ticks).toBe(after)
  })

  test('each tick carries the time since the last one: a long gap is a sleep', () => {
    let now = 1_000_000
    const seen: number[] = []
    const t = new Ticker((_, gap) => seen.push(gap), 5, () => now)
    t.start()
    t.stop()
    now += 5_000
    t.tick()
    now += 49 * 60_000
    t.tick()
    expect(seen).toEqual([5_000, 49 * 60_000])
  })

  test('a throwing handler does not stop the ticks', () => {
    let calls = 0
    const t = new Ticker(() => {
      calls++
      throw new Error('boom')
    })
    t.tick()
    t.tick()
    expect(calls).toBe(2)
  })
})

describe('Mattermost reconnect', () => {
  test('opens a new socket at once, and the old one closing later changes nothing', async () => {
    const conns: ServerWebSocket<unknown>[] = []
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined
        return new Response('no', { status: 400 })
      },
      websocket: {
        open(ws) { conns.push(ws) },
        message(ws, msg) {
          const m = JSON.parse(String(msg)) as { action?: string }
          if (m.action === 'authentication_challenge') ws.send(JSON.stringify({ event: 'hello', data: {} }))
        },
      },
    })
    const mm = new Mattermost(`http://127.0.0.1:${server.port}`, 'token')
    const connects: boolean[] = []
    let disconnects = 0
    const posts: string[] = []
    try {
      mm.listen({
        onEvent: ev => { if (ev.kind === 'posted') posts.push(ev.post.message) },
        onConnect: first => connects.push(first),
        onDisconnect: () => { disconnects++ },
      })
      await until('connected', () => mm.connected)
      expect(connects).toEqual([true])

      mm.reconnect('the machine slept')
      expect(disconnects).toBe(1)
      await until('a second socket, authenticated', () => conns.length === 2 && mm.connected)
      expect(connects).toEqual([true, false]) // false: a reconnect, so the hub catches up on missed posts

      // The old socket finally closes: no third socket, still connected.
      conns[0]!.close()
      await Bun.sleep(1_500)
      expect(conns.length).toBe(2)
      expect(mm.connected).toBe(true)
      expect(disconnects).toBe(1)

      conns[1]!.send(JSON.stringify({ event: 'posted', data: { post: JSON.stringify({ id: 'p1', message: 'still hearing you' }), channel_type: 'O' } }))
      await until('the post', () => posts.length === 1)
      expect(posts).toEqual(['still hearing you'])
    } finally {
      mm.stop()
      server.stop(true)
    }
  }, 15_000)
})
