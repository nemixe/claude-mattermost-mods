// The effort a worker's model requests go at: the hub's file for the session,
// else the session's own; subagents and models without effort are left alone.

import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'
import { register } from './register'

const STATE = '/state/mmhub/'
const FILE = '/state/mmhub/sessions/w-abc123/effort'

/**
 * The module, loaded by each test beside the plugin under test: `claude plugin
 * test .` at the repo root runs this file too, with the hub's panel mod as that
 * plugin. Under `claude plugin test session-mod` it runs twice, which changes nothing.
 */
const MOD = { plugins: [{ name: 'mmhub-worker-module', register }] }

/** The engine beneath: the hub's file, and the requests that went out. */
function world(on: On, file: string | undefined, key = 'w-abc123') {
  const sent: (string | number | undefined)[] = []
  mock.env(on, { MMHUB_STATE_DIR: STATE, MMHUB_SESSION_KEY: key })
  on('fs.read', (_, e) => {
    if (e.path !== FILE || file === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: file }
  })
  on('turn.step', async function* (_, e) {
    sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return sent
}

async function step($: Engine, e: Partial<TurnStepInput> = {}) {
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-4-8', effort: 'medium', messageCount: 1, ...e })
  let r = await s.next()
  while (!r.done) r = await s.next()
  return r.value
}

test('a request goes at the level the hub chose', MOD, async ($, on) => {
  const sent = world(on, 'xhigh\n')
  expect((await step($)).answer).toBe('ok')
  expect(sent).toEqual(['xhigh'])
})

test('none chosen, or not a level: the session\'s own', MOD, async ($, on) => {
  const sent = world(on, undefined)
  await step($)
  await step($, { effort: 'high' })
  expect(sent).toEqual(['medium', 'high'])
})

test('a file that names no level is ignored', MOD, async ($, on) => {
  const sent = world(on, 'very high')
  await step($)
  expect(sent).toEqual(['medium'])
})

test('a subagent keeps its own, and a model without effort is sent none', MOD, async ($, on) => {
  const sent = world(on, 'max')
  await step($, { agentId: 'a1', effort: 'low' })
  await step($, { effort: undefined })
  expect(sent).toEqual(['low', undefined])
})

test('only a worker of the hub reads a file', MOD, async ($, on) => {
  const sent = world(on, 'max', '../../etc')
  await step($)
  expect(sent).toEqual(['medium'])
})
