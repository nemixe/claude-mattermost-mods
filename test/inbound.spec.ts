import { describe, expect, test } from 'bun:test'
import { defaultAccess, type Access } from '../src/hub/access'
import { decideInbound, decideReaction, isMentioned, stripLeadingMention, type InboundInput } from '../src/hub/inbound'

const bot = { id: 'BOT', username: 'claude' }
const OWNER = 'U_OWNER'
const MEMBER = 'U_MEMBER'

function access(p: Partial<Access> = {}): Access {
  return { ...defaultAccess(), allowFrom: [OWNER], ...p }
}

function input(p: Partial<InboundInput> & { message?: string; user?: string; root?: string }): InboundInput {
  return {
    post: { id: 'P1', root_id: p.root ?? '', user_id: p.user ?? OWNER, channel_id: 'C1', message: p.message ?? '@claude hello' },
    channelType: 'O',
    bot,
    access: access(),
    workspace: 'demo',
    knownThread: false,
    awaitingWorkspace: false,
    ...p,
  }
}

describe('decideInbound', () => {
  test('own posts and system posts are ignored', () => {
    expect(decideInbound(input({ user: 'BOT' })).kind).toBe('ignore')
    expect(decideInbound({ ...input({}), post: { ...input({}).post, type: 'system_join_channel' } }).kind).toBe('ignore')
  })

  test('owner mention in a bound channel starts a thread rooted at the post', () => {
    expect(decideInbound(input({}))).toEqual({ kind: 'start', threadId: 'P1', workspace: 'demo', text: '@claude hello' })
  })

  test('a mention inside someone else\'s thread starts a thread rooted at that root', () => {
    expect(decideInbound(input({ root: 'ROOT' }))).toMatchObject({ kind: 'start', threadId: 'ROOT' })
  })

  test('no mention: ignored for new threads', () => {
    expect(decideInbound(input({ message: 'hello there' })).kind).toBe('ignore')
    expect(decideInbound(input({ message: 'hello', root: 'ROOT' })).kind).toBe('ignore')
  })

  test('requireMention false lets owners start threads with plain top-level posts', () => {
    expect(decideInbound(input({ message: 'hello', access: access({ requireMention: false }) })).kind).toBe('start')
  })

  test("a reply in a session's DM thread goes back to that session; other DM posts don't", () => {
    const dm = { channelType: 'D', workspace: undefined }
    expect(decideInbound(input({ ...dm, root: 'DMROOT', message: 'yes, go ahead', linkedDM: true }))).toEqual({ kind: 'dm_reply', threadId: 'DMROOT' })
    // A top-level DM, or a thread that isn't a session's DM: the usual flow.
    expect(decideInbound(input({ ...dm, message: 'new request', linkedDM: false })).kind).toBe('ask_workspace')
    expect(decideInbound(input({ ...dm, root: 'OTHER', message: 'hm', linkedDM: false })).kind).toBe('ask_workspace')
    // Permission answers still win; a non-owner never gets that far.
    expect(decideInbound(input({ ...dm, root: 'DMROOT', message: 'yes abcde', linkedDM: true })).kind).toBe('permission')
    expect(decideInbound(input({ ...dm, root: 'DMROOT', user: 'U_STRANGER', linkedDM: true, access: access({ dmPolicy: 'allowlist' }) })).kind).toBe('ignore')
  })

  test('with trigger "laya": a mention follows a thread; while followed, Laya judges the replies without one', () => {
    const laya = { trigger: 'laya' as const, knownThread: true, root: 'T' }
    // Followed (the default): a reply without a mention goes to Laya; when it can't answer, the router gets it.
    expect(decideInbound(input({ ...laya, message: 'what about staging?' }))).toEqual({
      kind: 'classify', threadId: 'T', then: { kind: 'message', threadId: 'T', text: 'what about staging?', role: 'owner' },
    })
    expect(decideInbound(input({ ...laya, message: 'ok', user: MEMBER, access: access({ channels: { C1: { allowFrom: [MEMBER] } } }) })))
      .toMatchObject({ kind: 'classify', then: { kind: 'message', role: 'member' } })
    // Not followed (the router called unfollow): only a mention gets through, and it follows the thread again.
    expect(decideInbound(input({ ...laya, followed: false, message: 'thanks all' }))).toMatchObject({ kind: 'ignore' })
    expect(decideInbound(input({ ...laya, followed: false, message: '@claude one more thing' }))).toEqual({
      kind: 'message', threadId: 'T', text: '@claude one more thing', role: 'owner', follow: true,
    })
    // Commands and permission answers come first, followed or not.
    expect(decideInbound(input({ ...laya, followed: false, message: '!follow' })).kind).toBe('command')
    expect(decideInbound(input({ ...laya, followed: false, message: 'yes abcde' })).kind).toBe('permission')
    // Outside hub threads nothing changes: a mention starts one, other posts are ignored.
    expect(decideInbound(input({ trigger: 'laya', message: 'can someone check the build?' })).kind).toBe('ignore')
    expect(decideInbound(input({ trigger: 'laya', root: 'ROOT', message: 'and the logs?' })).kind).toBe('ignore')
    expect(decideInbound(input({ trigger: 'laya' })).kind).toBe('start')
    // With mentions (the default trigger), follow state plays no part.
    expect(decideInbound(input({ knownThread: true, root: 'T', followed: false, message: 'hi' }))).toEqual({ kind: 'message', threadId: 'T', text: 'hi', role: 'owner' })
  })

  test('a DM always reaches the bot: no mention needed, never judged by Laya, follow state ignored', () => {
    const dm = { channelType: 'D', message: 'can you check the build?' }
    for (const trigger of ['mention', 'laya'] as const) {
      // A new DM starts a thread without a mention ...
      expect(decideInbound(input({ ...dm, trigger }))).toEqual({ kind: 'start', threadId: 'P1', workspace: 'demo', text: 'can you check the build?' })
      expect(decideInbound(input({ ...dm, trigger, workspace: undefined })).kind).toBe('ask_workspace')
      // ... and every reply in it goes straight to its router, followed or not.
      for (const followed of [true, false]) {
        expect(decideInbound(input({ ...dm, trigger, followed, root: 'T', knownThread: true, message: 'thanks!' })))
          .toEqual({ kind: 'message', threadId: 'T', text: 'thanks!', role: 'owner' })
      }
    }
    // Access rules still apply: someone who isn't an owner doesn't get a session from a DM.
    expect(['start', 'message', 'classify']).not.toContain(decideInbound(input({ ...dm, trigger: 'laya', user: 'U_ANY' })).kind)
  })

  test('replies in a known thread need no mention', () => {
    expect(decideInbound(input({ message: 'and also this', root: 'T', knownThread: true }))).toMatchObject({ kind: 'message', threadId: 'T' })
  })

  test('members talk in known threads only; they cannot start one', () => {
    const a = access({ channels: { C1: { allowFrom: [MEMBER] } } })
    expect(decideInbound(input({ user: MEMBER, access: a, root: 'T', knownThread: true, message: 'hi' }))).toMatchObject({ kind: 'message', role: 'member' })
    expect(decideInbound(input({ user: MEMBER, access: a })).kind).toBe('ignore')
  })

  test('bound channel with no policy: any channel member may talk in known threads', () => {
    expect(decideInbound(input({ user: 'U_ANY', root: 'T', knownThread: true, message: 'x' })).kind).toBe('message')
  })

  test('channel not bound and not listed: ignored', () => {
    expect(decideInbound(input({ user: 'U_ANY', workspace: undefined })).kind).toBe('ignore')
  })

  test('owner mention in an unbound channel asks for a workspace', () => {
    const a = access({ channels: { C1: { allowFrom: [] } } })
    expect(decideInbound(input({ workspace: undefined, access: a }))).toEqual({ kind: 'ask_workspace', threadId: 'P1' })
  })

  test('the owner answers the workspace question in that thread', () => {
    expect(decideInbound(input({ workspace: undefined, access: access({ channels: { C1: { allowFrom: [] } } }), root: 'P0', awaitingWorkspace: true, message: 'create demo My demo' })))
      .toEqual({ kind: 'workspace_answer', threadId: 'P0', text: 'create demo My demo' })
  })

  test('permission replies from owners only', () => {
    expect(decideInbound(input({ message: 'yes abcde', root: 'T', knownThread: true }))).toEqual({ kind: 'permission', behavior: 'allow', code: 'abcde' })
    expect(decideInbound(input({ message: 'No ABCDE', root: 'T', knownThread: true }))).toEqual({ kind: 'permission', behavior: 'deny', code: 'abcde' })
    expect(decideInbound(input({ user: 'U_ANY', message: 'yes abcde', root: 'T', knownThread: true })).kind).toBe('message')
    // 'l' is not in the alphabet; chatter around it is not an answer
    expect(decideInbound(input({ message: 'yes abcdl', root: 'T', knownThread: true })).kind).toBe('message')
    expect(decideInbound(input({ message: 'yes abcde please', root: 'T', knownThread: true })).kind).toBe('message')
  })

  test('commands: owners, with a mention or inside a known thread', () => {
    expect(decideInbound(input({ message: '@claude !ws' }))).toMatchObject({ kind: 'command', name: 'ws', args: [] })
    expect(decideInbound(input({ message: '!worker rm w-abc', root: 'T', knownThread: true }))).toMatchObject({ kind: 'command', name: 'worker', args: ['rm', 'w-abc'] })
    expect(decideInbound(input({ message: '!ws' })).kind).toBe('ignore')
    const a = access({ channels: { C1: { allowFrom: [MEMBER] } } })
    expect(decideInbound(input({ user: MEMBER, access: a, message: '!ws', root: 'T', knownThread: true })).kind).toBe('message')
  })

  test('DMs: no mention needed; unknown senders get pairing', () => {
    expect(decideInbound(input({ channelType: 'D', message: 'hi' })).kind).toBe('start')
    expect(decideInbound(input({ channelType: 'D', user: 'U_NEW', message: 'hi' })).kind).toBe('pair')
    expect(decideInbound(input({ channelType: 'D', user: 'U_NEW', message: 'hi', access: access({ dmPolicy: 'allowlist' }) })).kind).toBe('ignore')
  })

  test('dmPolicy disabled blocks everything', () => {
    expect(decideInbound(input({ access: access({ dmPolicy: 'disabled' }) })).kind).toBe('ignore')
  })
})

