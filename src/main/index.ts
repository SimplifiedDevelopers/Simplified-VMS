import { join } from 'path';
import { app, BrowserWindow, shell } from 'electron';
import { registerAuthIpcHandlers } from './ipc/auth';
import { registerDeviceIpcHandlers } from './ipc/devices';
import { registerLiveViewIpcHandlers } from './ipc/liveView';
import { registerPrefsIpcHandlers } from './ipc/prefs';

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
