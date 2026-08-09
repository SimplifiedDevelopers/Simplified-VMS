import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  AuthStatus,
  BackupResult,
  ChannelInfo,
  CompanyLinkKind,
  ConnectionTestResult,
  CustomLayout,
  CustomLayoutTile,
  DecodedFrame,
  DeviceConnectionStatus,
  DiscoveredDevice,
  LastLiveViewState,
  MediaSaveResult,
  NewDeviceInput,
  PlaybackCommand,
  PopoutTabKind,
  RecordingSearchFilter,
  RecordingSegment,
  SavedLogin,
  StoredDevice,
  StreamType,
  SystemStats,
  UpdateStatus,
} from '../shared/types';

const auth = {
  status: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
  createAdmin: (username: string, password: string): Promise<void> =>
    ipcRenderer.invoke('auth:createAdmin', username, password),
  login: (username: string, password: string): Promise<boolean> =>
    ipcRenderer.invoke('auth:login', username, password),
};

const prefs = {
  getSavedLogin: (): Promise<SavedLogin | null> => ipcRenderer.invoke('prefs:getSavedLogin'),
  saveLogin: (username: string, password: string, autoLogin: boolean): Promise<void> =>
    ipcRenderer.invoke('prefs:saveLogin', username, password, autoLogin),
  clearSavedLogin: (): Promise<void> => ipcRenderer.invoke('prefs:clearSavedLogin'),
};

const devices = {
  list: (): Promise<StoredDevice[]> => ipcRenderer.invoke('devices:list'),
  add: (input: NewDeviceInput): Promise<StoredDevice> => ipcRenderer.invoke('devices:add', input),
  update: (id: string, input: NewDeviceInput): Promise<StoredDevice> =>
    ipcRenderer.invoke('devices:update', id, input),
  delete: (id: string): Promise<void> => ipcRenderer.invoke('devices:delete', id),
  testConnection: (input: NewDeviceInput): Promise<ConnectionTestResult> =>
    ipcRenderer.invoke('devices:testConnection', input),
  renameChannel: (id: string, channel: number, label: string): Promise<ChannelInfo[] | null> =>
    ipcRenderer.invoke('devices:renameChannel', id, channel, label),
  // Cached status from the app's persistent connection to this device — no
  // network round-trip.
  getStatus: (id: string): Promise<DeviceConnectionStatus | undefined> =>
    ipcRenderer.invoke('devices:getStatus', id),
  // Bulk form — one round trip for every device's status instead of one
  // per device, used for a page's initial-render fetch.
  getAllStatuses: (): Promise<Record<string, DeviceConnectionStatus>> =>
    ipcRenderer.invoke('devices:getAllStatuses'),
  // Forces a real reconnect attempt right now (the "Refresh Status" button).
  checkStatus: (id: string): Promise<DeviceConnectionStatus | undefined> =>
    ipcRenderer.invoke('devices:checkStatus', id),
  // ONVIF WS-Discovery scan of the local network - takes a few seconds.
  discover: (): Promise<DiscoveredDevice[]> => ipcRenderer.invoke('devices:discover'),
  // Live push whenever any device's connection status changes (connects,
  // drops, or a background heartbeat retry succeeds/fails) — lets Device
  // Management show real-time status without polling.
  onStatusChanged: (callback: (deviceId: string, status: DeviceConnectionStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, deviceId: string, status: DeviceConnectionStatus): void =>
      callback(deviceId, status);
    ipcRenderer.on('devices:statusChanged', listener);
    return () => ipcRenderer.removeListener('devices:statusChanged', listener);
  },
};

