// Laya: TRIGGER.md rules, what it is asked (within its 512-token, 48-tokens-an-option limits),
// how its answers decide, and the Ollama call.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  askLaya, botKey, buildRequest, buildState, CONTEXT_CHARS, decide, DEFAULT_LAYA, DEFAULT_TRIGGER_MD, judge, layaReady, LINE_CHARS, loadTrigger,
  MAX_PARTICIPANTS, MAX_PEOPLE, MAX_RULES, members, mentionedNames, NEWEST_CHARS, parseTrigger, previousAuthor, RULE_MAX_CHARS, saveTrigger, triggerFile,
  twoWay, usableRules,
} from '../src/hub/laya'

describe('TRIGGER.md', () => {
  test('rules are the list items under an "answer" heading and a "don\'t answer" one; other text is ignored', () => {
    expect(parseTrigger(DEFAULT_TRIGGER_MD)).toEqual({
      answer: ['A question or request addressed to the bot, Claude, or "the AI"'],
      ignore: ['Acknowledgements and small talk'], // greetings and thanks have questions of their own
    })
    const md = [
      '# Rules', 'Some prose.', '- not a rule (no section yet)',
      '## Respond to', '- deploy questions', '* build failures', '1. anything for "ops"', 'prose again',
      '### Do not reply', '- lunch plans', '',
      '## Notes', '- not a rule either',
    ].join('\n')
    expect(parseTrigger(md)).toEqual({ answer: ['deploy questions', 'build failures', 'anything for "ops"'], ignore: ['lunch plans'] })
  })

  test('the built-in rules until a workspace has its own; saving checks size and content; reading never writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmhub-laya-'))
    expect(loadTrigger(dir)).toMatchObject({ own: false, text: DEFAULT_TRIGGER_MD })
    expect(existsSync(triggerFile(dir))).toBe(false)
    expect(() => saveTrigger(dir, '# nothing here')).toThrow('no rules found')
    expect(() => saveTrigger(dir, `## Answer\n${'- x\n'.repeat(2000)}`)).toThrow('at most 6000 characters')
    expect(existsSync(triggerFile(dir))).toBe(false)
    const rules = saveTrigger(dir, '## Answer\r\n- deploys\r\n## Don\'t answer\r\n- lunch\r\n\r\n')
    expect(rules).toEqual({ answer: ['deploys'], ignore: ['lunch'] })
    expect(readFileSync(triggerFile(dir), 'utf8')).toBe('## Answer\n- deploys\n## Don\'t answer\n- lunch\n')
    expect(loadTrigger(dir).own).toBe(true)
  })

  test('Laya is asked about MAX_RULES rules at most, "don\'t answer" ones first, each clipped', () => {
    const list = (n: number, c: string) => Array.from({ length: n }, (_, i) => `${c}${i}`)
    const u = usableRules({ answer: list(20, 'a'), ignore: list(20, 'b') })
    expect(u.ignore).toEqual(list(20, 'b'))
    expect(u.answer).toEqual(list(MAX_RULES - 20, 'a'))
    expect(u.dropped).toBe(40 - MAX_RULES)
    const long = usableRules({ answer: ['x'.repeat(400)], ignore: [] })
    expect(long.answer[0]!.length).toBe(RULE_MAX_CHARS)
    expect(long.clipped).toBe(1)
  })
})

