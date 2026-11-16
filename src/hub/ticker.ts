/**
 * A clock that survives the machine sleeping.
 *
 * Bun timers that are pending while macOS sleeps can stay stuck after it
 * wakes. Seen with Bun 1.3.14 after a hibernate: the hub's setIntervals
 * (heartbeat, reaper, the Mattermost ping) never fired again, while timers
 * created after the wake did, and socket I/O kept working. So the ticks come
 * from I/O instead: a child `sh` prints a line every few seconds, and each line
 * is a tick. A long gap between ticks means the machine slept (or the hub was
 * stalled); the hub then re-arms its timers and reconnects.
 *
 * The child dies with the hub: its next `echo` hits a closed pipe.
 */

import { errMsg, log } from '../shared/util'

export type TickFn = (now: number, gapMs: number) => void

export class Ticker {
  private proc?: ReturnType<typeof Bun.spawn>
  private stopped = false
  private lastTick = 0
  private starts: number[] = []

  constructor(
    private onTick: TickFn,
    private periodSec = 5,
    private now: () => number = Date.now,
  ) {}

  start(): void {
    this.stopped = false
    this.lastTick = this.now()
    this.spawn()
  }

  stop(): void {
    this.stopped = true
    try { this.proc?.kill() } catch {}
    this.proc = undefined
  }

  /** One line from the child (exposed for tests): the time since the last tick goes along. */
  tick(): void {
    const now = this.now()
    const gap = now - this.lastTick
    this.lastTick = now
    try {
      this.onTick(now, gap)
    } catch (err) {
      log('hub', `tick: ${errMsg(err)}`)
    }
  }

  private spawn(): void {
    if (this.stopped) return
    // A child that can't run at all (no /bin/sh) must not spin: at most 5 starts a minute.
    const now = this.now()
    this.starts = [...this.starts.filter(t => now - t < 60_000), now]
    if (this.starts.length > 5) {
      log('hub', 'ticker: its child keeps exiting — sleep recovery is off until the hub restarts')
      return
    }
    let proc: ReturnType<typeof Bun.spawn>
    try {
      proc = Bun.spawn(['/bin/sh', '-c', `while sleep ${this.periodSec}; do echo; done`], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
      })
    } catch (err) {
      log('hub', `ticker: ${errMsg(err)}`)
      return
    }
    this.proc = proc
    void this.read(proc)
  }

  private async read(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        if (this.stopped || this.proc !== proc) return
        for (const byte of chunk) if (byte === 10) this.tick()
      }
    } catch {}
    if (this.stopped || this.proc !== proc) return
    this.proc = undefined
    this.spawn()
  }
}