// A single shared ipcRenderer listener per channel dispatches to
// per-viewHandle subscribers, rather than every tile registering its own raw
// listener and filtering internally — that scaled O(n) per frame and
// tripped Node's default max-listener warning past 10 simultaneous tiles
// (exactly what 16/25/32-channel grids need to support). Shared between
// liveView and playback, which push frames on separate channels
// ('liveView:frame'/'playback:frame') but need identical dispatch logic.
function createFrameChannel(channel: string) {
  const subscribers = new Map<string, Set<(frame: DecodedFrame) => void>>();
  let registered = false;

  function ensureListener(): void {
    if (registered) return;
    registered = true;
    ipcRenderer.on(channel, (_event, viewHandle: string, frame: DecodedFrame) => {
      subscribers.get(viewHandle)?.forEach((callback) => callback(frame));
      // Tells the main process it's safe to send the next frame for this
      // viewHandle — see frameBackpressure.ts. Sent after dispatch (not
      // before) so a slow-painting subscriber naturally delays the ack,
      // and therefore the next frame, instead of acking immediately and
      // just moving the backlog into this process instead of Electron's
      // IPC transport.
      ipcRenderer.send('frame:ack', viewHandle);
    });
  }

  return (viewHandle: string, callback: (frame: DecodedFrame) => void): (() => void) => {
    ensureListener();
    let set = subscribers.get(viewHandle);
    if (!set) {
      set = new Set();
      subscribers.set(viewHandle, set);
    }
    set.add(callback);
    return () => {
      set!.delete(callback);
      if (set!.size === 0) subscribers.delete(viewHandle);
    };
  };
}

const onLiveViewFrame = createFrameChannel('liveView:frame');
const onPlaybackFrame = createFrameChannel('playback:frame');

