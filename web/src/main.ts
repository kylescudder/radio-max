import "./dashboard.css";

interface StationSnapshot {
  id: string;
  name: string;
  genre: string;
  trackTitle: string;
  trackIndex: number;
  trackCount: number;
  positionBytes: number;
  trackSizeBytes: number;
  listeners: number;
  uptimeSec: number;
  streamUrl: string;
  ets2Url: string;
}

interface StateMessage {
  type: "state";
  stations: StationSnapshot[];
}

interface Card {
  root: HTMLElement;
  name: HTMLElement;
  genre: HTMLElement;
  track: HTMLElement;
  bar: HTMLElement;
  listeners: HTMLElement;
  trackIdx: HTMLElement;
  uptime: HTMLElement;
  ets2: HTMLElement;
  copy: HTMLButtonElement;
}

const API_ORIGIN = (import.meta.env.VITE_API_ORIGIN ?? "").trim();

const statusEl = document.getElementById("status")!;
const stationsEl = document.getElementById("stations")!;
const template = document.getElementById("station-template") as HTMLTemplateElement;

const cards = new Map<string, Card>();
let reconnectDelay = 1000;

function setStatus(text: string, cls: "live" | "connecting" | "down"): void {
  statusEl.textContent = text;
  statusEl.className = `status status--${cls}`;
}

function fmtUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function ensureCard(id: string): Card {
  const existing = cards.get(id);
  if (existing) return existing;
  const node = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
  stationsEl.appendChild(node);
  const card: Card = {
    root: node,
    name: node.querySelector(".station__name")!,
    genre: node.querySelector(".station__genre")!,
    track: node.querySelector(".station__track")!,
    bar: node.querySelector(".station__bar")!,
    listeners: node.querySelector(".station__listeners")!,
    trackIdx: node.querySelector(".station__track-idx")!,
    uptime: node.querySelector(".station__uptime")!,
    ets2: node.querySelector(".station__ets2")!,
    copy: node.querySelector(".station__copy")!,
  };
  card.copy.addEventListener("click", () => {
    void copyToClipboard(card.ets2.textContent ?? "", card.copy);
  });
  cards.set(id, card);
  return card;
}

async function copyToClipboard(text: string, button: HTMLButtonElement): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch { /* clipboard unavailable */ }
    ta.remove();
  }
  const original = button.dataset.label ?? button.textContent ?? "Copy";
  button.dataset.label = original;
  button.textContent = "Copied";
  button.classList.add("is-copied");
  window.setTimeout(() => {
    button.textContent = original;
    button.classList.remove("is-copied");
  }, 1500);
}

function render(stations: StationSnapshot[]): void {
  const seen = new Set<string>();
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

function wsUrl(): string {
  if (API_ORIGIN) return API_ORIGIN.replace(/^http/, "ws") + "/api/ws";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/ws`;
}

function connect(): void {
  setStatus("connecting…", "connecting");
  const socket = new WebSocket(wsUrl());

  socket.addEventListener("open", () => {
    reconnectDelay = 1000;
    setStatus("live", "live");
  });

  socket.addEventListener("message", (event: MessageEvent<string>) => {
    try {
      const msg = JSON.parse(event.data) as StateMessage;
      if (msg.type === "state") render(msg.stations);
    } catch {
      // ignore malformed payload
    }
  });

  socket.addEventListener("close", () => {
    setStatus("reconnecting…", "connecting");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  });

  socket.addEventListener("error", () => {
    try { socket.close(); } catch { /* already closed */ }
  });
}

connect();
