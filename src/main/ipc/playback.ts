import { join } from 'path';
import { dialog, ipcMain, shell } from 'electron';
import { getAdapter } from '../adapters/registry';
import { ensureConnected } from '../services/connectionManager';
import * as recordingCalendarCache from '../services/recordingCalendarCache';
import { checkVideoHealth, clearVideoHealth } from '../services/videoHealthCheck';
import { listDevices } from '../store/deviceStore';
import { readSettings } from '../store/settingsStore';
import { forgetFrameHandle, shouldSendFrame } from '../services/frameBackpressure';
import type { DecodedFrame, PlaybackCommand, RecordingSearchFilter, RecordingSegment } from '../../shared/types';

function defaultExportFileName(deviceId: string, channel: number, startMs: number): string {
  const device = listDevices().find((d) => d.id === deviceId);
  const deviceName = (device?.name ?? deviceId).replace(/[\\/:*?"<>|]/g, '_');
  return `${deviceName}_ch${channel}_${new Date(startMs).toISOString().replace(/[:.]/g, '-')}.mp4`;
}

// Mirrors main/ipc/liveView.ts closely — same "resolve the persistent
// session, then talk to the adapter" shape, same disposable-frame try/catch
// around the push. The main difference is that playback/backup are
// optional VmsAdapter methods (see the interface's own doc comment) since
// only Uniview has them implemented so far — every handler here throws a
// clear "not supported for this vendor yet" error instead of a raw
// "adapter.xyz is not a function" when called for Hikvision/Dahua/TVT.
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
      if (!quick) return adapter.findRecordings(connection.sessionId, channel, startMs, endMs, filters, quick);
      return recordingCalendarCache.getOrFetch(deviceId, channel, startMs, endMs, filters, () =>
        adapter.findRecordings!(connection.sessionId, channel, startMs, endMs, filters, quick),
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

      const connection = await ensureConnected(deviceId);
      if (!connection) throw new Error(`Unable to connect to device: ${deviceId}`);
      const adapter = getAdapter(connection.vendor);
      if (!adapter.startPlayback) throw new Error(`Playback isn't supported for ${connection.vendor} yet`);
      const viewHandle = await adapter.startPlayback(
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
      );
      return viewHandle;
    },
  );

  ipcMain.handle(
    'playback:control',
    async (_event, deviceId: string, viewHandle: string, command: PlaybackCommand, value?: number) => {
      const connection = await ensureConnected(deviceId);
      if (!connection) return;
      const adapter = getAdapter(connection.vendor);
      if (!adapter.controlPlayback) throw new Error(`Playback isn't supported for ${connection.vendor} yet`);
      await adapter.controlPlayback(viewHandle, command, value);
    },
  );

  ipcMain.handle('playback:getTime', async (_event, deviceId: string, viewHandle: string): Promise<number> => {
    const connection = await ensureConnected(deviceId);
    if (!connection) return 0;
    const adapter = getAdapter(connection.vendor);
    if (!adapter.getPlaybackTime) return 0;
    return adapter.getPlaybackTime(viewHandle);
  });

  ipcMain.handle('playback:stop', async (_event, deviceId: string, viewHandle: string) => {
    clearVideoHealth(viewHandle);
    forgetFrameHandle(viewHandle);
    const connection = await ensureConnected(deviceId);
    if (!connection) return;
    const adapter = getAdapter(connection.vendor);
    if (adapter.stopPlayback) await adapter.stopPlayback(viewHandle);
  });

  // See VmsAdapter.setFrameDelivery's doc comment — pauses/resumes a
  // session's frame delivery without touching the underlying stream, for
  // a tile that's gone off-screen (hidden behind an expanded tile, or the
  // Playback tab isn't the active one).
  ipcMain.handle('playback:setFrameDelivery', async (_event, deviceId: string, viewHandle: string, enabled: boolean) => {
    const connection = await ensureConnected(deviceId);
    if (!connection) return;
    await getAdapter(connection.vendor).setFrameDelivery?.(viewHandle, enabled);
  });

  // Split into two steps (choose destination, then explicitly start) rather
  // than one combined call — the export popup shows the chosen path and a
  // separate "Download" button the user clicks to actually kick off the
  // transfer, instead of the Save dialog itself silently starting it.
  ipcMain.handle(
    'playback:chooseExportPath',
    async (_event, deviceId: string, channel: number, startMs: number): Promise<string | null> => {
      // The Save dialog itself is the user's explicit confirmation of the
      // destination — no separate chat confirmation needed, same as any
      // other app's "Save As" action. Actually starting the transfer is a
      // separate, later step (playback:startBackup) triggered by its own
      // explicit "Download" button.
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Export Recording',
        defaultPath: defaultExportFileName(deviceId, channel, startMs),
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
    (_event, deviceId: string, channel: number, startMs: number): string | null => {
      const { exportPath } = readSettings();
      if (!exportPath) return null;
      return join(exportPath, defaultExportFileName(deviceId, channel, startMs));
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
      const connection = await ensureConnected(deviceId);
      if (!connection) throw new Error(`Unable to connect to device: ${deviceId}`);
      const adapter = getAdapter(connection.vendor);
      if (!adapter.startBackup) throw new Error(`Export isn't supported for ${connection.vendor} yet`);
      return adapter.startBackup(connection.sessionId, channel, startMs, endMs, filePath);
    },
  );

  ipcMain.handle(
    'playback:getBackupProgress',
    async (_event, deviceId: string, downloadHandle: string): Promise<number> => {
      const connection = await ensureConnected(deviceId);
      if (!connection) return 100;
      const adapter = getAdapter(connection.vendor);
      if (!adapter.getBackupProgress) return 100;
      return adapter.getBackupProgress(downloadHandle);
    },
  );

  ipcMain.handle('playback:stopBackup', async (_event, deviceId: string, downloadHandle: string) => {
    const connection = await ensureConnected(deviceId);
    if (!connection) return;
    const adapter = getAdapter(connection.vendor);
    if (adapter.stopBackup) await adapter.stopBackup(downloadHandle);
  });
}
