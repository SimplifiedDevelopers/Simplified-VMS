import { ipcMain } from 'electron';
import { createAdminAccount, hasAdminAccount, verifyLogin } from '../store/authStore';
import type { AuthStatus } from '../../shared/types';

export function registerAuthIpcHandlers(): void {
  ipcMain.handle('auth:status', (): AuthStatus => ({ hasAdminAccount: hasAdminAccount() }));

  ipcMain.handle('auth:createAdmin', (_event, username: string, password: string) => {
    if (hasAdminAccount()) throw new Error('Admin account already exists');
    createAdminAccount(username, password);
  });

  ipcMain.handle('auth:login', (_event, username: string, password: string): boolean => {
    return verifyLogin(username, password);
  });
}
