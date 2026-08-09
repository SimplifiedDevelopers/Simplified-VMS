import { join } from 'path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { configureGpuDecode } from './adapters/uniview';
import { registerAuthIpcHandlers } from './ipc/auth';
import { registerBackupIpcHandlers } from './ipc/backup';
import { registerDeviceIpcHandlers } from './ipc/devices';
import { registerLayoutIpcHandlers } from './ipc/layouts';
import { beginQuitting as beginQuittingLiveView, registerLiveViewIpcHandlers, waitForPendingLiveViewCalls } from './ipc/liveView';
import { beginQuitting as beginQuittingPlayback, registerPlaybackIpcHandlers, waitForPendingPlaybackCalls } from './ipc/playback';
import { registerPrefsIpcHandlers } from './ipc/prefs';
import { registerSettingsIpcHandlers } from './ipc/settings';
import { registerSystemIpcHandlers } from './ipc/system';
import { registerUpdatesIpcHandlers } from './ipc/updates';
import { registerWindowIpcHandlers } from './ipc/windows';
import { stopAllExports } from './services/clipExporter';
import { connectAll, disconnectAll, onStatusChange, startHeartbeat } from './services/connectionManager';
import { registerFrameAckHandler } from './services/frameBackpressure';
import { startStatsBroadcast, stopStatsBroadcast } from './services/systemStats';
import { startUpdateStatusBroadcast } from './services/updater';
import { ensureDefaultMediaFolders, onSettingsChange, readSettings } from './store/settingsStore';

// Must be set before libuv's threadpool is first used (it reads this once,
// lazily, on first use — safe to set here since no native SDK call happens
// before app.whenReady()). Default is 4, far too small for this app: every
// vendor SDK call (login/startLiveView/stopLiveView/etc, up to 64
// simultaneous channels across a full grid) runs as an AsyncWorker on this
// same shared pool, and — confirmed on real Uniview hardware — a native
// RealPlay call can hang indefinitely with no error and no way to cancel
// it. A handful of hangs piling up on a 4-thread pool starves every other
// pending native call app-wide, which looks exactly like the whole app
// freezing rather than just the one affected channel.
process.env.UV_THREADPOOL_SIZE = '64';

// disableHardwareAcceleration() must run before app.whenReady() and can't be
// toggled live, so this reads the persisted setting synchronously up front.
// Off by default only makes sense on underpowered/virtualized machines (this
// dev VPS is one — no real GPU, Chromium's GPU process was observed failing
// with GpuControl.CreateCommandBuffer errors); most client machines have a
// real GPU and benefit from it, hence defaulting to enabled.
if (!readSettings().hardwareAcceleration) {
  app.disableHardwareAcceleration();
}

let mainWindow: BrowserWindow | null = null;
// Set once the user has confirmed the close-confirmation dialog (see the
// mainWindow 'close' listener and system:confirmClose below) - lets that
// same close attempt through instead of prompting again.
let allowQuit = false;

