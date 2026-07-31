import { exec } from 'child_process';

// MAC address lookup via the OS's own ARP cache (`arp -a`) — a device's MAC
// only resolves for hosts on the same local L2 network the app is running
// on (ARP doesn't cross a router), so devices added from a different
// network (confirmed with the user: some test devices are reachable by IP
// but aren't local) simply won't have one, same as any other optional
// field. Useful both as a secondary hint for spotting a vendor via its
// OUI prefix and for telling apart near-identical scan result rows.
const MAC_PATTERN = /([0-9a-f]{2}(?:-[0-9a-f]{2}){5})/i;
const ARP_TIMEOUT_MS = 5000;

function runArp(args: string): Promise<string> {
  return new Promise((resolve) => {
    exec(`arp ${args}`, { timeout: ARP_TIMEOUT_MS }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// Windows' `arp -a <ip>` only returns a result if that IP is already in the
// ARP cache — it doesn't actively probe/resolve an address that's never
// been contacted. Callers that already do (or are about to do) a real
// network round trip to this host (e.g. right after a login attempt) will
// reliably find an entry; a cold lookup with no prior traffic to the host
// may come back empty even for a genuinely local device.
export async function lookupMacAddress(host: string): Promise<string | undefined> {
  const output = await runArp(`-a ${host}`);
  const match = output.match(MAC_PATTERN);
  return match ? match[1].toUpperCase() : undefined;
}

// Bulk variant for annotating a whole batch of scan results with one
// system call instead of one per host — the subnet scan's own TCP connect
// attempts already populate the ARP cache for every host it touched.
export async function getArpTable(): Promise<Map<string, string>> {
  const output = await runArp('-a');
  const table = new Map<string, string>();
  const re = /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})/gim;
  let match: RegExpExecArray | null;
  while ((match = re.exec(output)) !== null) {
    table.set(match[1], match[2].toUpperCase());
  }
  return table;
}
