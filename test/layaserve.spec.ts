// laya-serve run by the hub: how it is launched (the API key stays out of argv),
// when the hub starts it again, the key on every request, and the warm-up.

import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { askLaya, DEFAULT_LAYA, layaReady, type LayaConfig } from '../src/hub/laya'
import { installed, keepServing, serveArgv, serveEnv, serveKey, servePaths, SERVE_SESSION, warmUp, type Keeper } from '../src/hub/layaserve'
import type { NewSession } from '../src/hub/tmux'
import { layaCall } from '../src/hub/trigger'

const KEY = 'k'.repeat(64)

/** A state dir with laya-serve "installed": a fake binary and a key file. */
function stateDir(script = '#!/bin/sh\necho started\n') {
  const dir = mkdtempSync(join(tmpdir(), 'mmhub-serve-'))
  const sp = servePaths({ dir })
  mkdirSync(join(sp.venv, 'bin'), { recursive: true })
  writeFileSync(sp.bin, script)
  chmodSync(sp.bin, 0o755)
  writeFileSync(sp.key, KEY + '\n', { mode: 0o600 })
  return { dir, sp }
}

const SERVE: LayaConfig = { ...DEFAULT_LAYA, url: 'http://127.0.0.1:8788', model: 'auto', serve: { port: 8788, models: ['english', 'multilingual'] } }

function fakeTmux(running = false) {
  const started: NewSession[] = []
  return {
    started,
    running: () => running,
    die: () => void (running = false),
    has: async (name: string) => name === SERVE_SESSION && running,
    newSession: async (o: NewSession) => void (started.push(o), (running = true)),
  }
}

describe('launch', () => {
  test('settings bind localhost and run offline; the key is read from its file, never put in argv or the environment given to tmux', async () => {
    const { sp } = stateDir('#!/bin/sh\necho "key=$LAYA_API_KEY port=$LAYA_PORT models=$LAYA_MODELS"\n')
    const env = serveEnv(SERVE.serve!, sp)
    expect(env).toMatchObject({ LAYA_HOST: '127.0.0.1', LAYA_PORT: '8788', LAYA_MODELS: 'english,multilingual', LAYA_DEFAULT_MODEL: 'english', HF_HOME: sp.hf, HF_HUB_OFFLINE: '1' })
    expect(env.LAYA_DEVICE).toBeUndefined()
    expect(serveEnv({ ...SERVE.serve!, device: 'cpu' }, sp).LAYA_DEVICE).toBe('cpu')
    // The models are freed after 5 idle minutes unless set otherwise; 0 keeps them loaded.
    expect(env.LAYA_IDLE_UNLOAD_SECONDS).toBe('300')
    expect(serveEnv({ ...SERVE.serve!, unloadAfterMinutes: 0 }, sp).LAYA_IDLE_UNLOAD_SECONDS).toBe('0')
    expect(serveEnv({ ...SERVE.serve!, unloadAfterMinutes: 10 }, sp).LAYA_IDLE_UNLOAD_SECONDS).toBe('600')
    const argv = serveArgv(sp)
    expect(argv).toContain(sp.key)
    expect(JSON.stringify([argv, env])).not.toContain(KEY)
    // The launch script hands the key to laya-serve, whose output goes to the log.
    const pr = Bun.spawn(argv, { env: { PATH: '/usr/bin:/bin', ...env }, stdout: 'ignore', stderr: 'ignore' })
    expect(await pr.exited).toBe(0)
    expect(readFileSync(sp.log, 'utf8')).toBe(`key=${KEY} port=8788 models=english,multilingual\n`)
  })

  test('no key file: it exits without starting laya-serve', async () => {
    const { sp } = stateDir()
    rmSync(sp.key)
    expect(installed(sp)).toBe(false)
    const run = Bun.spawn(serveArgv(sp), { stdout: 'ignore', stderr: 'ignore' })
    expect(await run.exited).toBe(97)
  })
})

