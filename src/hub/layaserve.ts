/**
 * Laya's own server (`laya-serve`, from Laya's makers) run by the hub, for machines
 * without Ollama. It answers the same /v1/systemone requests; measured on 540 posts
 * it decided exactly as Ollama did.
 *
 * `mmhub laya install` puts everything in <state>/laya: a Python venv (made with uv,
 * which fetches its own Python) holding the pinned `laya` package, the models
 * (English and multilingual) under hf/, and a random API key (0600). It then sets
 * `laya.serve` in config.json. From then on the hub keeps laya-serve running in the
 * tmux session `mmhub-laya` while some workspace's trigger is "laya": it starts it
 * when the session is gone (a crash ends it), waits longer after one that died
 * young, and sends one small request after each start, so the first real post
 * doesn't pay the warm-up. laya-serve binds 127.0.0.1, needs the key on every
 * request, and works offline: the models are downloaded at install.
 *
 * Memory: loaded, both models take about 3.6 GB (2.8 GB of it on the GPU), English
 * alone about 2.9 GB; idle, the process keeps about 0.5 GB. So laya-serve frees the
 * models after DEFAULT_UNLOAD_MINUTES without a request, as Ollama does, and loads
 * one again when a post needs it: that post takes about 2-3 s instead of 0.1-0.2 s
 * (measured on an M-series Mac), inside the hub's 5 s limit. The multilingual model
 * loads only for a post in another language.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Paths } from '../shared/paths'
import { errMsg, log } from '../shared/util'
import { askLaya, layaReady, type LayaConfig, type ServeConfig } from './laya'
import type { Tmux } from './tmux'

/** The version measured against Ollama (Nov 2026); install pins it. */
export const LAYA_PACKAGE = 'laya[serve]==0.4.35'
export const LAYA_PYTHON = '3.12'
export const SERVE_SESSION = 'mmhub-laya'
export const DEFAULT_SERVE_PORT = 8788
/** The checkpoints laya-serve can load: `english` (the one Ollama's `laya` is) and `multilingual` (100+ languages). */
export const SERVE_MODELS = ['english', 'multilingual'] as const
/** A start that dies sooner than this is a failed start: wait RETRY_AFTER_MS before the next. */
const YOUNG_MS = 120_000
const RETRY_AFTER_MS = 600_000
/** Ollama's default keep-alive too. */
export const DEFAULT_UNLOAD_MINUTES = 5

export function servePaths(p: Pick<Paths, 'dir'>) {
  const dir = join(p.dir, 'laya')
  const venv = join(dir, 'venv')
  return {
    dir,
    venv,
    python: join(venv, 'bin', 'python'),
    bin: join(venv, 'bin', 'laya-serve'),
    hf: join(dir, 'hf'),
    key: join(dir, 'api-key'),
    log: join(dir, 'serve.log'),
  }
}
export type ServePaths = ReturnType<typeof servePaths>

export function installed(sp: ServePaths): boolean {
  return existsSync(sp.bin) && existsSync(sp.key)
}

/** The installed laya version, from the venv's package metadata. */
export function installedVersion(sp: ServePaths): string | undefined {
  try {
    const lib = join(sp.venv, 'lib')
    for (const py of readdirSync(lib)) {
      for (const d of readdirSync(join(lib, py, 'site-packages'))) {
        const m = /^laya-([\w.]+)\.dist-info$/.exec(d)
        if (m) return m[1]
      }
    }
  } catch {}
  return undefined
}

