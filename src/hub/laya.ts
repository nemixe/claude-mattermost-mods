/**
 * Laya, Convai Innovations' decision model served by Ollama, decides whether a
 * reply that doesn't @mention the bot, in a thread the bot follows, is meant
 * for it. This is opt-in, for workspaces whose trigger is "laya" (following:
 * trigger.ts).
 *
 * Laya sees the newest post, up to `messages` posts before it in its thread,
 * and the workspace's TRIGGER.md rules. Its limits (Ollama 0.40, laya:latest): 512 tokens per question in
 * all, each option at most 48 tokens, and a longer text is cut silently. It is
 * English-only (laya:322m-multilingual-bf16 reads 100+ languages).
 *
 * The base question is dynamic: "who is the last message (marked >>) talking
 * to?", with one answer per participant (the bot first, then those the post
 * @mentions, then the thread's other posters, latest first) and "nobody".
 * Posters are labelled in the conversation: the bot "(AI assistant)", other
 * bot accounts "(another AI bot)". Measured on a real channel (laya:latest,
 * Nov 2026) where a person mostly talked to another bot: the older two-way
 * question ("the assistant or other people?") sent nearly every reply there to
 * the bot, since they were all meant for *an* AI; with the participants as
 * answers, about a third did, at the same hit rate on posts that were for the
 * bot. Giving Laya only the bot's own posts made it worse (it then can't see
 * who the person is talking to).
 *
 * The base question underrates an @mention: in a thread where a person mostly
 * talks to the bot, "@other can you…" still scored for the bot. So for each
 * account the post @mentions, Laya is also asked "is the last message talking
 * to @other?" (`to0…`). It is sure (0.88 to 0.94) when the post does talk to
 * them, and less sure (0.63 to 0.8) when it only names them ("summarize what
 * @other said"); when sure (`ruleThreshold`), the post isn't for the bot.
 *
 * The conversation starts with everyone in the thread ("People in this thread:
 * …", the bot always among them). On the same channel this made Laya far more
 * careful: at `threshold` 0.45, 4 in 526 replies not for the bot were sent,
 * against about 1 in 4 without it, and 3 of 5 requests for it in threads of
 * three or more (all 5 without it; at 0.5, 2 of 5 and 1 in 526).
 *
 * When the thread holds only the bot and the person who wrote the newest post, and the post
 * @mentions no one else, it is for the bot without asking Laya (`twoWay`).
 * Otherwise Laya is also asked whether the post is just a greeting (then it
 * isn't for the bot) or thanks (then it is for whoever wrote the post before it,
 * so for the bot only after the bot's own post). Laya tells English greetings
 * and thanks apart surely (0.8 to 0.98); Indonesian thanks ("makasih") scored
 * only about 0.5, so those fall through to the rules and the base question.
 *
 * Rules phrased as a whole instruction
 * made it worse. Asked one by one ("does this describe the last message?"),
 * specific rules score high when they apply (thanks 0.99, lunch plans 0.86),
 * while vague ones hover around 0.5 to 0.8 on everything. So each rule is a
 * question of its own in the same call, and it overrides the base question
 * only when Laya is sure (`ruleThreshold`). A "don't answer" rule wins over an
 * "answer" rule.
 *
 * TRIGGER.md has an "## Answer" list and a "## Don't answer" list, one rule
 * per line. Workers change it with the trigger_rules tool; owners edit it by
 * hand.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export type LayaConfig = {
  /** Ollama's base URL. */
  url: string
  model: string
  /** Answer when the base question's probability of "talking to the bot" is at least this. */
  threshold: number
  /** A rule decides, over the base question, when it describes the post with at least this probability. */
  ruleThreshold: number
  /** Laya is sure the post is just a greeting, or thanks, from this probability. */
  kindThreshold: number
  timeoutMs: number
  /** Earlier posts Laya reads along with the newest one. */
  messages: number
  /** Set by `mmhub laya install`: the hub runs Laya's own server (layaserve.ts) instead of using Ollama. */
  serve?: ServeConfig
}

