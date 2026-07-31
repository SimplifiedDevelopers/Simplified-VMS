import { ipcMain } from 'electron';
import { clearSavedLogin, getSavedLogin, saveLogin } from '../store/prefsStore';
import type { SavedLogin } from '../../shared/types';

export function registerPrefsIpcHandlers(): void {
  ipcMain.handle('prefs:getSavedLogin', (): SavedLogin | null => getSavedLogin());

  ipcMain.handle(
    'prefs:saveLogin',
    (_event, username: string, password: string, autoLogin: boolean): void => saveLogin(username, password, autoLogin),
  );

  ipcMain.handle('prefs:clearSavedLogin', (): void => clearSavedLogin());
}
