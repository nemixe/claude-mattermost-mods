/**
 * Trigger "openrouter": like Laya (laya.ts), it judges the replies without an
 * @mention in hub threads the bot follows, but with a hosted model reached through
 * OpenRouter. Everything around the judgement is Laya's: following from a mention
 * until the router unfollows, the TRIGGER.md rules, the thread as Laya reads it
 * (buildState) and the two-person shortcut.
 *
 * Two kinds of model:
 * - Decision models, the default google/gemini-decision-1 (or
 *   openai/gpt-6-luna-decisions): typed questions through OpenRouter's Decisions API
 *   (/api/alpha/decisions). That is the shape Laya's own server reads, so they get
 *   Laya's questions and Laya's decision (buildRequest, decide), with thresholds of
 *   their own.
 * - Chat models (any other id): one structured question through chat/completions,
 *   who is the reply talking to, and does a rule describe it.
 * Which kind a model is comes from its OpenRouter listing (output modality
 * "decisions"), looked up once per model; `api` in the config overrides it.
 *
 * The key is OPENROUTER_API_KEY in the hub's .env, read on each call and never put
 * in process.env, so sessions never see it. The thread's last posts and the names in
 * it leave the machine: by default only to providers that don't collect prompts
 * (provider.data_collection "deny").
 */

import { addressees, buildRequest, buildState, decide, participants, previousAuthor, twoWay, usableRules, type Answers, type ChatLine, type Person, type TriggerRules, type Verdict } from './laya'

export type OpenRouterApi = 'decisions' | 'chat'

