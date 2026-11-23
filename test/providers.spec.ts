// Providers: chains, choosing the active one, cooldowns, which failures are the
// provider's fault, startup screens, secrets on disk, and the launch that puts a
// provider's env into claude without it ever being in argv.

import { describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { classifyFailure, RETRY_DELAYS } from '../src/hub/lifecycle'
import {
  buildLaunch, chooseProvider, cooldownMs, DEFAULT_PROVIDER, ensureConfigDir, knownConfigDirs, loginState, managedConfigDir, markFailed, markOk,
  providerChain, providerFault, redact, resetTime, secretNames, startupProblem, syncTranscript, unusableReason, validateDef, writeSecret,
  type Health, type ProviderDef,
} from '../src/hub/providers'
import { LAUNCH_SH, providerEnvText, transcriptPath, wrapArgv, writeProviderEnv, sessionFiles } from '../src/hub/spawn'
import { paths } from '../src/shared/paths'

const MIN = 60_000
const NOW = 1_800_000_000_000

function tmp(prefix = 'mmhub-prov-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('chains', () => {
  test("a workspace's list replaces the hub's; \"hub\" splices the hub's in", () => {
    expect(providerChain(undefined, undefined)).toEqual(['default'])
    expect(providerChain(['acme', 'default'], undefined)).toEqual(['acme', 'default'])
    expect(providerChain(['acme', 'default'], ['client'])).toEqual(['client'])
    expect(providerChain(['acme', 'default'], ['client', 'hub'])).toEqual(['client', 'acme', 'default'])
    expect(providerChain(undefined, ['client', 'hub'])).toEqual(['client', 'default'])
    expect(providerChain(['a', 'a', 'hub'], ['b', 'a', 'hub'])).toEqual(['b', 'a'])
    expect(providerChain([], [])).toEqual(['default'])
  })
})

describe('choosing the active provider', () => {
  const none = () => undefined
  test('the first usable one that is not resting', () => {
    expect(chooseProvider(['a', 'b'], NOW, none, none)).toEqual({ name: 'a', index: 0, fallback: false, healthy: true })
    const resting: Record<string, Health> = { a: { strikes: 1, coolUntil: NOW + MIN } }
    expect(chooseProvider(['a', 'b'], NOW, n => resting[n], none)).toEqual({ name: 'b', index: 1, fallback: true, healthy: true })
    // Its rest is over: back to the primary.
    expect(chooseProvider(['a', 'b'], NOW + 2 * MIN, n => resting[n], none).name).toBe('a')
  })

  test('unusable providers are skipped; with none usable it says why', () => {
    const why = (n: string) => (n === 'a' ? 'not signed in' : undefined)
    expect(chooseProvider(['a', 'b'], NOW, none, why)).toMatchObject({ name: 'b', fallback: true, healthy: true })
    expect(chooseProvider(['a'], NOW, none, why)).toEqual({ name: 'a', index: 0, fallback: false, healthy: false, unusable: 'not signed in' })
  })

  test('when every provider rests, the one back first (and not healthy)', () => {
    const h: Record<string, Health> = { a: { strikes: 2, coolUntil: NOW + 30 * MIN }, b: { strikes: 1, coolUntil: NOW + 5 * MIN } }
    expect(chooseProvider(['a', 'b'], NOW, n => h[n], none)).toEqual({ name: 'b', index: 1, fallback: true, healthy: false })
  })
})

