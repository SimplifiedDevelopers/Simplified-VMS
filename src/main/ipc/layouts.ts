import { ipcMain } from 'electron';
import { deleteLayout, listLayouts, saveLayout } from '../store/layoutStore';
import type { CustomLayout, CustomLayoutTile } from '../../shared/types';

export function registerLayoutIpcHandlers(): void {
  ipcMain.handle('layouts:list', (): CustomLayout[] => listLayouts());

  ipcMain.handle('layouts:save', (_event, name: string, layout: number, tiles: CustomLayoutTile[]): CustomLayout =>
    saveLayout(name, layout, tiles),
  );

  ipcMain.handle('layouts:delete', (_event, id: string): void => deleteLayout(id));
}
