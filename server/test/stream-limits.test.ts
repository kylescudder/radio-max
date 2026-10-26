import { describe, expect, test } from 'bun:test'
import {
  positiveLimit,
  streamClient,
  StreamLimits
} from '../src/stream-limits.ts'

describe('stream admission', () => {
  test('one client cannot occupy every slot, and released slots are reusable', () => {
    const gate = new StreamLimits(3, 2, 100)
    const a = gate.admit('a'),
      b = gate.admit('a'),
      c = gate.admit('b')
    expect(a.ok && b.ok && c.ok).toBe(true)
    expect(gate.admit('a')).toMatchObject({ ok: false, status: 429 })
    expect(gate.admit('c')).toMatchObject({ ok: false, status: 503 })
    if (a.ok) {
      a.release()
      a.release()
    }
    expect(gate.admit('c').ok).toBe(true)
    expect(gate.admit('d')).toMatchObject({ ok: false, status: 503 })
  })

  test('rapid reconnects are throttled after disconnect and recover with time', () => {
    let clock = 0
    const gate = new StreamLimits(4, 2, 2, 8, () => clock)
    for (let n = 0; n < 2; n++) {
      const a = gate.admit('client')
      expect(a.ok).toBe(true)
      if (a.ok) a.release()
    }
    expect(gate.admit('client')).toMatchObject({
      ok: false,
      status: 429,
      retryAfter: 30
    })
    clock = 30_000
    expect(gate.admit('client').ok).toBe(true)
  })

  test('bookkeeping stays bounded without resetting quotas by eviction', () => {
    let clock = 0
    const gate = new StreamLimits(4, 2, 1, 2, () => clock)
    const active = gate.admit('active')
    const idle = gate.admit('idle')
    if (idle.ok) idle.release()
    expect(gate.admit('new')).toMatchObject({ ok: false, status: 503 })
    expect(gate.admit('idle')).toMatchObject({ ok: false, status: 429 })
    clock = 300_001
    expect(gate.admit('new').ok).toBe(true)
    // Expiry never removes an active client's reservations.
    if (active.ok) active.release()
  })

  test('invalid configuration cannot disable limits', () => {
    for (const value of ['0', '-1', 'NaN', '', '1.5', 'Infinity', '100001']) {
      expect(() => positiveLimit(value, 32)).toThrow()
    }
    expect(positiveLimit(undefined, 32)).toBe(32)
  })
})

describe('relay identity', () => {
  const token = 'a'.repeat(64)
  const request = (headers: Record<string, string> = {}) =>
    new Request('http://radio-max/radio/main', { headers })
  test('untrusted forwarding headers never select a client identity', () => {
    expect(
      streamClient(
        request({
          'X-Forwarded-For': '1.1.1.1',
          'X-Radio-Max-Client-IP': '1.1.1.1'
        }),
        '192.0.2.1',
        undefined
      )
    ).toBe('192.0.2.1')
    expect(streamClient(request(), '192.0.2.1', token)).toBeNull()
    expect(streamClient(request(), '127.0.0.1', token)).toBe('loopback')
    expect(
      streamClient(
        request({
          'X-Radio-Max-Relay-Token': 'wrong',
          'X-Radio-Max-Client-IP': '1.1.1.1'
        }),
        '127.0.0.1',
        token
      )
    ).toBeNull()
  })
  test('authenticated IPs must be valid and IPv6 aliases share a quota', () => {
    const identity = (ip: string) =>
      streamClient(
        request({
          'X-Radio-Max-Relay-Token': token,
          'X-Radio-Max-Client-IP': ip
        }),
        '192.0.2.1',
        token
      )
    expect(identity('2001:0db8::1')).toBe(identity('2001:db8:0:0:0:0:0:1'))
    expect(identity('1.1.1.1, 2.2.2.2')).toBeNull()
    expect(identity('')).toBeNull()
  })
})