describe('cooldowns', () => {
  test('per fault, doubling with each strike, at most a day; overrides; reset times', () => {
    expect(cooldownMs('rate_limit', 1)).toBe(10 * MIN)
    expect(cooldownMs('rate_limit', 2)).toBe(20 * MIN)
    expect(cooldownMs('auth', 1)).toBe(60 * MIN)
    expect(cooldownMs('auth', 20)).toBe(24 * 60 * MIN)
    expect(cooldownMs('errors', 1, { errors: 2 })).toBe(2 * MIN)

    const h1 = markFailed(undefined, 'rate_limit', 'rate_limit — 429', NOW)
    expect(h1).toEqual({ strikes: 1, coolUntil: NOW + 10 * MIN, fault: 'rate_limit', reason: 'rate_limit — 429', at: NOW })
    const h2 = markFailed(h1, 'rate_limit', '429', NOW + MIN)
    expect(h2.strikes).toBe(2)
    expect(h2.coolUntil).toBe(NOW + MIN + 20 * MIN)
    // A good turn: strikes start over, the rest still ends on time.
    expect(markOk(h2)).toEqual({ ...h2, strikes: 0 })
    expect(markOk(undefined)).toBeUndefined()

    // A usage limit that says when it resets rests until then.
    const reset = Math.floor((NOW + 3 * 60 * MIN) / 1000)
    expect(resetTime(`rate_limit — Claude AI usage limit reached|${reset}`, NOW)).toBe(reset * 1000)
    expect(resetTime('usage limit reached|1000000000', NOW)).toBeUndefined() // in the past
    expect(markFailed(undefined, 'quota', 'limit', NOW, { resetAt: reset * 1000 }).coolUntil).toBe(reset * 1000)
  })
})

describe('which failures are the provider\'s fault', () => {
  test('sign-in, quota and rate limits at once; other API errors once the retries gave up', () => {
    expect(providerFault(classifyFailure('authentication_failed — OAuth token has expired'), 1)).toBe('auth')
    expect(providerFault(classifyFailure('billing_error — Your credit balance is too low'), 1)).toBe('quota')
    expect(providerFault(classifyFailure('rate_limit — Claude usage limit reached'), 1)).toBe('quota')
    expect(providerFault(classifyFailure('rate_limit — 429 Too Many Requests'), 1)).toBe('rate_limit')
    const tries = RETRY_DELAYS.transient.length
    expect(providerFault(classifyFailure('overloaded'), tries)).toBeUndefined()
    expect(providerFault(classifyFailure('overloaded'), tries + 1)).toBe('errors')
    expect(providerFault(classifyFailure('invalid_request — prompt is too long'), 1)).toBeUndefined()
    expect(providerFault(classifyFailure('model_not_found'), 1)).toBeUndefined()
    expect(providerFault(classifyFailure('max_output_tokens'), 1)).toBeUndefined()
  })
})

describe('startup screens', () => {
  test('third-party providers: the channel flag is ignored (as Claude Code 2.1.325 prints it)', () => {
    const bedrock = [
      ' ▐▛███▛█   Claude Code v2.1.325',
      '▝▜██████▀  Opus 5.5 · Amazon Bedrock',
      '▎ --dangerously-load-development-channels ignored (server:mmhub)',
      '▎ Channels are not available on third-party providers',
      '❯ ',
    ].join('\n')
    expect(startupProblem(bedrock)).toEqual({ fault: 'channels', reason: 'no channels on third-party providers' })
    expect(startupProblem('▎ Channels are not currently available')).toEqual({ fault: 'channels', reason: 'channels not available' })
  })

  test('a config dir that never signed in shows onboarding; a lapsed one says so', () => {
    expect(startupProblem(" Let's get started.\n Choose the text style that looks best with your terminal")?.fault).toBe('auth')
    expect(startupProblem('Select login method:')?.fault).toBe('auth')
    expect(startupProblem('Not logged in · Please run /login')).toEqual({ fault: 'auth', reason: 'Not logged in' })
    expect(startupProblem('OAuth token revoked · Please run /login')?.fault).toBe('auth')
  })

  test('a resumed conversation replaying an old sign-in error is not a problem', () => {
    const resumed = [
      ' ▐▛███▛█   Claude Code v2.1.331',
      '▝▜██████▀  Opus 5.5 with medium effort · Claude Ultra',
      '← mmhub · rafel.ami: Hi',
      '⏺ Login reached its time limit · Please run /login',
      '❯ ',
    ].join('\n')
    expect(startupProblem(resumed)).toBeUndefined()
  })

  test('a normal start, and the dev-channel dialog, are not problems', () => {
    expect(startupProblem(' ▐▛███▛█   Claude Code v2.1.325\n▝▜██████▀  Opus 5.5 · Claude Max\n❯ ')).toBeUndefined()
    expect(startupProblem('Loading development channels\n❯ 1. I am using this for local development')).toBeUndefined()
  })
})

