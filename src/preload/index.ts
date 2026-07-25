import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  AuthStatus,
  ChannelInfo,
  ConnectionTestResult,
  DecodedFrame,
  NewDeviceInput,
  SavedLogin,
  StoredDevice,
  StreamType,
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
  checkStatus: (id: string): Promise<ConnectionTestResult> => ipcRenderer.invoke('devices:checkStatus', id),
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
};

const api = { auth, prefs, devices, liveView, settings, system };
export type PreloadApi = typeof api;

contextBridge.exposeInMainWorld('ssmVms', api);
