/**
 * Scheduled jobs ("cron"): recurring work that runs without anyone posting.
 *
 * At each time its schedule gives (cron.ts), a job hands its text to a router
 * of its workspace, like a person's message: each run gets a router of its own
 * for a new thread in the job's channel, or goes to the router of an existing
 * hub thread. Nothing waits on a live session: the message goes through the
 * router's inbox, which starts or resumes it within the hub's session caps (a
 * full pool means it waits its turn).
 *
 * What people read comes only from the sessions; the hub posts nothing of its
 * own. The schedule and unschedule tools post nothing (the session confirms in
 * its own words). A run's new thread starts as a draft (store.ts): the router's
 * first reply is a new post in the channel, which opens the thread, and a run
 * with nothing worth posting posts nothing at all.
 *
 * Who: owners only. A session (the schedule tool) must cite an owner's message
 * in its thread asking for the job; `!cron` is an owner command; the CLI runs
 * as this machine's user.
 *
 * No double runs: every due time gets one job_runs row (unique per job and
 * time), written together with the job's next time before anything is posted.
 * The check runs on the hub's sleep-proof 5 s ticker (and the reaper), never
 * on a long timer. A time found due more than the job's grace (30 min) late —
 * the hub was down, the machine asleep — is skipped and logged; several
 * missed times run at most once. A time whose previous run is still waiting
 * or being worked on is skipped too, so runs never pile up.
 */

import { errMsg, fmtAge, log, shortId } from '../shared/util'
import { fmtLocal, hubTimezone, minGapMinutes, nextRun, parseCron, parseSchedule, ScheduleError, validTimezone } from './cron'
import type { Hub } from './hub'
import { requestChannel } from './links'
import { isOwner } from './access'
import { isBotPost, type MMPost } from './mattermost'
import { DRAFT, type JobRow, type JobRunRow, type ThreadRow } from './store'
import { ToolError } from './tools'
import { loadBindings } from './workspaces'

export const MAX_JOBS_PER_WORKSPACE = 20
/** Runs at least this far apart: a job runs Claude sessions, which cost. */
export const MIN_GAP_MINUTES = 15
export const MAX_JOB_TEXT = 4000
export const MAX_JOB_NAME = 60
export const DEFAULT_GRACE_MINUTES = 30
const RUN_HISTORY_MS = 90 * 86_400_000
const OPEN = new Set(['queued', 'delivered', 'interrupted'])

export type JobInput = {
  workspace: string
  schedule: string
  text: string
  name?: string
  /** IANA zone (default: the schedule's own, else this machine's). */
  tz?: string
  /** A new thread each run in this channel (default: the workspace's first bound channel). */
  channelId?: string
  /** Every run to the router of this hub thread instead. */
  threadId?: string
  graceMinutes?: number
  createdBy: string
  origin: string
}

function fail(msg: string): never {
  throw new ToolError(msg)
}

/** Run on the hub's chain; a refusal comes back to the caller without the chain logging it as a failure. */
export async function onChain<T>(hub: Hub, fn: () => Promise<T> | T): Promise<T> {
  const r = await hub.enqueue(async () => {
    try {
      return { ok: true as const, v: await fn() }
    } catch (e) {
      return { ok: false as const, e }
    }
  })
  if (!r.ok) throw r.e
  return r.v
}

/** A short name from the instruction's first words. */
function nameFrom(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ')
  return words.length > MAX_JOB_NAME ? `${words.slice(0, MAX_JOB_NAME - 1)}…` : words
}

