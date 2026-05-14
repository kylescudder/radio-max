import { readFileSync } from "node:fs";
import { Station, type Listener } from "./station.ts";
import type { RootConfig, StationSnapshot } from "./types.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "*";
const CONFIG_PATH = process.env.CONFIG_PATH ?? "stations.json";
const AUDIO_ROOT = process.env.AUDIO_ROOT ?? "audio";

const config: RootConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

const wsClients = new Set<Bun.ServerWebSocket<unknown>>();

function snapshotAll(): StationSnapshot[] {
  return Array.from(stations.values(), (s) => s.snapshot());
}

function broadcastState(): void {
  if (wsClients.size === 0) return;
  const payload = JSON.stringify({ type: "state", stations: snapshotAll() });
  for (const ws of wsClients) ws.send(payload);
}

const stations = new Map<string, Station>();
for (const stationCfg of config.stations) {
  const station = new Station(
    stationCfg,
    AUDIO_ROOT,
    config.bitrateKbps,
    config.icyMetaInt,
    config.publicUrl,
    broadcastState,
  );
  station.start();
  stations.set(stationCfg.id, station);
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": DASHBOARD_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
};

function streamHeaders(station: Station, withMeta: boolean): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "audio/mpeg",
    "icy-notice1": "RadioMax",
    "icy-notice2": "Streaming for Euro Truck Simulator 2",
    "icy-name": station.name,
    "icy-genre": station.genre,
    "icy-br": String(station.bitrateKbps),
    "icy-sr": String(config.sampleRateHz),
    "icy-pub": "1",
    "Cache-Control": "no-cache, no-store",
    "Connection": "close",
    "Accept-Ranges": "none",
  };
  if (withMeta) h["icy-metaint"] = String(station.icyMetaInt);
  return h;
}

function handleStream(req: Request, station: Station): Response {
  const wantsMeta = req.headers.get("icy-metadata") === "1";
  let listener: Listener | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      listener = {
        controller,
        icyMetaInt: wantsMeta ? station.icyMetaInt : 0,
        bytesSinceMeta: 0,
        lastMetaTitle: "",
      };
      station.addListener(listener);
    },
    cancel() {
      if (listener) station.removeListener(listener);
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 1_000_000 }));
  return new Response(stream, { headers: streamHeaders(station, wantsMeta) });
}

function isAllowedOrigin(req: Request): boolean {
  if (DASHBOARD_ORIGIN === "*") return true;
  return req.headers.get("origin") === DASHBOARD_ORIGIN;
}

const server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (path.startsWith("/radio/")) {
      const id = path.slice("/radio/".length);
      const station = stations.get(id);
      if (!station) return new Response("Station not found", { status: 404 });
      if (req.method === "HEAD") {
        return new Response(null, { headers: streamHeaders(station, false) });
      }
      if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return handleStream(req, station);
    }

    if (path === "/api/state") {
      return Response.json({ stations: snapshotAll() }, { headers: corsHeaders });
    }

    if (path === "/api/ws") {
      if (!isAllowedOrigin(req)) return new Response("Forbidden", { status: 403 });
      if (srv.upgrade(req)) return;
      return new Response("Upgrade failed", { status: 426 });
    }

    if (path === "/healthz") return new Response("ok");

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      ws.send(JSON.stringify({ type: "state", stations: snapshotAll() }));
    },
    close(ws) {
      wsClients.delete(ws);
    },
    message() {
      // no inbound messages
    },
  },
});

console.log(`radio-max on :${server.port} | stations: ${Array.from(stations.keys()).join(", ")}`);

const shutdown = (): void => {
  for (const s of stations.values()) s.stop();
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
