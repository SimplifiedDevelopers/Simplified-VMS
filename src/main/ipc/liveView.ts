import { ipcMain, type WebContents } from 'electron';
import { getAdapter } from '../adapters/registry';
import { getDeviceCredentials, type DeviceCredentials } from '../store/deviceStore';
import type { ChannelInfo, DecodedFrame, StreamType, VendorId } from '../../shared/types';

interface CachedSession {
  vendor: VendorId;
  sessionId: string;
  channels: number[];
}

// One login per device is reused across channels/tiles rather than
// re-authenticating on every startLiveView call — matches how the
// reference software (and the underlying vendor SDKs) expect a device to
// be used: login once, open/close multiple live-view streams against it.
const sessionsByDevice = new Map<string, CachedSession>();

// Without this, "play all channels" (which fires one liveView:start per
// channel back-to-back) races: each call sees no cached session yet and
// independently calls NET_DVR_Login_V40 for the same device at the same
// time. Concurrent callers for the same device now share one in-flight
// login instead.
const pendingLogins = new Map<string, Promise<CachedSession>>();

const LOGIN_RETRY_DELAYS_MS = [800, 2000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginWithRetry(credentials: DeviceCredentials) {
  const adapter = getAdapter(credentials.vendor);
  let lastError: unknown;
  for (let attempt = 0; attempt <= LOGIN_RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await adapter.login(credentials);
    } catch (err) {
      lastError = err;
      if (attempt < LOGIN_RETRY_DELAYS_MS.length) await delay(LOGIN_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

async function resolveSession(deviceId: string): Promise<CachedSession> {
  const cached = sessionsByDevice.get(deviceId);
  if (cached) return cached;

  const pending = pendingLogins.get(deviceId);
  if (pending) return pending;

  const loginPromise = (async (): Promise<CachedSession> => {
    const credentials = getDeviceCredentials(deviceId);
    if (!credentials) throw new Error(`Unknown device: ${deviceId}`);

    const session = await loginWithRetry(credentials);
    const cachedSession: CachedSession = {
      vendor: credentials.vendor,
      sessionId: session.sessionId,
      channels: session.channels,
    };
    sessionsByDevice.set(deviceId, cachedSession);
    return cachedSession;
  })();

  pendingLogins.set(deviceId, loginPromise);
  try {
    return await loginPromise;
  } finally {
    pendingLogins.delete(deviceId);
  }
}

function channelsFromSession(session: CachedSession): ChannelInfo[] {
  return session.channels.map((channel) => ({ channel, label: `Channel ${channel}` }));
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