/** Check a job and store it; returns it. Call on the chain. */
export async function addJob(hub: Hub, j: JobInput, now = Date.now()): Promise<JobRow> {
  const w = hub.ws(j.workspace) ?? fail(`no workspace "${j.workspace}"`)
  const text = j.text.trim()
  if (!text) fail('the job needs an instruction: what the router should do at each run')
  if (text.length > MAX_JOB_TEXT) fail(`the instruction is ${text.length} characters (max ${MAX_JOB_TEXT}); put long material in the workspace knowledge/ folder and point to it`)
  let parsed: ReturnType<typeof parseSchedule>
  try {
    parsed = parseSchedule(j.schedule)
  } catch (err) {
    fail(err instanceof ScheduleError ? `schedule: ${err.message}` : errMsg(err))
  }
  if (j.tz && parsed.tz && j.tz !== parsed.tz) fail(`two time zones: ${parsed.tz} in the schedule and ${j.tz}`)
  const tz = j.tz ?? parsed.tz ?? hubTimezone()
  if (!validTimezone(tz)) fail(`unknown time zone "${tz}" (use an IANA name like Asia/Jakarta)`)
  const gap = minGapMinutes(parsed.cron)
  if (gap < MIN_GAP_MINUTES) fail(`"${j.schedule.trim()}" runs every ${gap} min at times; jobs run at least ${MIN_GAP_MINUTES} minutes apart`)
  const nextAt = nextRun(parsed.cron, tz, now) ?? fail(`"${j.schedule.trim()}" never runs`)
  const count = hub.store.jobs(w.name).length
  if (count >= MAX_JOBS_PER_WORKSPACE) fail(`workspace ${w.name} already has ${count} jobs (max ${MAX_JOBS_PER_WORKSPACE}); remove one first`)
  const grace = j.graceMinutes ?? DEFAULT_GRACE_MINUTES
  if (!Number.isInteger(grace) || grace < 0 || grace > 1440) fail('grace is whole minutes, 0-1440')

  let channelId: string | undefined
  let threadId: string | undefined
  if (j.threadId) {
    const t = hub.store.thread(j.threadId)
    if (!t || t.workspace !== w.name) fail(`${j.threadId} is not a hub thread of workspace ${w.name}`)
    threadId = t.id
  } else {
    channelId = j.channelId ?? (await requestChannel(hub, w)) ?? fail(`workspace ${w.name} has no channel bound; bind one first (mmhub ws bind)`)
    if (loadBindings(hub.p.bindings)[channelId] !== w.name) fail(`channel ${channelId} is not bound to workspace ${w.name}`)
  }
  const name = (j.name?.replace(/\s+/g, ' ').trim() || nameFrom(text)).slice(0, MAX_JOB_NAME)
  // As written, without the zone at its end (it is shown beside it).
  let schedule = j.schedule.trim().replace(/\s+/g, ' ')
  if (parsed.tz) schedule = schedule.replace(/\s+(?:in\s+)?\S+$/, '')
  const id = hub.store.insertJob({
    name, workspace: w.name, schedule, cron: parsed.cron, tz, channelId, threadId, text,
    graceMinutes: grace, paused: false, createdBy: j.createdBy, origin: j.origin, createdAt: now, nextAt,
  })
  log('cron', `job #${id} "${name}" (${w.name}) added by ${j.createdBy}: ${parsed.cron} ${tz}, next ${new Date(nextAt).toISOString()}`)
  return hub.store.job(id)!
}

export function getJob(hub: Hub, id: number, workspace?: string): JobRow {
  const job = hub.store.job(id) ?? fail(`no job #${id}`)
  if (workspace && job.workspace !== workspace) fail(`job #${id} belongs to workspace ${job.workspace}`)
  return job
}

/** Remove a job and its run history. Call on the chain. */
export function removeJob(hub: Hub, id: number, by: string, workspace?: string): JobRow {
  const job = getJob(hub, id, workspace)
  hub.store.deleteJob(id)
  log('cron', `job #${id} "${job.name}" removed by ${by}`)
  return job
}

/** Pause or resume. A resumed job runs from its next time after now: paused times don't catch up. Call on the chain. */
export function setPaused(hub: Hub, id: number, paused: boolean, by: string, workspace?: string, now = Date.now()): JobRow {
  const job = getJob(hub, id, workspace)
  if (job.paused === paused) return job
  hub.store.patchJob(id, paused ? { paused } : { paused, nextAt: nextRun(job.cron, job.tz, now) })
  log('cron', `job #${id} "${job.name}" ${paused ? 'paused' : 'resumed'} by ${by}`)
  return hub.store.job(id)!
}

// ---------------------------------------------------------------------------- running

