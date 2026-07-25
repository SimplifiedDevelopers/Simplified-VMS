import { contextBridge, ipcRenderer } from 'electron';
import type { DecodedFrame, DeviceSession, LoginParams, StreamType } from '../main/adapters/vmsAdapter';
import type { VendorId } from '../main/adapters/registry';

const vms = {
  login: (vendor: VendorId, params: LoginParams): Promise<DeviceSession> =>
    ipcRenderer.invoke('vms:login', vendor, params),

  logout: (sessionId: string): Promise<void> => ipcRenderer.invoke('vms:logout', sessionId),

  startLiveView: (sessionId: string, channel: number, streamType: StreamType): Promise<string> =>
    ipcRenderer.invoke('vms:startLiveView', sessionId, channel, streamType),

  stopLiveView: (sessionId: string, viewHandle: string): Promise<void> =>
    ipcRenderer.invoke('vms:stopLiveView', sessionId, viewHandle),

  onFrame: (callback: (viewHandle: string, frame: DecodedFrame) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, viewHandle: string, frame: DecodedFrame): void =>
      callback(viewHandle, frame);
    ipcRenderer.on('vms:frame', listener);
    return () => ipcRenderer.removeListener('vms:frame', listener);
  },
};

export type VmsBridge = typeof vms;

contextBridge.exposeInMainWorld('vms', vms);
