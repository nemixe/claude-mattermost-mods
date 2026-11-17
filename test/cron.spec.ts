// Schedules for scheduled jobs: shorthands and cron expressions, time zones,
// daylight-saving days, and the shortest gap between runs.

import { describe, expect, test } from 'bun:test'
import { fmtLocal, minGapMinutes, nextRun, parseCron, parseSchedule, ScheduleError } from '../src/hub/cron'

const at = (iso: string) => Date.parse(iso)
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString())

describe('parseSchedule', () => {
  test.each([
    ['every day 09:00', '0 9 * * *'],
    ['Every Weekday at 8:30am', '30 8 * * 1-5'],
    ['every weekend 10am', '0 10 * * 0,6'],
    ['every mon,thu 17:00', '0 17 * * 1,4'],
    ['every monday and friday 9:15pm', '15 21 * * 1,5'],
    ['every Sundays noon', '0 12 * * 0'],
    ['daily at midnight', '0 0 * * *'],
    ['every month on the 1st 09:00', '0 9 1 * *'],
    ['monthly on 15 at 18:30', '30 18 15 * *'],
    ['every hour', '0 * * * *'],
    ['hourly at :45', '45 * * * *'],
    ['every 2h', '0 */2 * * *'],
    ['every 2 hours at :30', '30 */2 * * *'],
    ['every 30m', '*/30 * * * *'],
    ['every 15 minutes', '*/15 * * * *'],
    ['@daily', '0 0 * * *'],
    ['@weekly', '0 0 * * 0'],
    ['0 9 * * MON-FRI', '0 9 * * mon-fri'],
    ['*/20   8-18  * * 1-5', '*/20 8-18 * * 1-5'],
  ])('%s → %s', (text, cron) => {
    expect(parseSchedule(text)).toEqual({ cron })
  })

  test('a trailing time zone', () => {
    expect(parseSchedule('every day 09:00 Asia/Jakarta')).toEqual({ cron: '0 9 * * *', tz: 'Asia/Jakarta' })
    expect(parseSchedule('0 9 * * * in UTC')).toEqual({ cron: '0 9 * * *', tz: 'UTC' })
    expect(parseSchedule('every weekday 7:00 America/Argentina/Buenos_Aires').tz).toBe('America/Argentina/Buenos_Aires')
  })

  test.each([
    ['every day', 'add a time'],
    ['every day 9', 'write the time as'],
    ['every 7m', "doesn't divide the hour evenly"],
    ['every 5h', "doesn't divide the day evenly"],
    ['every blah 9am', "can't read"],
    ['whenever', "can't read"],
    ['0 9 * *', "can't read"],
    ['61 * * * *', 'outside 0-59'],
    ['0 9 * 13 *', 'outside 1-12'],
    ['every day 25:00', 'is not a time of day'],
    ['every day 13pm', 'is not a time of day'],
    ['every day 09:00 Mars/Olympus_Mons', 'unknown time zone'],
    ['', 'empty schedule'],
  ])('%s is refused (%s)', (text, why) => {
    expect(() => parseSchedule(text)).toThrow(ScheduleError)
    expect(() => parseSchedule(text)).toThrow(why)
  })
})

