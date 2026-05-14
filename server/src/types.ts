export interface StationConfig {
  id: string;
  name: string;
  genre?: string;
}

export interface RootConfig {
  bitrateKbps: number;
  sampleRateHz: number;
  icyMetaInt: number;
  publicUrl: string;
  stations: StationConfig[];
}

export interface StationSnapshot {
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
