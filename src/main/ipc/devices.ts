import { ipcMain } from 'electron';
import { addDevice, deleteDevice, getDeviceCredentials, listDevices, updateDevice } from '../store/deviceStore';
import { getAdapter } from '../adapters/registry';
import type { ConnectionTestResult, NewDeviceInput, StoredDevice, VendorId } from '../../shared/types';

interface Credentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

// Login + immediate logout — never touches the liveView session cache, so
// testing/checking a device doesn't interfere with (or get confused with)
// an actual live-view session against the same device.
async function testLogin(vendor: VendorId, credentials: Credentials): Promise<ConnectionTestResult> {
  try {
    const adapter = getAdapter(vendor);
    const session = await adapter.login(credentials);
    await adapter.logout(session.sessionId).catch(() => undefined);
    return { ok: true, channelCount: session.channels.length };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerDeviceIpcHandlers(): void {
  ipcMain.handle('devices:list', (): StoredDevice[] => listDevices());

  ipcMain.handle('devices:add', (_event, input: NewDeviceInput): StoredDevice => addDevice(input));

  ipcMain.handle('devices:update', (_event, id: string, input: NewDeviceInput): StoredDevice =>
    updateDevice(id, input),
  );

  ipcMain.handle('devices:delete', (_event, id: string): void => deleteDevice(id));

  ipcMain.handle('devices:testConnection', (_event, input: NewDeviceInput): Promise<ConnectionTestResult> =>
    testLogin(input.vendor, input),
  );

  ipcMain.handle('devices:checkStatus', (_event, id: string): Promise<ConnectionTestResult> => {
    const credentials = getDeviceCredentials(id);
    if (!credentials) return Promise.resolve({ ok: false, error: 'Device not found' });
    return testLogin(credentials.vendor, credentials);
  });
}
