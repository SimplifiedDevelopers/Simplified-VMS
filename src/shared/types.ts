// Types shared across main, preload, and renderer (IPC payload shapes).
// Keeping these separate from src/main/adapters/vmsAdapter.ts (the adapter
// interface itself, which is main-process-only) avoids the renderer/preload
// TS project pulling in main-process-only code through type-only imports.

export type VendorId = 'hikvision' | 'dahua' | 'tvt' | 'uniview';

// Order matches the fleet mix (largest first) — surfaced in the Device
// Management "Add Device" vendor picker.
export const VENDOR_ORDER: readonly VendorId[] = ['tvt', 'uniview', 'hikvision', 'dahua'];

export const VENDOR_LABELS: Record<VendorId, string> = {
  tvt: 'TVT',
  uniview: 'UNV',
  hikvision: 'Hik',
  dahua: 'Dah',
};

export interface LoginParams {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface DeviceSession {
  sessionId: string;
  channelCount: number;
  // Analog and digital(IP) channels are numbered in separate ranges on
  // hybrid/NVR hardware — a device can have 0 analog + N digital channels
  // starting well above 1 (confirmed: a pure-IP 16-channel NVR only accepts
  // channels 33-48). Needed to build an accurate channel list per device.
  analogStart: number;
  analogCount: number;
  digitalStart: number;
  digitalCount: number;
}

export interface ChannelInfo {
  channel: number;
  label: string;
}

export type StreamType = 'main' | 'sub';

export interface DecodedFrame {
  width: number;
  height: number;
  format: 'rgb32' | 'yuv420p';
  data: Buffer;
  timestampMs: number;
}

// Renderer-safe device shape — password is intentionally never included.
// The main process resolves the actual (decrypted) credential itself when
// starting a session, so it never has to cross the IPC boundary in plaintext
// more than once (at creation time).
export interface StoredDevice {
  id: string;
  name: string;
  vendor: VendorId;
  host: string;
  port: number;
  username: string;
}

export interface NewDeviceInput {
  name: string;
  vendor: VendorId;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface AuthStatus {
  hasAdminAccount: boolean;
}

export interface SavedLogin {
  username: string;
  password: string;
  autoLogin: boolean;
}
