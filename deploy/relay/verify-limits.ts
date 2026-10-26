import { strict as assert } from 'node:assert'

const base =
  process.env.VERIFY_BASE_URL ?? 'http://api.radio-max.kylescudder.co.uk'
const maximum = Number(process.env.VERIFY_PER_IP ?? 4)
const controllers: AbortController[] = []
const getState = async () =>
  (await (
    await fetch(base + '/api/state', {
      signal: AbortSignal.timeout(5000)
    })
  ).json()) as { stations: { listeners: number }[] }

for (let n = 0; ; n++) {
  try {
    const response = await fetch(base + '/healthz', {
      signal: AbortSignal.timeout(2000)
    })
    if (response.ok) break
  } catch {
    /* wait for the isolated candidate */
  }
  if (n >= 29) throw new Error('Relay did not become ready')
  await Bun.sleep(100)
}
const baseline = (await getState()).stations[0].listeners
assert.equal(baseline, 0, 'Run capacity checks only with no existing listeners')
try {
  for (let n = 0; n <= maximum; n++) {
    const controller = new AbortController()
    controllers.push(controller)
    const response = await fetch(base + '/radio/main', {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
      headers: {
        'Icy-MetaData': '1',
        // Each attempt claims a different IP and credential; both must be overwritten.
        'X-Forwarded-For': `192.0.2.${n + 1}`,
        'X-Radio-Max-Client-IP': `198.51.100.${n + 1}`,
        'X-Radio-Max-Relay-Token': 'publicly-forged-token'
      }
    })
    assert.equal(response.status, n < maximum ? 200 : 429)
    if (n === maximum)
      assert.ok(Number(response.headers.get('retry-after')) > 0)
  }
  assert.equal((await getState()).stations[0].listeners, maximum)
} finally {
  for (const controller of controllers) controller.abort()
}

let remaining = -1
for (let n = 0; n < 40; n++) {
  remaining = (await getState()).stations[0].listeners
  if (remaining === baseline) break
  await Bun.sleep(100)
}
assert.equal(remaining, baseline, 'Disconnect must return every slot')
const controller = new AbortController()
try {
  const response = await fetch(base + '/radio/main', {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
  })
  assert.equal(response.status, 200, 'A released slot must accept a new player')
} finally {
  controller.abort()
}
for (let n = 0; n < 40; n++) {
  remaining = (await getState()).stations[0].listeners
  if (remaining === baseline) break
  await Bun.sleep(100)
}
assert.equal(
  remaining,
  baseline,
  'The reconnected player must also release its slot'
)
console.log(
  JSON.stringify({
    perIpLimit: maximum,
    excessStatus: 429,
    forwardedHeadersCannotBypassQuota: true,
    listenerCleanup: true,
    reconnectAfterRelease: true
  })
)
