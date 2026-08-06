// Types shared across main, preload, and renderer (IPC payload shapes).
// Keeping these separate from src/main/adapters/vmsAdapter.ts (the adapter
// interface itself, which is main-process-only) avoids the renderer/preload
// TS project pulling in main-process-only code through type-only imports.

export type VendorId = 'hikvision' | 'dahua' | 'tvt' | 'uniview' | 'onvif';

// Which tabs support being dragged out of the main window into their own
// standalone window (see AppShell.tsx's drag-to-detach tab strip and
// main/ipc/windows.ts) — the Home tab (controlPanel) always stays anchored
// in the main window, so it's deliberately excluded here. Defined in shared
// rather than alongside TabKind in AppShell.tsx (renderer-only) since the
// main process (windows.ts) needs the same union and tsconfig.node.json
// doesn't include src/renderer.
export type PopoutTabKind = 'liveView' | 'playback' | 'deviceManagement';

// Order matches the fleet mix (largest first) — surfaced in the Device
// Management "Add Device" vendor picker. ONVIF goes last — it's the generic
// fallback for devices that aren't one of the 4 named brands, not part of
// the fleet mix itself. Uniview leads (explicit user preference) even
// though TVT is the slightly larger slice of the fleet mix.
export const VENDOR_ORDER: readonly VendorId[] = ['uniview', 'tvt', 'hikvision', 'dahua', 'onvif'];