describe('what Laya is asked', () => {
  test('the conversation oldest first, the newest last and marked; the oldest go first; everything clipped', () => {
    const earlier = Array.from({ length: 10 }, (_, i) => ({ user: `u${i}`, text: `message ${i} ${'y'.repeat(200)}` }))
    const lines = buildState('hubbot', { user: 'bob', text: `can you check the build? ${'z'.repeat(1000)}` }, earlier).split('\n')
    const newest = lines.at(-1)!
    expect(newest).toStartWith('>> @bob: can you check the build?')
    expect(newest.length).toBeLessThanOrEqual('>> @bob: '.length + NEWEST_CHARS)
    const rest = lines.slice(0, -1)
    expect(rest.at(-1)).toStartWith('@u9: message 9') // the latest earlier one is kept
    expect(rest[0]).not.toStartWith('@u0') // the oldest are dropped first
    for (const l of rest) expect(l.length).toBeLessThanOrEqual(5 + LINE_CHARS)
    expect(rest.join('\n').length).toBeLessThanOrEqual(CONTEXT_CHARS)
    // Short posts: all ten fit.
    expect(buildState('hubbot', { user: 'bob', text: 'ok' }, earlier.map(e => ({ ...e, text: 'hi' }))).split('\n').length).toBe(11)
    expect(buildState('hubbot', { user: 'bob', text: '' }, [])).toBe('>> @bob: (a file)')
    // Who wrote what: the bot is the AI assistant, other bot accounts are other AI bots.
    expect(buildState('hubbot', { user: 'dave', text: 'and now?' }, [{ user: 'hubbot', bot: true, text: 'Done.' }, { user: 'devbot', bot: true, text: 'Tunnel up.' }]))
      .toBe('@hubbot (AI assistant): Done.\n@devbot (another AI bot): Tunnel up.\n>> @dave: and now?')
  })

  test('everyone who has posted in the thread comes first, labelled the same way, and takes room from the earlier posts', () => {
    const people = [{ user: 'dave' }, { user: 'hubbot', bot: true }, { user: 'devbot', bot: true }]
    const earlier = [{ user: 'hubbot', bot: true, text: 'Done.' }]
    expect(buildState('hubbot', { user: 'erin', text: 'nice' }, earlier, people))
      .toBe('People in this thread: @dave, @hubbot (AI assistant), @devbot (another AI bot), @erin.\n@hubbot (AI assistant): Done.\n>> @erin: nice')
    // In the order they first posted; the newest post's author last when it is their first. The bot first when it hasn't posted yet.
    expect(members('hubbot', { user: 'dave', text: 'x' }, people).map(p => p.user)).toEqual(['dave', 'hubbot', 'devbot'])
    expect(members('hubbot', { user: 'bob', text: 'x' }, [{ user: 'alice' }]).map(p => p.user)).toEqual(['hubbot', 'alice', 'bob'])
    const crowd = Array.from({ length: 11 }, (_, i) => ({ user: `u${i}` }))
    expect(buildState('hubbot', { user: 'bob', text: 'x' }, [], crowd).split('\n')[0]).toBe(`People in this thread: @hubbot (AI assistant), ${crowd.slice(0, MAX_PEOPLE - 1).map(p => `@${p.user}`).join(', ')} and 5 more.`)
    const long = Array.from({ length: 10 }, (_, i) => ({ user: `u${i}`, text: 'y'.repeat(200) }))
    const lines = buildState('hubbot', { user: 'bob', text: 'ok' }, long, crowd).split('\n')
    expect(lines.slice(0, -1).join('\n').length).toBeLessThanOrEqual(CONTEXT_CHARS)
  })

  test('the base question: who the last message is talking to, with the thread\'s participants as answers; then one question per rule', () => {
    const body = buildRequest({
      bot: 'hubbot', rules: { answer: ['deploy questions'], ignore: ['lunch plans'] }, model: 'laya',
      earlier: [{ user: 'alice', text: 'build is red' }, { user: 'hubbot', bot: true, text: 'Looking.' }, { user: 'devbot', bot: true, text: 'Tunnel up.' }, { user: 'bob', text: 'hm' }],
      newest: { user: 'bob', text: '@carol and @devbot, any idea?' },
      mentioned: [{ user: 'carol' }, { user: 'devbot', bot: true }],
    })
    expect(body).toMatchObject({ model: 'laya', keep_alive: '30m' })
    const q = body.questions as Record<string, { type: string; instructions: string; criteria: Record<string, string> }>
    expect(Object.keys(q)).toEqual(['who', 'to0', 'to1', 'greeting', 'thanks', 'no0', 'yes0'])
    expect(q.who!.instructions).toBe('Who is the last message (marked >>) talking to?')
    // The bot first, then those mentioned, then the other posters (latest first, not the sender), then nobody.
    expect(q.who!.criteria).toEqual({
      hubbot: '@hubbot (AI assistant)', carol: '@carol (a person)', devbot: '@devbot (another AI bot)', alice: '@alice (a person)',
      nobody: 'Nobody in particular, or everyone: chatter, thanks, news.',
    })
    // Each account it @mentions gets its own question: is it talking to them?
    expect(q.to0).toEqual({ type: 'choice', instructions: 'Is the last message (marked >>) talking to @carol?', criteria: { yes: 'Yes: it asks or tells @carol something.', no: 'No: it is for someone else.' } })
    expect(q.to1!.instructions).toBe('Is the last message (marked >>) talking to @devbot?')
    // Whether it is just a greeting, or thanks.
    expect(q.greeting!.instructions).toBe('What is the last message (marked >>)?')
    expect(Object.keys(q.greeting!.criteria)).toEqual(['greeting', 'other'])
    expect(Object.keys(q.thanks!.criteria)).toEqual(['thanks', 'other'])
    expect(q.no0).toEqual({ type: 'choice', instructions: 'Does this describe the last message (marked >>)?', criteria: { a: 'lunch plans', b: 'Something else' } })
    expect(q.yes0!.criteria.a).toBe('deploy questions')

    // No other bot around: the bot's other names count too. A sender who mentions themself is an answer as well.
    const solo = buildRequest({ bot: 'hubbot', rules: { answer: [], ignore: [] }, model: 'laya', earlier: [], newest: { user: 'bob', text: '@bob?' }, mentioned: [{ user: 'bob' }] })
    expect((solo.questions as any).who.criteria).toEqual({ hubbot: '@hubbot (AI assistant, also called Claude, the bot or the AI)', bob: '@bob (a person)', nobody: expect.any(String) })

    // At most MAX_PARTICIPANTS answers besides "nobody"; keys stay unique.
    const many = Array.from({ length: 9 }, (_, i) => ({ user: `u${i}`, text: 'x' }))
    const crowd = buildRequest({ bot: 'hubbot', rules: { answer: [], ignore: [] }, model: 'laya', earlier: [...many, { user: 'dave.lee', text: 'x' }, { user: 'nobody', text: 'x' }, { user: 'dave_lee', text: 'x' }], newest: { user: 'bob', text: 'hi' } })
    expect(Object.keys((crowd.questions as any).who.criteria)).toEqual(['hubbot', 'dave_lee', 'nobody_', 'dave_lee_', 'u8', 'u7', 'nobody'])
    expect(MAX_PARTICIPANTS).toBe(6)
    expect(botKey('hubbot')).toBe('hubbot')
    expect(botKey('my.bot')).toBe('my_bot')
  })

  test('a thread of only the bot and the person writing: theirs, unless a bot wrote it or it @mentions someone else', () => {
    const bob = { user: 'bob', text: 'hi again' }
    const bot = { user: 'hubbot', bot: true }
    expect(twoWay('hubbot', bob, [])).toBe(true) // the bot was mentioned in the root and hasn't answered yet
    expect(twoWay('hubbot', bob, [{ user: 'bob' }, bot])).toBe(true)
    expect(twoWay('hubbot', bob, [{ user: 'bob' }, bot], [bot])).toBe(true) // mentioning the bot brings no one in
    expect(twoWay('hubbot', bob, [{ user: 'bob' }, bot, { user: 'alice' }])).toBe(false)
    expect(twoWay('hubbot', bob, [{ user: 'bob' }, bot], [{ user: 'alice' }])).toBe(false)
    expect(twoWay('hubbot', bob, [{ user: 'bob' }, bot], [{ user: 'bob' }])).toBe(false) // any other @mention: Laya judges
    expect(twoWay('hubbot', { user: 'devbot', bot: true, text: 'Report.' }, [bot])).toBe(false) // two bots would answer each other
  })

  test('thanks are for whoever wrote the post before (the latest by someone else)', () => {
    const newest = { user: 'bob', text: 'thanks' }
    expect(previousAuthor(newest, [{ user: 'hubbot', bot: true, text: 'Done.' }, { user: 'bob', text: 'one more' }])).toEqual({ user: 'hubbot', bot: true })
    expect(previousAuthor(newest, [{ user: 'hubbot', bot: true, text: 'Done.' }, { user: 'alice', text: 'cool' }])).toEqual({ user: 'alice', bot: undefined })
    expect(previousAuthor(newest, [{ user: 'bob', text: 'hm' }])).toBeUndefined()
  })

  test('who a post @mentions', () => {
    expect(mentionedNames('@devbot /model')).toEqual(['devbot'])
    expect(mentionedNames('hi @Bob, ask @dave.lee. Then @bob again')).toEqual(['bob', 'dave.lee'])
    expect(mentionedNames('@here @all @channel, mail a@b.com')).toEqual([])
  })
})