export function serveKey(sp: ServePaths): string | undefined {
  try {
    return readFileSync(sp.key, 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** laya-serve's settings. None is secret: the launch script reads the key from its file. */
export function serveEnv(cfg: ServeConfig, sp: ServePaths): Record<string, string> {
  return {
    LAYA_HOST: '127.0.0.1',
    LAYA_PORT: String(cfg.port),
    LAYA_MODELS: cfg.models.join(','),
    // A post with no clear language goes to the English checkpoint.
    LAYA_DEFAULT_MODEL: 'english',
    LAYA_PRELOAD: '1',
    LAYA_MAX_LOADED: String(Math.max(2, cfg.models.length)),
    LAYA_IDLE_UNLOAD_SECONDS: String(Math.round((cfg.unloadAfterMinutes ?? DEFAULT_UNLOAD_MINUTES) * 60)),
    LAYA_LOG_LEVEL: 'warning',
    HF_HOME: sp.hf,
    HF_HUB_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    // transformers probes for TensorFlow at import, which can hang model loading.
    USE_TF: '0',
    ...(cfg.device ? { LAYA_DEVICE: cfg.device } : {}),
  }
}

/** Reads the key into LAYA_API_KEY ($1 is its file: only the path is in argv), appends output to the log ($3), runs laya-serve ($2). */
const SERVE_SH = 'LAYA_API_KEY=$(cat "$1") || exit 97; export LAYA_API_KEY; exec "$2" >>"$3" 2>&1'

export function serveArgv(sp: ServePaths): string[] {
  return ['/bin/sh', '-c', SERVE_SH, 'mmhub-laya', sp.key, sp.bin, sp.log]
}

export async function startServe(tmux: Pick<Tmux, 'newSession'>, cfg: ServeConfig, sp: ServePaths): Promise<void> {
  await tmux.newSession({ name: SERVE_SESSION, cwd: sp.dir, argv: serveArgv(sp), env: serveEnv(cfg, sp) })
}

/** What the hub remembers between checks. */
export type Keeper = { startedAt?: number; retryAt?: number; warned?: boolean }

/**
 * Keep laya-serve running while it is wanted (configured, installed, and some
 * workspace uses Laya). Never stops it: `mmhub laya use ollama` does.
 */
export async function keepServing(o: {
  tmux: Pick<Tmux, 'has' | 'newSession'>
  laya: LayaConfig
  sp: ServePaths
  wanted: boolean
  k: Keeper
  now: number
}): Promise<'off' | 'not installed' | 'running' | 'started' | 'waiting'> {
  const serve = o.laya.serve
  if (!serve || !o.wanted) return 'off'
  if (!installed(o.sp)) return 'not installed'
  if (await o.tmux.has(SERVE_SESSION)) return 'running'
  if (o.k.startedAt !== undefined && o.now - o.k.startedAt < YOUNG_MS) {
    o.k.retryAt = o.k.startedAt + RETRY_AFTER_MS
    log('trigger', `laya-serve stopped soon after it started; trying again in ${RETRY_AFTER_MS / 60_000} min (log: ${o.sp.log})`)
    o.k.startedAt = undefined
  }
  if (o.k.retryAt !== undefined && o.now < o.k.retryAt) return 'waiting'
  o.k.retryAt = undefined
  await startServe(o.tmux, serve, o.sp)
  o.k.startedAt = o.now
  log('trigger', `laya-serve: started on 127.0.0.1:${serve.port} (${serve.models.join(', ')})`)
  return 'started'
}

/** After a start: wait until it answers (models load), then one small request, so the device is warm for the first post. */
export async function warmUp(laya: LayaConfig, apiKey: string | undefined, fetchFn: typeof fetch = fetch, waitMs = 300_000): Promise<string> {
  const cfg = { ...laya, apiKey }
  const end = Date.now() + waitMs
  let why = await layaReady(cfg, fetchFn)
  while (why && Date.now() < end) {
    await Bun.sleep(2000)
    why = await layaReady(cfg, fetchFn)
  }
  if (why) return `not ready after ${Math.round(waitMs / 1000)} s: ${why}`
  const t = Date.now()
  try {
    await askLaya({ ...cfg, timeoutMs: 120_000 }, { model: laya.model, state: 'hello', questions: { q: { type: 'choice', instructions: 'What is this?', criteria: { greeting: 'A greeting', other: 'Something else' } } } }, fetchFn)
    return `ready (warm-up ${Date.now() - t} ms)`
  } catch (err) {
    return `answers /health but not a request: ${errMsg(err)}`
  }
}
