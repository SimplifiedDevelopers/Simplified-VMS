import { ipcMain } from 'electron';
import { getAdapter } from '../adapters/registry';
import { listDevices } from '../store/deviceStore';
import { ensureConnected, reconnectDevice } from '../services/connectionManager';
import { checkVideoHealth, clearVideoHealth } from '../services/videoHealthCheck';
import { forgetFrameHandle, shouldSendFrame } from '../services/frameBackpressure';
import { getLastLiveViewState, saveLastLiveViewState } from '../store/lastLiveViewStateStore';
import { readSettings } from '../store/settingsStore';
import { saveMediaFile } from '../services/mediaSave';
import type { ChannelInfo, DecodedFrame, LastLiveViewState, MediaSaveResult, StreamType } from '../../shared/types';

// Tracks every native (AsyncWorker-backed) call this file dispatches, so
// app quit (main/index.ts's before-quit) can wait for all of them to
// genuinely finish first — same fix, same reasoning, and same confirmed
// crash class as ipc/playback.ts's own pendingCalls/tracked (see its doc
// comment): an in-flight native call still running when quit proceeds
// anyway hits a hard "Error::ThrowAsJavaScriptException napi_throw" crash
// once it finally tries to resolve into a JS context that's mid-teardown.
const pendingCalls = new Set<Promise<unknown>>();

// Set once app quit actually begins — see ipc/playback.ts's matching
// `quitting`/assertNotQuitting doc comment for the full reasoning (the
// window stays alive during the whole wait below, so this stops brand new
// native calls from starting rather than only ever growing the set to
// wait for).
let quitting = false;

export function beginQuitting(): void {
  quitting = true;
}

function assertNotQuitting(): void {
  if (quitting) throw new Error('App is closing.');
}

function tracked<T>(promise: Promise<T>): Promise<T> {
  pendingCalls.add(promise);
  const clear = (): void => {
    pendingCalls.delete(promise);
  };
  promise.then(clear, clear);
  return promise;
}

// Loops rather than a single snapshot — see ipc/playback.ts's matching
// waitForPendingPlaybackCalls doc comment for why a one-shot wait isn't
// enough (confirmed live as a real crash otherwise).
export async function waitForPendingLiveViewCalls(): Promise<void> {
  while (pendingCalls.size > 0) {
    await Promise.allSettled([...pendingCalls]);
  }
}

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

  // Confirmed live on a Uniview device: after its sub-stream playback
  // froze and the tile was closed, every subsequent startLiveView attempt
  // (main or sub) failed immediately with this exact error - the device
  // had dropped the login session out from under the app's still-cached
  // connection, and nothing detected that, so every retry kept reusing
  // the same dead session until the whole app was relaunched (a fresh
  // login on boot). NETDEV_E_USER_NOT_ONLINE=101200, straight from
  // NetDEVSDK.h - "Users are not online". Matched on the exact message the
  // native addon throws (see addon.cc's SetError calls) rather than a
  // parsed error code, since that's the only thing that crosses the N-API
  // boundary as a plain Error today.
  function isDeadUniviewSession(err: unknown): boolean {
    return err instanceof Error && err.message.includes('NETDEV error 101200');
  }

  ipcMain.handle(
    'liveView:start',
    async (event, deviceId: string, channel: number, streamType: StreamType) => {
      // Frames for this session must go back to whichever window actually
      // requested it — captured once here rather than resolved fresh on
      // every frame, since a popped-out tab's own window (see
      // main/ipc/windows.ts) is a different webContents than the main
      // window's, and each only wants its own streams' frames.
      const sender = event.sender;
      assertNotQuitting();

      function onFrame(viewHandle: string) {
        return (frame: DecodedFrame): void => {
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
        };
      }

      // In steady state the app is already connected to every saved device
      // (see connectionManager.connectAll(), run once at startup) — this
      // only actually performs a fresh login the first time a brand new
      // device is used before the background connect sweep reaches it.
      async function attempt(): Promise<string> {
        const connection = await ensureConnected(deviceId);
        if (!connection) throw new Error(`Unable to connect to device: ${deviceId}`);
        const adapter = getAdapter(connection.vendor);
        let viewHandle = '';
        viewHandle = await tracked(
          adapter.startLiveView(connection.sessionId, channel, streamType, (frame) => onFrame(viewHandle)(frame)),
        );
        return viewHandle;
      }

      try {
        return await attempt();
      } catch (err) {
        if (!isDeadUniviewSession(err)) throw err;
        await reconnectDevice(deviceId);
        return await attempt();
      }
    },
  );

  // Deliberately NOT assertNotQuitting-guarded — stop should still run
  // (best-effort) during quit, tearing down a still-open session rather
  // than leaving it dangling. See ipc/playback.ts's playback:stop for the
  // same reasoning.
  ipcMain.handle('liveView:stop', async (_event, deviceId: string, viewHandle: string) => {
    clearVideoHealth(viewHandle);
    forgetFrameHandle(viewHandle);
    const connection = await ensureConnected(deviceId);
    if (!connection) return;
    await tracked(getAdapter(connection.vendor).stopLiveView(viewHandle));
  });

  // See VmsAdapter.setFrameDelivery's doc comment — pauses/resumes a
  // session's frame delivery without touching the underlying stream, for
  // a tile that's gone off-screen (hidden behind an expanded tile, or the
  // Live View tab isn't the active one).
  ipcMain.handle('liveView:setFrameDelivery', async (_event, deviceId: string, viewHandle: string, enabled: boolean) => {
    assertNotQuitting();
    const connection = await ensureConnected(deviceId);
    if (!connection) return;
    const promise = getAdapter(connection.vendor).setFrameDelivery?.(viewHandle, enabled);
    if (promise) await tracked(promise);
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

  // Read-only, NOT one-shot - AppShell calls this on login to decide
  // whether "Start App" actually has anything worth auto-opening the Live
  // View tab for (it previously auto-navigated there unconditionally
  // whenever the setting was on, even if the saved grid was completely
  // empty). Deliberately doesn't touch startupRestoreConsumed - calling
  // this must not use up the one real consumeStartupRestoreState() read
  // LiveView's own mount effect still needs once the tab actually opens.
  ipcMain.handle('liveView:peekLastSessionState', (): LastLiveViewState | null => getLastLiveViewState());

  // Live View toolbar's Snapshot action - the renderer already grabbed the
  // tile's own <canvas> via toBlob(), so this is purely "write the bytes
  // to Settings' Snapshot Path".
  ipcMain.handle(
    'liveView:saveSnapshot',
    (_event, deviceName: string, channel: number, data: ArrayBuffer): MediaSaveResult =>
      saveMediaFile(readSettings().snapshotPath, deviceName, channel, 'png', Buffer.from(data)),
  );

  // Live View toolbar's Record action - the renderer records the tile's
  // <canvas> via MediaRecorder (canvas.captureStream()) client-side and
  // hands over the finished WebM blob on stop; same "just write it" job
  // as the snapshot handler above, to Settings' Local Recording Path.
  ipcMain.handle(
    'liveView:saveRecording',
    (_event, deviceName: string, channel: number, data: ArrayBuffer): MediaSaveResult =>
      saveMediaFile(readSettings().localRecordingPath, deviceName, channel, 'webm', Buffer.from(data)),
  );
}
