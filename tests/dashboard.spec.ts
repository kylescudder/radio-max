import { expect, test } from '@playwright/test'

test('shows the live station from the WebSocket state feed', async ({
  page
}) => {
  await page.goto('/')

  await expect(page.locator('#status')).toHaveText('live')
  const station = page.locator('.station')
  await expect(station).toHaveCount(1)
  await expect(station.locator('.station__name')).toHaveText('RadioMax')
  await expect(station.locator('.station__track')).toHaveText('max verstappen')
  await expect(station.locator('.station__listeners')).toHaveText('0')
})

test('reflects a new listener and copies the ETS2 entry', async ({
  page,
  context,
  baseURL
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  const station = page.locator('.station')
  await expect(station.locator('.station__listeners')).toHaveText('0')

  // Join as a listener; the dashboard updates over the socket without polling.
  const listening = new AbortController()
  const stream = await fetch(`${baseURL}/radio/main`, {
    signal: listening.signal
  })
  expect(stream.status).toBe(200)
  await expect(station.locator('.station__listeners')).toHaveText('1')
  listening.abort()
  await expect(station.locator('.station__listeners')).toHaveText('0')

  await station.locator('summary', { hasText: 'ETS2 URL' }).click()
  const entry = station.locator('.station__ets2')
  await expect(entry).toHaveText(
    /\/radio\/main\|RadioMax\|Gaming Music\|EN\|128\|1$/
  )
  await station.getByRole('button', { name: 'Copy ETS2 URL' }).click()
  await expect(
    station.getByRole('button', { name: 'Copy ETS2 URL' })
  ).toHaveText('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    await entry.textContent()
  )
})

test('serves health and fingerprinted assets with the expected caching', async ({
  request,
  page
}) => {
  const health = await request.get('/healthz')
  expect(health.headers()['cache-control']).toBe('no-store')
  expect(await health.json()).toEqual({ ok: true, revision: 'development' })

  const scripts: string[] = []
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/_astro/'))
      scripts.push(response.headers()['cache-control'] ?? '')
  })
  await page.goto('/')
  await expect(page.locator('#status')).toHaveText('live')
  expect(scripts.length).toBeGreaterThanOrEqual(2)
  for (const cacheControl of scripts)
    expect(cacheControl).toContain('immutable')
})