export type OpenRouterConfig = {
  /** An OpenRouter model id: a decision model such as "google/gemini-decision-1", or a chat model. */
  model: string
  /** OpenRouter's API base. */
  url: string
  timeoutMs: number
  /** Earlier posts the model reads along with the newest one. */
  messages: number
  /** "deny" (default): only providers that neither store nor train on prompts. */
  dataCollection: 'deny' | 'allow'
  /** "decisions" or "chat". Unset: from the model's OpenRouter listing. */
  api?: OpenRouterApi
  /** Decision models: answer when "talking to the bot" is at least this likely (LayaConfig.threshold). */
  threshold: number
  /** Decision models: a rule, or "talking to someone it @mentions", decides from this probability. */
  ruleThreshold: number
  /** Decision models: sure the reply is just a greeting, or thanks, from this probability. */
  kindThreshold: number
  /** Chat models that think: OpenRouter's reasoning effort. Unset leaves the model's default. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
}

export const DEFAULT_OPENROUTER: OpenRouterConfig = {
  model: 'google/gemini-decision-1',
  url: 'https://openrouter.ai/api/v1',
  timeoutMs: 10_000,
  messages: 10,
  dataCollection: 'deny',
  threshold: 0.5,
  ruleThreshold: 0.8,
  kindThreshold: 0.7,
}

/** The .env variable that holds the key. */
export const OPENROUTER_KEY = 'OPENROUTER_API_KEY'

/** A call: the config and the key from .env. */
export type OpenRouterCall = OpenRouterConfig & { apiKey?: string }

type Judged = { bot: string; rules: TriggerRules; newest: ChatLine; earlier: ChatLine[]; people?: Person[]; mentioned?: Person[] }

const NOBODY = 'nobody'

function base(cfg: Pick<OpenRouterConfig, 'url'>): string {
  return cfg.url.replace(/\/+$/, '')
}

/** The Decisions route sits beside v1: https://openrouter.ai/api/alpha/decisions. */
function decisionsUrl(cfg: Pick<OpenRouterConfig, 'url'>): string {
  return `${base(cfg).replace(/\/v1$/, '')}/alpha/decisions`
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------- which API

type Listing = { data?: { architecture?: { output_modalities?: unknown }; endpoints?: unknown[] } }

/** What OpenRouter knows of each model, by API base and model id. */
const apis = new Map<string, OpenRouterApi>()
const cacheKey = (cfg: Pick<OpenRouterConfig, 'url' | 'model'>) => `${base(cfg)} ${cfg.model}`

function apiFromListing(j: Listing): OpenRouterApi | undefined {
  const m = j.data?.architecture?.output_modalities
  return Array.isArray(m) ? (m.includes('decisions') ? 'decisions' : 'chat') : undefined
}

/** GET models/<id>/endpoints: the model, its output and who serves it. Needs no key. */
async function listing(cfg: Pick<OpenRouterConfig, 'url' | 'model' | 'timeoutMs'>, fetchFn: typeof fetch): Promise<{ status: number; ok: boolean; j: Listing }> {
  const res = await fetchFn(`${base(cfg)}/models/${cfg.model.split(':')[0]}/endpoints`, { signal: AbortSignal.timeout(cfg.timeoutMs) })
  return { status: res.status, ok: res.ok, j: (await res.json().catch(() => ({}))) as Listing }
}

/** The API a model answers on: `api` when set, else its listing (kept), else a guess from its id. */
export async function apiOf(cfg: Pick<OpenRouterConfig, 'url' | 'model' | 'timeoutMs' | 'api'>, fetchFn: typeof fetch = fetch): Promise<OpenRouterApi> {
  if (cfg.api) return cfg.api
  const known = apis.get(cacheKey(cfg))
  if (known) return known
  try {
    const { ok, j } = await listing(cfg, fetchFn)
    const api = ok ? apiFromListing(j) : undefined
    if (api) {
      apis.set(cacheKey(cfg), api)
      return api
    }
  } catch {}
  return /decision/i.test(cfg.model) ? 'decisions' : 'chat'
}

// ---------------------------------------------------------------- calls

/** POST with the key; the JSON reply. Throws on any failure (the caller then lets only mentions through: trigger.ts). */
async function post(cfg: OpenRouterCall, url: string, body: Record<string, unknown>, fetchFn: typeof fetch): Promise<unknown> {
  if (!cfg.apiKey) throw new Error(`OpenRouter: no ${OPENROUTER_KEY} in .env (mmhub openrouter key)`)
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
  if (!res.ok || j.error) throw new Error(`OpenRouter: HTTP ${res.status}${j.error?.message ? `: ${j.error.message}` : ''}`)
  return j
}

// ---------------------------------------------------------------- decision models

/** The Decisions request: Laya's questions about the thread (laya.ts buildRequest), and which providers may see it. */
export function buildDecisionsRequest(cfg: Pick<OpenRouterConfig, 'model' | 'dataCollection'>, o: Judged): Record<string, unknown> {
  const { keep_alive: _, ...body } = buildRequest({ ...o, model: cfg.model })
  return { ...body, provider: { data_collection: cfg.dataCollection } }
}

/** POST /api/alpha/decisions; the answers. Throws when the base question has none (a refusal, say). */
export async function askDecisions(cfg: OpenRouterCall, body: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<Answers> {
  const j = (await post(cfg, decisionsUrl(cfg), body, fetchFn)) as { answers?: Record<string, { type?: string; probabilities?: Record<string, number> }> }
  const who = j.answers?.who
  if (!j.answers || !who?.probabilities) throw new Error(`OpenRouter: ${who?.type === 'refusal' ? 'the model declined to answer' : 'no answer in its reply'}`)
  return j.answers
}

// ---------------------------------------------------------------- chat models

function system(bot: string): string {
  return `You decide whether a chat message is meant for an AI assistant in a Mattermost thread, so that the assistant answers only messages addressed to it.
The assistant is @${bot} (also called Claude, the bot or the AI). The others in the thread are people or other AI bots.
You get the thread: who is in it, the earlier messages oldest first, and the newest message, marked ">>". Decide who the newest message is talking to:
- @${bot}: a question, request or answer addressed to it, or a reply to what it just said.
- someone else in the thread: it answers them, asks or tells them something, or @mentions them.
- ${NOBODY}: chatter, news or a remark to everyone.
A greeting or thanks is for whoever wrote the message before it. Messages may be in any language.
The workspace's rules correct your reading. When one clearly describes the newest message, set "rule" to "answer" or "ignore" ("ignore" wins when both apply); otherwise "none".
"confidence" is how sure you are of "to", from 0 to 1. Reply with the JSON object only.`
}

function bullets(list: string[]): string {
  return list.length ? list.map(r => `- ${r}`).join('\n') : '(none)'
}

/** The chat/completions request: the thread, the rules, and a JSON schema whose "to" lists who the message may be talking to. */
export function buildChatRequest(cfg: OpenRouterConfig, o: Judged): { body: Record<string, unknown>; names: string[]; nobody: string } {
  const r = usableRules(o.rules)
  const names = participants(o.bot, o.newest, o.earlier, o.mentioned).map(p => p.user)
  const nobody = names.includes(NOBODY) ? `(${NOBODY})` : NOBODY
  const user = `Thread:\n${buildState(o.bot, o.newest, o.earlier, o.people)}\n\nRules: answer when\n${bullets(r.answer)}\n\nRules: don't answer when\n${bullets(r.ignore)}`
  const schema = {
    type: 'object',
    properties: {
      to: { type: 'string', enum: [...names, nobody], description: 'Who the newest message is talking to (a username without @).' },
      rule: { type: 'string', enum: ['answer', 'ignore', 'none'] },
      confidence: { type: 'number' },
    },
    required: ['to', 'rule', 'confidence'],
    additionalProperties: false,
  }
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: 'system', content: system(o.bot) }, { role: 'user', content: user }],
    temperature: 0,
    max_tokens: 200,
    response_format: { type: 'json_schema', json_schema: { name: 'addressee', strict: true, schema } },
    // Only providers that can follow the schema, and (by default) that keep no prompts.
    provider: { require_parameters: true, data_collection: cfg.dataCollection },
    ...(cfg.reasoningEffort ? { reasoning: { effort: cfg.reasoningEffort, exclude: true } } : {}),
  }
  return { body, names, nobody }
}

