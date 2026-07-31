import { ipcMain } from 'electron';
import { getAdapter } from '../adapters/registry';
import { listDevices } from '../store/deviceStore';
import { ensureConnected } from '../services/connectionManager';
import { checkVideoHealth, clearVideoHealth } from '../services/videoHealthCheck';
import { forgetFrameHandle, shouldSendFrame } from '../services/frameBackpressure';
import { getLastLiveViewState, saveLastLiveViewState } from '../store/lastLiveViewStateStore';
import type { ChannelInfo, DecodedFrame, LastLiveViewState, StreamType } from '../../shared/types';

// "Start App" (AppSettings.restoreLiveViewOnStart) should only ever restore
// once per app launch - if the user later closes and manually reopens the
// Live View tab mid-session, it shouldn't silently repopulate with stale
// startup data. Rather than thread a one-shot flag through the renderer
// (AppShell/LiveView prop timing across tab open/close/remount), the
// simplest correct place to enforce "only the very first caller in this
// process gets the real data" is right here - this module-level flag
// naturally resets on every fresh app launch, matching the setting's own
// intent exactly.
let startupRestoreConsumed = false;

export function registerLiveViewIpcHandlers(): void {
  ipcMain.handle('liveView:getChannels', async (_event, deviceId: string): Promise<ChannelInfo[]> => {
    // Real VMS software treats a device's channel list as saved data, not
    // something to re-fetch on every click — it's set once (at add time,
    // see devices:add) and only touches the device again if it was never
    // successfully learned yet. Confirmed as a real pain point live:
    // switching devices in the Live View sidebar was visibly slow because
    // every expand triggered a fresh login just to list channels.
    const stored = listDevices().find((d) => d.id === deviceId);
    if (stored && stored.channels.length > 0) {
      return stored.channels;
    }
    const connection = await ensureConnected(deviceId);
    if (!connection) throw new Error(`Unable to connect to device: ${deviceId}`);
    return connection.channels;
  });

  ipcMain.handle(
    'liveView:start',
    async (event, deviceId: string, channel: number, streamType: StreamType) => {
      // Frames for this session must go back to whichever window actually
      // requested it — captured once here rather than resolved fresh on
      // every frame, since a popped-out tab's own window (see
      // main/ipc/windows.ts) is a different webContents than the main
      // window's, and each only wants its own streams' frames.
      const sender = event.sender;

      // In steady state the app is already connected to every saved device
      // (see connectionManager.connectAll(), run once at startup) — this
      // only actually performs a fresh login the first time a brand new
      // device is used before the background connect sweep reaches it.
      const connection = await ensureConnected(deviceId);
      if (!connection) throw new Error(`Unable to connect to device: ${deviceId}`);
      const adapter = getAdapter(connection.vendor);
      const viewHandle = await adapter.startLiveView(connection.sessionId, channel, streamType, (frame: DecodedFrame) => {
        // This callback is invoked directly from a native decode thread via
        // a ThreadSafeFunction — if it throws, Node reports it as an
        // "Uncaught N-API callback exception" instead of a normal JS error,
        // and floods the console with one per frame. A destroyed/closing
        // webContents (window being closed while a stream is still
        // delivering frames — a real race, not a bug in the stream itself)
        // is exactly the kind of thing that throws here; a live video
        // frame is disposable by nature, so dropping one on a send failure
        // is completely fine — there's nothing to recover or retry.
        if (shouldSendFrame(viewHandle)) {
          try {
            if (!sender.isDestroyed()) sender.send('liveView:frame', viewHandle, frame);
          } catch {
            // ignore — window is gone or going away, frame is dropped
          }
        }

        const { changed, healthy } = checkVideoHealth(viewHandle, frame.data, frame.width, frame.height);
        if (changed) {
          try {
            if (!sender.isDestroyed()) sender.send('liveView:videoHealth', viewHandle, healthy);
          } catch {
            // ignore — same disposable-frame reasoning as above
          }
        }
      });
      return viewHandle;
    },
  );

  ipcMain.handle('liveView:stop', async (_event, deviceId: string, viewHandle: string) => {
    clearVideoHealth(viewHandle);
    forgetFrameHandle(viewHandle);
    const connection = await ensureConnected(deviceId);
    if (!connection) return;
    await getAdapter(connection.vendor).stopLiveView(viewHandle);
  });

  // See VmsAdapter.setFrameDelivery's doc comment — pauses/resumes a
  // session's frame delivery without touching the underlying stream, for
  // a tile that's gone off-screen (hidden behind an expanded tile, or the
  // Live View tab isn't the active one).
  ipcMain.handle('liveView:setFrameDelivery', async (_event, deviceId: string, viewHandle: string, enabled: boolean) => {
    const connection = await ensureConnected(deviceId);
    if (!connection) return;
    await getAdapter(connection.vendor).setFrameDelivery?.(viewHandle, enabled);
  });

  // Fire-and-forget from the renderer whenever tiles/layout change
  // (debounced there) - always saves, regardless of whether "Start App" is
  // even on, so a freshly-enabled setting already has a reasonably current
  // snapshot to restore instead of nothing.
  ipcMain.handle('liveView:saveLastSessionState', (_event, state: LastLiveViewState): void => {
    saveLastLiveViewState(state);
  });

  // One-shot per app process - see startupRestoreConsumed's doc comment
  // above. Only the very first caller (LiveView's own mount effect, right
  // after AppShell auto-opens the tab on the first login of a fresh
  // launch) gets the real saved state; every later call in this same
  // process returns null.
  ipcMain.handle('liveView:consumeStartupRestoreState', (): LastLiveViewState | null => {
    if (startupRestoreConsumed) return null;
    startupRestoreConsumed = true;
    return getLastLiveViewState();
  });
}
