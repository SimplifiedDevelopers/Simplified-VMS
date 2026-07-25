// Types shared across main, preload, and renderer (IPC payload shapes).
// Keeping these separate from src/main/adapters/vmsAdapter.ts (the adapter
// interface itself, which is main-process-only) avoids the renderer/preload
// TS project pulling in main-process-only code through type-only imports.

export type VendorId = 'hikvision' | 'dahua' | 'tvt' | 'uniview';

export interface LoginParams {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface DeviceSession {
  sessionId: string;
  channelCount: number;
}

export type StreamType = 'main' | 'sub';

export interface DecodedFrame {
  width: number;
  height: number;
  format: 'rgb32' | 'yuv420p';
  data: Buffer;
  timestampMs: number;
}
