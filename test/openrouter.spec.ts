import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { apiOf, buildChatRequest, buildDecisionsRequest, decideChat, DEFAULT_OPENROUTER, judgeOpenRouter, openRouterReady, parseAnswer } from '../src/hub/openrouter'
import { setEnvVar } from '../src/shared/util'

const thread = {
  bot: 'hubbot',
  rules: { answer: ['questions about the build'], ignore: ['lunch plans'] },
  newest: { user: 'alice', text: 'is the build green?' },
  earlier: [{ user: 'bob', text: 'deploying now' }, { user: 'hubbot', bot: true, text: 'Looking.' }],
  people: [{ user: 'bob' }, { user: 'hubbot', bot: true }, { user: 'alice' }],
}
const cfg = { ...DEFAULT_OPENROUTER, apiKey: 'sk-or-v1-test' }
/** A chat model, told so (no listing looked up). */
const chat = { ...cfg, model: 'google/gemini-2.5-flash-lite', api: 'chat' as const }

function fakeFetch(reply: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return reply(String(url), init)
  }) as unknown as typeof fetch
  return { f, calls }
}
const answer = (o: object) => Response.json({ choices: [{ message: { content: JSON.stringify(o) } }] })
const listed = (out: string[]) => Response.json({ data: { architecture: { output_modalities: out }, endpoints: [{}] } })
const decisions = (who: Record<string, number>, more: object = {}) => Response.json({ answers: { who: { type: 'choice', probabilities: who }, ...more } })

describe('decision models (the default, google/gemini-decision-1)', () => {
  test("Laya's questions about the thread go to the Decisions API, with the key and the data policy", () => {
    const body = buildDecisionsRequest(DEFAULT_OPENROUTER, { ...thread, mentioned: [] })
    expect(body.model).toBe('google/gemini-decision-1')
    expect(body.state).toContain('People in this thread: @bob, @hubbot (AI assistant), @alice.')
    expect(body.state).toContain('>> @alice: is the build green?')
    const q = body.questions as Record<string, { type: string; criteria: Record<string, string> }>
    expect(Object.keys(q)).toEqual(['who', 'greeting', 'thanks', 'no0', 'yes0'])
    expect(Object.keys(q.who!.criteria)).toEqual(['hubbot', 'bob', 'nobody'])
    expect(q.no0!.criteria.a).toBe('lunch plans')
    expect(body.provider).toEqual({ data_collection: 'deny' })
    expect(body.keep_alive).toBeUndefined()
  })
  test('decided as Laya decides, with its own thresholds', async () => {
    const { f, calls } = fakeFetch(() => decisions({ hubbot: 0.62, bob: 0.3, nobody: 0.08 }))
    expect(await judgeOpenRouter({ ...cfg, api: 'decisions' }, thread, f)).toEqual({ yes: true, p: 0.62, why: 'its own reading' })
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-v1-test')
    // A sure don't-answer rule wins over the base question.
    const rule = fakeFetch(() => decisions({ hubbot: 0.9, nobody: 0.1 }, { no0: { type: 'choice', probabilities: { a: 0.93, b: 0.07 } } }))
    expect(await judgeOpenRouter({ ...cfg, api: 'decisions' }, thread, rule.f)).toEqual({ yes: false, p: 0.93, why: `don't-answer rule "lunch plans"` })
    const low = fakeFetch(() => decisions({ hubbot: 0.4, nobody: 0.6 }))
    expect((await judgeOpenRouter({ ...cfg, api: 'decisions' }, thread, low.f)).yes).toBe(false)
  })
  test('a refusal or an error throws (the hub then lets only mentions through)', async () => {
    const refused = fakeFetch(() => Response.json({ answers: { who: { type: 'refusal' } } }))
    await expect(judgeOpenRouter({ ...cfg, api: 'decisions' }, thread, refused.f)).rejects.toThrow('the model declined to answer')
    const policy = fakeFetch(() => Response.json({ error: { message: 'No endpoints found matching your data policy' } }, { status: 404 }))
    await expect(judgeOpenRouter({ ...cfg, api: 'decisions' }, thread, policy.f)).rejects.toThrow('HTTP 404: No endpoints found matching your data policy')
  })
  test('which API a model answers on comes from its listing, looked up once', async () => {
    const { f, calls } = fakeFetch(url => (url.includes('/models/') ? listed(['decisions']) : decisions({ hubbot: 0.9, nobody: 0.1 })))
    const c = { ...cfg, model: 'acme/decider-7' }
    expect(await apiOf(c, f)).toBe('decisions')
    expect(await apiOf(c, f)).toBe('decisions')
    expect(calls.map(x => x.url)).toEqual(['https://openrouter.ai/api/v1/models/acme/decider-7/endpoints'])
    expect(await apiOf({ ...cfg, model: 'acme/talker-2' }, fakeFetch(() => listed(['text'])).f)).toBe('chat')
    // Unreachable listing: a guess from the id, not kept.
    const down = fakeFetch(() => { throw new Error('offline') })
    expect(await apiOf({ ...cfg, model: 'acme/x-decisions' }, down.f)).toBe('decisions')
    expect(await apiOf({ ...cfg, model: 'acme/y' }, down.f)).toBe('chat')
  })
})