/** The latest run that went ahead. */
function lastStarted(hub: Hub, jobId: number): JobRunRow | undefined {
  return hub.store.runs(jobId, 50).find(r => r.status === 'started')
}

/**
 * That run's message still waits for its router, or the router is working on
 * it — unless the router is stuck ("failed") or an owner stopped it, when the
 * message waits for someone to act and must not hold up later runs.
 */
function stillGoing(hub: Hub, run: JobRunRow | undefined): boolean {
  if (run?.inboxId === undefined) return false
  if (!OPEN.has(hub.store.messageState(run.inboxId) ?? '')) return false
  const key = run.threadId ? hub.store.thread(run.threadId)?.routerKey : undefined
  const s = key ? hub.store.session(key) : undefined
  return !s || (s.status !== 'failed' && !(s.status === 'stopped' && s.closeReason === 'manual'))
}

/** Run every job whose time has come. Call on the chain. */
export async function runDueJobs(hub: Hub, now = Date.now()): Promise<number> {
  // Posting needs Mattermost: wait for it (the grace counts from the due time).
  if (hub.stopping || !hub.mm.connected) return 0
  let n = 0
  for (const job of hub.store.dueJobs(now)) {
    try {
      await due(hub, job, now)
      n++
    } catch (err) {
      log('cron', `job #${job.id}: ${errMsg(err)}`)
    }
  }
  return n
}

async function due(hub: Hub, job: JobRow, now: number): Promise<void> {
  const spec = parseCron(job.cron)
  // The latest due time by now; earlier ones that came and went are counted, not run.
  let slot = job.nextAt!
  let passed = 0
  for (let i = 0; i < 100_000; i++) {
    const n = nextRun(spec, job.tz, slot)
    if (n === undefined || n > now) break
    slot = n
    passed++
  }
  const next = nextRun(spec, job.tz, slot)
  const late = now - slot
  const at = fmtLocal(slot, job.tz, now)
  const earlier = passed ? `; ${passed} earlier time(s) missed too` : ''
  const record = (status: JobRunRow['status'], note?: string) =>
    hub.store.recordRun({ jobId: job.id, slot, kind: 'scheduled', at: now, status, ...(note ? { note } : {}) }, next)

  if (late > job.graceMinutes * 60_000) {
    const note = `due ${at}, found ${fmtAge(late)} late (the hub was down or the machine asleep)${earlier}: skipped`
    record('missed', note)
    log('cron', `job #${job.id} "${job.name}": ${note}`)
    return
  }
  if (stillGoing(hub, lastStarted(hub, job.id))) {
    const note = `due ${at}: skipped, the run before is still waiting or being worked on`
    record('skipped', note)
    log('cron', `job #${job.id} "${job.name}": ${note}`)
    return
  }
  const runId = record('started', passed ? `${passed} earlier time(s) missed` : undefined)
  if (runId === undefined) return // this time ran before (a restart between recording and moving on)
  await start(hub, job, runId, slot, `due ${at}${late > 90_000 ? `, running ${fmtAge(late)} late${earlier}` : ''}`)
}

/** Run a job now, besides its schedule (its next time stays). Call on the chain. */
export async function runNow(hub: Hub, id: number, by: string, workspace?: string, now = Date.now()): Promise<{ job: JobRow; run?: JobRunRow }> {
  const job = getJob(hub, id, workspace)
  const runId = hub.store.recordRun({ jobId: job.id, slot: now, kind: 'manual', at: now, status: 'started', note: `run now by ${by}` }, 'keep')!
  await start(hub, job, runId, now, `run now by ${by}`)
  return { job: hub.store.job(id)!, run: hub.store.runs(id, 1)[0] }
}

