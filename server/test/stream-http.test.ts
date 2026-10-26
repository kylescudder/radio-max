import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const token = 'b'.repeat(64)
const audio = mkdtempSync(join(tmpdir(), 'radio-limits-'))
let child: ReturnType<typeof Bun.spawn>
let base = ''

beforeAll(async () => {
  mkdirSync(join(audio, 'main'))
  // A paced byte fixture exercises real HTTP lifecycle and admission, not decoding.
  writeFileSync(join(audio, 'main', 'fixture.mp3'), Buffer.alloc(128_000))
  child = Bun.spawn([process.execPath, 'src/server.ts'], {
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      PORT: '0',
      AUDIO_ROOT: audio,
      WEB_ROOT: '',
      RADIO_MAX_RELAY_TOKEN: token,
      STREAM_MAX_LISTENERS: '3',
      STREAM_MAX_PER_IP: '2',
      STREAM_CONNECTS_PER_MINUTE: '12',
      STREAM_HOSTS: '127.0.0.1'
    }
  })
  const output = child.stdout as ReadableStream<Uint8Array>
  const reader = output.getReader()
  let message = ''
  try {
    while (!message.includes('radio-max on :')) {
      const part = await reader.read()
      if (part.done) throw new Error('Fixture server exited before readiness')
      message += new TextDecoder().decode(part.value)
    }
  } finally {
    reader.releaseLock()
  }
  base = 'http://127.0.0.1:' + message.match(/radio-max on :(\d+)/)![1]
}, 15_000)

afterAll(async () => {
  child?.kill()
  if (child) await child.exited
  rmSync(audio, { recursive: true, force: true })
})

test('real HTTP saturation rejects excess clients and abort releases reservations', async () => {
  const controllers: AbortController[] = []
  const connect = async (ip: string, extra: Record<string, string> = {}) => {
    const controller = new AbortController()
    controllers.push(controller)
    return fetch(base + '/radio/main', {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      headers: {
        'X-Radio-Max-Relay-Token': token,
        'X-Radio-Max-Client-IP': ip,
        ...extra
      }
    })
  }
  try {
    expect((await connect('192.0.2.1')).status).toBe(200)
    expect((await connect('192.0.2.1')).status).toBe(200)
    const limited = await connect('192.0.2.1', {
      'X-Forwarded-For': '198.51.100.1'
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('10')
    expect((await connect('192.0.2.2')).status).toBe(200)
    expect((await connect('192.0.2.3')).status).toBe(503)
    expect(
      (await connect('192.0.2.4', { 'X-Radio-Max-Relay-Token': 'invalid' }))
        .status
    ).toBe(403)
  } finally {
    for (const controller of controllers) controller.abort()
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = (await (await fetch(base + '/api/state')).json()) as {
      stations: { listeners: number }[]
    }
    if (!state.stations[0].listeners) break
    await Bun.sleep(50)
  }
  const state = (await (await fetch(base + '/api/state')).json()) as {
    stations: { listeners: number }[]
  }
  expect(state.stations[0].listeners).toBe(0)
  const recovered = await connect('192.0.2.3')
  expect(recovered.status).toBe(200)
  for (const controller of controllers) controller.abort()
}, 20_000)
