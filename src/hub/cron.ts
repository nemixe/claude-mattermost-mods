/**
 * Schedules for scheduled jobs (jobs.ts). Pure: parsing and time arithmetic
 * only, unit-tested in test/cron.spec.ts.
 *
 * A schedule is a 5-field cron expression (`m h dom mon dow`, Vixie rules:
 * when both day fields are restricted, either matches) or a shorthand that
 * becomes one:
 *
 *   every day 09:00 · every weekday 8:30 · every weekend 10am · every mon,thu 17:00
 *   every month on the 1st 09:00 · every hour · every 2h · every 2h at :30 · every 30m
 *   @hourly @daily @weekly @monthly @yearly
 *
 * A trailing IANA time zone ("every day 09:00 Asia/Jakarta") sets the job's zone.
 * Times are wall-clock times in that zone; nextRun finds them with Intl, so
 * daylight-saving changes are handled (a skipped wall time doesn't run that
 * day; a repeated one runs once).
 */

export type CronSpec = {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  /** The day-of-month / day-of-week field was "*" (or "*\/n"): the other one decides alone. */
  domStar: boolean
  dowStar: boolean
}

export class ScheduleError extends Error {}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_WORDS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

const EXAMPLES = '"every day 09:00", "every weekday 8:30", "every mon,thu 17:00", "every 2h", "every 30m", or cron "0 9 * * 1-5"'

// ---------------------------------------------------------------------------- cron fields

function field(text: string, min: number, max: number, names?: string[]): Set<number> {
  const out = new Set<number>()
  const num = (s: string): number => {
    const named = names?.indexOf(s.toLowerCase()) ?? -1
    if (named >= 0) return named + (names === MONTHS ? 1 : 0)
    if (!/^\d+$/.test(s)) throw new ScheduleError(`"${s}" is not a number`)
    return Number(s)
  }
  for (const part of text.split(',')) {
    const m = /^([^/]+)(?:\/(\d+))?$/.exec(part)
    if (!m) throw new ScheduleError(`can't read "${part}"`)
    const step = m[2] === undefined ? 1 : Number(m[2])
    if (step < 1) throw new ScheduleError(`step 0 in "${part}"`)
    let lo: number
    let hi: number
    if (m[1] === '*') {
      lo = min
      hi = max
    } else if (m[1]!.includes('-')) {
      const [a, b] = m[1]!.split('-')
      lo = num(a!)
      hi = num(b!)
    } else {
      lo = num(m[1]!)
      hi = m[2] === undefined ? lo : max
    }
    if (lo < min || hi > max || lo > hi) throw new ScheduleError(`"${part}" is outside ${min}-${max}`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 5) throw new ScheduleError(`a cron expression has 5 fields (minute hour day-of-month month day-of-week), not ${f.length}`)
  const dow = field(f[4]!, 0, 7, DAYS)
  if (dow.delete(7)) dow.add(0)
  return {
    minute: field(f[0]!, 0, 59),
    hour: field(f[1]!, 0, 23),
    dom: field(f[2]!, 1, 31),
    month: field(f[3]!, 1, 12, MONTHS),
    dow,
    domStar: f[2]!.startsWith('*'),
    dowStar: f[4]!.startsWith('*'),
  }
}

// ---------------------------------------------------------------------------- shorthands

/** "09:00", "9:30", "9am", "9:30pm", "noon", "midnight" → [hour, minute]. */
function parseTime(s: string): [number, number] | undefined {
  const t = s.trim().toLowerCase()
  if (t === 'noon') return [12, 0]
  if (t === 'midnight') return [0, 0]
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t)
  if (!m || (m[2] === undefined && !m[3])) return undefined
  let h = Number(m[1])
  const mi = m[2] === undefined ? 0 : Number(m[2])
  if (m[3]) {
    if (h < 1 || h > 12) return undefined
    h = (h % 12) + (m[3] === 'pm' ? 12 : 0)
  }
  if (h > 23 || mi > 59) return undefined
  return [h, mi]
}