describe('chat models', () => {
  test("the thread as Laya reads it, the rules, a schema naming who it may be talking to; only providers that keep no prompts", () => {
    const { body, names } = buildChatRequest(chat, thread)
    expect(body.model).toBe('google/gemini-2.5-flash-lite')
    expect(names).toEqual(['hubbot', 'bob'])
    const [sys, user] = body.messages as { role: string; content: string }[]
    expect(sys!.content).toContain('The assistant is @hubbot')
    expect(user!.content).toContain('People in this thread: @bob, @hubbot (AI assistant), @alice.')
    expect(user!.content).toContain('>> @alice: is the build green?')
    expect(user!.content).toContain('- questions about the build')
    expect(user!.content).toContain('- lunch plans')
    const schema = (body.response_format as { json_schema: { strict: boolean; schema: { properties: { to: { enum: string[] } } } } }).json_schema
    expect(schema.strict).toBe(true)
    expect(schema.schema.properties.to.enum).toEqual(['hubbot', 'bob', 'nobody'])
    expect(body.provider).toEqual({ require_parameters: true, data_collection: 'deny' })
    expect(body.temperature).toBe(0)
    expect(body.reasoning).toBeUndefined()
    expect(buildChatRequest({ ...chat, reasoningEffort: 'low' }, thread).body.reasoning).toEqual({ effort: 'low', exclude: true })
    // Someone called "nobody" keeps their name; the no-one answer moves aside.
    expect(buildChatRequest(chat, { ...thread, earlier: [{ user: 'nobody', text: 'hi' }] }).nobody).toBe('(nobody)')
  })
})

describe('the verdict', () => {
  test('a rule decides first ("ignore" over "answer"), then whether the reply talks to the bot', () => {
    expect(decideChat({ to: 'hubbot', rule: 'ignore', confidence: 0.9 }, 'hubbot').yes).toBe(false)
    expect(decideChat({ to: 'nobody', rule: 'answer', confidence: 0.8 }, 'hubbot').yes).toBe(true)
    expect(decideChat({ to: 'HubBot', rule: 'none', confidence: 0.7 }, 'hubbot')).toEqual({ yes: true, p: 0.7, why: 'talking to the bot' })
    expect(decideChat({ to: 'bob', rule: 'none', confidence: 0.9 }, 'hubbot')).toEqual({ yes: false, p: 0.9, why: 'talking to @bob' })
    expect(decideChat({ to: 'nobody', rule: 'none', confidence: 0.6 }, 'hubbot').why).toBe('talking to nobody in particular')
  })
  test('the answer is read from plain JSON, a code fence, or words around it', () => {
    expect(parseAnswer('{"to":"@hubbot","rule":"none","confidence":2}')).toEqual({ to: 'hubbot', rule: 'none', confidence: 1 })
    expect(parseAnswer('```json\n{"to":"bob","rule":"weird"}\n```')).toEqual({ to: 'bob', rule: 'none', confidence: 0.5 })
    expect(() => parseAnswer('I think the bot')).toThrow('no answer')
  })
})