describe('keepServing', () => {
  test('starts it only when configured, installed and some workspace uses Laya', async () => {
    const { sp } = stateDir()
    const t = fakeTmux()
    const k: Keeper = {}
    expect(await keepServing({ tmux: t, laya: DEFAULT_LAYA, sp, wanted: true, k, now: 0 })).toBe('off')
    expect(await keepServing({ tmux: t, laya: SERVE, sp, wanted: false, k, now: 0 })).toBe('off')
    expect(await keepServing({ tmux: t, laya: SERVE, sp: servePaths({ dir: join(tmpdir(), 'mmhub-none') }), wanted: true, k, now: 0 })).toBe('not installed')
    expect(t.started.length).toBe(0)
    expect(await keepServing({ tmux: t, laya: SERVE, sp, wanted: true, k, now: 0 })).toBe('started')
    expect(t.started[0]).toMatchObject({ name: SERVE_SESSION, cwd: sp.dir, argv: serveArgv(sp) })
    expect(await keepServing({ tmux: t, laya: SERVE, sp, wanted: true, k, now: 60_000 })).toBe('running')
    expect(t.started.length).toBe(1)
  })

  test('one that dies soon after starting is started again after 10 minutes; one that ran a while, at once', async () => {
    const { sp } = stateDir()
    const t = fakeTmux()
    const k: Keeper = {}
    const at = (now: number) => keepServing({ tmux: t, laya: SERVE, sp, wanted: true, k, now })
    expect(await at(0)).toBe('started')
    t.die()
    expect(await at(60_000)).toBe('waiting')
    expect(await at(500_000)).toBe('waiting')
    expect(await at(600_000)).toBe('started')
    expect(await at(700_000)).toBe('running')
    t.die() // ran 30 minutes, then exited
    expect(await at(2_400_000)).toBe('started')
    expect(t.started.length).toBe(3)
  })
})

describe('the API key', () => {
  test('sent as a Bearer token on every request; a refused key is named, though /health needs none', async () => {
    // As laya-serve 0.4.35 does: /health and unknown routes are open, /v1/systemone wants the key (and checks it before the body).
    const auth: (string | null)[] = []
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        auth.push(req.headers.get('authorization'))
        const path = new URL(req.url).pathname
        if (path === '/health') return Response.json({ status: 'ok', loaded: ['multilingual', 'english'], device: 'mps' })
        if (path !== '/v1/systemone') return Response.json({ detail: 'Not Found' }, { status: 404 })
        if (req.headers.get('authorization') !== `Bearer ${KEY}`) return Response.json({ error: 'invalid or missing bearer token' }, { status: 401 })
        const body = (await req.json()) as { questions?: unknown }
        if (!body.questions) return Response.json({ error: "request body must be an object with a 'questions' field" }, { status: 400 })
        return Response.json({ answers: { q: { probabilities: { greeting: 0.9, other: 0.1 } } } })
      },
    })
    const url = `http://127.0.0.1:${srv.port}`
    try {
      expect(await layaReady({ url, model: 'auto', apiKey: KEY })).toBeUndefined()
      expect(auth).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`, `Bearer ${KEY}`]) // /api/tags (404), /health, then the key check
      expect(await askLaya({ url, timeoutMs: 3000, apiKey: KEY }, { questions: {} })).toEqual({ q: { probabilities: { greeting: 0.9, other: 0.1 } } })
      expect(await layaReady({ url, model: 'auto' })).toBe(`laya-serve at ${url} refused the API key (HTTP 401)`)
      expect(await layaReady({ url, model: 'auto', apiKey: 'wrong' })).toBe(`laya-serve at ${url} refused the API key (HTTP 401)`)
      await expect(askLaya({ url, timeoutMs: 3000 }, { questions: {} })).rejects.toThrow('Laya: HTTP 401: invalid or missing bearer token')
      expect(await warmUp({ ...SERVE, url }, KEY, fetch, 5000)).toMatch(/^ready \(warm-up \d+ ms\)$/)
      expect(await warmUp({ ...SERVE, url }, 'wrong', fetch, 0)).toBe(`not ready after 0 s: laya-serve at ${url} refused the API key (HTTP 401)`)
    } finally {
      srv.stop(true)
    }
  })

  test("the hub's Laya calls carry the key when it runs laya-serve, and none with Ollama", () => {
    const { dir, sp } = stateDir()
    expect(serveKey(sp)).toBe(KEY)
    expect(layaCall({ cfg: { laya: SERVE } as never, p: { dir } as never }).apiKey).toBe(KEY)
    expect(layaCall({ cfg: { laya: DEFAULT_LAYA } as never, p: { dir } as never }).apiKey).toBeUndefined()
  })
})
