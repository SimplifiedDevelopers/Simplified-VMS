import type { RecordingSearchFilter, RecordingSegment } from '../../shared/types';

// Uniview's "quick" (calendar month) recording search is expensive enough
// on a busy channel (~30s, see native/uniview/src/addon.cc's
// SearchByFileChunked doc comment) that it's only worth doing once per
// device/channel/month per app session. Caches the result the first time
// a device/channel/month is actually viewed in Playback's MiniCalendar, so
// switching tabs/tiles back and forth doesn't re-pay that cost. (An
// earlier version of this also proactively pre-warmed the cache in the
// background right after every Uniview device connect — reverted after
// confirming live it competed for the same per-device-session mutex as
// ordinary Live View channel starts, making real Live View usage look
// hung while a multi-channel prefetch ran in the background. See
// connectionManager.ts's loginOnce for that history.) Generic (not
// Uniview-specific) since any future vendor with the same problem can
// reuse it.
// Unbounded otherwise: every distinct device/channel/range/filters
// combination ever queried (every month flipped through in the calendar,
// every custom "Search by Time" range) became a permanent entry for the
// rest of the app's lifetime, only ever pruned on that device's own
// disconnect/reconnect. On a long-running (days/weeks-uptime) install with
// many devices browsed across many days, that has no upper bound. Capped
// with simple insertion-order LRU (Map preserves insertion order in JS;
// re-set on hit to bump an entry to most-recently-used) rather than a TTL,
// since a past day's recordings don't go stale the way live data would.
const MAX_CACHE_ENTRIES = 300;
const cache = new Map<string, RecordingSegment[]>();
const inFlight = new Map<string, Promise<RecordingSegment[]>>();

function rememberInCache(key: string, segments: RecordingSegment[]): void {
  cache.delete(key);
  cache.set(key, segments);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

function cacheKey(
  deviceId: string,
  channel: number,
  startMs: number,
  endMs: number,
  filters: RecordingSearchFilter[],
): string {
  return `${deviceId}|${channel}|${startMs}|${endMs}|${[...filters].sort().join(',')}`;
}

export function getCached(
  deviceId: string,
  channel: number,
  startMs: number,
  endMs: number,
  filters: RecordingSearchFilter[],
): RecordingSegment[] | undefined {
  const key = cacheKey(deviceId, channel, startMs, endMs, filters);
  const cached = cache.get(key);
  if (cached) rememberInCache(key, cached);
  return cached;
}

export async function getOrFetch(
  deviceId: string,
  channel: number,
  startMs: number,
  endMs: number,
  filters: RecordingSearchFilter[],
  fetchSegments: () => Promise<RecordingSegment[]>,
): Promise<RecordingSegment[]> {
  const key = cacheKey(deviceId, channel, startMs, endMs, filters);
  const cached = cache.get(key);
  if (cached) {
    rememberInCache(key, cached);
    return cached;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = fetchSegments()
    .then((segments) => {
      rememberInCache(key, segments);
      return segments;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

// A device's cached calendar data can go stale on an explicit reconnect
// (deviceStore credentials/channels changed) — cleared there rather than
// left to linger under a reused deviceId indefinitely.
export function clearForDevice(deviceId: string): void {
  const prefix = `${deviceId}|`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const key of inFlight.keys()) {
    if (key.startsWith(prefix)) inFlight.delete(key);
  }
}