export const VENDOR_LABELS: Record<VendorId, string> = {
  tvt: 'TVT',
  uniview: 'UNV',
  hikvision: 'HIK',
  dahua: 'DAH',
  onvif: 'ONVIF',
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

export interface ChannelInfo {
  channel: number;
  label: string;
}

export interface DeviceSession {
  sessionId: string;
  // Explicit channels (not just a start/count range) — Hikvision's
  // analog/digital channels sit in two separate ranges (confirmed: a
  // pure-IP 16-channel NVR only accepts channels 33-48, not 1-16), and
  // Uniview's NETDEV_QueryVideoChlDetailListEx returns each channel's own
  // ID with no guaranteed contiguity at all. Each channel's `label` is the
  // device's own configured camera name when the vendor's SDK exposes one
  // cheaply (Uniview does, as part of the same call that lists channels);
  // otherwise it falls back to "Channel N" — see each adapter's login().
  channels: ChannelInfo[];
}

export type StreamType = 'main' | 'sub';

// Video settings tab (see SettingsModal.tsx) — stored/persisted now, but not
// all of these are wired into real Live View/Playback behavior yet
// (explicitly fine per the user: "add them, we can add the functionality
// later"). playMainStreamInSingleView mirrors LiveView.tsx's existing
// hardcoded `layout === 1 ? 'main' : 'sub'` behavior, not yet reading from
// this setting.
export type PlayMode = 'balanced' | 'minDelay' | 'fluent';
export type PlaybackQuality = 'hd' | 'sd';

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
  channels: ChannelInfo[];
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

// A device found on the local network via ONVIF WS-Discovery, not yet
// saved. The vendor/model info ONVIF returns is free-text and not every
// device populates it usefully, so guessedVendor is only ever a prefilled
// default in the Add Device dialog — the user always confirms or changes
// the adapter and always enters credentials themselves before it's saved,
// since discovery has no way to know a device's login.
export interface DiscoveredDevice {
  host: string;
  // The vendor's actual configured SDK/service port, when a vendor's own
  // broadcast discovery reports it directly (e.g. Uniview's NETDEV_Discovery)
  // rather than being guessed — prefilled into the Add Device dialog's
  // "Service Port" field instead of that vendor's generic default when
  // present, since it's the device's real setting, not a guess.
  port?: number;
  httpPort?: number;
  manufacturer?: string;
  model?: string;
  guessedVendor?: VendorId;
  // Only resolves for hosts on the same local network the app is running
  // on (ARP doesn't cross a router) — absent otherwise, same as any other
  // optional field here.
  mac?: string;
  // A host already saved as a Managed Device still appears in scan results
  // (rather than being silently dropped) so the list reads as "everything
  // found," with this flag driving an "Added" indicator instead of the
  // usual "+ Add" action.
  alreadyAdded?: boolean;
}

export interface AuthStatus {
  hasAdminAccount: boolean;
}

// Fixed company resources linked from the Home page (header logo, company
// info block, "Request Remote Support" button) — every actual URL is
// hardcoded in the main process, never passed up from the renderer.
export type CompanyLinkKind = 'website' | 'email' | 'phone' | 'support';

export interface SavedLogin {
  username: string;
  password: string;
  // Only meaningful alongside a saved username/password - Login.tsx disables
  // this checkbox unless "Save password" is also checked. Guarded on the
  // renderer side (AppShell passes allowAutoLogin=false right after an
  // explicit logout) so logging out doesn't get instantly overridden by
  // auto-login re-authenticating on the very next render - a real bug this
  // project hit once already with an earlier, cruder Auto Login feature.
  autoLogin: boolean;
}

// Electron's disableHardwareAcceleration() must be called before the app is
// ready and can't be toggled live - this setting always needs a relaunch to
// take effect. Defaults to enabled since most client machines have a real
// GPU; only underpowered/virtualized ones need to turn it off.
// 'auto' follows the OS's own light/dark setting (see nativeTheme in
// main/ipc/system.ts) instead of a fixed choice.
export type ThemeMode = 'light' | 'dark' | 'auto';

export interface AppSettings {
  hardwareAcceleration: boolean;
  // Uniview's own SDK-level H.264/H.265 decode acceleration (NETDEV_
  // EnabledGPUDecodeEx) — a completely separate subsystem from
  // hardwareAcceleration above (that one is Chromium's own rendering GPU).
  // Confirmed real: a VPS with no real GPU showed its "GPU" usage pinned at
  // 100% during playback, requiring a force-quit. Only affects Uniview for
  // now — the other vendors' SDKs haven't had their own decode-acceleration
  // controls researched yet.
  univiewGpuDecode: boolean;
  themeMode: ThemeMode;
  // Fine for a client site's handful of devices, but a fleet office adding
  // 100+ devices for on-demand client-footage lookups doesn't want every
  // single one logged into (and kept alive via a 30s heartbeat) just
  // sitting idle in the background. Off skips connectAll()/startHeartbeat()
  // at boot entirely — devices then only connect on demand (opening Live
  // View/Playback for one, or clicking "Refresh Status" in Device
  // Management), which already works today via connectionManager's
  // ensureConnected() lazy-connect fallback; this setting just stops the
  // proactive bulk-connect from ever running in the first place.
  autoConnectAllDevices: boolean;
  // "Start App" (System tab) - restores Live View to the same layout/
  // channels it had when the app was last closed. Applies once, right
  // after the very first successful login of a fresh app launch (not on
  // every lock/unlock mid-session - see AppShell.tsx's handleLoggedIn).
  // For a user who doesn't also use Auto Login, this still only takes
  // effect once they've actually logged in - Live View (like every other
  // tab) stays inaccessible and nothing connects/streams until then, same
  // gate every tab already goes through.
  restoreLiveViewOnStart: boolean;

  // Video settings tab.
  playMode: PlayMode;
  defaultStreamType: StreamType;
  playbackQuality: PlaybackQuality;
  playMainStreamInSingleView: boolean;
  snapshotPath: string;
  // Default destination folder for Playback's clip export — prefilled into
  // the export popup's path so the user doesn't have to browse to a
  // destination every single time, matching the export shortcut most other
  // VMS software offers. Empty means no preset; the popup still falls back
  // to an explicit Save dialog in that case (same as before this setting
  // existed).
  exportPath: string;
  // Default destination folder for the (not yet built) Start Local
  // Recording tile action — same "prefill so the user isn't prompted every
  // time" reasoning as exportPath above. Added ahead of that feature per
  // explicit user request, so the setting exists and is ready once
  // recording itself is wired up.
  localRecordingPath: string;
}

// Result of a Backup/Restore Configuration or Export/Import Devices List
// action (see ipc/backup.ts) — ok:false with no error means the user just
// canceled the file dialog, not a real failure.
export interface BackupResult {
  ok: boolean;
  error?: string;
  count?: number;
}

// Result of saving a Live View snapshot/recording to the configured
// Snapshot Path / Local Recording Path (see ipc/liveView.ts) — ok:false
// with a path-related error means the setting is empty, not a write
// failure.
export interface MediaSaveResult {
  ok: boolean;
  path?: string;
  error?: string;
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
  | { state: 'online'; channels: ChannelInfo[] }
  | { state: 'offline'; error: string };

// Host machine resource usage, shown in the Live View toolbar so the user
// can see whether the machine is under strain from decoding many channels
// at once — sampled in the main process (Node's os module) and pushed to
// the renderer periodically.
export interface SystemStats {
  cpuPercent: number;
  memPercent: number;
}

// Pushed from the main process's electron-updater wrapper (see
// main/services/updater.ts) whenever the update check/download lifecycle
// advances. The check itself only ever runs on demand (Settings > About >
// Check for Updates) — there's no background polling — so 'checking' only
// ever appears right after the renderer calls updates.check().
export type UpdateStatus =
  | { state: 'checking' }
  | { state: 'not-available' }
  | { state: 'available'; version: string }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

// One continuous block of recorded video on the device, as returned by a
// recording search. `type` is the device's own classification of *why* that
// block was recorded — each vendor's SDK reports this per-segment, so the
// Playback timeline can color-code it instead of showing one
// undifferentiated bar. 'smart' covers AI-based detection (human/vehicle
// etc.) on devices that support it; anything not recognized as one of the
// other three falls back to 'other'.
export type RecordingType = 'continuous' | 'motion' | 'smart' | 'other';

export interface RecordingSegment {
  startMs: number;
  endMs: number;
  type: RecordingType;
}

// Pause/resume/seek/speed/frame-step, mirroring each vendor's own
// playback-control verb set closely enough that every vendor can implement
// it with one native call rather than needing per-command adapter methods.
// `value`'s meaning depends on the command: milliseconds for 'seek', a
// speed multiplier (1/2/4) for 'setSpeed', unused for the rest.
export type PlaybackCommand = 'pause' | 'resume' | 'seek' | 'setSpeed' | 'stepFrame';
export type PlaybackSpeed = 1 | 2 | 4;

// Individually selectable via checkboxes in the Playback sidebar, so a
// search can combine e.g. Motion + Smart while excluding Continuous — DVR/
// NVR recording schedules commonly mix these, and finding "just the
// interesting parts" on a given day is a real, explicitly requested use
// case. 'all' is mutually exclusive with the other three in the UI (it
// supersedes them); callers pass an array of the selected values, an empty
// array meaning the same as ['all'].
export type RecordingSearchFilter = 'all' | 'continuous' | 'motion' | 'smart';

// A single tile's assignment within a saved Custom Layout. Stream type
// isn't stored here — like everywhere else in the app, it's always derived
// from the layout size itself (main only for a 1-tile layout, sub
// otherwise), so storing it separately would just be a second source of
// truth that could drift from the layout it's paired with.
export interface CustomLayoutTile {
  tileIndex: number;
  deviceId: string;
  channel: number;
}

// A saved arrangement of devices/channels across a specific grid size —
// lets the user jump straight back to a named group of cameras (e.g. "Front
// Gate Cluster") instead of re-assigning each tile by hand every time.
export interface CustomLayout {
  id: string;
  name: string;
  layout: number;
  tiles: CustomLayoutTile[];
}

// The last live-view arrangement seen before the app closed (or as of the
// most recent change) - same shape as a CustomLayout minus id/name, since
// this is a single auto-saved snapshot, not a user-named list entry. Powers
// "Start App" (AppSettings.restoreLiveViewOnStart) - kept in its own store
// (main/store/lastLiveViewStateStore.ts), separate from the user-visible
// Custom Layouts list, so it never shows up there as a stray entry.
export interface LastLiveViewState {
  layout: number;
  tiles: CustomLayoutTile[];
}
