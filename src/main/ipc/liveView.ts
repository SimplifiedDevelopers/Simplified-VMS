import { ipcMain, type WebContents } from 'electron';
import { getAdapter } from '../adapters/registry';
import { listDevices } from '../store/deviceStore';
import { ensureConnected, type ConnectionEntry } from '../services/connectionManager';
import type { ChannelInfo, DecodedFrame, StreamType } from '../../shared/types';

function channelsFromConnection(connection: ConnectionEntry): ChannelInfo[] {
  return connection.channels.map((channel) => ({ channel, label: `Channel ${channel}` }));
}

export function registerLiveViewIpcHandlers(getSender: () => WebContents): void {
  ipcMain.handle('liveView:getChannels', async (_event, deviceId: string): Promise<ChannelInfo[]> => {
    // Real VMS software treats a device's channel list as saved data, not
    // something to re-fetch on every click — it's set once (at add time,
    // see devices:add) and only touches the device again if it was never
    // successfully learned yet. Confirmed as a real pain point live:
    // switching devices in the Live View sidebar was visibly slow because
    // every expand triggered a fresh login just to list channels.
    const stored = listDevices().find((d) => d.id === deviceId);
    if (stored && stored.channels.length > 0) {
      return stored.channels.map((channel) => ({ channel, label: `Channel ${channel}` }));
    }
    const connection = await ensureConnected(deviceId);
    if (!connection) throw new Error(`Unable to connect to device: ${deviceId}`);
    return channelsFromConnection(connection);
  });

  ipcMain.handle(
    'liveView:start',
    async (_event, deviceId: string, channel: number, streamType: StreamType) => {
      // In steady state the app is already connected to every saved device
      // (see connectionManager.connectAll(), run once at startup) — this
      // only actually performs a fresh login the first time a brand new
      // device is used before the background connect sweep reaches it.
      const connection = await ensureConnected(deviceId);
      if (!connection) throw new Error(`Unable to connect to device: ${deviceId}`);
      const adapter = getAdapter(connection.vendor);
      const viewHandle = await adapter.startLiveView(connection.sessionId, channel, streamType, (frame: DecodedFrame) => {
        getSender().send('liveView:frame', viewHandle, frame);
      });
      return viewHandle;
    },
  );

  ipcMain.handle('liveView:stop', async (_event, deviceId: string, viewHandle: string) => {
    const connection = await ensureConnected(deviceId);
    if (!connection) return;
    await getAdapter(connection.vendor).stopLiveView(viewHandle);
  });
}
