import { createSocket } from 'dgram';
import { randomUUID } from 'crypto';
import type { DiscoveredDevice, VendorId } from '../../shared/types';

// ONVIF WS-Discovery — a UDP multicast probe that most DVR/NVR/IP-camera
// vendors respond to regardless of brand (unlike device login, which is
// vendor-SDK-specific), so this is the one piece of "find devices on the
// network" that can be implemented once instead of per-adapter.
const MULTICAST_ADDRESS = '239.255.255.250';
const MULTICAST_PORT = 3702;
const SCAN_DURATION_MS = 4000;

function buildProbe(messageId: string): Buffer {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" ` +
      `xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ` +
      `xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" ` +
      `xmlns:dn="http://www.onvif.org/ver10/network/wsdl">` +
      `<e:Header>` +
      `<w:MessageID>uuid:${messageId}</w:MessageID>` +
      `<w:To e:mustUnderstand="1">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
      `<w:Action e:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>` +
      `</e:Header>` +
      `<e:Body>` +
      `<d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>` +
      `</e:Body>` +
      `</e:Envelope>`,
  );
}

// Best-effort only — devices aren't required to identify their brand
// clearly in ONVIF Scopes/XAddrs, so this is just a convenience default the
// user can override, never trusted for anything else. Deliberately does
// NOT fall back to 'onvif' when no brand keyword matches: real
// Hikvision/Dahua/TVT/Uniview hardware very often doesn't mention its own
// brand in ONVIF Scopes/XAddrs text either (confirmed against real
// hardware — a genuine Dahua camera and a genuine TVT camera both got
// mislabeled 'onvif' by an earlier version of this fallback), and
// defaulting a real branded device to the generic ONVIF adapter is worse
// than leaving it unset, since ONVIF/RTSP is strictly less capable than
// that vendor's own proprietary adapter (no playback/backup, no PTZ).
// Leaving it undefined forces the user to pick from their own knowledge of
// the hardware, same as before an ONVIF adapter existed at all.
function guessVendor(text: string): VendorId | undefined {
  const lower = text.toLowerCase();
  if (lower.includes('hikvision') || /\bds-/.test(lower)) return 'hikvision';
  if (lower.includes('dahua')) return 'dahua';
  if (lower.includes('tvt')) return 'tvt';
  if (lower.includes('uniview') || /\bunv\b/.test(lower)) return 'uniview';
  return undefined;
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<[^:>]*:?${tag}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tag}>`, 'i'));
  return match?.[1]?.trim() ?? '';
}

export function discoverDevices(): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map<string, DiscoveredDevice>();

    socket.on('message', (msg, rinfo) => {
      const xml = msg.toString('utf-8');
      const scopes = extractTag(xml, 'Scopes');
      const xaddrs = extractTag(xml, 'XAddrs');
      if (!scopes && !xaddrs) return;
      if (found.has(rinfo.address)) return;

      const portMatch = xaddrs.match(/:(\d+)\//);
      const modelMatch = scopes.match(/onvif:\/\/www\.onvif\.org\/hardware\/(\S+)/i);
      const nameMatch = scopes.match(/onvif:\/\/www\.onvif\.org\/name\/(\S+)/i);

      found.set(rinfo.address, {
        host: rinfo.address,
        httpPort: portMatch ? Number(portMatch[1]) : undefined,
        model: modelMatch?.[1]?.replace(/_/g, ' '),
        manufacturer: nameMatch?.[1]?.replace(/_/g, ' '),
        guessedVendor: guessVendor(`${scopes} ${xaddrs}`),
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