/** Pick the run's thread (a draft for a new one: nothing is posted) and hand the instruction to its router. */
async function start(hub: Hub, job: JobRow, runId: number, slot: number, when: string): Promise<void> {
  const failed = (why: string) => {
    hub.store.patchRun(runId, { status: 'failed', note: why })
    hub.store.patchJob(job.id, { lastStatus: 'failed' })
    log('cron', `job #${job.id} "${job.name}": run failed — ${why}`)
  }
  const w = hub.ws(job.workspace)
  if (!w) return failed(`workspace ${job.workspace} is gone`)
  let thread: ThreadRow
  if (job.threadId) {
    const t = hub.store.thread(job.threadId)
    if (!t) return failed(`thread ${job.threadId} is gone`)
    thread = t
  } else {
    const ch = job.channelId!
    if (loadBindings(hub.p.bindings)[ch] !== w.name) return failed(`channel ${ch} is no longer bound to workspace ${w.name}`)
    // Nothing posted: the router's first reply opens the thread (tools.ts postAs).
    const id = `${DRAFT}${shortId(12)}`
    hub.createRouter({ threadId: id, channelId: ch, workspace: w, label: `⏰ ${job.name}`.slice(0, 60) })
    thread = hub.store.thread(id)!
  }
  const meta: Record<string, string> = {
    chat_id: thread.channelId,
    thread_id: thread.id,
    user: `job:${job.id}`,
    kind: 'scheduled',
    job_id: String(job.id),
    workspace: w.name,
    ts: new Date(slot).toISOString(),
  }
  const { id } = await hub.deliver(thread.routerKey, routerText(job, when), meta)
  hub.store.patchRun(runId, { threadId: thread.id, inboxId: id })
  hub.store.patchJob(job.id, { lastThread: thread.id })
  hub.status.changed()
  log('cron', `job #${job.id} "${job.name}" → thread ${thread.id} (router ${thread.routerKey}; ${when})`)
}

function routerText(job: JobRow, when: string): string {
  const where = job.threadId
    ? 'Post the outcome in this thread with reply: the hub posts nothing for this run, so your reply is all people see.'
    : "Nothing is posted yet: your first reply is a new post in the channel, which opens this run's thread, so make it stand on its own (people never see this instruction). If there is nothing worth posting, post nothing."
  return [
    `[Scheduled job #${job.id} "${job.name}" (${job.schedule}, ${job.tz}; ${when}), set up by ${job.createdBy}. Not a person: the hub runs this on its schedule, and nobody may be watching. Do what it asks — answer yourself when reading is enough, delegate work that changes things. ${where} Keep it short, and say plainly when something needs a person.]`,
    '',
    job.text,
  ].join('\n')
}

/** Forget runs older than 90 days. */
export function pruneJobRuns(hub: Hub, now = Date.now()): void {
  hub.store.pruneRuns(now - RUN_HISTORY_MS)
}

// ---------------------------------------------------------------------------- showing

function whereText(hub: Hub, job: JobRow, md: boolean): string {
  if (job.threadId) return `in thread ${md ? hub.permalink(job.threadId) : job.threadId}`
  return `a new thread in ${md ? `~${hub.channelName(job.channelId!)}` : `channel ${job.channelId}`} each run`
}

/** One job, for a person (Markdown) or the CLI (plain). */
export function jobText(hub: Hub, job: JobRow, o: { md: boolean; now?: number; runs?: number }): string {
  const now = o.now ?? Date.now()
  const next = job.paused ? 'paused' : job.nextAt ? `next ${fmtLocal(job.nextAt, job.tz, now)} (in ${fmtAge(job.nextAt - now)})` : 'never runs again'
  const last = job.lastAt ? `last ${job.lastStatus ?? '?'} ${fmtAge(now - job.lastAt)} ago` : 'not run yet'
  const head = o.md
    ? `- **#${job.id} ${job.name}** — \`${job.schedule}\` (${job.tz}) · ${next} · ${last}`
    : `#${job.id} ${job.name}  [${job.workspace}]\n  ${job.schedule} (${job.cron}, ${job.tz}) · ${next} · ${last}`
  const text = job.text.replace(/\s+/g, ' ')
  const lines = [
    head,
    `  ${whereText(hub, job, o.md)} · by ${job.createdBy} · grace ${job.graceMinutes}m`,
    `  ${o.md ? '' : '“'}${text.length > 160 ? `${text.slice(0, 160)}…` : text}${o.md ? '' : '”'}`,
  ]
  if (o.runs) {
    for (const r of hub.store.runs(job.id, o.runs)) {
      lines.push(`  · ${new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')}Z ${r.kind === 'manual' ? 'manual ' : ''}${r.status}${r.threadId ? ` → ${o.md ? hub.permalink(r.threadId) : r.threadId}` : ''}${r.note ? ` — ${r.note}` : ''}`)
    }
  }
  return lines.join('\n')
}

