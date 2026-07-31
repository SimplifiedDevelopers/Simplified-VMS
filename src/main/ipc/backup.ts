import { readFileSync, writeFileSync } from 'fs';
import { dialog, ipcMain } from 'electron';
import { readSettings, writeSettings } from '../store/settingsStore';
import { listDevicesWithPasswords, restoreDevices, importDevices, type DeviceBackupRecord } from '../store/deviceStore';
import { getAdminAccountRaw, restoreAdminAccount, type AuthFile } from '../store/authStore';
import { getSavedLogin, saveLogin, clearSavedLogin } from '../store/prefsStore';
import { listLayouts, restoreLayouts } from '../store/layoutStore';
import type { AppSettings, BackupResult, CustomLayout, SavedLogin } from '../../shared/types';

interface BackupFile {
  version: 1;
  exportedAt: string;
  settings: AppSettings;
  devices: DeviceBackupRecord[];
  adminAccount: AuthFile | null;
  savedLogin: SavedLogin | null;
  layouts: CustomLayout[];
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function errorResult(err: unknown): BackupResult {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

// Backup/Restore Configuration and Export/Import Devices List (Settings'
// Others tab). Device and saved-login passwords are stored encrypted via
// safeStorage, which is tied to this machine's own Windows user account
// (DPAPI) — useless on a different install. Both backup and export
// deliberately embed the real, plaintext passwords instead, so a backup
// file is actually restorable on a different machine (the whole point of
// handing this to another install) — which makes these files sensitive;
// the renderer surfaces a clear warning next to both buttons.
export function registerBackupIpcHandlers(): void {
  ipcMain.handle('backup:exportConfig', async (): Promise<BackupResult> => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Backup Configuration',
      defaultPath: `simplified-vms-backup-${timestampForFilename()}.json`,
      filters: [{ name: 'Simplified VMS Backup', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false };
    try {
      const data: BackupFile = {
        version: 1,
        exportedAt: new Date().toISOString(),
        settings: readSettings(),
        devices: listDevicesWithPasswords(),
        adminAccount: getAdminAccountRaw(),
        savedLogin: getSavedLogin(),
        layouts: listLayouts(),
      };
      writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      return { ok: true };
    } catch (err) {
      return errorResult(err);
    }
  });

  // Replaces the entire current installation's config wholesale — the
  // renderer prompts for an app restart afterward (in-memory state like
  // active device connections would otherwise be stale against what's now
  // on disk).
  ipcMain.handle('backup:importConfig', async (): Promise<BackupResult> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Restore Configuration',
      filters: [{ name: 'Simplified VMS Backup', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return { ok: false };
    try {
      const data = JSON.parse(readFileSync(filePaths[0], 'utf-8')) as BackupFile;
      writeSettings(data.settings);
      restoreDevices(data.devices);
      if (data.adminAccount) restoreAdminAccount(data.adminAccount);
      if (data.savedLogin) saveLogin(data.savedLogin.username, data.savedLogin.password, data.savedLogin.autoLogin);
      else clearSavedLogin();
      restoreLayouts(data.layouts);
      return { ok: true };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('backup:exportDevices', async (): Promise<BackupResult> => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Export Devices List',
      defaultPath: `devices-export-${timestampForFilename()}.json`,
      filters: [{ name: 'Device List', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false };
    try {
      writeFileSync(filePath, JSON.stringify(listDevicesWithPasswords(), null, 2), 'utf-8');
      return { ok: true };
    } catch (err) {
      return errorResult(err);
    }
  });

  // Merges into whatever's already saved (fresh ids per device) rather than
  // replacing anything — distinct from backup:importConfig's full restore.
  // Only imports our own export format now — real vendor device-list import
  // (iVMS-4200/SmartPSS/Guard Station) was removed per explicit user
  // decision: internal-office-only usage, staff can just add devices as
  // they go, not worth the ongoing maintenance to keep those parsers
  // correct against vendor export format changes for that little use.
  ipcMain.handle('backup:importDevices', async (): Promise<BackupResult> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Import Devices List',
      filters: [{ name: 'Device List (Simplified VMS)', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || filePaths.length === 0) return { ok: false };
    try {
      const records = JSON.parse(readFileSync(filePaths[0], 'utf-8')) as DeviceBackupRecord[];
      const imported = importDevices(records);
      return { ok: true, count: imported.length };
    } catch (err) {
      return errorResult(err);
    }
  });
}