/** The time at the end of a shorthand ("… at 09:00", "… 9am"); `rest` is what comes before it. */
function trailingTime(s: string): { rest: string; time: [number, number] } | undefined {
  const m = /^(.*?)\s*(?:\bat\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)$/i.exec(s.trim())
  if (!m) return undefined
  const time = parseTime(m[2]!)
  if (!time && !/^\d+$/.test(m[2]!)) throw new ScheduleError(`"${m[2]}" is not a time of day (00:00-23:59, or like 9am)`)
  return time ? { rest: m[1]!.trim(), time } : undefined
}

function divisorOf(n: number, of: number, unit: string): void {
  if (n < 1 || of % n !== 0) {
    const ok = Array.from({ length: of }, (_, i) => i + 1).filter(d => of % d === 0 && d < of)
    throw new ScheduleError(`"every ${n}${unit}" doesn't divide the ${unit === 'h' ? 'day' : 'hour'} evenly; use one of ${ok.join(', ')}${unit}, or a cron expression`)
  }
}

function shorthand(s: string): string | undefined {
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ')
  let m: RegExpExecArray | null
  if ((m = /^every (\d+) ?(m|min|mins|minute|minutes)$/.exec(t))) {
    const n = Number(m[1])
    if (n === 60) return '0 * * * *'
    divisorOf(n, 60, 'm')
    return `*/${n} * * * *`
  }
  if ((m = /^(?:every (?:(\d+) ?(?:h|hr|hrs|hour|hours)|hour)|hourly)(?: at :?(\d{1,2}))?$/.exec(t))) {
    const n = m[1] === undefined ? 1 : Number(m[1])
    const minute = m[2] === undefined ? 0 : Number(m[2])
    if (minute > 59) throw new ScheduleError(`minute ${minute} is outside 0-59`)
    if (n === 24) return `${minute} 0 * * *`
    divisorOf(n, 24, 'h')
    return `${minute} ${n === 1 ? '*' : `*/${n}`} * * *`
  }
  if (!/^(every|daily|weekdays?|monthly)\b/.test(t)) return undefined
  const tt = trailingTime(t)
  if (!tt) throw new ScheduleError(/\s\d{1,2}$/.test(t) ? 'write the time as "09:00" or "9am"' : `add a time, e.g. "${t} 09:00"`)
  const [h, mi] = tt.time
  const days = tt.rest
  if (/^(every day|daily|every ?day)$/.test(days)) return `${mi} ${h} * * *`
  if (/^(every weekday|weekdays|every workday)$/.test(days)) return `${mi} ${h} * * 1-5`
  if (/^(every weekend|weekends)$/.test(days)) return `${mi} ${h} * * 0,6`
  if ((m = /^(?:every month|monthly)(?: on)?(?: the)?(?: day)? (\d{1,2})(?:st|nd|rd|th)?$/.exec(days))) {
    const d = Number(m[1])
    if (d < 1 || d > 31) throw new ScheduleError(`day ${d} is outside 1-31`)
    return `${mi} ${h} ${d} * *`
  }
  if ((m = /^every (.+)$/.exec(days))) {
    const words = m[1]!.split(/\s*(?:,|\band\b|\s)\s*/).filter(Boolean)
    const dows = words.map(w => DAY_WORDS[w.replace(/s$/, '')] ?? DAY_WORDS[w])
    if (words.length && dows.every(d => d !== undefined)) return `${mi} ${h} * * ${[...new Set(dows)].sort((a, b) => a! - b!).join(',')}`
  }
  throw new ScheduleError(`can't read "${s.trim()}"; try ${EXAMPLES}`)
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** This machine's time zone (the default for new jobs). */
export function hubTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/**
 * A schedule as people write it → the cron expression it means, and the time
 * zone it ends with, if any. Throws ScheduleError with what to write instead.
 */
export function parseSchedule(text: string): { cron: string; tz?: string } {
  let s = text.trim().replace(/\s+/g, ' ')
  if (!s) throw new ScheduleError(`empty schedule; try ${EXAMPLES}`)
  let tz: string | undefined
  const last = /^(.*?)\s+(?:in\s+)?(\S+)$/.exec(s)
  if (last && /^([A-Z][A-Za-z_]+\/[A-Za-z0-9_+\-/]+|UTC|GMT)$/.test(last[2]!)) {
    if (!validTimezone(last[2]!)) throw new ScheduleError(`unknown time zone "${last[2]}" (use an IANA name like Asia/Jakarta)`)
    tz = last[2]!
    s = last[1]!
  }
  const alias = ALIASES[s.toLowerCase()]
  const cron = alias ?? shorthand(s) ?? s
  if (cron.split(' ').length !== 5) throw new ScheduleError(`can't read "${s}"; try ${EXAMPLES}`)
  parseCron(cron)
  return { cron: cron.toLowerCase(), ...(tz ? { tz } : {}) }
}

// ---------------------------------------------------------------------------- time

type Local = { y: number; mo: number; d: number; h: number; mi: number; dow: number }
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
const formats = new Map<string, Intl.DateTimeFormat>()

/** Wall-clock parts of an instant in a time zone. */
export function localParts(ms: number, tz: string): Local {
  let f = formats.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
    })
    formats.set(tz, f)
  }
  const o: Record<string, string> = {}
  for (const p of f.formatToParts(ms)) o[p.type] = p.value
  return { y: Number(o.year), mo: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, mi: Number(o.minute), dow: WEEKDAY[o.weekday!] ?? 0 }
}

