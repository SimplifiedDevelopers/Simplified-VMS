import { contextBridge, ipcRenderer } from 'electron';
import type {
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

const liveView = {
  getChannels: (deviceId: string): Promise<ChannelInfo[]> => ipcRenderer.invoke('liveView:getChannels', deviceId),

  start: (deviceId: string, channel: number, streamType: StreamType): Promise<string> =>
    ipcRenderer.invoke('liveView:start', deviceId, channel, streamType),

  stop: (deviceId: string, viewHandle: string): Promise<void> =>
    ipcRenderer.invoke('liveView:stop', deviceId, viewHandle),

  onFrame: (callback: (viewHandle: string, frame: DecodedFrame) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, viewHandle: string, frame: DecodedFrame): void =>
      callback(viewHandle, frame);
    ipcRenderer.on('liveView:frame', listener);
    return () => ipcRenderer.removeListener('liveView:frame', listener);
  },
};

const api = { auth, prefs, devices, liveView };
export type PreloadApi = typeof api;

contextBridge.exposeInMainWorld('ssmVms', api);