/** laya-serve as the hub runs it: its port, the checkpoints it loads, and a torch device (default: the best there is). */
export type ServeConfig = {
  port: number
  models: string[]
  device?: string
  /** Free the models after this many idle minutes (layaserve.ts DEFAULT_UNLOAD_MINUTES); 0 keeps them loaded. */
  unloadAfterMinutes?: number
}

/** A call to Laya: the config, and laya-serve's API key when the hub runs it (never stored in config.json). */
export type LayaCall = { apiKey?: string }

function authHeaders(c: LayaCall): Record<string, string> {
  return c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}
}

export const DEFAULT_LAYA: LayaConfig = { url: 'http://127.0.0.1:11434', model: 'laya', threshold: 0.45, ruleThreshold: 0.85, kindThreshold: 0.7, timeoutMs: 5000, messages: 10 }

/** Rules Laya is asked about, all told (each is one question; Laya takes 64 per call). */
export const MAX_RULES = 24
/** Characters of one rule (an option holds 48 tokens). */
export const RULE_MAX_CHARS = 150
/** Characters of the newest post. */
export const NEWEST_CHARS = 350
/** Characters per earlier post, and of all earlier posts together (the text shares 512 tokens with the question). */
export const LINE_CHARS = 140
export const CONTEXT_CHARS = 850
/** TRIGGER.md as a whole. */
export const TRIGGER_MAX_CHARS = 6000

export const DEFAULT_TRIGGER_MD = `# When to answer without an @mention

The judge (Laya, or a model through OpenRouter) reads each message that doesn't
@mention the bot and the messages before it, and judges on its own whether the
message is meant for the bot. These rules
correct it: each is checked on its own, and decides when it clearly describes the
message ("Don't answer" wins). One short, specific rule per line (at most
${RULE_MAX_CHARS} characters, ${MAX_RULES} rules in all). Vague rules do nothing.

## Answer
- A question or request addressed to the bot, Claude, or "the AI"

## Don't answer
- Acknowledgements and small talk
`

export type TriggerRules = { answer: string[]; ignore: string[] }

export function triggerFile(wsDir: string): string {
  return join(wsDir, 'TRIGGER.md')
}

/** The rules under "## Answer" and "## Don't answer" (any heading saying so); other text is ignored. */
export function parseTrigger(md: string): TriggerRules {
  const out: TriggerRules = { answer: [], ignore: [] }
  let section: keyof TriggerRules | undefined
  for (const line of md.split('\n')) {
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      const title = h[1]!.toLowerCase()
      section = /\b(don'?t|do not|never|not|ignore|skip|quiet)\b/.test(title) ? 'ignore' : /\b(answer|respond|reply)\b/.test(title) ? 'answer' : undefined
      continue
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line)
    if (section && item) out[section].push(item[1]!)
  }
  return out
}

/** The workspace's rules: its TRIGGER.md, or the built-in ones. */
export function loadTrigger(wsDir: string): { rules: TriggerRules; text: string; own: boolean } {
  const f = triggerFile(wsDir)
  const text = existsSync(f) ? readFileSync(f, 'utf8') : DEFAULT_TRIGGER_MD
  return { rules: parseTrigger(text), text, own: existsSync(f) }
}

/** What Laya is asked about: "don't answer" rules first (they win), each clipped, MAX_RULES in all. */
export function usableRules(rules: TriggerRules): TriggerRules & { dropped: number; clipped: number } {
  const ignore = rules.ignore.slice(0, MAX_RULES)
  const answer = rules.answer.slice(0, MAX_RULES - ignore.length)
  const clipped = [...ignore, ...answer].filter(r => r.length > RULE_MAX_CHARS).length
  const clip = (r: string) => (r.length > RULE_MAX_CHARS ? r.slice(0, RULE_MAX_CHARS) : r)
  return { answer: answer.map(clip), ignore: ignore.map(clip), dropped: rules.answer.length + rules.ignore.length - answer.length - ignore.length, clipped }
}

