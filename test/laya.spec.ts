// Laya: TRIGGER.md rules, what it is asked (within its 512-token, 48-tokens-an-option limits),
// how its answers decide, and the Ollama call.

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  askLaya, buildRequest, buildState, CONTEXT_CHARS, decide, DEFAULT_LAYA, DEFAULT_TRIGGER_MD, judge, layaReady, LINE_CHARS, loadTrigger,
  MAX_RULES, NEWEST_CHARS, parseTrigger, RULE_MAX_CHARS, saveTrigger, triggerFile, usableRules,
} from '../src/hub/laya'

describe('TRIGGER.md', () => {
  test('rules are the list items under an "answer" heading and a "don\'t answer" one; other text is ignored', () => {
    expect(parseTrigger(DEFAULT_TRIGGER_MD)).toEqual({
      answer: ['A question or request addressed to the bot, Claude, or "the AI"'],
      ignore: ['Thanks, greetings, acknowledgements and small talk'],
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
    const earlier = Array.from({ length: 10 }, (_, i) => ({ who: `@u${i}`, text: `message ${i} ${'y'.repeat(200)}` }))
    const lines = buildState({ who: '@bob', text: `can you check the build? ${'z'.repeat(1000)}` }, earlier).split('\n')
    const newest = lines.at(-1)!
    expect(newest).toStartWith('>> @bob: can you check the build?')
    expect(newest.length).toBeLessThanOrEqual('>> @bob: '.length + NEWEST_CHARS)
    const rest = lines.slice(0, -1)
    expect(rest.at(-1)).toStartWith('@u9: message 9') // the latest earlier one is kept
    expect(rest[0]).not.toStartWith('@u0') // the oldest are dropped first
    for (const l of rest) expect(l.length).toBeLessThanOrEqual(5 + LINE_CHARS)
    expect(rest.join('\n').length).toBeLessThanOrEqual(CONTEXT_CHARS)
    // Short posts: all ten fit.
    expect(buildState({ who: '@bob', text: 'ok' }, earlier.map(e => ({ ...e, text: 'hi' }))).split('\n').length).toBe(11)
    expect(buildState({ who: '@bob', text: '' }, [])).toBe('>> @bob: (a file)')
  })

  test('a base question, then one question per rule', () => {
    const body = buildRequest({ bot: 'hubbot', rules: { answer: ['deploy questions'], ignore: ['lunch plans'] }, newest: { who: '@bob', text: 'hi' }, earlier: [], model: 'laya' })
    expect(body).toMatchObject({ model: 'laya', state: '>> @bob: hi', keep_alive: '30m' })
    const q = body.questions as Record<string, { type: string; instructions: string; criteria: Record<string, string> }>
    expect(Object.keys(q)).toEqual(['who', 'no0', 'yes0'])
    expect(q.who!.instructions).toBe('Who is the last message (marked >>) meant for?')
    expect(q.who!.criteria.assistant).toContain('@hubbot (also called Claude, the bot or the AI)')
    expect(q.no0).toEqual({ type: 'choice', instructions: 'Does this describe the last message (marked >>)?', criteria: { a: 'lunch plans', b: 'Something else' } })
    expect(q.yes0!.criteria.a).toBe('deploy questions')
  })
})

describe('the decision', () => {
  const rules = { answer: ['deploy questions'], ignore: ['lunch plans', 'thanks'] }
  const cfg = { threshold: 0.5, ruleThreshold: 0.85 }
  const ans = (who: number, rest: Record<string, number> = {}) => ({
    who: { probabilities: { assistant: who, people: 1 - who } },
    ...Object.fromEntries(Object.entries(rest).map(([k, p]) => [k, { probabilities: { a: p, b: 1 - p } }])),
  })

  test("its own reading, unless a rule is sure; a sure \"don't answer\" rule beats a sure \"answer\" one", () => {
    expect(decide(ans(0.7), rules, cfg)).toEqual({ yes: true, p: 0.7, why: 'its own reading' })
    expect(decide(ans(0.3, { no0: 0.8, yes0: 0.84 }), rules, cfg)).toMatchObject({ yes: false, why: 'its own reading' }) // rules not sure enough
    expect(decide(ans(0.3, { yes0: 0.9 }), rules, cfg)).toEqual({ yes: true, p: 0.9, why: 'answer rule "deploy questions"' })
    expect(decide(ans(0.9, { no1: 0.99 }), rules, cfg)).toEqual({ yes: false, p: 0.99, why: 'don\'t-answer rule "thanks"' })
    expect(decide(ans(0.9, { no0: 0.86, no1: 0.95, yes0: 0.99 }), rules, cfg)).toMatchObject({ yes: false, why: 'don\'t-answer rule "thanks"' })
    expect(() => decide({}, rules, cfg)).toThrow('no answer')
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

  test('a rule Laya refuses (too many tokens for an option) is left out and the question asked again', async () => {
    const s = server(body => {
      const qs = Object.entries(body.questions as Record<string, { criteria: Record<string, string> }>)
      const bad = qs.findIndex(([, q]) => q.criteria.a?.startsWith('LONG'))
      if (bad >= 0) return Response.json({ error: `question ${bad}: option 0 has 51 tokens; limit is 48` }, { status: 400 })
      return Response.json({ answers: { who: { probabilities: { assistant: 0.2 } }, ...Object.fromEntries(qs.slice(1).map(([k]) => [k, { probabilities: { a: 0.95 } }])) } })
    })
    try {
      const v = await judge({ ...DEFAULT_LAYA, url: s.url }, { bot: 'hubbot', rules: { answer: ['LONG rule', 'deploys'], ignore: [] }, newest: { who: '@bob', text: 'deploy?' }, earlier: [] })
      expect(v).toEqual({ yes: true, p: 0.95, why: 'answer rule "deploys"' })
      expect(s.seen.length).toBe(2)
      expect(Object.keys(s.seen[1]!.questions as object)).toEqual(['who', 'yes0'])
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
    expect(await layaReady({ url: 'http://127.0.0.1:9', model: 'laya' })).toContain('Ollama unreachable')
  })
})
