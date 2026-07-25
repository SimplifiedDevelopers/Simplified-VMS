import { join } from 'path';
import { app, BrowserWindow, shell } from 'electron';
import { registerAuthIpcHandlers } from './ipc/auth';
import { registerDeviceIpcHandlers } from './ipc/devices';
import { registerLiveViewIpcHandlers } from './ipc/liveView';
import { registerPrefsIpcHandlers } from './ipc/prefs';
import { registerSettingsIpcHandlers } from './ipc/settings';
import { registerSystemIpcHandlers } from './ipc/system';
import { connectAll, disconnectAll, onStatusChange, startHeartbeat } from './services/connectionManager';
import { startStatsBroadcast } from './services/systemStats';
import { readSettings } from './store/settingsStore';

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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0e13',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  registerLiveViewIpcHandlers(() => mainWindow!.webContents);
}

app.whenReady().then(() => {
  registerAuthIpcHandlers();
  registerDeviceIpcHandlers();
  registerPrefsIpcHandlers();
  registerSettingsIpcHandlers();
  registerSystemIpcHandlers();
  createWindow();

  // Every configured DVR/NVR connects once here and stays connected for the
  // app's whole lifetime — matches how every other VMS the team has used
  // behaves, and fixes a real complaint: Device Management and Live View
  // previously only ever logged in on demand, so switching between pages
  // (or even just re-opening Device Management) meant reconnecting to every
  // device from scratch each time.
  connectAll();
  startHeartbeat();
  onStatusChange((deviceId, status) => {
    mainWindow?.webContents.send('devices:statusChanged', deviceId, status);
  });
  startStatsBroadcast((stats) => {
    mainWindow?.webContents.send('system:stats', stats);
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
  disconnectAll().finally(() => app.quit());
});
