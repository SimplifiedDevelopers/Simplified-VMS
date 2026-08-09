import { statSync } from 'fs';
import { join } from 'path';
import { dialog, ipcMain, shell } from 'electron';
import { getAdapter } from '../adapters/registry';
import { ensureConnected } from '../services/connectionManager';
import * as recordingCalendarCache from '../services/recordingCalendarCache';
import { checkVideoHealth, clearVideoHealth } from '../services/videoHealthCheck';
import * as clipExporter from '../services/clipExporter';
import { listDevices } from '../store/deviceStore';
import { readSettings } from '../store/settingsStore';
import { forgetFrameHandle, shouldSendFrame } from '../services/frameBackpressure';
import { saveMediaFile } from '../services/mediaSave';
import type { DecodedFrame, MediaSaveResult, PlaybackCommand, RecordingSearchFilter, RecordingSegment } from '../../shared/types';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// Local time (matches what the user actually sees in the timeline/clock),
// not toISOString()'s UTC — confirmed live as a real bug: a UTC-based
// filename was reporting a start time 4 hours off from the clip's real
// (local) start.
function formatLocalDateAndTime(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`,
  };
}

function defaultExportFileName(deviceId: string, channel: number, startMs: number, endMs: number): string {
  const device = listDevices().find((d) => d.id === deviceId);
  const deviceName = (device?.name ?? deviceId).replace(/[\\/:*?"<>|]/g, '_');
  // The device's own saved channel label (real camera name, or a
  // user-applied rename) rather than a vendor-specific raw channel number
  // — normalizeChannels (deviceStore.ts) already falls back to "Channel N"
  // for a device whose channel list hasn't been fetched/named yet.
  const channelLabel = (device?.channels.find((c) => c.channel === channel)?.label ?? `Channel ${channel}`).replace(
    /[\\/:*?"<>|]/g,
    '_',
  );
  const { date, time: startTime } = formatLocalDateAndTime(startMs);
  const { time: endTime } = formatLocalDateAndTime(endMs);
  return `${deviceName}_${channelLabel}_${date}_${startTime}-${endTime}.mp4`;
}

// Tracks every native (AsyncWorker-backed, running on a libuv thread) call
// this file dispatches, so app quit (main/index.ts's before-quit) can wait
// for all of them to genuinely finish before Node starts tearing down its
// environment. Confirmed live as a real crash otherwise: quitting while a
// FindRecordingsWorker was still in flight hit "FATAL ERROR:
// Error::ThrowAsJavaScriptException napi_throw" inside FindRecordingsWorker
// ::OnOK - the exact same hard-crash class connectionManager.ts's own
// inFlight/currentHeartbeatTick tracking exists to prevent for logins
// (see disconnectAll's doc comment), just never extended to cover the
// native calls this file issues. Applied uniformly to every adapter call
// here rather than only the one confirmed to have crashed, since they all
// share the identical risk shape.
const pendingCalls = new Set<Promise<unknown>>();

// Set once app quit actually begins (main/index.ts's before-quit) - the
// renderer's window stays alive and fully able to keep firing new IPC
// calls for the whole time quit is waiting on pendingCalls below (that's
// exactly why the wait is a loop, not a single snapshot: a new call
// dispatched mid-wait needs to be waited on too, not raced past). This
// flag stops NEW native calls from even starting once shutdown is
// underway, rather than only ever growing the set to wait for.
let quitting = false;

export function beginQuitting(): void {
  quitting = true;
}

function tracked<T>(promise: Promise<T>): Promise<T> {
  pendingCalls.add(promise);
  const clear = (): void => {
    pendingCalls.delete(promise);
  };
  promise.then(clear, clear);
  return promise;
}

// A single Promise.allSettled snapshot isn't enough - confirmed live as a
// real crash: the window is still fully alive during this wait (nothing
// destroys it until quit actually proceeds), so a new search/command the
// user (or a still-running effect) triggers mid-wait registers into
// pendingCalls AFTER a one-shot snapshot would have already been taken,
// and races right past it into the same fatal napi_throw this exists to
// prevent. Looping until the set is genuinely empty (combined with
// `quitting` above blocking brand new calls) closes that gap.
export async function waitForPendingPlaybackCalls(): Promise<void> {
  while (pendingCalls.size > 0) {
    await Promise.allSettled([...pendingCalls]);
  }
}

// Called at the top of every handler below that would otherwise dispatch a
// new native call — checking `quitting` alone (without this) still lets
// the crash-causing race happen, since tracked() only ever wraps a promise
// AFTER the underlying native call has already been dispatched.
function assertNotQuitting(): void {
  if (quitting) throw new Error('App is closing.');
}

// Mirrors main/ipc/liveView.ts closely — same "resolve the persistent
// session, then talk to the adapter" shape, same disposable-frame try/catch
// around the push. playback (startPlayback/etc.) is an optional VmsAdapter
// method (see the interface's own doc comment) since ONVIF doesn't
// implement it — those handlers throw a clear "not supported for this
// vendor yet" error instead of a raw "adapter.xyz is not a function".
//
// Export (startBackup/getBackupProgress/stopBackup below) deliberately does
// NOT call the matching optional adapter.startBackup/getBackupProgress/
// stopBackup methods, even though Hikvision/TVT/Uniview implement them —
// those vendor-native "backup"/download SDK calls turned out unreliable in
// practice (frequently a 0-byte file even at "100% done"), and Dahua never
// implemented it at all. Instead, clipExporter.ts runs the same
// startPlayback decode path every on-screen preview already uses and
// encodes the frames straight to the destination file itself with ffmpeg —
// one mechanism for every vendor that has startPlayback/stopPlayback,
// rather than four separate (and three broken) vendor-specific ones. The
// adapters' own startBackup/getBackupProgress/stopBackup are kept in place
// but intentionally unused, to avoid any native-addon changes here.
export function registerPlaybackIpcHandlers(): void {
  ipcMain.handle(
    'playback:findRecordings',
    async (
      _event,
      deviceId: string,
      channel: number,
      startMs: number,
      endMs: number,
      filters: RecordingSearchFilter[],
      quick?: boolean,
    ): Promise<RecordingSegment[]> => {
      assertNotQuitting();
      const connection = await ensureConnected(deviceId);
      if (!connection) throw new Error(`Unable to connect to device: ${deviceId}`);
      const adapter = getAdapter(connection.vendor);
      if (!adapter.findRecordings) throw new Error(`Recording search isn't supported for ${connection.vendor} yet`);
      // `quick` (MiniCalendar's whole-month probe) is the only case worth
      // caching — it's the one that's expensive enough on Uniview
      // (recordingCalendarCache.ts) to matter; a repeat visit to the same
      // device/channel/month within this app session serves instantly
      // from cache, and two requests racing for the same key share one
      // in-flight fetch instead of firing it twice.
      if (!quick) return tracked(adapter.findRecordings(connection.sessionId, channel, startMs, endMs, filters, quick));
      return recordingCalendarCache.getOrFetch(deviceId, channel, startMs, endMs, filters, () =>
        tracked(adapter.findRecordings!(connection.sessionId, channel, startMs, endMs, filters, quick)),
      );
    },
  );

  ipcMain.handle(
    'playback:start',
    async (event, deviceId: string, channel: number, startMs: number, endMs: number) => {
      // See liveView.ts's matching comment — captured once so frames go
      // back to whichever window (main or popped-out) actually started
      // this session, not a single fixed window.
      const sender = event.sender;

      assertNotQuitting();
      const connection = await ensureConnected(deviceId);
      if (!connection) throw new Error(`Unable to connect to device: ${deviceId}`);
      const adapter = getAdapter(connection.vendor);
      if (!adapter.startPlayback) throw new Error(`Playback isn't supported for ${connection.vendor} yet`);
      const viewHandle = await tracked(adapter.startPlayback(
        connection.sessionId,
        channel,
        startMs,
        endMs,
        (frame: DecodedFrame) => {
          // See liveView.ts's matching comment — a destroyed/closing
          // webContents throws here if a frame arrives mid-teardown; a
          // playback frame is just as disposable as a live one.
          if (shouldSendFrame(viewHandle)) {
            try {
              if (!sender.isDestroyed()) sender.send('playback:frame', viewHandle, frame);
            } catch {
              // ignore — window is gone or going away, frame is dropped
            }
          }

          const { changed, healthy } = checkVideoHealth(viewHandle, frame.data, frame.width, frame.height);
          if (changed) {
            try {
              if (!sender.isDestroyed()) sender.send('playback:videoHealth', viewHandle, healthy);
            } catch {
              // ignore — same disposable-frame reasoning as above
            }
          }
        },
      ));
      return viewHandle;
    },
  );

  ipcMain.handle(
    'playback:control',
    async (_event, deviceId: string, viewHandle: string, command: PlaybackCommand, value?: number) => {
      assertNotQuitting();
      const connection = await ensureConnected(deviceId);
      if (!connection) return;
      const adapter = getAdapter(connection.vendor);
      if (!adapter.controlPlayback) throw new Error(`Playback isn't supported for ${connection.vendor} yet`);
      await tracked(adapter.controlPlayback(viewHandle, command, value));
    },
  );

  ipcMain.handle('playback:getTime', async (_event, deviceId: string, viewHandle: string): Promise<number> => {
    assertNotQuitting();
    const connection = await ensureConnected(deviceId);
    if (!connection) return 0;
    const adapter = getAdapter(connection.vendor);
    if (!adapter.getPlaybackTime) return 0;
    return tracked(adapter.getPlaybackTime(viewHandle));
  });

  ipcMain.handle('playback:stop', async (_event, deviceId: string, viewHandle: string) => {
    clearVideoHealth(viewHandle);
    forgetFrameHandle(viewHandle);
    // Deliberately NOT assertNotQuitting-guarded — stop is exactly what
    // should still run (best-effort) even while quitting, tearing down a
    // still-open session rather than leaving it dangling. disconnectAll's
    // own logout() calls are separately awaited already; this one just
    // covers a playback-specific handle.
    const connection = await ensureConnected(deviceId);
    if (!connection) return;
    const adapter = getAdapter(connection.vendor);
    if (adapter.stopPlayback) await tracked(adapter.stopPlayback(viewHandle));
  });

  // See VmsAdapter.setFrameDelivery's doc comment — pauses/resumes a
  // session's frame delivery without touching the underlying stream, for
  // a tile that's gone off-screen (hidden behind an expanded tile, or the
  // Playback tab isn't the active one).
  ipcMain.handle('playback:setFrameDelivery', async (_event, deviceId: string, viewHandle: string, enabled: boolean) => {
    assertNotQuitting();
    const connection = await ensureConnected(deviceId);
    if (!connection) return;
    const promise = getAdapter(connection.vendor).setFrameDelivery?.(viewHandle, enabled);
    if (promise) await tracked(promise);
  });

  // Split into two steps (choose destination, then explicitly start) rather
  // than one combined call — the export popup shows the chosen path and a
  // separate "Download" button the user clicks to actually kick off the
  // transfer, instead of the Save dialog itself silently starting it.
  ipcMain.handle(
    'playback:chooseExportPath',
    async (_event, deviceId: string, channel: number, startMs: number, endMs: number): Promise<string | null> => {
      // The Save dialog itself is the user's explicit confirmation of the
      // destination — no separate chat confirmation needed, same as any
      // other app's "Save As" action. Actually starting the transfer is a
      // separate, later step (playback:startBackup) triggered by its own
      // explicit "Download" button.
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Export Recording',
        defaultPath: defaultExportFileName(deviceId, channel, startMs, endMs),
        filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
      });
      return canceled || !filePath ? null : filePath;
    },
  );

  // Prefills the export popup's destination from Settings' Export Path
  // (Video tab) so the user isn't forced to browse every single time —
  // "Change Destination…" (playback:chooseExportPath above) still opens a
  // real Save dialog if they want somewhere else for this one clip. Null
  // when no export path is configured, same as the user canceling the Save
  // dialog — the popup's existing "no path yet" state already handles that.
  ipcMain.handle(
    'playback:getDefaultExportPath',
    (_event, deviceId: string, channel: number, startMs: number, endMs: number): string | null => {
      const { exportPath } = readSettings();
      if (!exportPath) return null;
      return join(exportPath, defaultExportFileName(deviceId, channel, startMs, endMs));
    },
  );

  // Reveals the exported file in the OS's file explorer (Windows Explorer)
  // — the "Open" action in the Downloads popup.
  ipcMain.handle('playback:openExportLocation', (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle(
    'playback:startBackup',
    async (
      _event,
      deviceId: string,
      channel: number,
      startMs: number,
      endMs: number,
      filePath: string,
    ): Promise<string> => {
      assertNotQuitting();
      const connection = await ensureConnected(deviceId);
      if (!connection) throw new Error(`Unable to connect to device: ${deviceId}`);
      const adapter = getAdapter(connection.vendor);
      // Just the "kick off the export" call itself, not the whole transfer
      // — progress is polled separately (getBackupProgress) and the export
      // intentionally keeps running in the background after this resolves,
      // so tracking this specifically (not the export's full duration) is
      // what keeps quit from hanging (clipExporter.stopAllExports, wired
      // into index.ts's before-quit, is what actually tears down an export
      // still running at quit time).
      return tracked(clipExporter.startExport(channel, startMs, endMs, filePath, adapter, connection.sessionId));
    },
  );

  ipcMain.handle(
    'playback:getBackupProgress',
    async (_event, _deviceId: string, downloadHandle: string): Promise<number> => {
      assertNotQuitting();
      return clipExporter.getExportProgress(downloadHandle);
    },
  );

  // Deliberately NOT assertNotQuitting-guarded — same "stop should still
  // run during quit" reasoning as playback:stop above, so an in-progress
  // export's ffmpeg process and native playback session get torn down
  // cleanly instead of orphaned.
  ipcMain.handle('playback:stopBackup', async (_event, _deviceId: string, downloadHandle: string) => {
    await tracked(clipExporter.stopExport(downloadHandle));
  });

  // Same "stop should still work during quit" reasoning as stopBackup —
  // pausing only tears down the native session, so it's just as safe to
  // let run unguarded.
  ipcMain.handle('playback:pauseBackup', async (_event, _deviceId: string, downloadHandle: string) => {
    await tracked(clipExporter.pauseExport(downloadHandle));
  });

  // Guarded (unlike pause/stop above) since resuming opens a brand new
  // native playback session — exactly the kind of new work assertNotQuitting
  // exists to block once shutdown is underway.
  ipcMain.handle('playback:resumeBackup', async (_event, _deviceId: string, downloadHandle: string) => {
    assertNotQuitting();
    await tracked(clipExporter.resumeExport(downloadHandle));
  });

  // Kept as a final trust-but-verify check even now that export goes
  // through clipExporter.ts's own ffmpeg pipeline rather than a vendor's
  // native "backup" SDK call (the original reason this existed: TVT's
  // native download could report "100% done" for a transfer that had
  // actually failed, silently producing a 0-byte file). Checked here once,
  // when the renderer's poll first sees progress reach 100%, rather than
  // trusting the progress signal alone.
  ipcMain.handle('playback:verifyExportedFile', (_event, filePath: string): { ok: boolean; size: number } => {
    try {
      const stat = statSync(filePath);
      return { ok: stat.size > 0, size: stat.size };
    } catch {
      return { ok: false, size: 0 };
    }
  });

  // Playback tile's own right-click "Snapshot" — same "just write the
  // already-painted canvas" job as liveView:saveSnapshot, to the same
  // Settings' Snapshot Path (one shared destination for snapshots
  // regardless of which tab they were taken from).
  ipcMain.handle(
    'playback:saveSnapshot',
    (_event, deviceName: string, channel: number, data: ArrayBuffer): MediaSaveResult =>
      saveMediaFile(readSettings().snapshotPath, deviceName, channel, 'png', Buffer.from(data)),
  );
}
