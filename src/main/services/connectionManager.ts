import { getAdapter } from '../adapters/registry';
import { getDeviceCredentials, listDevices, setDeviceChannels } from '../store/deviceStore';
import type { DeviceConnectionStatus, VendorId } from '../../shared/types';

// Every other VMS the team has used connects to every configured DVR/NVR
// once when the software opens and stays connected until it closes, rather
// than logging in and out on demand every time a page happens to need a
// device — confirmed as a real usability complaint: Device Management was
// doing a fresh login+logout probe every time it was visited, and Live View
// only ever opened a session lazily on first use with no persistent status.
// This module owns exactly one login session per device for the app's
// entire lifetime and is the single source of truth other IPC handlers
// (devices, liveView) read from instead of managing their own sessions.

export interface ConnectionEntry {
  vendor: VendorId;
  sessionId: string;
  channels: number[];
}

const connections = new Map<string, ConnectionEntry>();
const statusByDevice = new Map<string, DeviceConnectionStatus>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Set<(deviceId: string, status: DeviceConnectionStatus) => void>();

// Vendor SDK logins can take seconds on a slow link and occasionally fail
// transiently on the first attempt even against a healthy device (see
// project memory - real Hikvision/Uniview fleet devices both needed this).
const RETRY_DELAYS_MS = [800, 2000];
// Real fleets run 200+ devices - firing every login at once on startup
// would be a login stampede against the network and against this VPS.
// Devices connect a handful at a time instead.
const MAX_CONCURRENT_CONNECTS = 5;
const HEARTBEAT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(deviceId: string, status: DeviceConnectionStatus): void {
  statusByDevice.set(deviceId, status);
  listeners.forEach((listener) => listener(deviceId, status));
}

export function onStatusChange(listener: (deviceId: string, status: DeviceConnectionStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStatus(deviceId: string): DeviceConnectionStatus | undefined {
  return statusByDevice.get(deviceId);
}

export function getAllStatuses(): Record<string, DeviceConnectionStatus> {
  return Object.fromEntries(statusByDevice);
}

export function getConnection(deviceId: string): ConnectionEntry | undefined {
  return connections.get(deviceId);
}

// Uniview's login protocol needs a second network round trip just to learn
// the channel list (see LoginParams.skipChannelQuery in shared/types.ts) -
// roughly doubling its connect time versus Hikvision/Dahua/TVT, which get
// channels for free from login itself. Once a device's channel list is
// already known and saved (see deviceStore.setDeviceChannels), routine
// reconnects (app-boot connectAll(), heartbeat retries) don't need it
// again — only an explicit forced refresh (device add/update, the "Refresh
// Status" button) re-fetches it, in case it genuinely changed.
async function loginOnce(deviceId: string, forceFullRefresh: boolean): Promise<void> {
  const credentials = getDeviceCredentials(deviceId);
  if (!credentials) return;

  const cachedChannels = listDevices().find((d) => d.id === deviceId)?.channels ?? [];
  const skipChannelQuery = !forceFullRefresh && cachedChannels.length > 0;

  setStatus(deviceId, { state: 'connecting' });
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const adapter = getAdapter(credentials.vendor);
      const session = await adapter.login({ ...credentials, skipChannelQuery });
      const channels = session.channels.length > 0 ? session.channels : cachedChannels;
      connections.set(deviceId, { vendor: credentials.vendor, sessionId: session.sessionId, channels });
      if (session.channels.length > 0) setDeviceChannels(deviceId, session.channels);
      setStatus(deviceId, { state: 'online', channels });
      return;
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_DELAYS_MS.length) await delay(RETRY_DELAYS_MS[attempt]);
    }
  }
  connections.delete(deviceId);
  setStatus(deviceId, { state: 'offline', error: lastError instanceof Error ? lastError.message : String(lastError) });
}

// Concurrent callers for the same device share one in-flight attempt rather
// than each independently calling login (same rationale as the old
// liveView.ts pendingLogins map this replaces).
function connectDevice(deviceId: string, forceFullRefresh = false): Promise<void> {
  const existing = inFlight.get(deviceId);
  if (existing) return existing;
  const promise = loginOnce(deviceId, forceFullRefresh).finally(() => inFlight.delete(deviceId));
  inFlight.set(deviceId, promise);
  return promise;
}

// Returns the live session for a device, connecting first if this is the
// very first time it's been needed (e.g. connectAll() hasn't reached it yet,
// or a device was just added). In steady state this resolves instantly from
// the already-open connection instead of doing a fresh login.
export async function ensureConnected(deviceId: string): Promise<ConnectionEntry | null> {
  const existing = connections.get(deviceId);
  if (existing) return existing;
  await connectDevice(deviceId);
  return connections.get(deviceId) ?? null;
}

async function runWithConcurrencyLimit(deviceIds: string[], limit: number, task: (id: string) => Promise<void>): Promise<void> {
  const queue = [...deviceIds];
  async function worker(): Promise<void> {
    let next: string | undefined;
    while ((next = queue.shift())) {
      await task(next);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, deviceIds.length) }, worker));
}

export async function connectAll(): Promise<void> {
  const deviceIds = listDevices().map((d) => d.id);
  await runWithConcurrencyLimit(deviceIds, MAX_CONCURRENT_CONNECTS, connectDevice);
}

// Verifies already-online devices are genuinely still reachable (our
// addons don't wire up the vendor SDKs' own disconnect/exception
// callbacks, so a dropped session otherwise wouldn't be noticed until the
// next real use fails) and retries devices that are currently offline, so
// Device Management's status reflects reality without the user needing to
// manually click "Refresh".
async function heartbeatTick(): Promise<void> {
  const deviceIds = listDevices().map((d) => d.id);
  await runWithConcurrencyLimit(deviceIds, MAX_CONCURRENT_CONNECTS, async (deviceId) => {
    if (inFlight.has(deviceId)) return;
    const entry = connections.get(deviceId);
    if (!entry) {
      await connectDevice(deviceId);
      return;
    }
    // A cheap real call against the open session - if the device dropped
    // it without telling us, this fails and triggers a reconnect below.
    // Pure reachability check, so the channel list is never needed here.
    try {
      const adapter = getAdapter(entry.vendor);
      const session = await adapter.login({ ...getDeviceCredentials(deviceId)!, skipChannelQuery: true });
      await adapter.logout(session.sessionId).catch(() => undefined);
    } catch {
      connections.delete(deviceId);
      await connectDevice(deviceId);
    }
  });
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    heartbeatTick().catch(() => undefined);
  }, HEARTBEAT_MS);
}

export function forgetDevice(deviceId: string): void {
  const entry = connections.get(deviceId);
  connections.delete(deviceId);
  statusByDevice.delete(deviceId);
  if (entry) {
    getAdapter(entry.vendor).logout(entry.sessionId).catch(() => undefined);
  }
}

// Re-establishes a device's connection with its current (possibly just
// changed) credentials — used after devices:add/update (new/changed
// credentials, and a real chance the channel list itself changed too) and
// by the "Refresh Status" button (an explicit "check for real, right now"
// request) — always does the full channel-query round trip rather than
// trusting whatever's cached, unlike the routine background connects in
// connectAll()/heartbeatTick().
export function reconnectDevice(deviceId: string): Promise<void> {
  forgetDevice(deviceId);
  return connectDevice(deviceId, true);
}

export async function disconnectAll(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  await Promise.all(
    Array.from(connections.entries()).map(([, entry]) => getAdapter(entry.vendor).logout(entry.sessionId).catch(() => undefined)),
  );
  connections.clear();
  statusByDevice.clear();
}
