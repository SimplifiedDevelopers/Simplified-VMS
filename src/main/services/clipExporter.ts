import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import type { DecodedFrame } from '../../shared/types';
import type { VmsAdapter } from '../adapters/vmsAdapter';
import { resolveFfmpegPath } from './ffmpegPath';
import { killProcessTree } from './processTree';

// Every vendor's own native "backup"/download SDK call turned out to be
// unreliable (Dahua never implemented it at all; Hikvision/TVT/Uniview's
// native downloads frequently finish "100%" with a 0-byte file on disk —
// see main/ipc/playback.ts's doc comment history). Since on-screen Playback
// already decodes frames identically for every vendor via
// adapter.startPlayback, this exports a time range by running that exact
// same decode path in the background and piping every frame straight into
// ffmpeg to encode the destination file ourselves — one mechanism instead
// of four vendor-specific ones, reusing the ffmpeg spawn/path conventions
// already established for the ONVIF adapter's RTSP decode (ffmpegPath.ts,
// processTree.ts).

// No explicit "playback ended" signal exists on VmsAdapter (only onFrame) —
// startPlayback already bounds native decode to [startMs, endMs], so the
// SDK simply stops calling back once it's out of frames in range. This is
// what actually detects "done" (or "stalled") instead.
const INACTIVITY_TIMEOUT_MS = 5000;

// Real vendor playback paces at roughly real presentation speed (confirmed
// by the fact that on-screen Playback already plays back correctly at 1x)
// so ffmpeg's encode should essentially always keep up — this queue is a
// safety valve against a slow/stalled encoder, not the expected path.
const MAX_QUEUED_FRAMES = 300;

// How long to wait for ffmpeg to exit cleanly (after closing its stdin)
// before falling back to a hard kill.
const FFMPEG_EXIT_GRACE_MS = 3000;

// How long to wait for the vendor's native stopPlayback call before giving
// up on it and killing ffmpeg anyway. Confirmed live: an export's ffmpeg
// process (and the CPU it was burning) outlived both Stop being clicked and
// the Playback tab being closed — the native stop call itself is a real
// network round trip to the device (same class of call already known to be
// slow on some vendors/devices), and without a timeout here a stuck one
// would block this whole finalize path, and the ffmpeg process it's
// supposed to clean up, forever.
const NATIVE_STOP_TIMEOUT_MS = 5000;

function withTimeout(promise: Promise<void>, ms: number, label: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // eslint-disable-next-line no-console
      console.error(`[clipExporter] ${label} did not resolve within ${ms}ms — proceeding without it`);
      resolve();
    }, ms);
    promise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

interface ExportJob {
  adapter: VmsAdapter;
  // Kept so pauseExport/resumeExport can re-open a fresh native playback
  // session later — startExport itself only ever needed these transiently
  // before this.
  sessionId: string;
  channel: number;
  viewHandle: string | null;
  startMs: number;
  endMs: number;
  filePath: string;
  ffmpeg: ChildProcess | null;
  progress: number;
  // Anchors progress to the first frame's own timestamp rather than
  // assuming frame.timestampMs is an absolute epoch value comparable to
  // startMs/endMs - confirmed live as necessary: Uniview's frame
  // timestamps turned out to be a stream-relative PTS counter, not a
  // real epoch timestamp, so comparing it directly against startMs always
  // landed near 0%. Measuring elapsed time FROM the first frame instead
  // works regardless of whether a vendor's timestamps are epoch-absolute
  // or stream-relative, as long as they advance at real content speed.
  firstFrameContentMs: number | null;
  // Furthest content timestamp actually written so far - resumeExport
  // restarts native playback from just past this point rather than from
  // startMs again, so resuming doesn't re-capture (and duplicate) content
  // already in the file.
  lastContentMs: number | null;
  formatChecked: boolean;
  inactivityTimer: ReturnType<typeof setTimeout> | null;
  queue: Buffer[];
  draining: boolean;
  finalizePromise: Promise<void> | null;
  // Set by pauseExport, cleared by resumeExport. ffmpeg stays alive and
  // open the whole time - only the native playback session is torn down
  // and later re-opened, so the same output file just keeps growing
  // rather than needing a second file stitched together afterward.
  paused: boolean;
}

const jobs = new Map<string, ExportJob>();

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function armInactivityTimer(handle: string, job: ExportJob): void {
  if (job.inactivityTimer) clearTimeout(job.inactivityTimer);
  job.inactivityTimer = setTimeout(() => {
    finalize(handle).catch(() => undefined);
  }, INACTIVITY_TIMEOUT_MS);
}

// Drains job.queue against ffmpeg's stdin in order, respecting Node stream
// backpressure (write() returning false) rather than assuming every write
// lands synchronously.
function flushQueue(job: ExportJob): void {
  while (job.queue.length > 0) {
    const stdin = job.ffmpeg?.stdin;
    if (!stdin || stdin.destroyed) return;
    const next = job.queue[0];
    const ok = stdin.write(next);
    job.queue.shift();
    if (!ok) {
      job.draining = true;
      stdin.once('drain', () => {
        job.draining = false;
        flushQueue(job);
      });
      return;
    }
  }
}

