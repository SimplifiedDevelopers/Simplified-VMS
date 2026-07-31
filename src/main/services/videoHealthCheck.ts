// Detects video loss (a blank/solid-colored frame) purely from decoded pixel
// content, not any vendor SDK alarm. Researched via a competitor product's
// own implementation (CheckMyCCTV) before building this: its "video loss"
// detection isn't a vendor alarm subscription either — that path is
// confirmed unreliable in practice (its own Uniview SDK logs are full of
// failed ONVIF alarm-subscription renewals against real devices). Instead it
// snapshots each channel and checks whether the image is essentially one
// flat color. A lost signal renders as a solid grey/black/blue frame on the
// DVR's own output regardless of vendor *or* whether the channel is IP or
// analog/coax — so this is the only approach that also catches video loss
// on a hybrid DVR's coax channels, which have no SDK-level alarm at all.
//
// Runs against frames already flowing through the existing native decode
// pipeline (see ipc/liveView.ts / ipc/playback.ts) — no extra capture step,
// no per-vendor work.

const CHECK_INTERVAL_MS = 5_000;
// Requires this many consecutive solid-frame checks (~15s at the interval
// above) before flagging unhealthy, so a single transitional black frame
// (IR switch, brief flash, a keyframe artifact) can't false-positive.
// Recovery is immediate — any single non-solid check clears it right away.
const CONSECUTIVE_SOLID_TO_FLAG = 3;
// Sparse sample grid rather than scanning every pixel — cheap enough to run
// on the main thread per tile without adding real CPU cost, the exact
// concern the resource-usage optimization pass earlier this project was
// built around.
const SAMPLE_GRID = 24;
const COLOR_TOLERANCE = 18;
const SOLID_FRACTION_THRESHOLD = 0.92;

interface TileHealthState {
  lastCheckedMs: number;
  consecutiveSolid: number;
  healthy: boolean;
}

const stateByHandle = new Map<string, TileHealthState>();

function isFrameSolid(data: Buffer, width: number, height: number): boolean {
  const stepX = Math.max(1, Math.floor(width / SAMPLE_GRID));
  const stepY = Math.max(1, Math.floor(height / SAMPLE_GRID));
  const samples: number[] = [];
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const offset = (y * width + x) * 4;
      if (offset + 2 >= data.length) continue;
      samples.push(data[offset], data[offset + 1], data[offset + 2]);
    }
  }
  if (samples.length < 30) return false;

  // Quantize each sampled pixel into a coarse bucket to find the dominant
  // color, then measure what fraction of samples actually fall near it —
  // tolerating a small fraction of outliers (an on-screen channel name/OSD
  // overlay on an otherwise-blank frame, minor compression noise) rather
  // than requiring every single sampled pixel to match exactly.
  const bucketCounts = new Map<string, number>();
  for (let i = 0; i < samples.length; i += 3) {
    const key = `${samples[i] >> 4},${samples[i + 1] >> 4},${samples[i + 2] >> 4}`;
    bucketCounts.set(key, (bucketCounts.get(key) ?? 0) + 1);
  }
  let dominantKey = '';
  let dominantCount = 0;
  for (const [key, count] of bucketCounts) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantKey = key;
    }
  }
  const [dr, dg, db] = dominantKey.split(',').map((v) => Number(v) << 4);

  let matching = 0;
  let total = 0;
  for (let i = 0; i < samples.length; i += 3) {
    total++;
    if (
      Math.abs(samples[i] - dr) <= COLOR_TOLERANCE &&
      Math.abs(samples[i + 1] - dg) <= COLOR_TOLERANCE &&
      Math.abs(samples[i + 2] - db) <= COLOR_TOLERANCE
    ) {
      matching++;
    }
  }
  return matching / total >= SOLID_FRACTION_THRESHOLD;
}

// Returns a result only when the health status actually changed, so callers
// only push an IPC event on real transitions instead of every check.
export function checkVideoHealth(
  viewHandle: string,
  data: Buffer,
  width: number,
  height: number,
): { changed: boolean; healthy: boolean } {
  const now = Date.now();
  let state = stateByHandle.get(viewHandle);
  if (!state) {
    state = { lastCheckedMs: 0, consecutiveSolid: 0, healthy: true };
    stateByHandle.set(viewHandle, state);
  }
  if (now - state.lastCheckedMs < CHECK_INTERVAL_MS) {
    return { changed: false, healthy: state.healthy };
  }
  state.lastCheckedMs = now;

  state.consecutiveSolid = isFrameSolid(data, width, height) ? state.consecutiveSolid + 1 : 0;

  const shouldBeHealthy = state.consecutiveSolid < CONSECUTIVE_SOLID_TO_FLAG;
  const changed = shouldBeHealthy !== state.healthy;
  state.healthy = shouldBeHealthy;
  return { changed, healthy: shouldBeHealthy };
}

export function clearVideoHealth(viewHandle: string): void {
  stateByHandle.delete(viewHandle);
}
