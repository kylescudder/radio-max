# radio-max

A small Icecast/Shoutcast-style MP3 streaming server for Euro Truck Simulator 2,
with a live dashboard.

- **Server**: Bun + TypeScript. Streams `.mp3` files from disk on a real-time
  schedule (paced to the configured bitrate), with proper `icy-metaint`
  metadata blocks injected for ICY-aware clients.
- **Dashboard**: static HTML/CSS/JS. Connects to the server over a WebSocket
  and re-renders only when state changes — no polling.

```
server/                   Bun service (deploy to Hetzner)
├─ src/server.ts          HTTP + WS entry
├─ src/station.ts         per-station broadcast loop
├─ src/icy.ts             icy-metaint helpers
├─ stations.json          station + bitrate config
└─ audio/<station_id>/    .mp3 files for each station

web/                      Static dashboard (deploy to Netlify)
├─ index.html
├─ dashboard.js
└─ dashboard.css
```

## Quick start (local)

```bash
cd server
bun install
bun run dev
```

The server listens on `http://localhost:8080` and serves:

- `GET /radio/<station_id>` — the MP3 stream (this is the URL you give ETS2)
- `GET /api/state`          — JSON snapshot of all stations
- `GET /api/ws`             — WebSocket; receives `{type:"state", stations:[…]}`
                              on every state change (track flip, listener
                              join/leave)
- `HEAD /radio/<station_id>` — ICY header probe (ETS2 issues these)
- `GET /healthz`            — `ok`

Verify with curl:

```bash
curl -s http://localhost:8080/api/state | jq
curl -sI http://localhost:8080/radio/main
curl -H 'Icy-MetaData: 1' http://localhost:8080/radio/main | head -c 100 | xxd
```

## Adding stations

Edit `server/stations.json`:

```json
{
  "bitrateKbps": 128,
  "sampleRateHz": 44100,
  "icyMetaInt": 16000,
  "publicUrl": "http://radio-max.kylescudder.co.uk",
  "stations": [
    { "id": "main",   "name": "RadioMax",      "genre": "Gaming Music" },
    { "id": "drives", "name": "RadioMax Drives", "genre": "Rock" }
  ]
}
```

Then drop `.mp3` files into `server/audio/<station_id>/`. Files are loaded
alphabetically and looped. Restart the server to pick up changes.

> **Source files must match `bitrateKbps`.** The server paces bytes at the
> configured bitrate — it does not transcode. If you mix 192 kbps and 128 kbps
> files in the same station, playback speed will be wrong. Re-encode with
> `ffmpeg -i in.mp3 -b:a 128k out.mp3` first.

## Configuration

| env var             | default          | purpose                                       |
| ------------------- | ---------------- | --------------------------------------------- |
| `PORT`              | `8080`           | listen port                                   |
| `CONFIG_PATH`       | `stations.json`  | path to config file                           |
| `AUDIO_ROOT`        | `audio`          | directory containing `<station_id>/` subdirs  |
| `DASHBOARD_ORIGIN`  | `*`              | exact origin allowed for `/api/*` + WS, or `*` |

In production, set `DASHBOARD_ORIGIN` to your dashboard URL (e.g.
`https://radio.example.com`) so the WS endpoint rejects other origins.

## Deploying to Hetzner

Build is one binary path: `bun src/server.ts`. Use a systemd unit:

```ini
# /etc/systemd/system/radio-max.service
[Unit]
Description=radio-max
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/radio-max/server
ExecStart=/root/.bun/bin/bun src/server.ts
Restart=always
RestartSec=2
Environment=PORT=8080
Environment=DASHBOARD_ORIGIN=https://radio.kylescudder.co.uk

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now radio-max
journalctl -u radio-max -f
```

### Caddyfile (dual HTTP/HTTPS, same origin)

ETS2 needs plain HTTP. The browser dashboard (if it lives on HTTPS) needs
HTTPS. Caddy can listen on both for the same domain:

```caddy
radio-max.kylescudder.co.uk {
    reverse_proxy localhost:8080
}

http://radio-max.kylescudder.co.uk {
    reverse_proxy localhost:8080
}
```

The HTTPS block auto-provisions a Let's Encrypt cert. ETS2 hits
`http://radio-max.kylescudder.co.uk/radio/main`, the dashboard hits
`https://radio-max.kylescudder.co.uk/api/ws` — same Bun process serves both.

## Deploying the dashboard

### Option A — Netlify (separate domain)

The repo includes a `netlify.toml` at the root. Connect this repo to a Netlify
site and it will deploy the `web/` directory as a static site.

Then in `web/dashboard.js`, set:

```js
const API_ORIGIN = "https://radio-max.kylescudder.co.uk";
```

And set `DASHBOARD_ORIGIN` on the radio server to your Netlify URL so the
WS endpoint accepts it.

> Browsers block `ws://` and `http://` requests from `https://` pages
> (mixed content). The dual-listener Caddyfile above gives you HTTPS on the
> radio server, which is what makes this setup work.

### Option B — same origin, served by the radio server

Simpler if you don't need to split. Tell Caddy to serve `web/` directly:

```caddy
radio-max.kylescudder.co.uk {
    @api  path /api/* /radio/* /healthz
    handle @api {
        reverse_proxy localhost:8080
    }
    handle {
        root * /opt/radio-max/web
        file_server
    }
}
```

Leave `API_ORIGIN = ""` in `dashboard.js` (same-origin / relative URLs).

## ETS2 setup

Add to `Documents/Euro Truck Simulator 2/live_streams.sii`:

```
stream_data[]: "http://radio-max.kylescudder.co.uk/radio/main|RadioMax|GB|128|0|1"
```

Format: `URL|name|country|bitrate|0|1`. The dashboard's "ETS2 URL" field
gives you the pre-formatted string.

## What changed from the old server

The previous Node/Express server crashed under modest load on a CX21 because:

1. **Broadcast tick was faster than playback** — 1 KB every 50 ms is ~160 kbps;
   the source is 128 kbps. Slow clients couldn't drain fast enough, Node
   buffered the overflow in memory until OOM.
2. **`icy-metaint: 16000` was advertised, but no metadata blocks were ever
   inserted** — clients reading the byte stream interpreted random audio bytes
   as the metadata length prefix, corrupting the stream.
3. **Per-request `console.log`** on every `/stations`/`/clients` poll. The
   old dashboard polled both endpoints every 2 seconds per tab, which
   amplified into hundreds of synchronous stdout writes per second under
   even one tab.

This rewrite paces to the exact bitrate, emits standards-compliant
`icy-metaint` blocks, pushes dashboard updates over WebSocket on change only,
and logs only startup + errors.