describe('judgeOpenRouter with a chat model', () => {
  test('asks chat/completions with the key, then decides', async () => {
    const { f, calls } = fakeFetch(() => answer({ to: 'hubbot', rule: 'none', confidence: 0.92 }))
    expect(await judgeOpenRouter(chat, thread, f)).toEqual({ yes: true, p: 0.92, why: 'talking to the bot' })
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-v1-test')
  })
  test('only the bot and the author in the thread: for the bot, without a call', async () => {
    const { f, calls } = fakeFetch(() => answer({}))
    const v = await judgeOpenRouter(chat, { ...thread, earlier: [{ user: 'hubbot', bot: true, text: 'Hi' }], people: [{ user: 'hubbot', bot: true }, { user: 'alice' }] }, f)
    expect(v.yes).toBe(true)
    expect(calls.length).toBe(0)
  })
  test('no key, a refused key or an error throws (the hub then lets only mentions through)', async () => {
    const { f } = fakeFetch(() => Response.json({ error: { message: 'No auth credentials found', code: 401 } }, { status: 401 }))
    await expect(judgeOpenRouter({ ...chat, apiKey: undefined }, thread, f)).rejects.toThrow('no OPENROUTER_API_KEY')
    await expect(judgeOpenRouter(chat, thread, f)).rejects.toThrow('OpenRouter: HTTP 401: No auth credentials found')
  })
})

describe('openRouterReady', () => {
  test('the key, then the model and whether anyone serves it, then one test judgement', async () => {
    expect(await openRouterReady({ ...cfg, apiKey: undefined })).toContain('no OPENROUTER_API_KEY')
    const route = (key: number, model: number, endpoints: unknown[] = [{}], judged: () => Response = () => decisions({ claude: 0.9, nobody: 0.1 })) =>
      fakeFetch(url =>
        url.endsWith('/key') ? new Response('{}', { status: key })
        : url.includes('/models/') ? Response.json({ data: { architecture: { output_modalities: ['decisions'] }, endpoints } }, { status: model })
        : judged())
    expect(await openRouterReady(cfg, route(401, 200).f)).toContain('refused the key')
    expect(await openRouterReady(cfg, route(200, 404).f)).toContain('no model google/gemini-decision-1')
    expect(await openRouterReady(cfg, route(200, 200, []).f)).toContain('no provider serves')
    const policy = route(200, 200, [{}], () => Response.json({ error: { message: 'No endpoints found matching your data policy' } }, { status: 404 }))
    expect(await openRouterReady(cfg, policy.f)).toContain('a test judgement failed: OpenRouter: HTTP 404: No endpoints found matching your data policy (with openrouter.dataCollection "deny"')
    const ok = route(200, 200)
    expect(await openRouterReady(cfg, ok.f)).toBeUndefined()
    expect(ok.calls.map(c => c.url)).toEqual(['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/models/google/gemini-decision-1/endpoints', 'https://openrouter.ai/api/alpha/decisions'])
  })
})

test('setEnvVar replaces one key and keeps the rest, at 0600', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'mmhub-env-')), '.env')
  writeFileSync(f, 'MATTERMOST_URL=https://mm.example.com\nOPENROUTER_API_KEY=old\nMATTERMOST_BOT_TOKEN=t\n\n')
  setEnvVar(f, 'OPENROUTER_API_KEY', 'sk-or-new')
  expect(readFileSync(f, 'utf8')).toBe('MATTERMOST_URL=https://mm.example.com\nMATTERMOST_BOT_TOKEN=t\nOPENROUTER_API_KEY=sk-or-new\n')
  expect(statSync(f).mode & 0o777).toBe(0o600)
  expect(() => setEnvVar(f, 'X', 'a\nB=c')).toThrow()
})
