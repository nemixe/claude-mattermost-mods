// `claude auth status` run where the hub's sessions run: a throwaway session in a
// real (private) tmux server, so the answer is what a session would see, not what
// the shell that asked sees.

import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { authStatusInTmux, readAuthStatus } from '../src/hub/authcheck'
import { cleanEnv, Tmux, type NewSession } from '../src/hub/tmux'

describe('reading claude auth status', () => {
  test('signed in or not, and what it signed in with; a failure says why, with no secret', () => {
    expect(readAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"a@b.c","orgName":"Acme","subscriptionType":"max"}', '', 0))
      .toEqual({ loggedIn: true, text: 'signed in · auth claude.ai · API firstParty · a@b.c (Acme) · max' })
    expect(readAuthStatus('{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}', '', 1))
      .toEqual({ loggedIn: false, text: 'not signed in · auth none · API firstParty' })
    expect(readAuthStatus('', 'warming up\nInvalid token sk-ant-oat01-SECRET', 1)).toEqual({ text: 'claude auth status failed: Invalid token sk-ant-…' })
    expect(readAuthStatus('', '', 127)).toEqual({ text: 'claude auth status failed: exit 127' })
  })
})

const tmuxBin = Bun.which('tmux')

describe.skipIf(!tmuxBin)('in the hub\'s tmux server', () => {
  const socket = `mmhub-authtest-${process.pid}`
  const tmux = new Tmux(socket, cleanEnv(), tmuxBin!)
  afterAll(async () => {
    await tmux.run(['kill-server'])
  })

  const bin = mkdtempSync(join(tmpdir(), 'mmhub-authbin-'))
  const claude = join(bin, 'claude')
  // A stand-in for claude: signed in when it got a token; says whether it ran inside tmux and what env it got.
  writeFileSync(claude, `#!/bin/sh
[ "$*" = "auth status --json" ] || { echo "unexpected args: $*" >&2; exit 2; }
case "$FAKE_MODE" in
  fail) echo "Invalid token sk-ant-oat01-$CLAUDE_CODE_OAUTH_TOKEN" >&2; exit 3;;
  slow) sleep 5;;
esac
li=false; m=none
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && { li=true; m="oauth_token:$CLAUDE_CODE_OAUTH_TOKEN"; }
printf '{"loggedIn": %s, "authMethod": "%s", "apiProvider": "%s", "orgName": "%s"}\\n' "$li" "$m" "\${TMUX:+in tmux}" "$FAKE_ORG"
`)
  chmodSync(claude, 0o755)

  /** The tmux calls the check makes, passed on to the real server. */
  function spy() {
    const made: NewSession[] = []
    const killed: string[] = []
    return {
      made, killed,
      newSession: async (o: NewSession) => { made.push(o); await tmux.newSession(o) },
      kill: async (n: string) => { killed.push(n); return tmux.kill(n) },
    }
  }
  const env = (extra: Record<string, string> = {}) => ({ PATH: '/usr/bin:/bin', FAKE_ORG: 'acme', ...extra })

  test("runs claude inside the tmux server with a session's environment, then tidies up", async () => {
    const t = spy()
    const a = await authStatusInTmux(t, { claudeBin: claude, cwd: bin, env: env() })
    expect(a).toEqual({ loggedIn: false, text: 'not signed in · auth none · API in tmux (acme)' })
    const name = t.made[0]!.name
    expect(name).toMatch(/^mmhub-auth-/)
    expect(t.killed).toEqual([name])
    expect(await tmux.has(name)).toBe(false)
    expect(existsSync(t.made[0]!.argv[4]!)).toBe(false) // its scratch folder
  })

  test("a provider's env reaches claude through the launch wrapper's 0600 file, never argv", async () => {
    const t = spy()
    const a = await authStatusInTmux(t, { claudeBin: claude, cwd: bin, env: env(), providerEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'oat-SECRET' } })
    expect(a).toEqual({ loggedIn: true, text: 'signed in · auth oauth_token:oat-SECRET · API in tmux (acme)' })
    expect(JSON.stringify(t.made)).not.toContain('SECRET')
  })

  test('a failing claude says why, redacted', async () => {
    const a = await authStatusInTmux(spy(), { claudeBin: claude, cwd: bin, env: env({ FAKE_MODE: 'fail' }), providerEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'abc' } })
    expect(a).toEqual({ text: 'claude auth status failed: Invalid token sk-ant-…' })
  })

  test('one that never answers is given up on, and its session killed', async () => {
    const t = spy()
    const a = await authStatusInTmux(t, { claudeBin: claude, cwd: bin, env: env({ FAKE_MODE: 'slow' }), timeoutMs: 300 })
    expect(a).toEqual({ text: 'claude auth status gave no answer within 1 s' })
    expect(await tmux.has(t.made[0]!.name)).toBe(false)
  })
})
