import { dialog, ipcMain } from 'electron';
import { readSettings, writeSettings } from '../store/settingsStore';
import type { AppSettings } from '../../shared/types';

export function registerSettingsIpcHandlers(): void {
  ipcMain.handle('settings:get', (): AppSettings => readSettings());
  ipcMain.handle('settings:set', (_event, partial: Partial<AppSettings>): AppSettings => writeSettings(partial));

  // The Video settings tab's "Browse" button for Snapshot Path — folder
  // picker only, resolves to null if the user cancels.
  ipcMain.handle('settings:chooseSnapshotFolder', async (): Promise<string | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose Snapshot Folder',
      properties: ['openDirectory'],
    });
    return canceled || filePaths.length === 0 ? null : filePaths[0];
  });

  // Same shape, for Playback's clip-export default folder.
  ipcMain.handle('settings:chooseExportFolder', async (): Promise<string | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose Export Folder',
      properties: ['openDirectory'],
    });
    return canceled || filePaths.length === 0 ? null : filePaths[0];
  });

  // Same shape, for the Start Local Recording tile action's default folder.
  ipcMain.handle('settings:chooseLocalRecordingFolder', async (): Promise<string | null> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Choose Local Recording Folder',
      properties: ['openDirectory'],
    });
    return canceled || filePaths.length === 0 ? null : filePaths[0];
  });
}