function dayMatches(s: CronSpec, l: Local): boolean {
  const dom = s.dom.has(l.d)
  const dow = s.dow.has(l.dow)
  if (s.domStar && s.dowStar) return true
  if (s.domStar) return dow
  if (s.dowStar) return dom
  return dom || dow
}

const MIN = 60_000
/** How far ahead nextRun looks before deciding a schedule never runs (Feb 30). */
const HORIZON_MS = 5 * 366 * 86_400_000

/**
 * The first whole minute after `after` whose wall-clock time in `tz` matches
 * the schedule, or undefined if none does within five years.
 */
export function nextRun(cron: string | CronSpec, tz: string, after: number): number | undefined {
  const s = typeof cron === 'string' ? parseCron(cron) : cron
  const prev = localParts(after, tz)
  const prevKey = `${prev.y}-${prev.mo}-${prev.d} ${prev.h}:${prev.mi}`
  let t = Math.floor(after / MIN) * MIN + MIN
  const end = after + HORIZON_MS
  while (t < end) {
    const l = localParts(t, tz)
    if (!s.month.has(l.mo) || !dayMatches(s, l)) {
      // To about 23:00 of this day, then hour by hour past midnight (a daylight-saving day may be 23 or 25 hours long).
      t += (l.h < 22 ? (22 - l.h) * 60 + (60 - l.mi) : 60 - l.mi) * MIN
      continue
    }
    if (!s.hour.has(l.h)) {
      t += (60 - l.mi) * MIN
      continue
    }
    if (!s.minute.has(l.mi)) {
      let m = l.mi + 1
      while (m < 60 && !s.minute.has(m)) m++
      t += (m - l.mi) * MIN
      continue
    }
    // An hour that repeats when clocks go back: its times run once.
    if (`${l.y}-${l.mo}-${l.d} ${l.h}:${l.mi}` === prevKey) {
      t += MIN
      continue
    }
    return t
  }
  return undefined
}

/** The shortest time between two runs, in minutes (from the hours and minutes it runs at; days ignored). */
export function minGapMinutes(cron: string | CronSpec): number {
  const s = typeof cron === 'string' ? parseCron(cron) : cron
  const times: number[] = []
  for (const h of [...s.hour].sort((a, b) => a - b)) for (const m of [...s.minute].sort((a, b) => a - b)) times.push(h * 60 + m)
  if (times.length < 2) return 1440
  let gap = times[0]! + 1440 - times[times.length - 1]!
  for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i]! - times[i - 1]!)
  return gap
}

const display = new Map<string, Intl.DateTimeFormat>()

/** "Wed 18 Nov 09:00" in the zone (the year too when it isn't this year). */
export function fmtLocal(ms: number, tz: string, now = Date.now()): string {
  const l = localParts(ms, tz)
  const key = `${tz}`
  let f = display.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' })
    display.set(key, f)
  }
  const year = localParts(now, tz).y === l.y ? '' : ` ${l.y}`
  return `${f.format(ms).replace(',', '')}${year} ${String(l.h).padStart(2, '0')}:${String(l.mi).padStart(2, '0')}`
}