export function jobsText(hub: Hub, workspace: string | undefined, md: boolean, now = Date.now()): string {
  const jobs = hub.store.jobs(workspace)
  if (!jobs.length) return `No scheduled jobs${workspace ? ` in workspace ${workspace}` : ''}.`
  return [`Scheduled jobs${workspace ? ` in workspace ${workspace}` : ''} (${jobs.length}):`, ...jobs.map(j => jobText(hub, j, { md, now }))].join('\n')
}

/** "every weekday 09:00 (Asia/Jakarta), a new thread in ~ops each run; next Wed 18 Nov 09:00" */
export function summary(hub: Hub, job: JobRow, now = Date.now()): string {
  return `${job.schedule} (${job.tz}), ${whereText(hub, job, true)}; ${job.nextAt ? `next run ${fmtLocal(job.nextAt, job.tz, now)}` : 'it never runs again'}`
}

// ---------------------------------------------------------------------------- sessions' tools

/** The owner's message a session cites: in one of its threads, written by an owner. */
async function ownerAsked(hub: Hub, key: string, messageId: string | undefined): Promise<{ thread: ThreadRow; who: string }> {
  if (!messageId) fail("pass message_id: the owner's message in your thread that asks for this")
  let post: MMPost
  try {
    post = await hub.mm.getPost(messageId)
  } catch {
    fail(`no message ${messageId}`)
  }
  const thread = hub.threadsOf(key).find(t => t.id === (post.root_id || post.id)) ?? fail(`message ${messageId} is not in your thread(s)`)
  if (post.user_id === hub.bot.id || !isOwner(hub.accessStore.load(), post.user_id, isBotPost(post))) {
    fail('only a hub owner can set up or remove scheduled jobs, and that message is not from one. Tell the person an owner has to ask.')
  }
  return { thread, who: `@${await hub.mm.username(post.user_id)}` }
}

function workspaceOf(hub: Hub, key: string): string {
  return hub.store.session(key)?.workspace ?? fail('unknown session')
}

export async function scheduleTool(hub: Hub, key: string, a: { schedule: string; text: string; messageId?: string; name?: string; tz?: string; inThisThread: boolean; graceMinutes?: number }): Promise<string> {
  const ws = workspaceOf(hub, key)
  const { thread, who } = await ownerAsked(hub, key, a.messageId)
  return onChain(hub, async () => {
    const job = await addJob(hub, {
      workspace: ws, schedule: a.schedule, text: a.text, name: a.name, tz: a.tz, graceMinutes: a.graceMinutes,
      ...(a.inThisThread ? { threadId: thread.id } : { channelId: thread.channelId }),
      createdBy: who, origin: `thread ${thread.id}`,
    })
    // The session confirms it in its own words: the hub posts nothing here.
    return `scheduled job #${job.id} "${job.name}" set up for ${who}: ${summary(hub, job)}. Each run reaches ${job.threadId ? "this thread's router" : 'a new router in a new thread'} as a kind="scheduled" message. Nothing was posted: confirm it to the person yourself with reply, in their language: when it runs next and where. Nothing more: no !cron commands, nor how to remove or pause it.`
  })
}

export async function unscheduleTool(hub: Hub, key: string, a: { jobId: number; messageId?: string }): Promise<string> {
  const ws = workspaceOf(hub, key)
  const { who } = await ownerAsked(hub, key, a.messageId)
  return onChain(hub, async () => {
    const job = removeJob(hub, a.jobId, who, ws)
    return `removed job #${job.id} "${job.name}" (${job.schedule}, ${job.tz}) for ${who}. Nothing was posted: tell the person yourself with reply.`
  })
}

export function listSchedulesTool(hub: Hub, key: string): string {
  const ws = workspaceOf(hub, key)
  return jobsText(hub, ws, false)
}