describe('nextRun', () => {
  test('wall-clock times in the zone', () => {
    // Tue 17 Nov 2026 10:00 in Jakarta (UTC+7).
    const now = at('2026-11-17T03:00:00Z')
    expect(iso(nextRun('0 9 * * 1-5', 'Asia/Jakarta', now))).toBe('2026-11-18T02:00:00.000Z')
    expect(iso(nextRun('0 9 * * *', 'UTC', now))).toBe('2026-11-17T09:00:00.000Z')
    // Friday after 9: Monday.
    expect(iso(nextRun('0 9 * * 1-5', 'Asia/Jakarta', at('2026-11-20T03:00:00Z')))).toBe('2026-11-23T02:00:00.000Z')
    // A due time itself is "after": the next one follows.
    expect(iso(nextRun('*/30 * * * *', 'UTC', at('2026-11-17T03:30:00Z')))).toBe('2026-11-17T04:00:00.000Z')
    expect(iso(nextRun('*/30 * * * *', 'UTC', at('2026-11-17T03:29:59Z')))).toBe('2026-11-17T03:30:00.000Z')
  })

  test('day of month and day of week: either matches when both are set', () => {
    const tz = 'Asia/Jakarta'
    // "the 15th, or Fridays", from Thu 12 Nov 2026.
    let t = nextRun('0 9 15 * 5', tz, at('2026-11-12T00:00:00Z'))!
    expect(iso(t)).toBe('2026-11-13T02:00:00.000Z') // Fri 13
    t = nextRun('0 9 15 * 5', tz, t)!
    expect(iso(t)).toBe('2026-11-15T02:00:00.000Z') // Sun 15
    expect(iso(nextRun('0 9 15 * 5', tz, t))).toBe('2026-11-20T02:00:00.000Z') // Fri 20
    // With "*" in one day field, the other decides.
    expect(iso(nextRun('0 9 1 * *', tz, at('2026-11-17T00:00:00Z')))).toBe('2026-12-01T02:00:00.000Z')
    expect(iso(nextRun('0 0 1 1 *', 'UTC', at('2026-11-17T00:00:00Z')))).toBe('2027-01-01T00:00:00.000Z')
  })

  test('never: undefined', () => {
    expect(nextRun('0 0 30 2 *', 'UTC', at('2026-11-17T00:00:00Z'))).toBeUndefined()
  })

  test('daylight saving: a skipped wall time does not run that day; a repeated one runs once', () => {
    const tz = 'America/New_York'
    // 8 Mar 2026: 02:00 → 03:00, so 02:30 doesn't exist that day.
    expect(iso(nextRun('30 2 * * *', tz, at('2026-03-07T12:00:00Z')))).toBe('2026-03-09T06:30:00.000Z')
    expect(iso(nextRun('0 9 * * *', tz, at('2026-03-07T15:00:00Z')))).toBe('2026-03-08T13:00:00.000Z') // 09:00 EDT
    // 1 Nov 2026: 02:00 → 01:00, so 01:30 happens twice; it runs at the first, then the next day.
    const first = nextRun('30 1 * * *', tz, at('2026-10-31T12:00:00Z'))!
    expect(iso(first)).toBe('2026-11-01T05:30:00.000Z') // 01:30 EDT
    expect(iso(nextRun('30 1 * * *', tz, first))).toBe('2026-11-02T06:30:00.000Z') // 01:30 EST, the day after
    expect(iso(nextRun('0 9 * * *', tz, first))).toBe('2026-11-01T14:00:00.000Z') // 09:00 EST
  })

  test('fast enough for a year-long search', () => {
    const t0 = performance.now()
    expect(iso(nextRun('0 0 29 2 *', 'Asia/Jakarta', at('2026-03-01T00:00:00Z')))).toBe('2028-02-28T17:00:00.000Z')
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})

test('minGapMinutes: from the hours and minutes it runs at', () => {
  expect(minGapMinutes('*/15 * * * *')).toBe(15)
  expect(minGapMinutes('0,5 9 * * *')).toBe(5)
  expect(minGapMinutes('0 9,17 * * *')).toBe(480)
  expect(minGapMinutes('0 9 * * 1-5')).toBe(1440)
  expect(minGapMinutes('55 0,23 * * *')).toBe(60) // 23:55 → 00:55 the next day
  expect(minGapMinutes(parseCron('0 */2 * * *'))).toBe(120)
})

test('fmtLocal', () => {
  const now = at('2026-11-17T03:00:00Z')
  expect(fmtLocal(at('2026-11-18T02:00:00Z'), 'Asia/Jakarta', now)).toBe('Wed 18 Nov 09:00')
  expect(fmtLocal(at('2027-01-01T00:00:00Z'), 'UTC', now)).toBe('Fri 1 Jan 2027 00:00')
})