describe('redaction', () => {
  test('keys and tokens never reach posts, logs or status.json', () => {
    expect(redact('authentication_failed — invalid x-api-key sk-ant-api03-abcDEF_123-xyz')).toBe('authentication_failed — invalid x-api-key sk-ant-…')
    expect(redact('AKIAABCDEFGHIJKLMNOP denied')).toBe('AKIA… denied')
    expect(redact('Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe('Bearer …')
    expect(redact(`token ${'x'.repeat(50)}`)).toBe('token …')
    expect(redact('rate_limit — 429 Too Many Requests')).toBe('rate_limit — 429 Too Many Requests')
  })
})

describe('definitions, secrets and launches', () => {
  test('definitions are checked: reserved names, kinds, env the hub owns', () => {
    expect(validateDef('acme', { kind: 'login' })).toEqual([])
    expect(validateDef('default', { kind: 'login' })).toEqual(['"default" is reserved'])
    expect(validateDef('Acme', { kind: 'nope' as never }).length).toBe(2)
    expect(validateDef('gw', { kind: 'gateway', env: { PATH: '/x', MMHUB_ROLE: 'x', CLAUDE_CONFIG_DIR: '/x' } })).toEqual([
      "PATH can't be set by a provider", "MMHUB_ROLE can't be set by a provider", "CLAUDE_CONFIG_DIR can't be set by a provider (use --config-dir)",
    ])
  })

  test('secrets are 0600 files in 0700 folders; an API key reaches claude through apiKeyHelper, others through env', () => {
    const state = tmp()
    writeSecret(state, 'key', 'ANTHROPIC_API_KEY', 'sk-ant-api03-SECRET\n')
    writeSecret(state, 'tok', 'CLAUDE_CODE_OAUTH_TOKEN', 'oat-SECRET')
    const f = join(state, 'providers', 'key', 'secrets', 'ANTHROPIC_API_KEY')
    expect(readFileSync(f, 'utf8')).toBe('sk-ant-api03-SECRET')
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(f)).mode & 0o777).toBe(0o700)
    expect(secretNames(state, 'key')).toEqual(['ANTHROPIC_API_KEY'])
    expect(() => writeSecret(state, 'key', 'X', 'two\nlines')).toThrow('line break')
    expect(() => writeSecret(state, 'key', 'PATH', '/evil')).toThrow("can't be set")
    expect(() => writeSecret(state, '../x', 'X', 'v')).toThrow('invalid provider name')

    const key = buildLaunch(state, 'key', { kind: 'api-key' })
    expect(key.env).toEqual({})
    expect(key.apiKeyHelper).toBe(`cat ${f}`)
    expect(JSON.stringify(key)).not.toContain('SECRET')
    const tok = buildLaunch(state, 'tok', { kind: 'oauth-token' })
    expect(tok.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oat-SECRET' })
    const bedrock = buildLaunch(state, 'bk', { kind: 'bedrock', env: { AWS_REGION: 'eu-west-1', PATH: '/evil' } })
    expect(bedrock.env).toEqual({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1' })
    expect(buildLaunch(state, DEFAULT_PROVIDER, undefined)).toEqual({ name: 'default', kind: 'default', env: {} })
  })

  test('what makes a provider unusable', () => {
    const state = tmp()
    expect(unusableReason(state, 'default', undefined)).toBeUndefined()
    expect(unusableReason(state, 'x', undefined)).toBe('not defined')
    expect(unusableReason(state, 'k', { kind: 'api-key' })).toBe('needs secret ANTHROPIC_API_KEY')
    writeSecret(state, 'k', 'ANTHROPIC_API_KEY', 'sk')
    expect(unusableReason(state, 'k', { kind: 'api-key' })).toBeUndefined()
    expect(unusableReason(state, 'g', { kind: 'gateway' })).toBe('needs ANTHROPIC_BASE_URL')
    expect(unusableReason(state, 'g', { kind: 'gateway', env: { ANTHROPIC_BASE_URL: 'https://llm.internal' } })).toBeUndefined()
    expect(unusableReason(state, 'b', { kind: 'bedrock', env: { AWS_REGION: 'us-east-1' } })).toBe('Claude Code has no channels on third-party providers')
    expect(unusableReason(state, 'b', { kind: 'bedrock', env: { AWS_REGION: 'us-east-1' }, channels: true })).toBeUndefined()
    expect(unusableReason(state, 'v', { kind: 'vertex', channels: true, env: { CLOUD_ML_REGION: 'us-east5' } })).toBe('needs ANTHROPIC_VERTEX_PROJECT_ID')
  })

  test("a login provider gets its own config dir, sharing the base config's transcripts", () => {
    const state = tmp()
    const base = tmp('mmhub-base-')
    const def: ProviderDef = { kind: 'login' }
    expect(unusableReason(state, 'acme', def)).toBe('not signed in')
    const launch = buildLaunch(state, 'acme', def, base)
    const dir = managedConfigDir(state, 'acme')
    expect(launch.configDir).toBe(dir)
    expect(launch.env).toEqual({ CLAUDE_CONFIG_DIR: dir })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(lstatSync(join(dir, 'projects')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(dir, 'projects'))).toBe(join(base, 'projects'))

    // What `claude` then `/login` leave behind.
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { accountUuid: 'u1' } }))
    expect(loginState(dir)).toBe('signed-in')
    expect(unusableReason(state, 'acme', def)).toBeUndefined()

    // A config dir the user picked is used as it is (no link made in it).
    const own = join(tmp('mmhub-own-'), 'cfg')
    ensureConfigDir(state, 'mine', own, base)
    expect(existsSync(join(own, 'projects'))).toBe(false)
    expect(knownConfigDirs(state, { acme: def, mine: { kind: 'login', configDir: own } }, base)).toEqual([base, dir, own])
  })

  test('a transcript follows the session to another config dir, newest copy wins', () => {
    const a = tmp('mmhub-a-')
    const b = tmp('mmhub-b-')
    const cwd = '/work/acme/.worktrees/w-1'
    expect(syncTranscript(cwd, 'S1', b, [a, b])).toBe(false)
    const fa = transcriptPath(cwd, 'S1', a)
    mkdirSync(dirname(fa), { recursive: true })
    writeFileSync(fa, 'turn 1\n')
    expect(syncTranscript(cwd, 'S1', b, [a, b])).toBe(true)
    const fb = transcriptPath(cwd, 'S1', b)
    expect(readFileSync(fb, 'utf8')).toBe('turn 1\n')
    // More turns happened under b; going back to a brings them along.
    writeFileSync(fb, 'turn 1\nturn 2\n')
    utimesSync(fb, new Date(), new Date(Date.now() + 5000))
    expect(syncTranscript(cwd, 'S1', a, [a, b])).toBe(true)
    expect(readFileSync(fa, 'utf8')).toBe('turn 1\nturn 2\n')

    // Linked projects/ folders: the same file, nothing copied.
    const c = tmp('mmhub-c-')
    symlinkSync(join(a, 'projects'), join(c, 'projects'))
    expect(syncTranscript(cwd, 'S1', c, [a, c])).toBe(true)
  })
})