/** Replace TRIGGER.md. Throws a message for the session when it can't be used. */
export function saveTrigger(wsDir: string, content: string): TriggerRules {
  const text = content.replace(/\r\n/g, '\n').trimEnd() + '\n'
  if (text.length > TRIGGER_MAX_CHARS) throw new Error(`TRIGGER.md may be at most ${TRIGGER_MAX_CHARS} characters (this is ${text.length})`)
  const rules = parseTrigger(text)
  if (!rules.answer.length && !rules.ignore.length) throw new Error('no rules found: put one rule per line ("- …") under "## Answer" and "## Don\'t answer"')
  const f = triggerFile(wsDir)
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o644 })
  renameSync(tmp, f)
  return rules
}

/** A post as Laya sees it: its author's username (`bot`: a bot account) and its text. */
export type ChatLine = { user: string; bot?: boolean; text: string }
/** Someone the newest post may be talking to. */
export type Person = { user: string; bot?: boolean }

/** Answers to "who is it talking to?" besides "nobody": the bot and up to five others. */
export const MAX_PARTICIPANTS = 6
/** Characters of a username in Laya's text and options. */
const NAME_CHARS = 40
const EVERYONE = new Set(['channel', 'here', 'all'])

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** How a poster appears to Laya: the bot is the AI assistant; other bot accounts are other AI bots. */
function label(p: Person, bot: string): string {
  const name = `@${clip(p.user, NAME_CHARS)}`
  return p.user === bot ? `${name} (AI assistant)` : p.bot ? `${name} (another AI bot)` : name
}

/** People named on the "People in this thread" line, at most. */
export const MAX_PEOPLE = 8

/**
 * Everyone in the thread: those who have posted, in the order they first did, the
 * newest post's author last if they hadn't. The bot first if it hasn't posted yet:
 * it follows the thread, so it was mentioned there.
 */
export function members(bot: string, newest: ChatLine, people: Person[]): Person[] {
  const out: Person[] = people.some(p => p.user === bot) ? [] : [{ user: bot, bot: true }]
  for (const p of [...people, newest]) if (!out.some(x => x.user === p.user)) out.push({ user: p.user, bot: p.bot })
  return out
}

/**
 * The conversation: who has posted in the thread (when `people` is given), then
 * the posts oldest first, the newest last and marked ">>"; the oldest posts go
 * when it is too long.
 */
