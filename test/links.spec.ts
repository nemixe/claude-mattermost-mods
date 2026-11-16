// Who may ask a workspace, how far a request may travel, and the links table.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { accepts, MAX_CHAIN, nextChain } from '../src/hub/links'
import { Store } from '../src/hub/store'

describe('who may ask a workspace', () => {
  test('anyone by default; acceptFrom lists the workspaces (or "*"); [] closes it', () => {
    expect(accepts({}, 'acme')).toBe(true)
    expect(accepts({ acceptFrom: ['*'] }, 'acme')).toBe(true)
    expect(accepts({ acceptFrom: ['acme'] }, 'acme')).toBe(true)
    expect(accepts({ acceptFrom: ['beta'] }, 'acme')).toBe(false)
    expect(accepts({ acceptFrom: [] }, 'acme')).toBe(false)
  })
})

describe('how far a request travels', () => {
  test('never back into a workspace it came through; at most MAX_CHAIN workspaces ask on', () => {
    expect(MAX_CHAIN).toBe(2)
    expect(nextChain(undefined, 'a', 'b')).toEqual({ chain: ['a'] })
    // b, serving a's request, asks c: fine. Asking a back: a loop.
    expect(nextChain(['a'], 'b', 'c')).toEqual({ chain: ['a', 'b'] })
    expect(nextChain(['a'], 'b', 'a')).toEqual({ refused: expect.stringContaining('already part of this request (a → b → a)') })
    // c, serving b's request (which came from a), may not pass it on.
    expect(nextChain(['a', 'b'], 'c', 'd')).toEqual({ refused: expect.stringContaining('already came through a → b → c') })
  })
})

describe('links table', () => {
  test('stored, read back, counted, listed per session', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'mmhub-links-')), 'hub.db'))
    store.insertLink({ threadId: 'T1', kind: 'workspace', channelId: 'CB', fromKey: 'w-a', fromWorkspace: 'acme', fromThread: 'TA', peer: 'beta', chain: ['acme'], createdAt: 1000 })
    store.insertLink({ threadId: 'D1', kind: 'dm', channelId: 'DM', fromKey: 'w-a', fromWorkspace: 'acme', peer: 'U1', chain: ['acme'], createdAt: 2000 })
    expect(store.link('T1')).toEqual({ threadId: 'T1', kind: 'workspace', channelId: 'CB', fromKey: 'w-a', fromWorkspace: 'acme', fromThread: 'TA', peer: 'beta', chain: ['acme'], messages: 0, createdAt: 1000 })
    expect(store.link('D1')?.fromThread).toBeUndefined()
    expect(store.bumpLink('T1')).toBe(1)
    expect(store.bumpLink('T1')).toBe(2)
    expect(store.linksFrom('w-a').map(l => l.threadId)).toEqual(['D1', 'T1'])
    expect(store.linksFrom('w-a', 1500).map(l => l.threadId)).toEqual(['D1'])
    expect(store.linksFrom('w-b')).toEqual([])
    expect(store.linkChannels().sort()).toEqual(['CB', 'DM'])
    expect(store.link('nope')).toBeUndefined()
    store.close()
  })
})