type ChatAnswer = { to: string; rule: 'answer' | 'ignore' | 'none'; confidence: number }

/** The model's JSON, also when it comes in a code fence or with words around it. */
export function parseAnswer(content: unknown): ChatAnswer {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
  let j: Partial<ChatAnswer> | undefined
  try {
    j = JSON.parse(text)
  } catch {
    const m = /\{[\s\S]*\}/.exec(text)
    if (m) try { j = JSON.parse(m[0]) } catch {}
  }
  if (!j || typeof j.to !== 'string') throw new Error(`OpenRouter: no answer in the model's reply (${text.slice(0, 80)})`)
  const rule = j.rule === 'answer' || j.rule === 'ignore' ? j.rule : 'none'
  const confidence = typeof j.confidence === 'number' && Number.isFinite(j.confidence) ? Math.min(1, Math.max(0, j.confidence)) : 0.5
  return { to: j.to.replace(/^@/, ''), rule, confidence }
}

/** The verdict from a chat answer: a rule decides ("ignore" over "answer"), else whether it talks to the bot. */
export function decideChat(a: ChatAnswer, bot: string, nobody = NOBODY): Verdict {
  if (a.rule === 'ignore') return { yes: false, p: a.confidence, why: "a don't-answer rule" }
  if (a.rule === 'answer') return { yes: true, p: a.confidence, why: 'an answer rule' }
  if (a.to.toLowerCase() === bot.toLowerCase()) return { yes: true, p: a.confidence, why: 'talking to the bot' }
  return { yes: false, p: a.confidence, why: a.to === nobody ? 'talking to nobody in particular' : `talking to @${a.to.slice(0, 40)}` }
}

