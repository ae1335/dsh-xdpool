/**
 * In-memory per-provider/per-key cooldown, and the demotion that rides on it.
 *
 * A 429/402 was previously confined to the retry loop: it swapped keys for THIS
 * request and forgot by the next one. These tests pin the memory that now
 * survives across requests — a key that cools is demoted on the NEXT resolve,
 * not discarded, and it comes back once the window passes. Because the deadline
 * is an explicit `now` on the demotion seam, no fake clock is needed.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { demoteCoolingKeys, resetKeyCooldowns, setKeyCooldown } from '../src/aggregate.ts'

beforeEach(() => {
  resetKeyCooldowns()
})

describe('demoteCoolingKeys', () => {
  const keys = ['sk-a', 'sk-b', 'sk-c'] as const

  it('passes every key through untouched when nothing is cooling', () => {
    expect(demoteCoolingKeys('agnes', keys, 1000)).toEqual(['sk-a', 'sk-b', 'sk-c'])
  })

  it('moves a cooling key to the end without dropping it', () => {
    setKeyCooldown('agnes', 'sk-a', 2000)
    expect(demoteCoolingKeys('agnes', keys, 1500)).toEqual(['sk-b', 'sk-c', 'sk-a'])
  })

  it('restores a key once its window has passed', () => {
    setKeyCooldown('agnes', 'sk-a', 2000)
    // `now` at the deadline is not inside the window: `until > now` is false.
    expect(demoteCoolingKeys('agnes', keys, 2000)).toEqual(['sk-a', 'sk-b', 'sk-c'])
  })

  it('keeps relative order among the ready keys and among the cooling keys', () => {
    setKeyCooldown('agnes', 'sk-a', 2000)
    setKeyCooldown('agnes', 'sk-c', 3000)
    expect(demoteCoolingKeys('agnes', keys, 1500)).toEqual(['sk-b', 'sk-a', 'sk-c'])
  })

  it('scopes a cooldown to its provider: the same key cools nowhere else', () => {
    setKeyCooldown('agnes', 'sk-a', 2000)
    // Same key under another id is untouched; different key under the same id is too.
    expect(demoteCoolingKeys('agnes', ['sk-a', 'sk-b'], 1500)).toEqual(['sk-b', 'sk-a'])
    expect(demoteCoolingKeys('moonshot', ['sk-a', 'sk-b'], 1500)).toEqual(['sk-a', 'sk-b'])
  })

  it('ignores a cooldown on a blank key, which can never be a request', () => {
    setKeyCooldown('agnes', '', 2000)
    expect(demoteCoolingKeys('agnes', ['sk-a', ''], 1500)).toEqual(['sk-a', ''])
  })
})
