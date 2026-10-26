import { strict as assert } from 'node:assert'
import type { StationSnapshot } from '../server/src/types.ts'

const base = process.env.VERIFY_BASE_URL ?? 'http://127.0.0.1:8080'
const origin =
  process.env.DASHBOARD_ORIGIN ?? 'https://radio-max.kylescudder.co.uk'
const exclusive = process.env.VERIFY_EXCLUSIVE === 'true'
const get = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { signal: AbortSignal.timeout(12_000), ...init })
const checks: string[] = []
async function stationState(): Promise<{ stations: StationSnapshot[] }> {
  return (await (await get('/api/state')).json()) as {
    stations: StationSnapshot[]
  }
}
const health = await get('/healthz')
assert.equal(health.headers.get('cache-control'), 'no-store')
const revision = health.headers.get('x-radio-max-revision')
assert.ok(revision)
assert.deepEqual(await health.json(), { ok: true, revision })
const page = await get('/')
assert.equal(page.status, 200)
const html = await page.text()
assert.match(html, /RadioMax/)
const assets = [...html.matchAll(/(?:src|href)="(\/_astro\/[^\"]+)"/g)].map(
  (m) => m[1]
)
assert.ok(assets.length >= 2)
for (const asset of assets) {
  const r = await get(asset)
  assert.equal(r.status, 200)
  assert.match(r.headers.get('cache-control')!, /immutable/)
  assert.ok((await r.arrayBuffer()).byteLength > 0)
}
for (const path of [
  '/src/server.ts',
  '/stations.json',
  '/audio/main/max-verstappen.mp3',
  '/%2e%2e/server/stations.json'
]) {
  assert.equal((await get(path)).status, 404)
}
checks.push('dashboard, built assets and private-file isolation')
const state = await stationState()
assert.equal(state.stations.length, 1)
assert.equal(state.stations[0].id, 'main')
assert.ok(state.stations[0].trackCount > 0)
assert.equal(state.stations[0].trackTitle, 'max verstappen')
assert.deepEqual(
  state.stations[0].ets2Url.split('|'),
  [state.stations[0].streamUrl, 'RadioMax', 'Gaming Music', 'EN', '128', '1'],
  'ETS2 entry is URL|name|genre|language|bitrate|favorite'
)
assert.equal((await get('/radio/missing')).status, 404)
assert.equal((await get('/radio/main', { method: 'POST' })).status, 405)
const head = await get('/radio/main', { method: 'HEAD' })
assert.equal(head.status, 200)
assert.equal(head.headers.get('content-type'), 'audio/mpeg')
assert.equal(head.headers.get('icy-br'), '128')
assert.equal(head.headers.get('icy-sr'), '48000')
checks.push('station data and ETS2 HTTP/HEAD headers')
if (process.env.STREAM_HOSTS) {
  for (const method of ['GET', 'HEAD']) {
    const blocked = await get('/radio/main', {
      method,
      headers: {
        Host: 'radio-max-preview.kylescudder.co.uk',
        'X-Forwarded-Host': '127.0.0.1'
      }
    })
    assert.equal(blocked.status, 404)
  }
  checks.push(
    'public preview cannot stream audio or bypass the host restriction'
  )
}

const streamAbort = new AbortController()
const stream = await get('/radio/main', {
  headers: { 'Icy-MetaData': '1' },
  signal: AbortSignal.any([streamAbort.signal, AbortSignal.timeout(12_000)])
})
assert.equal(stream.status, 200)
assert.match(stream.headers.get('cache-control')!, /no-store/)
const interval = Number(stream.headers.get('icy-metaint'))
assert.equal(interval, 16000)
const reader = stream.body!.getReader()
const started = performance.now()
let body = new Uint8Array(0)
try {
  while (body.length < interval * 3 + 512) {
    const part = await reader.read()
    assert.equal(part.done, false)
    const combined = new Uint8Array(body.length + part.value!.length)
    combined.set(body)
    combined.set(part.value!, body.length)
    body = combined
  }
} finally {
  await reader.cancel()
  streamAbort.abort()
}
const duration = (performance.now() - started) / 1000
const bytesPerSecond = body.length / duration
assert.ok(
  bytesPerSecond > 12_000 && bytesPerSecond < 22_000,
  `Unexpected pace: ${bytesPerSecond} bytes/s`
)
let offset = interval
const firstSize = body[offset] * 16
assert.ok(firstSize > 0)
assert.match(
  new TextDecoder().decode(body.slice(offset + 1, offset + 1 + firstSize)),
  /StreamTitle='RadioMax - max verstappen';/
)
offset += 1 + firstSize + interval
assert.equal(body[offset], 0, 'unchanged ICY title uses an empty block')
checks.push('continuous 128 kbps stream, ICY metadata spacing and cancellation')

const wsBase = base.replace(/^http/, 'ws')
await new Promise<void>((resolve, reject) => {
  const ws = new WebSocket(wsBase + '/api/ws', { headers: { Origin: origin } })
  const timeout = setTimeout(() => {
    ws.close()
    reject(new Error('WebSocket timed out'))
  }, 5000)
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(String(event.data))
      assert.equal(data.type, 'state')
      assert.equal(data.stations[0].id, 'main')
      ws.send('unsupported client message')
    } catch (e) {
      clearTimeout(timeout)
      ws.close()
      reject(e)
    }
  }
  ws.onerror = () => {
    clearTimeout(timeout)
    ws.close()
    reject(new Error('WebSocket failed'))
  }
  ws.onclose = (event) => {
    clearTimeout(timeout)
    try {
      assert.equal(
        event.code,
        1008,
        'State feed rejects inbound application messages'
      )
      resolve()
    } catch (error) {
      reject(error)
    }
  }
})
assert.equal(
  (await get('/api/ws', { headers: { Origin: 'https://example.invalid' } }))
    .status,
  403
)
if (exclusive) {
  let listeners = -1
  for (let attempt = 0; attempt < 15; attempt++) {
    listeners = (await stationState()).stations[0].listeners
    if (listeners === state.stations[0].listeners) break
    await Bun.sleep(200)
  }
  assert.equal(listeners, state.stations[0].listeners)
}
checks.push(
  'read-only WebSocket snapshot and origin restriction' +
    (exclusive ? ', isolated listener cleanup' : '')
)
console.log(
  JSON.stringify(
    {
      passed: true,
      revision,
      checks,
      streamBytesPerSecond: Math.round(bytesPerSecond)
    },
    null,
    2
  )
)
