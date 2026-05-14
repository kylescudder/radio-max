import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StationConfig, StationSnapshot } from "./types.ts";
import { buildMetaBlock, EMPTY_META_BLOCK } from "./icy.ts";

const TICK_MS = 200;
const BACKPRESSURE_DROP_BYTES = 2_000_000;

export interface Listener {
  controller: ReadableStreamDefaultController<Uint8Array>;
  icyMetaInt: number;
  bytesSinceMeta: number;
  lastMetaTitle: string;
}

export class Station {
  readonly id: string;
  readonly name: string;
  readonly genre: string;
  readonly bitrateKbps: number;
  readonly icyMetaInt: number;
  readonly publicUrl: string;

  private readonly audioDir: string;
  private files: string[] = [];
  private trackIndex = 0;
  private trackBuffer: Uint8Array = new Uint8Array(0);
  private positionBytes = 0;
  private readonly listeners = new Set<Listener>();
  private tickHandle: ReturnType<typeof setInterval> | null = null;
  private readonly startedAt = Date.now();
  private readonly onChange: () => void;

  constructor(
    config: StationConfig,
    audioRoot: string,
    bitrateKbps: number,
    icyMetaInt: number,
    publicUrl: string,
    onChange: () => void,
  ) {
    this.id = config.id;
    this.name = config.name;
    this.genre = config.genre ?? "Music";
    this.bitrateKbps = bitrateKbps;
    this.icyMetaInt = icyMetaInt;
    this.publicUrl = publicUrl;
    this.audioDir = join(audioRoot, config.id);
    this.onChange = onChange;
  }

  start(): void {
    this.refreshFiles();
    if (this.files.length === 0) {
      console.warn(`[${this.id}] no .mp3 files in ${this.audioDir}`);
      return;
    }
    this.loadTrack(0);
    const bytesPerTick = Math.floor(((this.bitrateKbps * 1000) / 8) * (TICK_MS / 1000));
    this.tickHandle = setInterval(() => this.tick(bytesPerTick), TICK_MS);
  }

  stop(): void {
    if (this.tickHandle) clearInterval(this.tickHandle);
    this.tickHandle = null;
    for (const l of this.listeners) {
      try { l.controller.close(); } catch { /* already closed */ }
    }
    this.listeners.clear();
  }

  addListener(listener: Listener): void {
    this.listeners.add(listener);
    this.onChange();
  }

  removeListener(listener: Listener): void {
    if (!this.listeners.delete(listener)) return;
    try { listener.controller.close(); } catch { /* already closed */ }
    this.onChange();
  }

  snapshot(): StationSnapshot {
    const streamUrl = `${this.publicUrl}/radio/${this.id}`;
    return {
      id: this.id,
      name: this.name,
      genre: this.genre,
      trackTitle: this.trackTitle(),
      trackIndex: this.trackIndex,
      trackCount: this.files.length,
      positionBytes: this.positionBytes,
      trackSizeBytes: this.trackBuffer.length,
      listeners: this.listeners.size,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      streamUrl,
      ets2Url: `${streamUrl}|${this.name}|GB|${this.bitrateKbps}|0|1`,
    };
  }

  private refreshFiles(): void {
    try {
      this.files = readdirSync(this.audioDir)
        .filter((f) => f.toLowerCase().endsWith(".mp3"))
        .sort();
    } catch {
      this.files = [];
    }
  }

  private loadTrack(index: number): void {
    this.trackIndex = this.files.length === 0 ? 0 : index % this.files.length;
    if (this.files.length === 0) {
      this.trackBuffer = new Uint8Array(0);
      this.positionBytes = 0;
      return;
    }
    const path = join(this.audioDir, this.files[this.trackIndex]);
    this.trackBuffer = readFileSync(path);
    this.positionBytes = 0;
    this.onChange();
  }

  private trackTitle(): string {
    const file = this.files[this.trackIndex] ?? "";
    return file.replace(/\.mp3$/i, "").replace(/[_-]+/g, " ").trim();
  }

  private tick(maxBytes: number): void {
    const chunk = this.advance(maxBytes);
    if (chunk.length === 0 || this.listeners.size === 0) return;
    const title = this.trackTitle();
    const dead: Listener[] = [];
    for (const listener of this.listeners) {
      if (!this.sendToListener(listener, chunk, title)) dead.push(listener);
    }
    for (const d of dead) this.removeListener(d);
  }

  private advance(maxBytes: number): Uint8Array {
    if (this.trackBuffer.length === 0) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let remaining = maxBytes;
    while (remaining > 0 && this.trackBuffer.length > 0) {
      const left = this.trackBuffer.length - this.positionBytes;
      const take = Math.min(left, remaining);
      chunks.push(this.trackBuffer.subarray(this.positionBytes, this.positionBytes + take));
      this.positionBytes += take;
      remaining -= take;
      if (this.positionBytes >= this.trackBuffer.length) {
        this.loadTrack(this.trackIndex + 1);
      }
    }
    if (chunks.length === 1) return chunks[0];
    const total = chunks.reduce((s, b) => s + b.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    return merged;
  }

  private sendToListener(l: Listener, audio: Uint8Array, currentTitle: string): boolean {
    try {
      if (l.icyMetaInt === 0) {
        l.controller.enqueue(audio);
      } else {
        let i = 0;
        while (i < audio.length) {
          const untilMeta = l.icyMetaInt - l.bytesSinceMeta;
          const sliceLen = Math.min(untilMeta, audio.length - i);
          l.controller.enqueue(audio.subarray(i, i + sliceLen));
          l.bytesSinceMeta += sliceLen;
          i += sliceLen;
          if (l.bytesSinceMeta >= l.icyMetaInt) {
            if (currentTitle !== l.lastMetaTitle) {
              l.controller.enqueue(buildMetaBlock(`${this.name} - ${currentTitle}`));
              l.lastMetaTitle = currentTitle;
            } else {
              l.controller.enqueue(EMPTY_META_BLOCK);
            }
            l.bytesSinceMeta = 0;
          }
        }
      }
      const desired = l.controller.desiredSize ?? 0;
      return desired > -BACKPRESSURE_DROP_BYTES;
    } catch {
      return false;
    }
  }
}
