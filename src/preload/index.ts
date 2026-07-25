import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  AuthStatus,
  ChannelInfo,
  ConnectionTestResult,
  DecodedFrame,
  DeviceConnectionStatus,
  NewDeviceInput,
  SavedLogin,
  StoredDevice,
  StreamType,
  SystemStats,
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
  // Cached status from the app's persistent connection to this device — no
  // network round-trip.
  getStatus: (id: string): Promise<DeviceConnectionStatus | undefined> =>
    ipcRenderer.invoke('devices:getStatus', id),
  // Forces a real reconnect attempt right now (the "Refresh Status" button).
  checkStatus: (id: string): Promise<DeviceConnectionStatus | undefined> =>
    ipcRenderer.invoke('devices:checkStatus', id),
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

// A single shared ipcRenderer listener dispatches to per-viewHandle
// subscribers, rather than every tile registering its own raw listener on
// the shared channel and filtering internally — that scaled O(n) per frame
// and tripped Node's default max-listener warning past 10 simultaneous
// tiles (exactly what 16/25/32-channel grids need to support).
const frameSubscribers = new Map<string, Set<(frame: DecodedFrame) => void>>();
let rawFrameListenerRegistered = false;

function ensureRawFrameListener(): void {
  if (rawFrameListenerRegistered) return;
  rawFrameListenerRegistered = true;
  ipcRenderer.on('liveView:frame', (_event, viewHandle: string, frame: DecodedFrame) => {
    frameSubscribers.get(viewHandle)?.forEach((callback) => callback(frame));
  });
}

const liveView = {
  getChannels: (deviceId: string): Promise<ChannelInfo[]> => ipcRenderer.invoke('liveView:getChannels', deviceId),

  start: (deviceId: string, channel: number, streamType: StreamType): Promise<string> =>
    ipcRenderer.invoke('liveView:start', deviceId, channel, streamType),

  stop: (deviceId: string, viewHandle: string): Promise<void> =>
    ipcRenderer.invoke('liveView:stop', deviceId, viewHandle),

  onFrame: (viewHandle: string, callback: (frame: DecodedFrame) => void): (() => void) => {
    ensureRawFrameListener();
    let subscribers = frameSubscribers.get(viewHandle);
    if (!subscribers) {
      subscribers = new Set();
      frameSubscribers.set(viewHandle, subscribers);
    }
    subscribers.add(callback);
    return () => {
      subscribers!.delete(callback);
      if (subscribers!.size === 0) frameSubscribers.delete(viewHandle);
    };
  },
};

const settings = {
  get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  set: (partial: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke('settings:set', partial),
};

const system = {
  restart: (): Promise<void> => ipcRenderer.invoke('system:restart'),
  openInBrowser: (host: string, port: number): Promise<void> => ipcRenderer.invoke('system:openInBrowser', host, port),
  // Live CPU/memory usage of the machine running the app, pushed every 2s —
  // shown in the Live View toolbar so the user can tell if the machine is
  // under strain from decoding many channels at once.
  onStats: (callback: (stats: SystemStats) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, stats: SystemStats): void => callback(stats);
    ipcRenderer.on('system:stats', listener);
    return () => ipcRenderer.removeListener('system:stats', listener);
  },
};

const api = { auth, prefs, devices, liveView, settings, system };
export type PreloadApi = typeof api;

contextBridge.exposeInMainWorld('ssmVms', api);