describe('the launch script', () => {
  test("runs claude with the provider's env, from a file it deletes; inherited provider vars are dropped", async () => {
    const p = paths(tmp())
    const f = sessionFiles(p, 'w-test')
    const envFile = writeProviderEnv(f, { CLAUDE_CODE_OAUTH_TOKEN: "o'at-SECRET $HOME `x`", CLAUDE_CONFIG_DIR: '/cfg/acme' })
    expect(statSync(envFile).mode & 0o777).toBe(0o600)
    expect(providerEnvText({ A: "it's" })).toBe(`export A='it'\\''s'\n`)

    const argv = wrapArgv(['/usr/bin/env'], envFile)
    expect(argv.slice(0, 3)).toEqual(['/bin/sh', '-c', LAUNCH_SH])
    expect(argv.join(' ')).not.toContain('SECRET')

    const run = Bun.spawn(argv, { env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-from-the-hub', KEEP: 'me' }, stdout: 'pipe' })
    const out = await new Response(run.stdout).text()
    expect(await run.exited).toBe(0)
    const env = Object.fromEntries(out.trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("o'at-SECRET $HOME `x`")
    expect(env.CLAUDE_CONFIG_DIR).toBe('/cfg/acme')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.KEEP).toBe('me')
    expect(existsSync(envFile)).toBe(false)
  })
})