/** POST chat/completions; the model's answer. Throws on any failure. */
export async function askChat(cfg: OpenRouterCall, body: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<ChatAnswer> {
  const j = (await post(cfg, `${base(cfg)}/chat/completions`, body, fetchFn)) as { choices?: { message?: { content?: unknown } }[] }
  return parseAnswer(j.choices?.[0]?.message?.content)
}

// ---------------------------------------------------------------- the judge

/**
 * Judge a post: in a thread of only the bot and its author it is for the bot (laya.ts
 * twoWay, no call made); else ask the model, on the API it answers on, and decide.
 */
export async function judgeOpenRouter(cfg: OpenRouterCall, o: Judged, fetchFn: typeof fetch = fetch): Promise<Verdict> {
  if (o.people && twoWay(o.bot, o.newest, o.people, o.mentioned)) return { yes: true, p: 1, why: `only @${o.newest.user.slice(0, 40)} and the bot in this thread` }
  if (!cfg.apiKey) throw new Error(`OpenRouter: no ${OPENROUTER_KEY} in .env (mmhub openrouter key)`)
  if ((await apiOf(cfg, fetchFn)) === 'decisions') {
    const answers = await askDecisions(cfg, buildDecisionsRequest(cfg, o), fetchFn)
    return decide(answers, o.rules, cfg, o.bot, addressees(o.bot, o.mentioned), previousAuthor(o.newest, o.earlier))
  }
  const { body, nobody } = buildChatRequest(cfg, o)
  return decideChat(await askChat(cfg, body, fetchFn), o.bot, nobody)
}

/** A thread of three for the test judgement (no two-person shortcut). */
const SAMPLE: Judged = {
  bot: 'claude',
  rules: { answer: [], ignore: [] },
  newest: { user: 'budi', text: 'can you check why the build failed?' },
  earlier: [{ user: 'ana', text: 'the deploy is stuck' }, { user: 'claude', bot: true, text: 'Looking at it.' }],
  people: [{ user: 'ana' }, { user: 'claude', bot: true }, { user: 'budi' }],
}

/**
 * Why the OpenRouter judge can't work yet (no key, a refused key, an unknown model,
 * a test judgement that fails), or undefined when it can. The test judgement is one
 * real call, a fraction of a cent.
 */
export async function openRouterReady(cfg: OpenRouterCall, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  if (!cfg.apiKey) return `no ${OPENROUTER_KEY} in .env (mmhub openrouter key)`
  try {
    const key = await fetchFn(`${base(cfg)}/key`, { headers: { Authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(cfg.timeoutMs) })
    if (key.status === 401 || key.status === 403) return 'OpenRouter refused the key (mmhub openrouter key)'
    if (!key.ok) return `OpenRouter answered HTTP ${key.status} for the key`
  } catch (err) {
    return `OpenRouter unreachable: ${errMsg(err)}`
  }
  const bad = await modelReady(cfg, fetchFn)
  if (bad) return bad
  try {
    await judgeOpenRouter(cfg, SAMPLE, fetchFn)
    return undefined
  } catch (err) {
    const m = errMsg(err)
    const policy = cfg.dataCollection === 'deny' && /data policy|privacy|no endpoints/i.test(m)
    return `a test judgement failed: ${m}${policy ? ' (with openrouter.dataCollection "deny", no provider of this model may be allowed)' : ''}`
  }
}

/** Why OpenRouter can't run `cfg.model` (unknown, nobody serves it, no text or decisions out), or undefined. Needs no key. */
export async function modelReady(cfg: Pick<OpenRouterConfig, 'url' | 'model' | 'timeoutMs'>, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const { status, ok, j } = await listing(cfg, fetchFn)
    if (status === 404) return `OpenRouter has no model ${cfg.model} (mmhub openrouter model <id>)`
    if (!ok) return `OpenRouter answered HTTP ${status} for model ${cfg.model}`
    if (Array.isArray(j.data?.endpoints) && !j.data.endpoints.length) return `no provider serves ${cfg.model} right now`
    const out = j.data?.architecture?.output_modalities
    if (Array.isArray(out) && !out.includes('decisions') && !out.includes('text')) return `${cfg.model} answers in neither text nor decisions`
    const api = apiFromListing(j)
    if (api) apis.set(cacheKey(cfg), api)
    return undefined
  } catch (err) {
    return `OpenRouter unreachable: ${errMsg(err)}`
  }
}
