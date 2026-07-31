import { join } from 'path';
import { BrowserWindow, ipcMain } from 'electron';
import type { PopoutTabKind } from '../../shared/types';

const POPOUT_TITLES: Record<PopoutTabKind, string> = {
  liveView: 'Live View',
  playback: 'Playback',
  deviceManagement: 'Device Management',
};

// Spawns a standalone window for a tab dragged out of the main window's tab
// strip (see AppShell.tsx's onDragEnd). Frameless, same as the main window
// — the native OS title bar looked out of place next to the app's own dark
// chrome (confirmed live: "gets a white header from windows"), so
// PopoutWindow.tsx draws its own slim version of AppShell's header instead,
// backed by the same window-control IPC (system:minimizeWindow etc., now
// resolved per-calling-window rather than fixed to the main window).
export function registerWindowIpcHandlers(): void {
  ipcMain.handle('windows:popOutTab', (_event, kind: PopoutTabKind, screenX: number, screenY: number): void => {
    const width = 1100;
    const height = 720;
    const popout = new BrowserWindow({
      width,
      height,
      minWidth: 640,
      minHeight: 480,
      x: Math.round(screenX - width / 2),
      y: Math.round(screenY - 40),
      show: false,
      frame: false,
      backgroundColor: '#0a0e13',
      title: `${POPOUT_TITLES[kind]} — Simplified VMS`,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
      },
    });

    popout.once('ready-to-show', () => popout.show());

    // Own window's maximize state, pushed only to itself — distinct from
    // the main window's equivalent listeners in main/index.ts, since each
    // window's maximize/restore button only ever cares about itself.
    popout.on('maximize', () => popout.webContents.send('system:windowMaximizedChanged', true));
    popout.on('unmaximize', () => popout.webContents.send('system:windowMaximizedChanged', false));

    const hash = `popout=${kind}`;
    if (process.env.ELECTRON_RENDERER_URL) {
      popout.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
    } else {
      popout.loadFile(join(__dirname, '../renderer/index.html'), { hash });
    }
  });
}