function writeFrame(job: ExportJob, data: Buffer): void {
  const stdin = job.ffmpeg?.stdin;
  if (!stdin || stdin.destroyed) return;
  if (job.draining || job.queue.length > 0) {
    if (job.queue.length < MAX_QUEUED_FRAMES) job.queue.push(data);
    return;
  }
  const ok = stdin.write(data);
  if (!ok) {
    job.draining = true;
    stdin.once('drain', () => {
      job.draining = false;
      flushQueue(job);
    });
  }
}

function waitForQueueDrain(job: ExportJob): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (job.queue.length === 0 && !job.draining) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
}

function handleFrame(handle: string, job: ExportJob, frame: DecodedFrame): void {
  if (job.finalizePromise) return;
  armInactivityTimer(handle, job);

  if (job.firstFrameContentMs === null) job.firstFrameContentMs = frame.timestampMs;
  const elapsedContentMs = frame.timestampMs - job.firstFrameContentMs;
  job.progress = clamp((elapsedContentMs / Math.max(1, job.endMs - job.startMs)) * 100, 0, 100);
  job.lastContentMs = frame.timestampMs;

  if (!job.formatChecked) {
    job.formatChecked = true;
    // The type technically allows 'yuv420p' even though every vendor's
    // native addon only ever actually produces 'rgb32' (RGBA bytes) today —
    // cheap insurance against silently feeding mismatched raw bytes into
    // ffmpeg's rawvideo input if that ever changes.
    if (frame.format !== 'rgb32') {
      finalize(handle).catch(() => undefined);
      return;
    }
  }

  if (!job.ffmpeg) {
    const args = [
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${frame.width}x${frame.height}`,
      '-use_wallclock_as_timestamps', '1',
      '-i', 'pipe:0',
      '-an',
      '-c:v', 'libx264',
      // libx264's default preset ('medium') was confirmed live to sustain
      // 55-96% CPU across all 4 vendors during an export, not just Dahua —
      // 'medium' spends real CPU searching for smaller output at a fixed
      // quality. Moved to 'veryfast' first (real, substantial CPU cut),
      // then to 'ultrafast' after a user report that exports still ran far
      // slower than the manufacturer's own VMS software — its export is a
      // raw stream copy of the already-compressed recording (no decode, no
      // re-encode), which this pipeline can't match no matter the preset
      // since it decodes every frame and re-encodes in real time by design
      // (built this way because each vendor's own native backup/export SDK
      // call was unreliable, producing 0-byte files - see clipExporter.ts's
      // module doc comment). 'ultrafast' is the fastest libx264 preset,
      // trading further compression efficiency (a larger file than
      // 'veryfast' produced) for the least possible per-frame encode work -
      // the right trade here since an evidence clip's source is already
      // lossy-compressed by the camera, so a bigger but still-lossy output
      // costs little.
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-loglevel', 'error',
      '-y',
      job.filePath,
    ];
    job.ffmpeg = spawn(resolveFfmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    // Drained but otherwise ignored — ffmpeg can stall if its stderr pipe
    // buffer fills with nothing reading it. verifyExportedFile (playback.ts)
    // is what surfaces an actual encode failure to the user, via file size.
    job.ffmpeg.stderr?.on('data', () => undefined);
    job.ffmpeg.stdin?.on('error', () => undefined);
  }

  writeFrame(job, frame.data);
}

function finalize(handle: string): Promise<void> {
  const job = jobs.get(handle);
  if (!job) return Promise.resolve();
  if (!job.finalizePromise) job.finalizePromise = doFinalize(handle, job);
  return job.finalizePromise;
}

async function doFinalize(handle: string, job: ExportJob): Promise<void> {
  if (job.inactivityTimer) clearTimeout(job.inactivityTimer);

  if (job.viewHandle && job.adapter.stopPlayback) {
    await withTimeout(
      job.adapter.stopPlayback(job.viewHandle).catch(() => undefined),
      NATIVE_STOP_TIMEOUT_MS,
      'stopPlayback (finalize)',
    );
  }

  if (job.ffmpeg) {
    await waitForQueueDrain(job);
    const proc = job.ffmpeg;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    proc.stdin?.end();
    const timedOut = new Promise<void>((resolve) => setTimeout(resolve, FFMPEG_EXIT_GRACE_MS));
    await Promise.race([exited, timedOut]);
    if (proc.exitCode === null && proc.signalCode === null) {
      await killProcessTree(proc);
    }
  }

  job.progress = 100;
  jobs.delete(handle);
}

// Starts a background playback session for [startMs, endMs] and encodes
// every decoded frame straight to filePath. Returns a handle for progress
// polling (getExportProgress) and cancellation (stopExport) — same
// contract main/ipc/playback.ts's handlers already expose to the renderer.
export async function startExport(
  channel: number,
  startMs: number,
  endMs: number,
  filePath: string,
  adapter: VmsAdapter,
  sessionId: string,
): Promise<string> {
  if (!adapter.startPlayback || !adapter.stopPlayback) {
    throw new Error(`Export isn't supported for ${adapter.vendor} yet`);
  }

  const handle = randomUUID();
  const job: ExportJob = {
    adapter,
    sessionId,
    channel,
    viewHandle: null,
    startMs,
    endMs,
    filePath,
    ffmpeg: null,
    progress: 0,
    firstFrameContentMs: null,
    lastContentMs: null,
    formatChecked: false,
    inactivityTimer: null,
    queue: [],
    draining: false,
    finalizePromise: null,
    paused: false,
  };
  jobs.set(handle, job);
  armInactivityTimer(handle, job);

  try {
    // paceToRealtime=true — see VmsAdapter.startPlayback's doc comment.
    // Confirmed live as necessary: without it, a vendor whose native
    // decode isn't paced to real time (no on-screen render forcing it to
    // wait) floods this callback fast enough to starve Electron's main
    // thread, which Windows then kills as "not responding."
    const viewHandle = await adapter.startPlayback(
      sessionId,
      channel,
      startMs,
      endMs,
      (frame) => {
        handleFrame(handle, job, frame);
      },
      true,
    );
    // pauseExport can run while this call was still in flight (Dahua's
    // native connect is slow enough for a user to hit Pause within that
    // window) - rather than let a paused job's session slip back in once
    // this resolves, immediately stop what was just opened.
    if (job.paused || job.finalizePromise) {
      adapter.stopPlayback?.(viewHandle).catch(() => undefined);
    } else {
      job.viewHandle = viewHandle;
    }
  } catch (err) {
    if (job.inactivityTimer) clearTimeout(job.inactivityTimer);
    jobs.delete(handle);
    throw err;
  }

  return handle;
}

// 0-100. Falls back to 100 for an unknown/already-finalized handle, same
// "connection gone → report done" semantics main/ipc/playback.ts already
// used for the vendor-native path this replaces.
export function getExportProgress(handle: string): number {
  return jobs.get(handle)?.progress ?? 100;
}

export async function stopExport(handle: string): Promise<void> {
  await finalize(handle);
}

// Stops the underlying native playback session but leaves ffmpeg open and
// the job registered — unlike stopExport/finalize, this is meant to be
// resumed. The inactivity timer is cleared for the same reason it's
// cleared during finalize: no frames arriving is expected and intentional
// while paused, not a stall to detect.
export async function pauseExport(handle: string): Promise<void> {
  const job = jobs.get(handle);
  if (!job || job.paused || job.finalizePromise) return;
  job.paused = true;
  if (job.inactivityTimer) clearTimeout(job.inactivityTimer);
  const viewHandle = job.viewHandle;
  job.viewHandle = null;
  if (viewHandle && job.adapter.stopPlayback) {
    await withTimeout(
      job.adapter.stopPlayback(viewHandle).catch(() => undefined),
      NATIVE_STOP_TIMEOUT_MS,
      'stopPlayback (pause)',
    );
  }
}

// Re-opens a native playback session starting just past whatever was last
// actually written (not from the original startMs again, which would
// re-capture and duplicate already-exported content) and keeps feeding the
// SAME still-open ffmpeg process.
export async function resumeExport(handle: string): Promise<void> {
  const job = jobs.get(handle);
  if (!job || !job.paused || job.finalizePromise) return;
  job.paused = false;
  if (!job.adapter.startPlayback) return;
  const resumeFromMs = job.lastContentMs !== null ? job.lastContentMs + 1 : job.startMs;
  if (resumeFromMs >= job.endMs) {
    finalize(handle).catch(() => undefined);
    return;
  }
  armInactivityTimer(handle, job);
  try {
    const viewHandle = await job.adapter.startPlayback(
      job.sessionId,
      job.channel,
      resumeFromMs,
      job.endMs,
      (frame) => {
        handleFrame(handle, job, frame);
      },
      true,
    );
    // Re-paused (or cancelled) again while this connect was in flight.
    if (job.paused || job.finalizePromise) {
      job.adapter.stopPlayback?.(viewHandle).catch(() => undefined);
    } else {
      job.viewHandle = viewHandle;
    }
  } catch {
    // Leave it paused rather than silently finalizing - the renderer's
    // Resume button is still there for the user to try again.
    job.paused = true;
    if (job.inactivityTimer) clearTimeout(job.inactivityTimer);
  }
}

// Finalizes every still-active export in parallel — wired into app quit
// (main/index.ts's before-quit) so an in-flight export's ffmpeg process and
// native playback session don't get orphaned when the user quits mid-export.
export async function stopAllExports(): Promise<void> {
  await Promise.allSettled([...jobs.keys()].map((handle) => finalize(handle)));
}
