import { ipcMain } from 'electron';
import { addDevice, deleteDevice, listDevices, updateDevice } from '../store/deviceStore';
import { getAdapter } from '../adapters/registry';
import { forgetDevice, getConnection, getStatus, reconnectDevice } from '../services/connectionManager';
import type { ConnectionTestResult, NewDeviceInput, StoredDevice, VendorId } from '../../shared/types';

interface Credentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

// Login + immediate logout — used only for testing a device's credentials
// before it's saved (devices:testConnection, from the Add/Edit dialog's
// "Test Connection" button). The device isn't in the store yet at that
// point, so there's no persistent connection to manage.
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

  ipcMain.handle('devices:add', async (_event, input: NewDeviceInput): Promise<StoredDevice> => {
    const device = addDevice(input);
    // Joins the persistent connection pool immediately instead of waiting
    // for the next connectAll() sweep — connectionManager persists the
    // real channel list as a side effect of connecting.
    await reconnectDevice(device.id);
    const connection = getConnection(device.id);
    return connection ? { ...device, channels: connection.channels } : device;
  });

  ipcMain.handle('devices:update', async (_event, id: string, input: NewDeviceInput): Promise<StoredDevice> => {
    const device = updateDevice(id, input);
    // Credentials/host may have changed, so the old session (if any) is no
    // longer valid — reconnectDevice discards it and logs in fresh.
    await reconnectDevice(id);
    const connection = getConnection(id);
    return connection ? { ...device, channels: connection.channels } : device;
  });

  ipcMain.handle('devices:delete', (_event, id: string): void => {
    forgetDevice(id);
    deleteDevice(id);
  });

  ipcMain.handle('devices:testConnection', (_event, input: NewDeviceInput): Promise<ConnectionTestResult> =>
    testLogin(input.vendor, input),
  );

  // Returns the connection manager's current cached status instantly — no
  // network round-trip — since every saved device is already connected (or
  // being connected) in the background. Used for the initial render before
  // the push-based devices:statusChanged subscription takes over.
  ipcMain.handle('devices:getStatus', (_event, id: string) => getStatus(id));

  // The "Refresh Status" button's explicit re-check: forces a real
  // reconnect attempt right now rather than waiting for the next
  // background heartbeat tick.
  ipcMain.handle('devices:checkStatus', async (_event, id: string) => {
    await reconnectDevice(id);
    return getStatus(id);
  });
}
