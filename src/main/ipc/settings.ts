import { ipcMain } from 'electron';
import { readSettings, writeSettings } from '../store/settingsStore';
import type { AppSettings } from '../../shared/types';

export function registerSettingsIpcHandlers(): void {
  ipcMain.handle('settings:get', (): AppSettings => readSettings());
  ipcMain.handle('settings:set', (_event, partial: Partial<AppSettings>): AppSettings => writeSettings(partial));
}
