import { getAdapter } from '../adapters/registry';
import { getDeviceCredentials, listDevices, setDeviceChannels } from '../store/deviceStore';
import * as recordingCalendarCache from './recordingCalendarCache';
import type { ChannelInfo, DeviceConnectionStatus, VendorId } from '../../shared/types';

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
  channels: ChannelInfo[];
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
// Devices connect a batch at a time instead - 25 comfortably covers the
// highest number of devices a client would realistically have open in the
// app at once, while still meaningfully pacing a much larger saved list
// (e.g. an office's 100+ device on-demand roster, see
// AppSettings.autoConnectAllDevices) rather than firing every login at once.
const MAX_CONCURRENT_CONNECTS = 25;
// Each tick does a real SDK login+logout per already-online device (see
// heartbeatTick's own comment on why - no vendor addon wires up the SDKs'
// own disconnect callback) - a genuine, real recurring cost across a large
// fleet, not just network chatter (login involves protocol handshake +
// session setup on both sides). Real report from the field: an office with
// 50+ devices found the app using noticeably more CPU/resources than their
// previous VMS, on hardware that handled that other software's own 50+
// device connection fine. 30s meant every device got re-verified twice a
// minute forever, regardless of whether anything was actively being
// viewed. Widened to 2 minutes - a device going genuinely offline is still
// noticed within a reasonable window (and "Refresh Status" forces an
// immediate check any time), while cutting this background cost 4x.
const HEARTBEAT_MS = 120_000;

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
// A vendor's per-channel (or bulk) name-fetch call can fail against a real
// device (timeout, transient SDK error, etc.) without failing login itself —
// the native addons fall back to a generic "Channel N" label per channel in
// that case rather than raising an error, since a missing name shouldn't
// block a successful connection. That generic label is indistinguishable
// from a real channel list at this layer UNLESS compared against what's
// already cached, so a failed refresh doesn't silently regress a device
// that already had real names from a previous successful fetch (confirmed
// live: refreshing a device wiped out its already-learned Hikvision names
// after a transient SDK failure).
function isGenericLabel(ch: ChannelInfo): boolean {
  return ch.label === `Channel ${ch.channel}`;
}

function mergeChannels(fetched: ChannelInfo[], cached: ChannelInfo[]): ChannelInfo[] {
  if (fetched.length === 0) return cached;
  return fetched.map((ch) => {
    if (!isGenericLabel(ch)) return ch;
    const cachedMatch = cached.find((c) => c.channel === ch.channel);
    return cachedMatch && !isGenericLabel(cachedMatch) ? cachedMatch : ch;
  });
}

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
      const channels = mergeChannels(session.channels, cachedChannels);
      connections.set(deviceId, { vendor: credentials.vendor, sessionId: session.sessionId, channels });
      if (session.channels.length > 0) setDeviceChannels(deviceId, channels);
      setStatus(deviceId, { state: 'online', channels });
      // Auto-prefetching Uniview's calendar search at every connect was
      // REVERTED after confirming live it competes for the same
      // per-session mutex as ordinary Live View channel starts (both are
      // native calls into the same device session, serialized by
      // SdkMutexForSession) - a multi-channel background prefetch running
      // right after connect could monopolize that lock for minutes,
      // making real Live View usage on that same device look hung
      // ("Connecting…" that never resolves) even though nothing was
      // actually stuck. recordingCalendarCache.ts still caches results
      // once a device/channel/month is actually viewed in Playback - just
      // not warmed proactively before that first view.
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
// heartbeatTick()'s own reachability probe (a direct adapter.login() call
// below, not routed through connectDevice()) was never added to the
// inFlight map disconnectAll() waits on — confirmed live: the exact same
// "FATAL ERROR: Error::ThrowAsJavaScriptException napi_throw" crash inside
// LoginWorker::OnOK recurred through this specific untracked path, even
// with the inFlight fix already in place, since that fix only ever covered
// connectDevice()-wrapped logins. Tracking the whole heartbeatTick() call
// here (rather than each of its internal per-device probes individually)
// covers this gap and every other future one the same way, since anything
// heartbeatTick does internally is nested inside this one promise.
let currentHeartbeatTick: Promise<void> | null = null;

export function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    currentHeartbeatTick = heartbeatTick()
      .catch(() => undefined)
      .finally(() => {
        currentHeartbeatTick = null;
      });
  }, HEARTBEAT_MS);
}

export function forgetDevice(deviceId: string): void {
  const entry = connections.get(deviceId);
  connections.delete(deviceId);
  statusByDevice.delete(deviceId);
  recordingCalendarCache.clearForDevice(deviceId);
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
  // A heartbeat tick or connectAll() reconnect can still have a native
  // login call running on a libuv worker thread (Napi::AsyncWorker) right
  // when the app starts quitting. Without waiting for it here, Node can
  // begin tearing down its environment while that call is still in
  // flight — when it finally completes and its AsyncWorker tries to
  // resolve the JS Promise (OnOK/OnError), N-API can't safely throw/call
  // back into a JS context that's mid-teardown and hard-crashes the whole
  // process instead of raising a normal, catchable error. Confirmed live:
  // "FATAL ERROR: Error::ThrowAsJavaScriptException napi_throw" inside
  // LoginWorker::OnOK, right when closing the app. Letting every in-flight
  // attempt actually finish (success or failure, doesn't matter which)
  // before logging anything out or returning closes that race.
  //
  // currentHeartbeatTick covers a second, previously-missed instance of the
  // exact same race: heartbeatTick's own reachability-probe login isn't
  // tracked in inFlight at all (see the comment on it above), so this crash
  // recurred through that path even after the inFlight fix landed.
  await Promise.allSettled([...inFlight.values(), currentHeartbeatTick].filter((p): p is Promise<void> => p !== null));
  await Promise.all(
    Array.from(connections.entries()).map(([, entry]) => getAdapter(entry.vendor).logout(entry.sessionId).catch(() => undefined)),
  );
  connections.clear();
  statusByDevice.clear();
}
