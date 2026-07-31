import { createSocket } from 'dgram';
import { randomUUID } from 'crypto';
import type { DiscoveredDevice } from '../../shared/types';

// SADP (Search Active Devices Protocol) - Hikvision's own proprietary
// discovery mechanism, the same one their SADP tool/iVMS-4200 use. Unlike
// ONVIF WS-Discovery (services/discovery.ts), this is a vendor-specific
// protocol - genuinely Hikvision-branded devices are the ones that answer
// it, matching the same trust model already confirmed for TVT's and
// Dahua's own native discovery calls (a response through a vendor's own
// proprietary broadcast is confirmation enough on its own, no separate
// "confirm the vendor field" check needed - that check is only necessary
// for Uniview's NETDEV_Discovery, confirmed live to be cross-answered by
// non-Uniview cameras sharing compatible firmware). Pure UDP/XML, no SDK
// or native addon needed for discovery specifically, mirroring
// discovery.ts's own hand-rolled-regex-parsing convention rather than
// adding an XML library dependency.
const MULTICAST_ADDRESS = '239.255.255.250';
const MULTICAST_PORT = 37020;
const SCAN_DURATION_MS = 3000;

// Confirmed via public reverse-engineering of the real SADP tool (Hikvision
// ships no public SDK function for this - HCNetSDK's NET_DVR_GetSadpInfoList
// requires an already-logged-in session, not a broadcast search at all).
// Devices only listen on the multicast address/port and reply via unicast
// straight back to the sender's own (IP, port) - same shape as ONVIF
// WS-Discovery, so the same "bind ephemeral port, send multicast, listen
// for unicast replies on that same socket" pattern applies unchanged.
function buildProbe(uuid: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${uuid}</Uuid><Types>inquiry</Types></Probe>`,
  );
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match?.[1]?.trim() ?? '';
}

// A real Hikvision DeviceSN looks like "DS-2CD2432F-IW20150126CCCH502126167"
// - model, then an 8-digit manufacture date (always starts with a 20xx
// year), then a serial tail. The model is everything before that date run.
// Unverified against real hardware yet - DeviceType/DeviceDescription are
// tried first since they may already be a clean model string; this is a
// fallback extraction, not the primary path.
function modelFromSerial(serial: string): string | undefined {
  const match = serial.match(/^(.+?)-?20\d{6}/);
  const model = match?.[1]?.trim();
  return model && model.length > 0 ? model : undefined;
}

export function discoverHikvisionDevices(): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map<string, DiscoveredDevice>();

    socket.on('message', (msg, rinfo) => {
      const xml = msg.toString('utf-8');
      const deviceSn = extractTag(xml, 'DeviceSN');
      const commandPortStr = extractTag(xml, 'CommandPort');
      if (!deviceSn && !commandPortStr) return;
      if (found.has(rinfo.address)) return;

      // Temporary diagnostics (same project convention used for every
      // other vendor's discovery this engagement) - first time this
      // protocol's real response data has been observed live, since the
      // exact field population (DeviceType vs. DeviceDescription vs.
      // DeviceSN-derived model) is unverified against real hardware.
      // eslint-disable-next-line no-console
      console.log(`[hik-sadp-diag] ip=${rinfo.address} raw=${xml}`);

      const deviceType = extractTag(xml, 'DeviceType');
      const deviceDescription = extractTag(xml, 'DeviceDescription');
      const commandPort = commandPortStr ? Number(commandPortStr) : undefined;
      const httpPortStr = extractTag(xml, 'HttpPort');
      const httpPort = httpPortStr ? Number(httpPortStr) : undefined;
      const mac = extractTag(xml, 'MAC') || undefined;

      const model = deviceType || deviceDescription || modelFromSerial(deviceSn);

      found.set(rinfo.address, {
        host: rinfo.address,
        port: commandPort,
        httpPort,
        model,
        manufacturer: 'Hikvision',
        guessedVendor: 'hikvision',
        mac,
      });
    });

    socket.on('error', () => {
      // A bad network interface shouldn't crash the scan - just resolve
      // with whatever (if anything) was already found.
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(4);
      } catch {
        // best-effort - some network configurations reject these, the
        // probe can still go out without them
      }
      socket.send(buildProbe(randomUUID()), MULTICAST_PORT, MULTICAST_ADDRESS);
    });

    setTimeout(() => {
      socket.close();
      resolve(Array.from(found.values()));
    }, SCAN_DURATION_MS);
  });
}
