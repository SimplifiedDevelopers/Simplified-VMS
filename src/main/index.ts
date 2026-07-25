import { join } from 'path';
import { app, BrowserWindow, shell } from 'electron';
import { registerAuthIpcHandlers } from './ipc/auth';
import { registerDeviceIpcHandlers } from './ipc/devices';
import { logoutAllSessions, registerLiveViewIpcHandlers } from './ipc/liveView';
import { registerPrefsIpcHandlers } from './ipc/prefs';

// This runs on a Windows Server VM over RDP with no real GPU — Chromium's
// GPU process was observed failing (GpuControl.CreateCommandBuffer errors).
// A struggling/retrying GPU process can starve the rest of the app of CPU,
// which is consistent with intermittent NET_DVR connect timeouts that never
// reproduce in a bare Node/Electron-as-Node process with no Chromium
// renderer at all.
app.disableHardwareAcceleration();

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
  createWindow();

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
  logoutAllSessions().finally(() => app.quit());
});