const liveView = {
  getChannels: (deviceId: string): Promise<ChannelInfo[]> => ipcRenderer.invoke('liveView:getChannels', deviceId),

  start: (deviceId: string, channel: number, streamType: StreamType): Promise<string> =>
    ipcRenderer.invoke('liveView:start', deviceId, channel, streamType),

  stop: (deviceId: string, viewHandle: string): Promise<void> =>
    ipcRenderer.invoke('liveView:stop', deviceId, viewHandle),

  setFrameDelivery: (deviceId: string, viewHandle: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('liveView:setFrameDelivery', deviceId, viewHandle, enabled),

  onFrame: onLiveViewFrame,

  // Fires only on an actual health-status transition for a viewHandle, not
  // continuously — see main/services/videoHealthCheck.ts.
  onVideoHealth: (callback: (viewHandle: string, healthy: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, viewHandle: string, healthy: boolean): void =>
      callback(viewHandle, healthy);
    ipcRenderer.on('liveView:videoHealth', listener);
    return () => ipcRenderer.removeListener('liveView:videoHealth', listener);
  },

  // "Start App" (AppSettings.restoreLiveViewOnStart) support — see
  // main/ipc/liveView.ts's matching handlers for the one-shot-per-process
  // semantics on the consume side.
  saveLastSessionState: (state: LastLiveViewState): Promise<void> =>
    ipcRenderer.invoke('liveView:saveLastSessionState', state),
  consumeStartupRestoreState: (): Promise<LastLiveViewState | null> =>
    ipcRenderer.invoke('liveView:consumeStartupRestoreState'),
  peekLastSessionState: (): Promise<LastLiveViewState | null> =>
    ipcRenderer.invoke('liveView:peekLastSessionState'),

  saveSnapshot: (deviceName: string, channel: number, data: ArrayBuffer): Promise<MediaSaveResult> =>
    ipcRenderer.invoke('liveView:saveSnapshot', deviceName, channel, data),
  saveRecording: (deviceName: string, channel: number, data: ArrayBuffer): Promise<MediaSaveResult> =>
    ipcRenderer.invoke('liveView:saveRecording', deviceName, channel, data),
};

const playback = {
  findRecordings: (
    deviceId: string,
    channel: number,
    startMs: number,
    endMs: number,
    filters: RecordingSearchFilter[],
    quick?: boolean,
  ): Promise<RecordingSegment[]> =>
    ipcRenderer.invoke('playback:findRecordings', deviceId, channel, startMs, endMs, filters, quick),

  start: (deviceId: string, channel: number, startMs: number, endMs: number): Promise<string> =>
    ipcRenderer.invoke('playback:start', deviceId, channel, startMs, endMs),

  control: (deviceId: string, viewHandle: string, command: PlaybackCommand, value?: number): Promise<void> =>
    ipcRenderer.invoke('playback:control', deviceId, viewHandle, command, value),

  getTime: (deviceId: string, viewHandle: string): Promise<number> =>
    ipcRenderer.invoke('playback:getTime', deviceId, viewHandle),

  stop: (deviceId: string, viewHandle: string): Promise<void> => ipcRenderer.invoke('playback:stop', deviceId, viewHandle),

  setFrameDelivery: (deviceId: string, viewHandle: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('playback:setFrameDelivery', deviceId, viewHandle, enabled),

  // Resolves to null if the user cancels the native Save dialog. Only
  // chooses the destination — playback:startBackup (below) is a separate,
  // later step so the UI can show the chosen path and a distinct
  // "Download" button before anything actually starts transferring.
  chooseExportPath: (deviceId: string, channel: number, startMs: number, endMs: number): Promise<string | null> =>
    ipcRenderer.invoke('playback:chooseExportPath', deviceId, channel, startMs, endMs),

  // Null when Settings' Video tab has no Export Path configured — the
  // popup falls back to requiring chooseExportPath (above) in that case.
  getDefaultExportPath: (deviceId: string, channel: number, startMs: number, endMs: number): Promise<string | null> =>
    ipcRenderer.invoke('playback:getDefaultExportPath', deviceId, channel, startMs, endMs),

  startBackup: (deviceId: string, channel: number, startMs: number, endMs: number, filePath: string): Promise<string> =>
    ipcRenderer.invoke('playback:startBackup', deviceId, channel, startMs, endMs, filePath),

  getBackupProgress: (deviceId: string, downloadHandle: string): Promise<number> =>
    ipcRenderer.invoke('playback:getBackupProgress', deviceId, downloadHandle),

  stopBackup: (deviceId: string, downloadHandle: string): Promise<void> =>
    ipcRenderer.invoke('playback:stopBackup', deviceId, downloadHandle),

  pauseBackup: (deviceId: string, downloadHandle: string): Promise<void> =>
    ipcRenderer.invoke('playback:pauseBackup', deviceId, downloadHandle),

  resumeBackup: (deviceId: string, downloadHandle: string): Promise<void> =>
    ipcRenderer.invoke('playback:resumeBackup', deviceId, downloadHandle),

  verifyExportedFile: (filePath: string): Promise<{ ok: boolean; size: number }> =>
    ipcRenderer.invoke('playback:verifyExportedFile', filePath),

  openExportLocation: (filePath: string): Promise<void> => ipcRenderer.invoke('playback:openExportLocation', filePath),

  onFrame: onPlaybackFrame,

  // See liveView.onVideoHealth's matching comment.
  onVideoHealth: (callback: (viewHandle: string, healthy: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, viewHandle: string, healthy: boolean): void =>
      callback(viewHandle, healthy);
    ipcRenderer.on('playback:videoHealth', listener);
    return () => ipcRenderer.removeListener('playback:videoHealth', listener);
  },
};

const layouts = {
  list: (): Promise<CustomLayout[]> => ipcRenderer.invoke('layouts:list'),
  save: (name: string, layout: number, tiles: CustomLayoutTile[]): Promise<CustomLayout> =>
    ipcRenderer.invoke('layouts:save', name, layout, tiles),
  delete: (id: string): Promise<void> => ipcRenderer.invoke('layouts:delete', id),
};

const settings = {
  get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  set: (partial: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:set', partial),
  // Video settings tab's "Browse" button — resolves to null if canceled.
  chooseSnapshotFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:chooseSnapshotFolder'),
  chooseExportFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:chooseExportFolder'),
  chooseLocalRecordingFolder: (): Promise<string | null> => ipcRenderer.invoke('settings:chooseLocalRecordingFolder'),
  // Live push whenever settings change from ANY window — each BrowserWindow
  // (main or a popped-out tab) only ever reads settings once at its own
  // mount time, so without this a popped-out tab's theme (or any other
  // setting) goes stale the moment it's changed elsewhere.
  onChanged: (callback: (settings: AppSettings) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, settings: AppSettings): void => callback(settings);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
};

const system = {
  restart: (): Promise<void> => ipcRenderer.invoke('system:restart'),
  openInBrowser: (host: string, port: number): Promise<void> => ipcRenderer.invoke('system:openInBrowser', host, port),
  openCompanyLink: (kind: CompanyLinkKind): Promise<void> => ipcRenderer.invoke('system:openCompanyLink', kind),
  // True OS-level fullscreen (edge-to-edge, no title bar) — used by Live
  // View's fullscreen toggle, distinct from just maximizing the window.
  setFullScreen: (fullScreen: boolean): Promise<void> => ipcRenderer.invoke('system:setFullScreen', fullScreen),
  // The window is frameless — AppShell's own header draws these buttons in
  // place of the native OS title bar, so they need a real IPC call to
  // actually act on the window.
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('system:minimizeWindow'),
  toggleMaximizeWindow: (): Promise<void> => ipcRenderer.invoke('system:toggleMaximizeWindow'),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('system:closeWindow'),
  isWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke('system:isWindowMaximized'),
  // Fired when the user tries to close the main window (header button, OS
  // close control, or taskbar) — the close is held until confirmClose()
  // below is called, so AppShell can show its own themed confirmation
  // dialog instead of the close just happening immediately.
  onRequestCloseConfirm: (callback: () => void): (() => void) => {
    const listener = (): void => callback();
    ipcRenderer.on('system:requestCloseConfirm', listener);
    return () => ipcRenderer.removeListener('system:requestCloseConfirm', listener);
  },
  // Confirms the close prompted by onRequestCloseConfirm above — closes the
  // main window and every popped-out tab window with it.
  confirmClose: (): Promise<void> => ipcRenderer.invoke('system:confirmClose'),
  onWindowMaximizedChanged: (callback: (maximized: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean): void => callback(maximized);
    ipcRenderer.on('system:windowMaximizedChanged', listener);
    return () => ipcRenderer.removeListener('system:windowMaximizedChanged', listener);
  },
  // Live CPU/memory usage of the machine running the app, pushed every 2s —
  // shown in the Live View toolbar so the user can tell if the machine is
  // under strain from decoding many channels at once.
  onStats: (callback: (stats: SystemStats) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, stats: SystemStats): void => callback(stats);
    ipcRenderer.on('system:stats', listener);
    return () => ipcRenderer.removeListener('system:stats', listener);
  },
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('system:getAppVersion'),
  // Opens the bundled manual.html in the OS's default handler; resolves to
  // false if the file isn't there yet (still a placeholder today).
  openManual: (): Promise<boolean> => ipcRenderer.invoke('system:openManual'),
  // Used by AppShell's tab strip to tell whether a dragged tab was dropped
  // outside the main window (see windows.popOutTab below).
  getWindowBounds: (): Promise<{ x: number; y: number; width: number; height: number }> =>
    ipcRenderer.invoke('system:getWindowBounds'),
  // Backs the "Automatic" theme option — resolves 'auto' to whatever the OS
  // itself is currently set to, and stays live if the OS setting changes.
  getSystemPrefersDark: (): Promise<boolean> => ipcRenderer.invoke('system:getSystemPrefersDark'),
  onSystemThemeChanged: (callback: (prefersDark: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, prefersDark: boolean): void => callback(prefersDark);
    ipcRenderer.on('system:systemThemeChanged', listener);
    return () => ipcRenderer.removeListener('system:systemThemeChanged', listener);
  },
};

const windows = {
  // Detaches a tab into its own standalone window, positioned near where it
  // was dropped (see AppShell.tsx's drag-to-detach tab strip).
  popOutTab: (kind: PopoutTabKind, screenX: number, screenY: number): Promise<void> =>
    ipcRenderer.invoke('windows:popOutTab', kind, screenX, screenY),
};

const backup = {
  // Full config backup/restore (settings, devices w/ real passwords, admin
  // account, saved login, custom layouts) — Settings' Others tab.
  exportConfig: (): Promise<BackupResult> => ipcRenderer.invoke('backup:exportConfig'),
  importConfig: (): Promise<BackupResult> => ipcRenderer.invoke('backup:importConfig'),
  // Device list only, merged into whatever's already saved on import. Our
  // own export format only — real vendor device-list import was removed.
  exportDevices: (): Promise<BackupResult> => ipcRenderer.invoke('backup:exportDevices'),
  importDevices: (): Promise<BackupResult> => ipcRenderer.invoke('backup:importDevices'),
};

const updates = {
  // Manual-only — there's no background polling, so 'checking' status only
  // ever fires right after this call (see Settings > About).
  check: (): Promise<void> => ipcRenderer.invoke('updates:check'),
  download: (): Promise<void> => ipcRenderer.invoke('updates:download'),
  // Quits and relaunches into the downloaded version.
  install: (): Promise<void> => ipcRenderer.invoke('updates:install'),
  onStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => callback(status);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  },
};

const api = { auth, prefs, devices, layouts, liveView, playback, settings, system, windows, backup, updates };
export type PreloadApi = typeof api;

contextBridge.exposeInMainWorld('ssmVms', api);