// Background push notifications (window state, device status, CPU/memory
// stats) fire on their own timers/events independent of any renderer
// request — `mainWindow` was never nulled out when the window closed, so
// these kept trying to `.send()` on a destroyed webContents afterward and
// crashed the main process with an uncaught "Object has been destroyed"
// TypeError (confirmed live, from the stats broadcaster's 2s interval).
// A push notification is disposable by nature, so silently dropping one
// when the window is gone is completely fine — nothing to recover.
//
// Broadcasts to every open window (main + any popped-out tabs, see
// ipc/windows.ts) rather than just mainWindow, since a popped-out Device
// Management window still needs devices:statusChanged and a popped-out
// Live View window still needs system:stats.
function safeSend(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send(channel, ...args);
    } catch {
      // window is gone or going away, drop it
    }
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    // Frameless — the native OS title bar is replaced by AppShell's own
    // dark header, which draws its own minimize/maximize/close buttons and
    // is made draggable via CSS (-webkit-app-region) instead.
    frame: false,
    backgroundColor: '#0a0e13',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Own maximize state, pushed only to itself — a popped-out tab window
  // (see ipc/windows.ts) has the same listeners wired to itself, not this
  // one, since each window's maximize/restore button only cares about
  // itself, not the others.
  mainWindow.on('maximize', () => mainWindow?.webContents.send('system:windowMaximizedChanged', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('system:windowMaximizedChanged', false));

  // Confirmation gate for closing the whole program — covers both the
  // header's custom close button (system:closeWindow calls mainWindow.close(),
  // which fires this same native 'close' event) and the native OS/taskbar
  // close control, since both end up here. Popped-out tab windows (see
  // ipc/windows.ts) aren't gated the same way — closing just one of those
  // doesn't end the whole app, so it stays a plain, unprompted close.
  mainWindow.on('close', (event) => {
    if (allowQuit) return;
    event.preventDefault();
    mainWindow?.webContents.send('system:requestCloseConfirm');
  });

  function isBroadvoiceUrl(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      return hostname === 'broadvoice.com' || hostname.endsWith('.broadvoice.com');
    } catch {
      return false;
    }
  }

  // The Broadvoice chat widget (see index.html) always calls
  // window.open(url, '_pidj', ...) with the same fixed window name, relying
  // on the browser's own named-popup semantics (reuse/focus the existing
  // '_pidj' window while it's open, open a fresh one once it's closed).
  // Electron's setWindowOpenHandler doesn't reliably replicate that reuse
  // behavior once a window has already been created through it once —
  // confirmed live: after closing the chat popup, clicking the bubble again
  // did nothing. Tracking the window ourselves here (rather than trusting
  // Chromium's named-target bookkeeping across a setWindowOpenHandler
  // boundary) sidesteps that entirely.
  let chatWindow: BrowserWindow | null = null;

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Everything else that ever calls window.open() (arbitrary external
    // links elsewhere in the app) should still be kicked out to the user's
    // real browser — only Broadvoice's own domain stays inside the app as a
    // small popup window instead.
    if (!isBroadvoiceUrl(details.url)) {
      shell.openExternal(details.url);
      return { action: 'deny' };
    }
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.focus();
      return { action: 'deny' };
    }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 420,
        height: 640,
        title: 'Chat with SSM Support',
        autoHideMenuBar: true,
        webPreferences: { sandbox: true },
      },
    };
  });

  mainWindow.webContents.on('did-create-window', (childWindow, details) => {
    if (!isBroadvoiceUrl(details.url)) return;
    chatWindow = childWindow;
    childWindow.on('closed', () => {
      chatWindow = null;
    });
    // Broadvoice's chat page sets its own <title> ("Pidj", their internal
    // product name) once it loads, which would otherwise silently overwrite
    // the title set above — this keeps the popup's title bar reading "Chat
    // with SSM Support" instead of leaking the vendor's own branding.
    childWindow.on('page-title-updated', (event) => event.preventDefault());
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // Media/Snapshot, Media/Local Recording, Media/Video Backup next to the
  // installed app — see settingsStore.ts's doc comment for why this isn't
  // strictly required (each feature already creates its own target folder
  // on first save) but is still done proactively at startup.
  ensureDefaultMediaFolders();

  registerAuthIpcHandlers();
  registerBackupIpcHandlers();
  registerDeviceIpcHandlers();
  registerLayoutIpcHandlers();
  registerPrefsIpcHandlers();
  registerSettingsIpcHandlers();
  // Registered once here rather than per-window — none of these depend on
  // any particular window (see the per-caller event.sender routing in
  // liveView.ts/playback.ts/system.ts) — any window, main or popped-out,
  // can call these and only ever affects/gets frames back for itself.
  registerLiveViewIpcHandlers();
  registerPlaybackIpcHandlers();
  registerFrameAckHandler();
  registerSystemIpcHandlers();
  registerUpdatesIpcHandlers();
  registerWindowIpcHandlers();

  // Called once the user confirms the close-confirmation dialog (see the
  // mainWindow 'close' listener above) — app.quit() closes every open
  // window, main and popped-out alike, so no live view/playback keeps
  // running in a detached window after the program is closed.
  ipcMain.handle('system:confirmClose', (): void => {
    allowQuit = true;
    app.quit();
  });

  createWindow();

  // Uniview's own SDK-level decode acceleration (distinct from
  // hardwareAcceleration above, which is Chromium's rendering GPU) - set
  // once here, before any device connects, matching the same
  // "requires an app restart to change" pattern as hardwareAcceleration.
  configureGpuDecode(readSettings().univiewGpuDecode);

  // Every configured DVR/NVR connects once here and stays connected for the
  // app's whole lifetime — matches how every other VMS the team has used
  // behaves, and fixes a real complaint: Device Management and Live View
  // previously only ever logged in on demand, so switching between pages
  // (or even just re-opening Device Management) meant reconnecting to every
  // device from scratch each time. Off (autoConnectAllDevices) for a fleet
  // office adding 100+ devices for on-demand client-footage lookups, where
  // proactively logging into (and heartbeat-pinging) every single one just
  // sitting idle would be wasted overhead — devices still connect on demand
  // via ensureConnected() when actually opened, this only skips the bulk
  // pre-connect and its background keep-alive.
  if (readSettings().autoConnectAllDevices) {
    connectAll();
    startHeartbeat();
  }
  onStatusChange((deviceId, status) => {
    safeSend('devices:statusChanged', deviceId, status);
  });
  onSettingsChange((settings) => {
    safeSend('settings:changed', settings);
  });
  startStatsBroadcast((stats) => {
    safeSend('system:stats', stats);
  });
  startUpdateStatusBroadcast((status) => {
    safeSend('updates:status', status);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  stopStatsBroadcast();
  // beginQuitting() on both modules FIRST — stops any new native call from
  // even starting once shutdown is underway (the window stays alive for
  // the whole wait below, so without this a freshly-dispatched call could
  // still race past it) — then wait for whatever's already in flight (a
  // loop, not a one-shot snapshot, for the same reason) alongside
  // disconnectAll(). Confirmed live as a real crash otherwise: an
  // in-flight native call (findRecordings, playback/live view start/stop,
  // backup start, etc.) still running when quit proceeded anyway hit the
  // exact same "Error::ThrowAsJavaScriptException napi_throw" hard crash
  // disconnectAll's own inFlight/currentHeartbeatTick tracking exists to
  // prevent for logins.
  //
  // stopAllExports() covers a separate gap: a clip export can run for
  // minutes in the background (clipExporter.ts), well past whatever
  // pendingCalls/waitForPendingPlaybackCalls tracks (that's just the
  // initial dispatch, deliberately, so quit doesn't hang on an export's
  // full duration) — without this, quitting mid-export would leave its
  // ffmpeg.exe process and native playback session orphaned instead of
  // torn down. Racing alongside the others in the same allSettled (rather
  // than a separate await) still lets quit proceed as soon as everything
  // actually finishes, without an unbounded hang.
  //
  // Broadcast BEFORE beginQuitting*() below, not after - this is the
  // renderer's only signal that new calls are about to start being
  // rejected. Confirmed live: Playback's own 1-second getTime poll (and,
  // less often, the frame-delivery pause effect) kept firing for the
  // whole rest of this wait with no way to know quitting had started,
  // each one hitting assertNotQuitting's thrown "App is closing." and
  // logging an "Error occurred in handler" - pure noise, but real
  // overhead stacked on top of the wait this event exists to keep short.
  // Distinct from system:requestCloseConfirm, which fires BEFORE the user
  // confirms and could still be cancelled - this fires only once the
  // close is truly proceeding.
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('system:appQuitting');
  }
  beginQuittingPlayback();
  beginQuittingLiveView();
  Promise.allSettled([
    disconnectAll(),
    waitForPendingPlaybackCalls(),
    waitForPendingLiveViewCalls(),
    stopAllExports(),
  ]).finally(() => app.quit());
});