describe('the decision', () => {
  const rules = { answer: ['deploy questions'], ignore: ['lunch plans', 'thanks'] }
  const cfg = { threshold: 0.5, ruleThreshold: 0.85, kindThreshold: 0.7 }
  const ans = (who: number, rest: Record<string, number> = {}) => ({
    who: { probabilities: { hubbot: who, dave: (1 - who) / 2, nobody: (1 - who) / 2 } },
    ...Object.fromEntries(Object.entries(rest).map(([k, p]) => [k, { probabilities: { a: p, b: 1 - p } }])),
  })

  test("its own reading, unless a rule is sure; a sure \"don't answer\" rule beats a sure \"answer\" one", () => {
    expect(decide(ans(0.7), rules, cfg, 'hubbot')).toEqual({ yes: true, p: 0.7, why: 'its own reading' })
    expect(decide(ans(0.3, { no0: 0.8, yes0: 0.84 }), rules, cfg, 'hubbot')).toMatchObject({ yes: false, why: 'its own reading' }) // rules not sure enough
    expect(decide(ans(0.3, { yes0: 0.9 }), rules, cfg, 'hubbot')).toEqual({ yes: true, p: 0.9, why: 'answer rule "deploy questions"' })
    expect(decide(ans(0.9, { no1: 0.99 }), rules, cfg, 'hubbot')).toEqual({ yes: false, p: 0.99, why: 'don\'t-answer rule "thanks"' })
    expect(decide(ans(0.9, { no0: 0.86, no1: 0.95, yes0: 0.99 }), rules, cfg, 'hubbot')).toMatchObject({ yes: false, why: 'don\'t-answer rule "thanks"' })
    expect(() => decide({}, rules, cfg, 'hubbot')).toThrow('no answer')
  })

  test('a post Laya is sure talks to someone it @mentions is not for the bot, whatever else it says', () => {
    const to = (p: number) => ({ probabilities: { yes: p, no: 1 - p } })
    const m = [{ user: 'coweb', bot: true }, { user: 'dave' }]
    expect(decide({ ...ans(0.67), to0: to(0.89) }, rules, cfg, 'hubbot', m)).toEqual({ yes: false, p: 0.89, why: 'talking to @coweb' })
    expect(decide({ ...ans(0.6, { yes0: 0.99 }), to0: to(0.3), to1: to(0.9) }, rules, cfg, 'hubbot', m)).toMatchObject({ yes: false, why: 'talking to @dave' })
    // Only naming someone ("summarize what @coweb said") scores lower: the base question decides.
    expect(decide({ ...ans(0.6), to0: to(0.8) }, rules, cfg, 'hubbot', m)).toEqual({ yes: true, p: 0.6, why: 'its own reading' })
    // No answer to a "to" question (or no mentions): as before.
    expect(decide(ans(0.6), rules, cfg, 'hubbot', m)).toMatchObject({ yes: true })
  })

  test('sure it is a greeting or thanks: for the bot only after its own post. Before the rules', () => {
    const kind = (greeting: number, thanks: number) => ({ greeting: { probabilities: { greeting, other: 1 - greeting } }, thanks: { probabilities: { thanks, other: 1 - thanks } } })
    const bot = { user: 'hubbot', bot: true }, alice = { user: 'alice' }
    expect(decide({ ...ans(0.2, { no1: 0.99 }), ...kind(0.5, 0.95) }, rules, cfg, 'hubbot', [], bot)).toEqual({ yes: true, p: 0.95, why: 'thanks, for the post before it (@hubbot)' })
    expect(decide({ ...ans(0.9, { yes0: 0.99 }), ...kind(0.5, 0.95) }, rules, cfg, 'hubbot', [], alice)).toEqual({ yes: false, p: 0.95, why: 'thanks, for the post before it (@alice)' })
    expect(decide({ ...ans(0.9), ...kind(0.5, 0.95) }, rules, cfg, 'hubbot')).toMatchObject({ yes: false, why: 'thanks, for the post before it (nobody)' })
    expect(decide({ ...ans(0.2, { no1: 0.99 }), ...kind(0.8, 0.5) }, rules, cfg, 'hubbot', [], bot)).toEqual({ yes: true, p: 0.8, why: 'a greeting, for the post before it (@hubbot)' })
    expect(decide({ ...ans(0.9, { yes0: 0.99 }), ...kind(0.8, 0.5) }, rules, cfg, 'hubbot', [], alice)).toEqual({ yes: false, p: 0.8, why: 'a greeting, for the post before it (@alice)' })
    // Sure of both: the likelier. Neither sure: as before.
    expect(decide({ ...ans(0.9), ...kind(0.93, 0.74) }, rules, cfg, 'hubbot', [], alice)).toMatchObject({ yes: false, why: 'a greeting, for the post before it (@alice)' })
    expect(decide({ ...ans(0.1), ...kind(0.73, 0.77) }, rules, cfg, 'hubbot', [], bot)).toMatchObject({ yes: true, p: 0.77 })
    expect(decide({ ...ans(0.6), ...kind(0.69, 0.69) }, rules, cfg, 'hubbot', [], alice)).toEqual({ yes: true, p: 0.6, why: 'its own reading' })
    // Talking to someone it @mentions still comes first.
    expect(decide({ ...ans(0.2), ...kind(0.1, 0.95), to0: { probabilities: { yes: 0.9, no: 0.1 } } }, rules, cfg, 'hubbot', [alice], bot)).toMatchObject({ yes: false, why: 'talking to @alice' })
  })
})

