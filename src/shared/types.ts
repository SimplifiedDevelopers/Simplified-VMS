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
  // Uniview-specific hint (other vendors ignore it): Uniview's login call
  // (NETDEV_Login_V30) doesn't return channel info at all, unlike
  // Hikvision/Dahua/TVT whose login calls return it directly — it needs a
  // second network round trip (NETDEV_QueryVideoChlDetailListEx) just to
  // learn the channel list, roughly doubling connect time. Set this when
  // the caller already knows the channel list (or doesn't need it at all,
  // e.g. a pure reachability check) so that extra round trip can be
  // skipped; `channels` on the returned DeviceSession will just be empty.
  skipChannelQuery?: boolean;
}

export interface DeviceSession {
  sessionId: string;
  // Explicit channel numbers rather than a start/count range — Hikvision's
  // analog/digital channels sit in two separate ranges (confirmed: a
  // pure-IP 16-channel NVR only accepts channels 33-48, not 1-16), and
  // Uniview's NETDEV_QueryVideoChlDetailListEx returns each channel's own
  // ID with no guaranteed contiguity at all. An explicit list is the only
  // shape that's actually accurate for both.
  channels: number[];
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
  // The device's web UI port — the VMS itself never talks to it, only used
  // to open the device's browser-based admin page ("Open" action).
  httpPort: number;
  username: string;
  // Fetched and saved the moment the device is added (or first
  // successfully connected to) so that browsing the Live View device list
  // never has to log in and query the device just to show its channel
  // list — every other VMS the team has used treats this as static,
  // rarely-changing data, not something to re-fetch on every click. Empty
  // until the first successful login populates it.
  channels: number[];
}

export interface NewDeviceInput {
  name: string;
  vendor: VendorId;
  host: string;
  port: number;
  httpPort: number;
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

// Electron's disableHardwareAcceleration() must be called before the app is
// ready and can't be toggled live - this setting always needs a relaunch to
// take effect. Defaults to enabled since most client machines have a real
// GPU; only underpowered/virtualized ones need to turn it off.
export interface AppSettings {
  hardwareAcceleration: boolean;
}

// Result of a login+immediate-logout probe — doesn't persist a session,
// used only to test connectivity for a device before it's saved (the
// device doesn't exist in the store yet, so there's nothing to keep
// connected). Already-saved devices get their live status from
// DeviceConnectionStatus instead (see below).
export interface ConnectionTestResult {
  ok: boolean;
  channelCount?: number;
  error?: string;
}

// Live status of a saved device's persistent connection, owned by the main
// process's connectionManager — every saved device connects once when the
// app opens and stays connected until it closes, so this reflects a real
// standing session rather than a fresh probe.
export type DeviceConnectionStatus =
  | { state: 'connecting' }
  | { state: 'online'; channels: number[] }
  | { state: 'offline'; error: string };

// Host machine resource usage, shown in the Live View toolbar so the user
// can see whether the machine is under strain from decoding many channels
// at once — sampled in the main process (Node's os module) and pushed to
// the renderer periodically.
export interface SystemStats {
  cpuPercent: number;
  memPercent: number;
}
