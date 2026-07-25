import { ipcMain, type WebContents } from 'electron';
import { getAdapter } from '../adapters/registry';
import { getDeviceCredentials } from '../store/deviceStore';
import type { DecodedFrame, StreamType, VendorId } from '../../shared/types';

interface CachedSession {
  vendor: VendorId;
  sessionId: string;
}

// One login per device is reused across channels/tiles rather than
// re-authenticating on every startLiveView call — matches how the
// reference software (and the underlying vendor SDKs) expect a device to
// be used: login once, open/close multiple live-view streams against it.
const sessionsByDevice = new Map<string, CachedSession>();

async function resolveSession(deviceId: string): Promise<CachedSession> {
  const cached = sessionsByDevice.get(deviceId);
  if (cached) return cached;

  const credentials = getDeviceCredentials(deviceId);
  if (!credentials) throw new Error(`Unknown device: ${deviceId}`);

  const adapter = getAdapter(credentials.vendor);
  const session = await adapter.login(credentials);
  const cachedSession: CachedSession = { vendor: credentials.vendor, sessionId: session.sessionId };
  sessionsByDevice.set(deviceId, cachedSession);
  return cachedSession;
}

export function registerLiveViewIpcHandlers(getSender: () => WebContents): void {
  ipcMain.handle(
    'liveView:start',
    async (_event, deviceId: string, channel: number, streamType: StreamType) => {
      const session = await resolveSession(deviceId);
      const adapter = getAdapter(session.vendor);
      const viewHandle = await adapter.startLiveView(session.sessionId, channel, streamType, (frame: DecodedFrame) => {
        getSender().send('liveView:frame', viewHandle, frame);
      });
      return viewHandle;
    },
  );

  ipcMain.handle('liveView:stop', async (_event, deviceId: string, viewHandle: string) => {
    const session = sessionsByDevice.get(deviceId);
    if (!session) return;
    await getAdapter(session.vendor).stopLiveView(viewHandle);
  });
}
