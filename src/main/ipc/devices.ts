import { ipcMain } from 'electron';
import { addDevice, deleteDevice, listDevices, updateDevice } from '../store/deviceStore';
import type { NewDeviceInput, StoredDevice } from '../../shared/types';

export function registerDeviceIpcHandlers(): void {
  ipcMain.handle('devices:list', (): StoredDevice[] => listDevices());

  ipcMain.handle('devices:add', (_event, input: NewDeviceInput): StoredDevice => addDevice(input));

  ipcMain.handle('devices:update', (_event, id: string, input: NewDeviceInput): StoredDevice =>
    updateDevice(id, input),
  );

  ipcMain.handle('devices:delete', (_event, id: string): void => deleteDevice(id));
}
