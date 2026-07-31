import { ipcMain } from 'electron';
import { checkForUpdates, downloadUpdate, quitAndInstall } from '../services/updater';

export function registerUpdatesIpcHandlers(): void {
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:download', () => downloadUpdate());
  ipcMain.handle('updates:install', () => quitAndInstall());
}
