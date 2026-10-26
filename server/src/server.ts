import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Station, type Listener } from './station.ts'
import type { RootConfig, StationSnapshot } from './types.ts'
import { positiveLimit, streamClient, StreamLimits } from './stream-limits.ts'

const PORT = Number(process.env.PORT ?? 8080)
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? '*'
const CONFIG_PATH = process.env.CONFIG_PATH ?? 'stations.json'
const AUDIO_ROOT = process.env.AUDIO_ROOT ?? 'audio'
const WEB_ROOT = process.env.WEB_ROOT
const REVISION = process.env.RADIO_MAX_REVISION ?? 'development'
const RELAY_TOKEN = process.env.RADIO_MAX_RELAY_TOKEN || undefined
if (RELAY_TOKEN !== undefined && !/^[a-f0-9]{64}$/i.test(RELAY_TOKEN)) {
  throw new Error(
    'RADIO_MAX_RELAY_TOKEN must contain 64 hexadecimal characters'
  )
}
const streamLimits = new StreamLimits(
  positiveLimit(process.env.STREAM_MAX_LISTENERS, 32),
  positiveLimit(process.env.STREAM_MAX_PER_IP, 4),
  positiveLimit(process.env.STREAM_CONNECTS_PER_MINUTE, 12)
)
// Audio is accepted only on the private origin hostnames.
// Caddy preserves the original Host; forwarded-host headers are not trusted.
const STREAM_HOSTS = new Set(
  (process.env.STREAM_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
)

const config: RootConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
if (process.env.PUBLIC_URL)
  config.publicUrl = process.env.PUBLIC_URL.replace(/\/$/, '')

// Only serve files discovered inside the built dashboard, never arbitrary paths.
const webFiles = new Map<string, ReturnType<typeof Bun.file>>()
if (WEB_ROOT) {
  for (const path of new Bun.Glob('**/*').scanSync({
    cwd: WEB_ROOT,
    onlyFiles: true
  })) {
    webFiles.set(`/${path}`, Bun.file(resolve(WEB_ROOT, path)))
  }
}

const wsClients = new Set<Bun.ServerWebSocket<unknown>>()

function snapshotAll(): StationSnapshot[] {
  return Array.from(stations.values(), (s) => s.snapshot())
}

function broadcastState(): void {
  if (wsClients.size === 0) return
  const payload = JSON.stringify({ type: 'state', stations: snapshotAll() })
  for (const ws of wsClients) ws.send(payload)
}

const stations = new Map<string, Station>()
for (const stationCfg of config.stations) {
  const station = new Station(
    stationCfg,
    AUDIO_ROOT,
    config.bitrateKbps,
    config.icyMetaInt,
    config.publicUrl,
    broadcastState
  )
  station.start()
  stations.set(stationCfg.id, station)
}

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': DASHBOARD_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  Vary: 'Origin',
  'Cache-Control': 'no-store',
  'X-Radio-Max-Revision': REVISION
}

function streamHeaders(
  station: Station,
  withMeta: boolean
): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'audio/mpeg',
    'icy-notice1': 'RadioMax',
    'icy-notice2': 'Streaming for Euro Truck Simulator 2',
    'icy-name': station.name,
    'icy-genre': station.genre,
    'icy-br': String(station.bitrateKbps),
    'icy-sr': String(config.sampleRateHz),
    'icy-pub': '1',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'close',
    'Accept-Ranges': 'none'
  }
  if (withMeta) h['icy-metaint'] = String(station.icyMetaInt)
  return h
}

function handleStream(
  req: Request,
  station: Station,
  release: () => void
): Response {
  const wantsMeta = req.headers.get('icy-metadata') === '1'
  let listener: Listener | null = null
  const finish = () => {
    release()
    req.signal.removeEventListener('abort', disconnect)
  }
  const disconnect = () => {
    if (listener) station.removeListener(listener)
    finish()
  }
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        listener = {
          controller,
          icyMetaInt: wantsMeta ? station.icyMetaInt : 0,
          bytesSinceMeta: 0,
          lastMetaTitle: '',
          onClose: finish
        }
        station.addListener(listener)
        if (req.signal.aborted) disconnect()
        else req.signal.addEventListener('abort', disconnect, { once: true })
      },
      cancel() {
        disconnect()
      }
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 1_000_000 })
  )
  return new Response(stream, { headers: streamHeaders(station, wantsMeta) })
}

function isAllowedOrigin(req: Request): boolean {
  if (DASHBOARD_ORIGIN === '*') return true
  return req.headers.get('origin') === DASHBOARD_ORIGIN
}

const server = Bun.serve({
  hostname: '0.0.0.0',
  port: PORT,
  maxRequestBodySize: 1024,
  fetch(req, srv) {
    const url = new URL(req.url)
    const path = url.pathname

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    if (path.startsWith('/radio/')) {
      if (STREAM_HOSTS.size > 0 && !STREAM_HOSTS.has(url.hostname)) {
        return new Response('Not found', {
          status: 404,
          headers: { 'Cache-Control': 'no-store' }
        })
      }
      const id = path.slice('/radio/'.length)
      const station = stations.get(id)
      if (!station) return new Response('Station not found', { status: 404 })
      const client = streamClient(req, srv.requestIP(req)?.address, RELAY_TOKEN)
      if (client === null) return new Response('Forbidden', { status: 403 })
      if (req.method === 'HEAD') {
        return new Response(null, { headers: streamHeaders(station, false) })
      }
      if (req.method !== 'GET')
        return new Response('Method not allowed', { status: 405 })
      const admission = streamLimits.admit(client)
      if (!admission.ok)
        return new Response('Stream connection limit reached', {
          status: admission.status,
          headers: {
            'Retry-After': String(admission.retryAfter),
            'Cache-Control': 'no-store'
          }
        })
      // A radio connection is intentionally long lived.
      srv.timeout(req, 0)
      return handleStream(req, station, admission.release)
    }

    if (path === '/api/state') {
      return Response.json(
        { stations: snapshotAll() },
        { headers: corsHeaders }
      )
    }

    if (path === '/api/ws') {
      if (!isAllowedOrigin(req))
        return new Response('Forbidden', { status: 403 })
      if (srv.upgrade(req)) return
      return new Response('Upgrade failed', { status: 426 })
    }

    if (path === '/healthz')
      return Response.json(
        { ok: true, revision: REVISION },
        {
          headers: {
            'Cache-Control': 'no-store',
            'X-Radio-Max-Revision': REVISION
          }
        }
      )

    const file = webFiles.get(path === '/' ? '/index.html' : path)
    if (file && (req.method === 'GET' || req.method === 'HEAD')) {
      return new Response(req.method === 'HEAD' ? null : file, {
        headers: {
          'Content-Type': file.type,
          'Cache-Control': path.startsWith('/_astro/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'X-Radio-Max-Revision': REVISION
        }
      })
    }

    return new Response('Not found', { status: 404 })
  },
  websocket: {
    maxPayloadLength: 1024,
    open(ws) {
      wsClients.add(ws)
      ws.send(JSON.stringify({ type: 'state', stations: snapshotAll() }))
    },
    close(ws) {
      wsClients.delete(ws)
    },
    message(ws) {
      ws.close(1008, 'Read-only state feed')
    }
  }
})

console.log(
  `radio-max on :${server.port} | stations: ${Array.from(stations.keys()).join(', ')}`
)

const shutdown = (): void => {
  for (const s of stations.values()) s.stop()
  server.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