export function buildState(bot: string, newest: ChatLine, earlier: ChatLine[], people?: Person[]): string {
  const lines: string[] = []
  let head: string | undefined
  if (people) {
    const all = members(bot, newest, people)
    const more = all.length - MAX_PEOPLE
    head = `People in this thread: ${all.slice(0, MAX_PEOPLE).map(p => label(p, bot)).join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
  }
  let room = CONTEXT_CHARS - (head ? head.length + 1 : 0)
  for (const l of [...earlier].reverse()) {
    const line = `${label(l, bot)}: ${clip(l.text || '(a file)', LINE_CHARS)}`
    if (line.length > room) break
    lines.unshift(line)
    room -= line.length + 1
  }
  return [...(head ? [head] : []), ...lines, `>> ${label(newest, bot)}: ${clip(newest.text || '(a file)', NEWEST_CHARS)}`].join('\n')
}

/** Usernames a post @mentions (lowercase, in order; not @channel, @here or @all). */
export function mentionedNames(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(^|[^\w.-])@([\w][\w.-]*)/g)) {
    const name = m[2]!.replace(/[.-]+$/, '').toLowerCase()
    if (name && !EVERYONE.has(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** Who the newest post may be talking to: the bot, then those it @mentions, then the thread's other posters, latest first. */
export function participants(bot: string, newest: ChatLine, earlier: ChatLine[], mentioned: Person[] = []): Person[] {
  const out: Person[] = [{ user: bot, bot: true }]
  const add = (p: Person, isMention: boolean) => {
    if (out.some(x => x.user === p.user) || (p.user === newest.user && !isMention)) return
    out.push({ user: p.user, bot: p.bot })
  }
  for (const m of mentioned) add(m, true)
  for (const l of [...earlier].reverse()) add(l, false)
  return out.slice(0, MAX_PARTICIPANTS)
}

const NOBODY = 'nobody'
/** The option key of a participant ("nobody" is taken). The bot comes first, so its key never changes. */
function optionKeys(ps: Person[]): string[] {
  const keys: string[] = []
  for (const p of ps) {
    let k = p.user.replace(/[^\w]/g, '_')
    while (k === NOBODY || keys.includes(k)) k += '_'
    keys.push(k)
  }
  return keys
}

/** Accounts the post @mentions besides the bot: one "is it talking to them?" question each. */
export function addressees(bot: string, mentioned: Person[] = []): Person[] {
  const out: Person[] = []
  for (const m of mentioned) if (m.user !== bot && !out.some(x => x.user === m.user)) out.push(m)
  return out.slice(0, MAX_PARTICIPANTS - 1)
}

/**
 * Only the bot and one person have posted in the thread, that person wrote the
 * newest post, and it @mentions no one but the bot: then it is for the bot,
 * whatever it says. Not when a bot account wrote it (two bots would answer each
 * other).
 */
export function twoWay(bot: string, newest: ChatLine, people: Person[], mentioned: Person[] = []): boolean {
  if (newest.bot || newest.user === bot || addressees(bot, mentioned).length) return false
  return people.every(p => p.user === bot || p.user === newest.user)
}

/** Who wrote the post before the newest one (the latest by someone else): thanks are for them. */
export function previousAuthor(newest: ChatLine, earlier: ChatLine[]): Person | undefined {
  const l = earlier.findLast(x => x.user !== newest.user)
  return l && { user: l.user, bot: l.bot }
}

/** The bot's option key in the base question. */
export function botKey(bot: string): string {
  return optionKeys([{ user: bot }])[0]!
}

const ON = 'the last message (marked >>)'
// Asked apart: one "greeting, thanks or else?" question scored thanks lower.
const GREETING = { greeting: 'A greeting (any language): hi, hai, halo, hello, hey, pagi, good morning, selamat pagi.', other: 'Anything else: a question, request, answer, thanks or remark.' }
const THANKS = { thanks: 'Thanks: thanks, thank you, thx, makasih, terima kasih.', other: 'Anything else: a question, request, answer, greeting or remark.' }

/**
 * The /v1/systemone request: the base question `who` (one answer per participant,
 * then "nobody"), "is it talking to @x?" for each account the post @mentions
 * (`to0…`), whether it is just a greeting (`greeting`) or thanks (`thanks`), then
 * one question per rule (`no0…`, `yes0…`).
 */
export function buildRequest(o: { bot: string; rules: TriggerRules; newest: ChatLine; earlier: ChatLine[]; people?: Person[]; mentioned?: Person[]; model: string }): Record<string, unknown> {
  const r = usableRules(o.rules)
  const ps = participants(o.bot, o.newest, o.earlier, o.mentioned)
  const otherBots = ps.some(p => p.user !== o.bot && p.bot)
  const keys = optionKeys(ps)
  const criteria: Record<string, string> = {}
  ps.forEach((p, i) => {
    const name = `@${clip(p.user, NAME_CHARS)}`
    criteria[keys[i]!] = p.user === o.bot
      ? `${name} (AI assistant${otherBots ? '' : ', also called Claude, the bot or the AI'})`
      : `${name} (${p.bot ? 'another AI bot' : 'a person'})`
  })
  criteria[NOBODY] = 'Nobody in particular, or everyone: chatter, thanks, news.'
  const questions: Record<string, unknown> = { who: { type: 'choice', instructions: `Who is ${ON} talking to?`, criteria } }
  addressees(o.bot, o.mentioned).forEach((m, i) => {
    const name = `@${clip(m.user, NAME_CHARS)}`
    questions[`to${i}`] = { type: 'choice', instructions: `Is ${ON} talking to ${name}?`, criteria: { yes: `Yes: it asks or tells ${name} something.`, no: 'No: it is for someone else.' } }
  })
  questions.greeting = { type: 'choice', instructions: `What is ${ON}?`, criteria: GREETING }
  questions.thanks = { type: 'choice', instructions: `What is ${ON}?`, criteria: THANKS }
  const rule = (text: string) => ({ type: 'choice', instructions: `Does this describe ${ON}?`, criteria: { a: text, b: 'Something else' } })
  r.ignore.forEach((t, i) => (questions[`no${i}`] = rule(t)))
  r.answer.forEach((t, i) => (questions[`yes${i}`] = rule(t)))
  return { model: o.model, state: buildState(o.bot, o.newest, o.earlier, o.people), questions, keep_alive: '30m' }
}

export type Answers = Record<string, { probabilities?: Record<string, number> } | undefined>

export type Verdict = { yes: boolean; p: number; why: string }

/**
 * The decision from Laya's answers: not for the bot when it is sure the post talks to
 * someone it @mentions. Sure it is thanks: for the bot when `previous` (who wrote the
 * post before) is the bot. Sure it is just a greeting: not for the bot. Then a sure
 * "don't answer" rule, a sure "answer" rule, and last the base question.
 */
export function decide(answers: Answers, rules: TriggerRules, cfg: Pick<LayaConfig, 'threshold' | 'ruleThreshold' | 'kindThreshold'>, bot: string, mentioned: Person[] = [], previous?: Person): Verdict {
  const p = (k: string, opt: string) => answers[k]?.probabilities?.[opt]
  const base = p('who', botKey(bot))
  if (typeof base !== 'number' || !Number.isFinite(base)) throw new Error('Laya: no answer in its reply')
  const r = usableRules(rules)
  const sure = (prefix: string, list: string[]) => {
    let best: { i: number; p: number } | undefined
    list.forEach((_, i) => {
      const q = p(`${prefix}${i}`, 'a')
      if (typeof q === 'number' && q >= cfg.ruleThreshold && (!best || q > best.p)) best = { i, p: q }
    })
    return best
  }
  const to = addressees(bot, mentioned)
  let other: { i: number; p: number } | undefined
  to.forEach((_, i) => {
    const q = p(`to${i}`, 'yes')
    if (typeof q === 'number' && q >= cfg.ruleThreshold && (!other || q > other.p)) other = { i, p: q }
  })
  if (other) return { yes: false, p: other.p, why: `talking to @${clip(to[other.i]!.user, 40)}` }
  // Sure of both (a greeting can read as thanks, and back): the likelier one.
  const kind = (k: 'greeting' | 'thanks') => { const q = p(k, k); return typeof q === 'number' && q >= cfg.kindThreshold ? q : 0 }
  const greeting = kind('greeting'), thanks = kind('thanks')
  if (thanks && thanks >= greeting) {
    const to = previous ? `@${clip(previous.user, 40)}` : 'nobody'
    return { yes: previous?.user === bot, p: thanks, why: `thanks, for the post before it (${to})` }
  }
  if (greeting) return { yes: false, p: greeting, why: 'just a greeting, in a thread of more than two' }
  const no = sure('no', r.ignore)
  if (no) return { yes: false, p: no.p, why: `don't-answer rule "${clip(r.ignore[no.i]!, 40)}"` }
  const yes = sure('yes', r.answer)
  if (yes) return { yes: true, p: yes.p, why: `answer rule "${clip(r.answer[yes.i]!, 40)}"` }
  return { yes: base >= cfg.threshold, p: base, why: 'its own reading' }
}

/** POST /v1/systemone; Laya's answers. Throws on any failure. */
export async function askLaya(cfg: Pick<LayaConfig, 'url' | 'timeoutMs'> & LayaCall, body: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<Answers> {
  const res = await fetchFn(`${cfg.url.replace(/\/+$/, '')}/v1/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  const j = (await res.json().catch(() => ({}))) as { error?: string; answers?: Answers }
  if (!res.ok) throw new Error(`Laya: HTTP ${res.status}${j.error ? `: ${j.error}` : ''}`)
  if (!j.answers) throw new Error('Laya: no answer in its reply')
  return j.answers
}

/**
 * Judge a post: in a thread of only the bot and its author, it is for the bot
 * (`twoWay`, `people` being everyone who posted before it); else build the request,
 * ask, decide. A rule or @mention Laya refuses (too many tokens for an option) is
 * left out and the question asked again.
 */
export async function judge(cfg: LayaConfig & LayaCall, o: { bot: string; rules: TriggerRules; newest: ChatLine; earlier: ChatLine[]; people?: Person[]; mentioned?: Person[] }, fetchFn: typeof fetch = fetch): Promise<Verdict> {
  if (o.people && twoWay(o.bot, o.newest, o.people, o.mentioned)) return { yes: true, p: 1, why: `only @${clip(o.newest.user, 40)} and the bot in this thread` }
  const rules = usableRules(o.rules)
  const kept: TriggerRules = { answer: [...rules.answer], ignore: [...rules.ignore] }
  const mentioned = addressees(o.bot, o.mentioned)
  const previous = previousAuthor(o.newest, o.earlier)
  for (let attempt = 0; ; attempt++) {
    const body = buildRequest({ ...o, rules: kept, mentioned, model: cfg.model })
    try {
      return decide(await askLaya(cfg, body, fetchFn), kept, cfg, o.bot, mentioned, previous)
    } catch (err) {
      const m = err instanceof Error ? /question (\d+): option \d+ has \d+ tokens/.exec(err.message) : null
      const key = m ? Object.keys(body.questions as object)[Number(m[1])] : undefined
      const k = key ? /^(to|no|yes)(\d+)$/.exec(key) : null // `who`, `greeting` and `thanks` can't be left out
      if (!k || attempt >= 3) throw err
      const list = k[1] === 'to' ? mentioned : k[1] === 'no' ? kept.ignore : kept.answer
      list.splice(Number(k[2]), 1)
    }
  }
}

/**
 * Why Laya can't answer yet, or undefined when it can (for `mmhub doctor`): Ollama
 * without the model, or a server that isn't up. Ollama lists its models at
 * /api/tags; Laya's own server (`laya-serve`, from `pip install "laya[serve]"`) has
 * no such list and reports itself at /health instead, and judges the same way.
 */
export async function layaReady(cfg: Pick<LayaConfig, 'url' | 'model'> & LayaCall, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  const get = (path: string) => fetchFn(`${cfg.url.replace(/\/+$/, '')}${path}`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(3000) })
  try {
    const res = await get('/api/tags')
    if (res.status === 401 || res.status === 403) return `${cfg.url} refused the API key (HTTP ${res.status})`
    if (res.status === 404) {
      const h = await get('/health')
      const j = (await h.json().catch(() => ({}))) as { status?: string }
      if (!h.ok || j.status !== 'ok') return h.ok || h.status !== 404 ? `laya-serve at ${cfg.url}: ${j.status ?? `HTTP ${h.status}`}` : `${cfg.url} is neither Ollama nor laya-serve`
      // /health needs no key, so check it with a request it refuses (400, before the model runs) or turns away (401).
      const k = await fetchFn(`${cfg.url.replace(/\/+$/, '')}/v1/systemone`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) }, body: '{}', signal: AbortSignal.timeout(3000) })
      if (k.status === 401 || k.status === 403) return `laya-serve at ${cfg.url} refused the API key (HTTP ${k.status})`
      return undefined
    }
    if (!res.ok) return `Ollama at ${cfg.url}: HTTP ${res.status}`
    const j = (await res.json()) as { models?: { name?: string; model?: string }[] }
    const want = cfg.model.includes(':') ? cfg.model : `${cfg.model}:latest`
    const names = (j.models ?? []).map(m => m.name ?? m.model ?? '')
    if (!names.includes(want) && !names.includes(cfg.model)) return `Ollama at ${cfg.url} doesn't have ${cfg.model}: ollama pull ${cfg.model}`
    return undefined
  } catch (err) {
    return `nothing answers at ${cfg.url} (${err instanceof Error ? err.message : String(err)}): start Ollama, or laya-serve`
  }
}
