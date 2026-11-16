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
 * What worked on sample chats (laya:latest, Nov 2026): one base question, "who
 * is the last message (marked >>) meant for: the assistant or other people?",
 * with the conversation oldest first. Rules phrased as a whole instruction
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
  /** Answer when the base question's probability of "meant for the bot" is at least this. */
  threshold: number
  /** A rule decides, over the base question, when it describes the post with at least this probability. */
  ruleThreshold: number
  timeoutMs: number
  /** Earlier posts Laya reads along with the newest one. */
  messages: number
}

export const DEFAULT_LAYA: LayaConfig = { url: 'http://127.0.0.1:11434', model: 'laya', threshold: 0.5, ruleThreshold: 0.85, timeoutMs: 5000, messages: 10 }

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

Laya reads each message that doesn't @mention the bot and the messages before it,
and judges on its own whether the message is meant for the bot. These rules
correct it: each is checked on its own, and decides when it clearly describes the
message ("Don't answer" wins). One short, specific rule per line (at most
${RULE_MAX_CHARS} characters, ${MAX_RULES} rules in all). Vague rules do nothing.

## Answer
- A question or request addressed to the bot, Claude, or "the AI"

## Don't answer
- Thanks, greetings, acknowledgements and small talk
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

export type ChatLine = { who: string; text: string }

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** The conversation, oldest first, the newest post last and marked ">>"; the oldest posts go when it is too long. */
export function buildState(newest: ChatLine, earlier: ChatLine[]): string {
  const lines: string[] = []
  let room = CONTEXT_CHARS
  for (const l of [...earlier].reverse()) {
    const line = `${l.who}: ${clip(l.text || '(a file)', LINE_CHARS)}`
    if (line.length > room) break
    lines.unshift(line)
    room -= line.length + 1
  }
  return [...lines, `>> ${newest.who}: ${clip(newest.text || '(a file)', NEWEST_CHARS)}`].join('\n')
}

const ON = 'the last message (marked >>)'

/** The /v1/systemone request: the base question `who`, then one question per rule (`no0…`, `yes0…`). */
export function buildRequest(o: { bot: string; rules: TriggerRules; newest: ChatLine; earlier: ChatLine[]; model: string }): Record<string, unknown> {
  const r = usableRules(o.rules)
  const questions: Record<string, unknown> = {
    who: {
      type: 'choice',
      instructions: `Who is ${ON} meant for?`,
      criteria: {
        assistant: `The AI assistant @${o.bot} (also called Claude, the bot or the AI): asks or tells it something, or answers its question.`,
        people: 'Other people in the chat, or nobody.',
      },
    },
  }
  const rule = (text: string) => ({ type: 'choice', instructions: `Does this describe ${ON}?`, criteria: { a: text, b: 'Something else' } })
  r.ignore.forEach((t, i) => (questions[`no${i}`] = rule(t)))
  r.answer.forEach((t, i) => (questions[`yes${i}`] = rule(t)))
  return { model: o.model, state: buildState(o.newest, o.earlier), questions, keep_alive: '30m' }
}

type Answers = Record<string, { probabilities?: Record<string, number> } | undefined>

export type Verdict = { yes: boolean; p: number; why: string }

/** The decision from Laya's answers: a sure "don't answer" rule, else a sure "answer" rule, else the base question. */
export function decide(answers: Answers, rules: TriggerRules, cfg: Pick<LayaConfig, 'threshold' | 'ruleThreshold'>): Verdict {
  const p = (k: string, opt: string) => answers[k]?.probabilities?.[opt]
  const base = p('who', 'assistant')
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
  const no = sure('no', r.ignore)
  if (no) return { yes: false, p: no.p, why: `don't-answer rule "${clip(r.ignore[no.i]!, 40)}"` }
  const yes = sure('yes', r.answer)
  if (yes) return { yes: true, p: yes.p, why: `answer rule "${clip(r.answer[yes.i]!, 40)}"` }
  return { yes: base >= cfg.threshold, p: base, why: 'its own reading' }
}

/** POST /v1/systemone; Laya's answers. Throws on any failure. */
export async function askLaya(cfg: Pick<LayaConfig, 'url' | 'timeoutMs'>, body: Record<string, unknown>, fetchFn: typeof fetch = fetch): Promise<Answers> {
  const res = await fetchFn(`${cfg.url.replace(/\/+$/, '')}/v1/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  const j = (await res.json().catch(() => ({}))) as { error?: string; answers?: Answers }
  if (!res.ok) throw new Error(`Laya: HTTP ${res.status}${j.error ? `: ${j.error}` : ''}`)
  if (!j.answers) throw new Error('Laya: no answer in its reply')
  return j.answers
}

/**
 * Judge a post: build the request, ask, decide. A rule Laya refuses (too many
 * tokens for an option) is left out and the question asked again.
 */
export async function judge(cfg: LayaConfig, o: { bot: string; rules: TriggerRules; newest: ChatLine; earlier: ChatLine[] }, fetchFn: typeof fetch = fetch): Promise<Verdict> {
  const rules = usableRules(o.rules)
  const kept: TriggerRules = { answer: [...rules.answer], ignore: [...rules.ignore] }
  for (let attempt = 0; ; attempt++) {
    const body = buildRequest({ ...o, rules: kept, model: cfg.model })
    try {
      return decide(await askLaya(cfg, body, fetchFn), kept, cfg)
    } catch (err) {
      const m = err instanceof Error ? /question (\d+): option \d+ has \d+ tokens/.exec(err.message) : null
      const i = m ? Number(m[1]) - 1 : -1 // question 0 is `who`
      if (!m || i < 0 || attempt >= 3) throw err
      if (i < kept.ignore.length) kept.ignore.splice(i, 1)
      else kept.answer.splice(i - kept.ignore.length, 1)
    }
  }
}

/** Whether Ollama serves the model (for `mmhub doctor`). */
export async function layaReady(cfg: Pick<LayaConfig, 'url' | 'model'>, fetchFn: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetchFn(`${cfg.url.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return `Ollama at ${cfg.url}: HTTP ${res.status}`
    const j = (await res.json()) as { models?: { name?: string; model?: string }[] }
    const want = cfg.model.includes(':') ? cfg.model : `${cfg.model}:latest`
    const names = (j.models ?? []).map(m => m.name ?? m.model ?? '')
    if (!names.includes(want) && !names.includes(cfg.model)) return `Ollama at ${cfg.url} doesn't have ${cfg.model}: ollama pull ${cfg.model}`
    return undefined
  } catch (err) {
    return `Ollama unreachable at ${cfg.url} (${err instanceof Error ? err.message : String(err)})`
  }
}