describe('mentions', () => {
  test('word boundaries', () => {
    expect(isMentioned('hey @claude!', 'claude')).toBe(true)
    expect(isMentioned('hey @claude-bot', 'claude')).toBe(false)
    expect(isMentioned('mail@claude.com', 'claude')).toBe(false)
    expect(isMentioned('CLAUDE pls', 'claude', ['^claude\\b'])).toBe(true)
  })
  test('strip leading mention', () => {
    expect(stripLeadingMention('@claude: !ws', 'claude')).toBe('!ws')
    expect(stripLeadingMention('hi @claude', 'claude')).toBe('hi @claude')
  })
})

describe('decideReaction', () => {
  const code = (id: string) => (id === 'PROMPT' ? 'abcde' : undefined)
  test('owner ✅ / ❌ on a prompt post', () => {
    expect(decideReaction({ user_id: OWNER, post_id: 'PROMPT', emoji_name: 'white_check_mark' }, bot, access(), code)).toEqual({ kind: 'permission', behavior: 'allow', code: 'abcde' })
    expect(decideReaction({ user_id: OWNER, post_id: 'PROMPT', emoji_name: 'x' }, bot, access(), code)).toEqual({ kind: 'permission', behavior: 'deny', code: 'abcde' })
  })
  test('non-owners, other posts and other emoji are ignored', () => {
    expect(decideReaction({ user_id: 'U_ANY', post_id: 'PROMPT', emoji_name: 'white_check_mark' }, bot, access(), code).kind).toBe('ignore')
    expect(decideReaction({ user_id: OWNER, post_id: 'OTHER', emoji_name: 'white_check_mark' }, bot, access(), code).kind).toBe('ignore')
    expect(decideReaction({ user_id: OWNER, post_id: 'PROMPT', emoji_name: 'smile' }, bot, access(), code).kind).toBe('ignore')
  })
})

test('a plain top-level message answers an open workspace question (DMs)', () => {
  expect(decideInbound(input({ channelType: 'D', workspace: undefined, awaitingWorkspace: true, message: 'create acme Acme workspace' })))
    .toEqual({ kind: 'workspace_answer', threadId: 'P1', text: 'create acme Acme workspace' })
  // Without an open question it is just a new request that triggers the question.
  expect(decideInbound(input({ channelType: 'D', workspace: undefined, message: 'create acme Acme workspace' })).kind).toBe('ask_workspace')
})
