import { ipcMain } from 'electron';
import { addDevice, deleteDevice, listDevices, renameDeviceChannel, updateDevice } from '../store/deviceStore';
import { getAdapter } from '../adapters/registry';
import { discoverUniviewDevices } from '../adapters/uniview';
import { discoverTvtDevices } from '../adapters/tvt';
import { discoverDahuaDevices } from '../adapters/dahua';
import { forgetDevice, getAllStatuses, getConnection, getStatus, reconnectDevice } from '../services/connectionManager';
import { discoverDevices } from '../services/discovery';
import { getArpTable } from '../services/macLookup';
import { discoverHikvisionDevices } from '../services/sadp';
import type { ChannelInfo, ConnectionTestResult, DiscoveredDevice, NewDeviceInput, StoredDevice, VendorId } from '../../shared/types';

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
    // Same substitution as deviceStore.ts's getDeviceCredentials — Uniview's
    // login always uses the HTTP port, never the Service Port field, and
    // this pre-save test should fail/succeed consistently with the real
    // connect that follows Save, not disagree with it.
    testLogin(input.vendor, { ...input, port: input.vendor === 'uniview' ? input.httpPort : input.port }),
  );

  // Live View sidebar's per-channel "Rename" - see deviceStore's
  // renameDeviceChannel doc comment for why this is local-only (no vendor
  // write support), not pushed to the device itself.
  ipcMain.handle('devices:renameChannel', (_event, id: string, channel: number, label: string): ChannelInfo[] | null =>
    renameDeviceChannel(id, channel, label),
  );

  // Returns the connection manager's current cached status instantly — no
  // network round-trip — since every saved device is already connected (or
  // being connected) in the background. Used for the initial render before
  // the push-based devices:statusChanged subscription takes over.
  ipcMain.handle('devices:getStatus', (_event, id: string) => getStatus(id));

  // Bulk form of the above — one IPC round trip for every device's status
  // instead of one per device. DeviceManagement/LiveView/Playback's
  // initial-render status fetch used to call devices:getStatus once per
  // device (50+ separate round trips and 50+ individual React state
  // updates/re-renders for a large fleet, found via a resource-usage
  // audit); this lets each page merge everything into one setState call.
  ipcMain.handle('devices:getAllStatuses', () => getAllStatuses());

  // The "Refresh Status" button's explicit re-check: forces a real
  // reconnect attempt right now rather than waiting for the next
  // background heartbeat tick.
  ipcMain.handle('devices:checkStatus', async (_event, id: string) => {
    await reconnectDevice(id);
    return getStatus(id);
  });

  // Broadcast-based discovery only — ONVIF WS-Discovery plus each vendor's
  // own broadcast discovery protocol: Uniview's NETDEV_Discovery, TVT's
  // NET_SDK_DiscoverDevice, Dahua's CLIENT_StartSearchDevices, and
  // Hikvision's SADP (services/sadp.ts — pure JS/UDP, no native addon,
  // since HCNetSDK's own NET_DVR_GetSadpInfoList needs an already-logged-in
  // session rather than being a real broadcast search). TVT's SDK does
  // document a multi-vendor search covering all of them through one call,
  // but that specific function turned out to be an internal-only symbol
  // not actually exported in the SDK we have, so each vendor needs its own.
  // Deliberately NOT a TCP port sweep or a login-attempt-based guess (both
  // tried and removed) — a device either announces itself over the network
  // the way real vendor tools do, or it doesn't show up here and has to be
  // added manually. Already-saved devices still appear in results (rather
  // than being dropped) so the list reads as "everything found on the
  // network," each flagged alreadyAdded so the UI can show an indicator
  // instead of the usual "+ Add" action.
  ipcMain.handle('devices:discover', async (): Promise<DiscoveredDevice[]> => {
    const [onvifResults, univiewResults, tvtResults, dahuaResults, hikvisionResults, arpTable] = await Promise.all([
      discoverDevices(),
      discoverUniviewDevices(),
      discoverTvtDevices(),
      discoverDahuaDevices(),
      discoverHikvisionDevices(),
      getArpTable(),
    ]);

    // Merged by host — a device found by both ONVIF and a vendor's own
    // broadcast (plausible for a device with ONVIF also enabled) keeps the
    // vendor-specific entry, since it's a confirmed vendor match with the
    // device's actual configured port, not just an ONVIF-derived guess.
    const byHost = new Map<string, DiscoveredDevice>();
    for (const device of onvifResults) byHost.set(device.host, device);
    for (const device of univiewResults) {
      // Confirmed live: Uniview's own broadcast discovery gets answered by
      // plenty of non-Uniview cameras too (common — many OEM/white-label
      // cameras share chipset firmware that responds to several vendors'
      // discovery formats), but the device's own manufacturer field
      // correctly stays blank/generic ("NONE") for those, only genuinely
      // populated with "UNV"/"UNIVIEW" for real Uniview firmware. Same
      // lesson as ONVIF's own guessVendor: only claim the vendor when the
      // device's own data actually confirms it, never just because
      // something answered the broadcast at all. An unconfirmed response
      // still has real host/port/model info worth surfacing (better than
      // nothing), just without a vendor claim attached.
      const isConfirmedUniview = /^(unv|uniview)$/i.test(device.manufacturer.trim());
      if (isConfirmedUniview) {
        byHost.set(device.host, {
          host: device.host,
          port: device.port,
          model: device.model,
          manufacturer: 'Uniview',
          guessedVendor: 'uniview',
        });
      } else if (!byHost.has(device.host)) {
        byHost.set(device.host, { host: device.host, port: device.port, model: device.model });
      }
    }
    for (const device of tvtResults) {
      byHost.set(device.host, {
        host: device.host,
        port: device.port,
        httpPort: device.httpPort,
        model: device.model,
        manufacturer: 'TVT',
        guessedVendor: 'tvt',
        mac: device.mac,
      });
    }
    // Unlike Uniview's NETDEV_Discovery (confirmed live to be answered by
    // plenty of non-Uniview cameras too, requiring a manufacturer-field
    // check), Dahua's CLIENT_StartSearchDevices is a genuinely
    // vendor-proprietary broadcast/protocol, matching TVT's own
    // NET_SDK_DiscoverDevice below — the same real fleet network with
    // Uniview/TVT hardware present produced exactly one response to this
    // call, the real Dahua device, no cross-answering observed. A
    // per-field "confirm it's really Dahua" check was tried first (by
    // analogy with Uniview) but real diagnostic data disproved both
    // fields tried: `szVendor` came back "General" (a generic SDK
    // fallback, not blank as expected, and not "Dahua" either) and
    // `byManuFactory` came back 48 (DH_IPC_OTHER/"custom") rather than 0
    // (DH_IPC_PRIVATE) even for this confirmed-genuine device. Neither
    // field reliably signals "genuinely Dahua" in practice, so - same as
    // TVT - a response through Dahua's own discovery call is trusted on
    // its own.
    for (const device of dahuaResults) {
      byHost.set(device.host, {
        host: device.host,
        port: device.port,
        httpPort: device.httpPort,
        model: device.model,
        manufacturer: 'Dahua',
        guessedVendor: 'dahua',
        mac: device.mac,
      });
    }
    // SADP (services/sadp.ts) is Hikvision's own proprietary broadcast, same
    // trust model as TVT/Dahua above - a response through it is confirmed
    // Hikvision on its own.
    for (const device of hikvisionResults) {
      byHost.set(device.host, device);
    }

    const existingHosts = new Set(listDevices().map((d) => d.host));
    return Array.from(byHost.values()).map((d) => ({
      ...d,
      mac: d.mac || arpTable.get(d.host),
      alreadyAdded: existingHosts.has(d.host),
    }));
  });
}