describe('the Ollama call', () => {
  function server(reply: (body: Record<string, unknown>) => Response | Promise<Response>) {
    const seen: Record<string, unknown>[] = []
    const srv = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/api/tags') return Response.json({ models: [{ name: 'laya:latest' }] })
        const body = (await req.json()) as Record<string, unknown>
        seen.push(body)
        return reply(body)
      },
    })
    return { srv, seen, url: `http://127.0.0.1:${srv.port}/` }
  }

  test("Laya's answers; failures throw", async () => {
    const answers = { who: { type: 'choice', probabilities: { assistant: 0.83, people: 0.17 } } }
    const ok = server(() => Response.json({ answers }))
    try {
      expect(await askLaya({ url: ok.url, timeoutMs: 2000 }, { model: 'laya' })).toEqual(answers)
      expect(ok.seen).toEqual([{ model: 'laya' }])
    } finally {
      ok.srv.stop(true)
    }
    const missing = server(() => Response.json({ error: "model 'laya' not found" }, { status: 404 }))
    try {
      await expect(askLaya({ url: missing.url, timeoutMs: 2000 }, {})).rejects.toThrow("HTTP 404: model 'laya' not found")
    } finally {
      missing.srv.stop(true)
    }
    const odd = server(() => Response.json({}))
    try {
      await expect(askLaya({ url: odd.url, timeoutMs: 2000 }, {})).rejects.toThrow('no answer')
    } finally {
      odd.srv.stop(true)
    }
    const slow = server(async () => {
      await Bun.sleep(500)
      return Response.json({})
    })
    try {
      await expect(askLaya({ url: slow.url, timeoutMs: 50 }, {})).rejects.toThrow()
    } finally {
      slow.srv.stop(true)
    }
  })

  test('a rule or @mention Laya refuses (too many tokens for an option) is left out and the question asked again', async () => {
    const s = server(body => {
      const qs = Object.entries(body.questions as Record<string, { criteria: Record<string, string> }>)
      const bad = qs.findIndex(([, q]) => q.criteria.a?.startsWith('LONG') || q.criteria.yes?.includes('LONG'))
      if (bad >= 0) return Response.json({ error: `question ${bad}: option 0 has 51 tokens; limit is 48` }, { status: 400 })
      return Response.json({ answers: { who: { probabilities: { hubbot: 0.2 } }, ...Object.fromEntries(qs.slice(1).map(([k]) => [k, { probabilities: { a: 0.95 } }])) } })
    })
    try {
      const v = await judge({ ...DEFAULT_LAYA, url: s.url }, { bot: 'hubbot', rules: { answer: ['LONG rule', 'deploys'], ignore: [] }, newest: { user: 'bob', text: 'deploy?' }, earlier: [] })
      expect(v).toEqual({ yes: true, p: 0.95, why: 'answer rule "deploys"' })
      expect(s.seen.length).toBe(2)
      expect(Object.keys(s.seen[1]!.questions as object)).toEqual(['who', 'greeting', 'thanks', 'yes0'])
      // A mention Laya refuses: asked again without it (the who question keeps the name).
      s.seen.length = 0
      const w = await judge({ ...DEFAULT_LAYA, url: s.url }, { bot: 'hubbot', rules: { answer: ['deploys'], ignore: [] }, newest: { user: 'bob', text: '@LONGNAME deploy?' }, earlier: [], mentioned: [{ user: 'LONGNAME' }] })
      expect(w.yes).toBe(true)
      expect(s.seen.map(b => Object.keys(b.questions as object))).toEqual([['who', 'to0', 'greeting', 'thanks', 'yes0'], ['who', 'greeting', 'thanks', 'yes0']])
      // Only the bot and the person writing in the thread: Laya isn't asked.
      s.seen.length = 0
      const two = await judge({ ...DEFAULT_LAYA, url: s.url }, { bot: 'hubbot', rules: { answer: [], ignore: ['thanks'] }, newest: { user: 'bob', text: 'thanks!' }, earlier: [{ user: 'hubbot', bot: true, text: 'Done.' }], people: [{ user: 'bob' }, { user: 'hubbot', bot: true }] })
      expect(two).toEqual({ yes: true, p: 1, why: 'only @bob and the bot in this thread' })
      expect(s.seen.length).toBe(0)
    } finally {
      s.srv.stop(true)
    }
  })

  test('readiness: the model is there, missing, or Ollama is away', async () => {
    const s = server(() => Response.json({}))
    try {
      expect(await layaReady({ url: s.url, model: 'laya' })).toBeUndefined()
      expect(await layaReady({ url: s.url, model: 'laya:latest' })).toBeUndefined()
      expect(await layaReady({ url: s.url, model: 'laya:322m-multilingual-bf16' })).toContain('ollama pull laya:322m-multilingual-bf16')
    } finally {
      s.srv.stop(true)
    }
    expect(await layaReady({ url: 'http://127.0.0.1:9', model: 'laya' })).toContain('nothing answers at http://127.0.0.1:9')
  })

  test("readiness of Laya's own server (laya-serve): no model list, but /health", async () => {
    let health: Response = Response.json({ status: 'ok', loaded: ['english'], device: 'mps' })
    const srv = Bun.serve({ port: 0, fetch: req => (new URL(req.url).pathname === '/health' ? health.clone() : new Response('Not Found', { status: 404 })) })
    const url = `http://127.0.0.1:${srv.port}`
    try {
      expect(await layaReady({ url, model: 'laya' })).toBeUndefined() // the model name doesn't matter to it
      health = Response.json({ status: 'loading' })
      expect(await layaReady({ url, model: 'laya' })).toBe(`laya-serve at ${url}: loading`)
      health = new Response('Not Found', { status: 404 })
      expect(await layaReady({ url, model: 'laya' })).toBe(`${url} is neither Ollama nor laya-serve`)
    } finally {
      srv.stop(true)
    }
  })
})
