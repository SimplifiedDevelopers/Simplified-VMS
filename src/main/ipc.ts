import { ipcMain, type WebContents } from 'electron';
import { getAdapter, type VendorId } from './adapters/registry';
import type { DecodedFrame, LoginParams, StreamType } from './adapters/vmsAdapter';

interface ActiveSession {
  vendor: VendorId;
  sessionId: string;
}

const sessions = new Map<string, ActiveSession>();

export function registerVmsIpcHandlers(getSender: () => WebContents): void {
  ipcMain.handle('vms:login', async (_event, vendor: VendorId, params: LoginParams) => {
    const adapter = getAdapter(vendor);
    const session = await adapter.login(params);
    sessions.set(session.sessionId, { vendor, sessionId: session.sessionId });
    return session;
  });

  ipcMain.handle('vms:logout', async (_event, sessionId: string) => {
    const active = sessions.get(sessionId);
    if (!active) return;
    await getAdapter(active.vendor).logout(sessionId);
    sessions.delete(sessionId);
  });

  ipcMain.handle(
    'vms:startLiveView',
    async (_event, sessionId: string, channel: number, streamType: StreamType) => {
      const active = sessions.get(sessionId);
      if (!active) throw new Error(`Unknown session: ${sessionId}`);
      const adapter = getAdapter(active.vendor);
      let viewHandle = '';
      viewHandle = await adapter.startLiveView(sessionId, channel, streamType, (frame: DecodedFrame) => {
        getSender().send('vms:frame', viewHandle, frame);
      });
      return viewHandle;
    },
  );

  ipcMain.handle('vms:stopLiveView', async (_event, sessionId: string, viewHandle: string) => {
    const active = sessions.get(sessionId);
    if (!active) return;
    await getAdapter(active.vendor).stopLiveView(viewHandle);
  });
}
