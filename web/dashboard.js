// Edit if the dashboard is served from a different origin than the radio server.
// Empty string = same-origin (relative URLs). Otherwise an absolute https origin.
const API_ORIGIN = "";

const statusEl = document.getElementById("status");
const stationsEl = document.getElementById("stations");
const template = document.getElementById("station-template");

const cards = new Map();
let reconnectDelay = 1000;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status status--${cls}`;
}

function fmtUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function ensureCard(id) {
  let card = cards.get(id);
  if (card) return card;
  const node = template.content.firstElementChild.cloneNode(true);
  stationsEl.appendChild(node);
  card = {
    root: node,
    name: node.querySelector(".station__name"),
    genre: node.querySelector(".station__genre"),
    track: node.querySelector(".station__track"),
    bar: node.querySelector(".station__bar"),
    listeners: node.querySelector(".station__listeners"),
    trackIdx: node.querySelector(".station__track-idx"),
    uptime: node.querySelector(".station__uptime"),
    ets2: node.querySelector(".station__ets2"),
  };
  cards.set(id, card);
  return card;
}

function render(stations) {
  const seen = new Set();
  for (const s of stations) {
    seen.add(s.id);
    const c = ensureCard(s.id);
    c.name.textContent = s.name;
    c.genre.textContent = s.genre;
    c.track.textContent = s.trackTitle || "—";
    const pct = s.trackSizeBytes > 0 ? (s.positionBytes / s.trackSizeBytes) * 100 : 0;
    c.bar.style.width = `${Math.min(100, Math.max(0, pct)).toFixed(1)}%`;
    c.listeners.textContent = String(s.listeners);
    c.trackIdx.textContent = `${s.trackIndex + 1} / ${s.trackCount}`;
    c.uptime.textContent = fmtUptime(s.uptimeSec);
    c.ets2.textContent = s.ets2Url;
  }
  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      card.root.remove();
      cards.delete(id);
    }
  }
}

function wsUrl() {
  if (API_ORIGIN) {
    return API_ORIGIN.replace(/^http/, "ws") + "/api/ws";
  }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/ws`;
}

async function pollOnce() {
  try {
    const res = await fetch(`${API_ORIGIN}/api/state`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    render(data.stations);
    setStatus("live (polling)", "live");
  } catch {
    setStatus("offline", "down");
  }
}

function connect() {
  setStatus("connecting…", "connecting");
  let socket;
  try {
    socket = new WebSocket(wsUrl());
  } catch {
    fallbackToPolling();
    return;
  }

  socket.addEventListener("open", () => {
    reconnectDelay = 1000;
    setStatus("live", "live");
  });

  socket.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "state") render(msg.stations);
    } catch {
      // ignore malformed message
    }
  });

  socket.addEventListener("close", () => {
    setStatus("reconnecting…", "connecting");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  });

  socket.addEventListener("error", () => {
    try { socket.close(); } catch { /* noop */ }
  });
}

let pollTimer = null;
function fallbackToPolling() {
  pollOnce();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, 5000);
}

connect();
