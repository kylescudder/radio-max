import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

interface Client {
  active: number
  tokens: number
  updated: number
}

type Admission =
  | { ok: true; release: () => void }
  | { ok: false; status: 429 | 503; retryAfter: number }

export function positiveLimit(
  value: string | undefined,
  fallback: number
): number {
  if (value === undefined) return fallback
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 100_000) {
    throw new Error(
      'Stream limits must be positive integers no greater than 100000'
    )
  }
  return Number(value)
}

// Forwarded identity is accepted only with the private edge-to-origin token.
// Unauthenticated requests can stream only from the app's own loopback for checks.
export function streamClient(
  req: Request,
  peer: string | undefined,
  token: string | undefined
): string | null {
  if (!token) return peer ?? 'unknown'
  const supplied = req.headers.get('x-radio-max-relay-token')
  if (supplied !== null) {
    const a = Buffer.from(supplied)
    const b = Buffer.from(token)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    const address = req.headers.get('x-radio-max-client-ip') ?? ''
    if (!isIP(address) || address.includes('%')) return null
    return address.includes(':')
      ? new URL(`http://[${address}]/`).hostname
      : address
  }
  return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
    ? 'loopback'
    : null
}

export class StreamLimits {
  private readonly clients = new Map<string, Client>()
  private active = 0

  constructor(
    private readonly maximum = 32,
    private readonly perClient = 4,
    private readonly attemptsPerMinute = 12,
    private readonly maximumClients = 4096,
    private readonly now = () => performance.now()
  ) {}

  admit(key: string): Admission {
    const now = this.now()
    let client = this.clients.get(key)
    if (!client) {
      // Bounded bookkeeping. Never evict recent clients to bypass their quotas.
      for (const [address, record] of this.clients) {
        if (record.active) continue
        if (now - record.updated < 300_000) break
        this.clients.delete(address)
      }
      if (this.clients.size >= this.maximumClients)
        return { ok: false, status: 503, retryAfter: 30 }
      client = { active: 0, tokens: this.attemptsPerMinute, updated: now }
    }
    client.tokens = Math.min(
      this.attemptsPerMinute,
      client.tokens +
        (Math.max(0, now - client.updated) * this.attemptsPerMinute) / 60_000
    )
    client.updated = now
    this.clients.delete(key)
    this.clients.set(key, client)
    if (client.tokens < 1)
      return {
        ok: false,
        status: 429,
        retryAfter: Math.ceil(
          ((1 - client.tokens) * 60) / this.attemptsPerMinute
        )
      }
    client.tokens--
    if (client.active >= this.perClient)
      return { ok: false, status: 429, retryAfter: 10 }
    if (this.active >= this.maximum)
      return { ok: false, status: 503, retryAfter: 10 }
    client.active++
    this.active++
    let released = false
    return {
      ok: true,
      release: () => {
        if (released) return
        released = true
        client.active--
        this.active--
        // Keep the map ordered by last activity, including disconnects.
        const ended = this.now()
        client.tokens = Math.min(
          this.attemptsPerMinute,
          client.tokens +
            (Math.max(0, ended - client.updated) * this.attemptsPerMinute) /
              60_000
        )
        client.updated = ended
        this.clients.delete(key)
        this.clients.set(key, client)
      }
    }
  }
}
