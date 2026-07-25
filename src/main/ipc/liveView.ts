import { ipcMain, type WebContents } from 'electron';
import { getAdapter } from '../adapters/registry';
import { getDeviceCredentials } from '../store/deviceStore';
import type { ChannelInfo, DecodedFrame, StreamType, VendorId } from '../../shared/types';

interface CachedSession {
  vendor: VendorId;
  sessionId: string;
  analogStart: number;
  analogCount: number;
  digitalStart: number;
  digitalCount: number;
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
  const cachedSession: CachedSession = {
    vendor: credentials.vendor,
    sessionId: session.sessionId,
    analogStart: session.analogStart,
    analogCount: session.analogCount,
    digitalStart: session.digitalStart,
    digitalCount: session.digitalCount,
  };
  sessionsByDevice.set(deviceId, cachedSession);
  return cachedSession;
}

function channelsFromSession(session: CachedSession): ChannelInfo[] {
  const channels: ChannelInfo[] = [];
  for (let i = 0; i < session.analogCount; i++) {
    const channel = session.analogStart + i;
    channels.push({ channel, label: `Channel ${channel}` });
  }
  for (let i = 0; i < session.digitalCount; i++) {
    const channel = session.digitalStart + i;
    channels.push({ channel, label: `Channel ${channel}` });
  }
  return channels;
}

export function registerLiveViewIpcHandlers(getSender: () => WebContents): void {
  ipcMain.handle('liveView:getChannels', async (_event, deviceId: string): Promise<ChannelInfo[]> => {
    const session = await resolveSession(deviceId);
    return channelsFromSession(session);
  });

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

// Vendor SDKs (Hikvision included) cap concurrent logins per account on a
// given device. Without this, every app restart during dev testing leaves
// the previous session's login dangling on the device — nothing ever
// called NET_DVR_Logout for it — and repeated restarts eventually exhaust
// that limit, surfacing as a plain connect failure that looks unrelated.
export async function logoutAllSessions(): Promise<void> {
  await Promise.all(
    Array.from(sessionsByDevice.values()).map((session) =>
      getAdapter(session.vendor)
        .logout(session.sessionId)
        .catch(() => undefined),
    ),
  );
  sessionsByDevice.clear();
}
