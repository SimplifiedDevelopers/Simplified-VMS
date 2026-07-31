import { useEffect, useMemo, useState } from 'react';
import { theme } from '../theme';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { TrashIcon } from '../components/icons';
import type {
  DeviceConnectionStatus,
  DiscoveredDevice,
  NewDeviceInput,
  StoredDevice,
  SystemStats,
} from '../../../shared/types';
import { VENDOR_LABELS } from '../../../shared/types';
import { DeviceDialog } from './DeviceDialog';

type Status = DeviceConnectionStatus | undefined;
type SortDir = 'asc' | 'desc';

const STATUS_RANK: Record<string, number> = { online: 0, connecting: 1, offline: 2 };

function statusRank(status: Status): number {
  return status ? (STATUS_RANK[status.state] ?? 3) : 3;
}

function compare(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// A generic placeholder like "IP Camera"/"IPCAM" carries no real
// information (confirmed live: ONVIF's own free-text model field returns
// exactly these for devices that don't report a real model), so it's
// treated the same as no model at all for display purposes.
const GENERIC_MODEL_PATTERN = /^(ip\s*cam(era)?|ipcam|generic|unknown)$/i;

function isUsableModel(model: string | undefined): model is string {
  return Boolean(model && model.trim() && !GENERIC_MODEL_PATTERN.test(model.trim()));
}

// The device's own specific model number (e.g. "NVR302-16S-P16") is always
// more useful to see at a glance than a generic manufacturer/vendor name —
// confirmed live: showing manufacturer first made every confirmed device
// in a scan display the same generic vendor word instead of the one piece
// of info that actually distinguishes them. Manufacturer isn't shown here
// at all anymore — the separate Vendor/Brand column already covers that.
function displayName(found: { model?: string }): string {
  return isUsableModel(found.model) ? found.model : 'Unknown device';
}

// "IPCY-" prefixed models are the company's own OEM product line (SSM),
// not a real connection protocol — purely a recognition label for the
// Vendor/Brand column, distinct from guessedVendor (which only ever
// reflects a real, confirmed adapter/protocol match, still required to
// actually connect via "+ Add"). Never overrides a real guessedVendor
// match; only fills the gap when there isn't one.
function brandLabel(found: { guessedVendor?: keyof typeof VENDOR_LABELS; model?: string }): string {
  if (found.guessedVendor) return VENDOR_LABELS[found.guessedVendor];
  if (found.model?.trim().toUpperCase().startsWith('IPCY')) return 'SSM';
  return '—';
}

// Plain string comparison sorts "192.168.1.10" before "192.168.1.9" (lexical,
// not numeric) — parse each octet and compare numerically instead. Falls
// back to plain string compare for hostnames/domains that aren't IPv4.
function compareIp(a: string, b: string): number {
  const aMatch = a.match(IPV4_PATTERN);
  const bMatch = b.match(IPV4_PATTERN);
  if (!aMatch || !bMatch) return a.localeCompare(b);
  for (let i = 1; i <= 4; i++) {
    const diff = Number(aMatch[i]) - Number(bMatch[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function resourceLevelColor(percent: number): string {
  if (percent >= 85) return theme.danger;
  if (percent >= 60) return theme.warning;
  return theme.success;
}

export function DeviceManagement() {
  const [devices, setDevices] = useState<StoredDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<'add' | StoredDevice | null>(null);
  const [discoveryPrefill, setDiscoveryPrefill] = useState<Partial<NewDeviceInput> | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StoredDevice | null>(null);
  const [statusById, setStatusById] = useState<Record<string, Status>>({});
  const [discovered, setDiscovered] = useState<DiscoveredDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [hasScanned, setHasScanned] = useState(false);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [deviceSort, setDeviceSort] = useState<{ key: string; dir: SortDir } | null>(null);
  const [discoveredSort, setDiscoveredSort] = useState<{ key: string; dir: SortDir } | null>(null);

  async function refresh(): Promise<void> {
    const list = await window.ssmVms.devices.list();
    setDevices(list);
    setLoading(false);
    // Every device is already connected (or connecting) in the background
    // via the app-wide connection manager — this just reads the current
    // cached status instantly, it doesn't reconnect anything. Live updates
    // after this come from the devices:statusChanged subscription below.
    // One bulk call instead of one devices:getStatus round trip per
    // device — for a 50+ device fleet that was 50+ separate IPC calls
    // firing in a burst every time this page loaded, found via a
    // resource-usage audit.
    const statuses = await window.ssmVms.devices.getAllStatuses();
    setStatusById((prev) => ({ ...prev, ...statuses }));
  }

  async function refreshStatusNow(): Promise<void> {
    await Promise.all(
      devices.map(async (device) => {
        setStatusById((prev) => ({ ...prev, [device.id]: { state: 'connecting' } }));
        const status = await window.ssmVms.devices.checkStatus(device.id);
        setStatusById((prev) => ({ ...prev, [device.id]: status }));
      }),
    );
    // checkStatus() may have just persisted a MAC address resolved for the
    // first time (or refreshed one) — re-fetch the device list so it shows
    // up without needing a full page reload.
    await refresh();
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    return window.ssmVms.devices.onStatusChanged((deviceId, status) => {
      setStatusById((prev) => ({ ...prev, [deviceId]: status }));
    });
  }, []);

  // Auto-scan once whenever this page opens, so results are already there
  // instead of making the user click "Scan Network" first every time.
  useEffect(() => {
    handleScan();
  }, []);

  useEffect(() => window.ssmVms.system.onStats(setStats), []);

  function toggleSort(
    current: { key: string; dir: SortDir } | null,
    setSort: (v: { key: string; dir: SortDir } | null) => void,
    key: string,
  ): void {
    if (current?.key === key) {
      setSort(current.dir === 'asc' ? { key, dir: 'desc' } : null);
    } else {
      setSort({ key, dir: 'asc' });
    }
  }

  const sortedDevices = useMemo(() => {
    if (!deviceSort) return devices;
    const { key, dir } = deviceSort;
    const factor = dir === 'asc' ? 1 : -1;
    return [...devices].sort((a, b) => {
      switch (key) {
        case 'status':
          return factor * (statusRank(statusById[a.id]) - statusRank(statusById[b.id]));
        case 'name':
          return factor * compare(a.name, b.name);
        case 'vendor':
          return factor * compare(VENDOR_LABELS[a.vendor], VENDOR_LABELS[b.vendor]);
        case 'ip':
          return factor * compareIp(a.host, b.host);
        case 'port':
          return factor * compare(a.port, b.port);
        case 'username':
          return factor * compare(a.username, b.username);
        default:
          return 0;
      }
    });
  }, [devices, deviceSort, statusById]);

  const sortedDiscovered = useMemo(() => {
    if (!discoveredSort) return discovered;
    const { key, dir } = discoveredSort;
    const factor = dir === 'asc' ? 1 : -1;
    return [...discovered].sort((a, b) => {
      switch (key) {
        case 'name':
          return factor * compare(displayName(a), displayName(b));
        case 'ip':
          return factor * compareIp(a.host, b.host);
        case 'port':
          return factor * compare(a.httpPort ?? 0, b.httpPort ?? 0);
        case 'vendor':
          return factor * compare(brandLabel(a), brandLabel(b));
        case 'mac':
          return factor * compare(a.mac ?? '', b.mac ?? '');
        default:
          return 0;
      }
    });
  }, [discovered, discoveredSort]);

  async function handleSave(input: NewDeviceInput): Promise<void> {
    if (dialog && dialog !== 'add') {
      await window.ssmVms.devices.update(dialog.id, input);
    } else {
      await window.ssmVms.devices.add(input);
      setDiscovered((prev) => prev.map((d) => (d.host === input.host ? { ...d, alreadyAdded: true } : d)));
    }
    setDialog(null);
    setDiscoveryPrefill(null);
    await refresh();
  }

  async function handleDelete(): Promise<void> {
    if (!pendingDelete) return;
    await window.ssmVms.devices.delete(pendingDelete.id);
    setPendingDelete(null);
    await refresh();
  }

  function addFromDiscovered(found: DiscoveredDevice): void {
    setDiscoveryPrefill({
      name: isUsableModel(found.model) ? found.model : '',
      host: found.host,
      vendor: found.guessedVendor,
      // Only set when the discovery source reports the device's actual
      // configured port directly (e.g. Uniview's NETDEV_Discovery) rather
      // than being guessed — DeviceDialog falls back to that vendor's
      // generic default port when this is left undefined.
      port: found.port,
      httpPort: found.httpPort,
    });
    setDialog('add');
  }

  async function handleScan(): Promise<void> {
    setScanning(true);
    try {
      const results = await window.ssmVms.devices.discover();
      setDiscovered(results);
      setHasScanned(true);
    } finally {
      setScanning(false);
    }
  }

  return (
    <div style={{ padding: '1.5rem', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexShrink: 0 }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: theme.text }}>
          Managed Devices ({devices.length})
        </span>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <button onClick={refreshStatusNow} style={secondaryButtonStyle}>
            Refresh Status
          </button>
          <button onClick={() => setDialog('add')} style={addButtonStyle}>
            + Add
          </button>
        </div>
      </div>

      <div style={{ border: `1px solid ${theme.border}`, borderRadius: '6px', overflow: 'hidden', flexShrink: 0 }}>
        <div style={rowStyle(true)}>
          <SortableHeader flex={1} label="Status" sortKey="status" sort={deviceSort} onSort={(k) => toggleSort(deviceSort, setDeviceSort, k)} />
          <SortableHeader flex={1} label="Name" sortKey="name" sort={deviceSort} onSort={(k) => toggleSort(deviceSort, setDeviceSort, k)} />
          <SortableHeader flex={1} label="Brand" sortKey="vendor" sort={deviceSort} onSort={(k) => toggleSort(deviceSort, setDeviceSort, k)} />
          <SortableHeader flex={1} label="IP/Domain" sortKey="ip" sort={deviceSort} onSort={(k) => toggleSort(deviceSort, setDeviceSort, k)} />
          <SortableHeader flex={1} label="Port" sortKey="port" sort={deviceSort} onSort={(k) => toggleSort(deviceSort, setDeviceSort, k)} />
          <SortableHeader flex={1} label="Username" sortKey="username" sort={deviceSort} onSort={(k) => toggleSort(deviceSort, setDeviceSort, k)} />
          <span style={{ ...cellStyle, flex: 1, textAlign: 'left' }}>Actions</span>
        </div>

        {!loading && devices.length === 0 && (
          <div style={{ padding: '1.5rem', textAlign: 'center', color: theme.textFaint, fontSize: '12.5px' }}>
            No devices yet — click Add to connect your first DVR/NVR.
          </div>
        )}

        {sortedDevices.map((device) => (
          <div key={device.id} style={rowStyle(false)}>
            <span style={{ ...cellStyle, flex: 1 }}>
              <StatusBadge status={statusById[device.id]} />
            </span>
            <span style={{ ...cellStyle, flex: 1, color: theme.text }}>{device.name}</span>
            <span style={{ ...cellStyle, flex: 1 }}>{VENDOR_LABELS[device.vendor]}</span>
            <span style={{ ...cellStyle, flex: 1 }}>{device.host}</span>
            <span style={{ ...cellStyle, flex: 1 }}>{device.port}</span>
            <span style={{ ...cellStyle, flex: 1 }}>{device.username}</span>
            <span style={{ ...cellStyle, flex: 1, textAlign: 'left', display: 'flex', gap: '1.1rem', justifyContent: 'flex-start' }}>
              <button onClick={() => window.ssmVms.system.openInBrowser(device.host, device.httpPort)} style={linkButtonStyle}>
                Open
              </button>
              <button onClick={() => setDialog(device)} style={linkButtonStyle}>
                Edit
              </button>
              <button
                onClick={() => setPendingDelete(device)}
                title="Delete"
                style={{ ...linkButtonStyle, color: theme.textFaint, display: 'flex', alignItems: 'center', marginLeft: '1.6rem' }}
                onMouseEnter={(e) => (e.currentTarget.style.color = theme.danger)}
                onMouseLeave={(e) => (e.currentTarget.style.color = theme.textFaint)}
              >
                <TrashIcon size={15} />
              </button>
            </span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: '1.5rem', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexShrink: 0 }}>
          <span style={{ fontSize: '12.5px', fontWeight: 600, color: theme.text }}>
            Online Devices {hasScanned && `(${discovered.length})`}
          </span>
          <button onClick={handleScan} disabled={scanning} style={{ ...secondaryButtonStyle, opacity: scanning ? 0.6 : 1 }}>
            {scanning ? 'Scanning…' : 'Scan Network'}
          </button>
        </div>

        {/* Only this section scrolls internally (not the whole page) so the
            CPU/Memory readout below stays pinned and always visible, even
            when a scan turns up more devices than fit on screen at once —
            the header row stays outside the scrolling body so column labels
            never scroll out of view either. */}
        <div style={{ border: `1px solid ${theme.border}`, borderRadius: '6px', overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ ...rowStyle(true), flexShrink: 0 }}>
            <SortableHeader flex={1} label="Brand" sortKey="vendor" sort={discoveredSort} onSort={(k) => toggleSort(discoveredSort, setDiscoveredSort, k)} />
            <SortableHeader flex={1} label="Model" sortKey="name" sort={discoveredSort} onSort={(k) => toggleSort(discoveredSort, setDiscoveredSort, k)} />
            <SortableHeader flex={1} label="IP Address" sortKey="ip" sort={discoveredSort} onSort={(k) => toggleSort(discoveredSort, setDiscoveredSort, k)} />
            <SortableHeader flex={1} label="Port" sortKey="port" sort={discoveredSort} onSort={(k) => toggleSort(discoveredSort, setDiscoveredSort, k)} />
            <SortableHeader flex={1} label="MAC Address" sortKey="mac" sort={discoveredSort} onSort={(k) => toggleSort(discoveredSort, setDiscoveredSort, k)} />
            <span style={{ ...cellStyle, flex: 1, textAlign: 'left' }}>Actions</span>
          </div>

          <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {!hasScanned && (
              <div style={{ padding: '1.1rem', textAlign: 'center', color: theme.textFaint, fontSize: '12px' }}>
                Scanning the local network…
              </div>
            )}
            {hasScanned && discovered.length === 0 && (
              <div style={{ padding: '1.1rem', textAlign: 'center', color: theme.textFaint, fontSize: '12px' }}>
                No new devices found on the local network.
              </div>
            )}
            {sortedDiscovered.map((found) => (
              <div key={found.host} style={{ ...rowStyle(false), padding: '0.5rem 0.9rem' }}>
                <span style={{ ...cellStyle, flex: 1 }}>{brandLabel(found)}</span>
                <span style={{ ...cellStyle, flex: 1, color: theme.text }}>{displayName(found)}</span>
                <span style={{ ...cellStyle, flex: 1 }}>{found.host}</span>
                <span style={{ ...cellStyle, flex: 1 }}>{found.httpPort ?? '—'}</span>
                <span style={{ ...cellStyle, flex: 1 }}>{found.mac ?? '—'}</span>
                <span style={{ ...cellStyle, flex: 1, textAlign: 'left', display: 'flex', gap: '1.1rem', justifyContent: 'flex-start' }}>
                  <button
                    onClick={() => window.ssmVms.system.openInBrowser(found.host, found.httpPort ?? 80)}
                    title="Open the device's own web admin page to verify what it actually is before adding it"
                    style={linkButtonStyle}
                  >
                    Open
                  </button>
                  {found.alreadyAdded ? (
                    <span style={{ fontSize: '12px', color: theme.textFaint, fontStyle: 'italic' }}>Added</span>
                  ) : (
                    <button onClick={() => addFromDiscovered(found)} style={linkButtonStyle}>
                      + Add
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem', marginTop: '1rem', flexShrink: 0 }}>
        <span style={{ fontSize: '11px', color: theme.textFaint, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          CPU
          <strong style={{ color: stats ? resourceLevelColor(stats.cpuPercent) : theme.textMuted, fontWeight: 600 }}>
            {stats ? `${stats.cpuPercent}%` : '—'}
          </strong>
        </span>
        <span style={{ fontSize: '11px', color: theme.textFaint, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          Memory
          <strong style={{ color: stats ? resourceLevelColor(stats.memPercent) : theme.textMuted, fontWeight: 600 }}>
            {stats ? `${stats.memPercent}%` : '—'}
          </strong>
        </span>
      </div>

      {dialog && (
        <DeviceDialog
          initial={dialog === 'add' ? null : dialog}
          prefill={dialog === 'add' ? (discoveryPrefill ?? undefined) : undefined}
          onSave={handleSave}
          onCancel={() => {
            setDialog(null);
            setDiscoveryPrefill(null);
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Message"
          message={`Delete "${pendingDelete.name}"? This can't be undone.`}
          confirmLabel="Delete"
          onCancel={() => setPendingDelete(null)}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}

function SortableHeader({
  flex,
  label,
  sortKey,
  sort,
  onSort,
}: {
  flex: number;
  label: string;
  sortKey: string;
  sort: { key: string; dir: SortDir } | null;
  onSort: (key: string) => void;
}) {
  const active = sort?.key === sortKey;
  return (
    <span
      onClick={() => onSort(sortKey)}
      style={{ ...cellStyle, flex, display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer', userSelect: 'none' }}
    >
      {label}
      <span style={{ fontSize: '10px', color: active ? theme.text : theme.textFaint, opacity: active ? 1 : 0.4 }}>
        {active && sort?.dir === 'desc' ? '▼' : '▲'}
      </span>
    </span>
  );
}

function StatusBadge({ status }: { status: Status }) {
  if (!status) return <span style={{ fontSize: '11.5px', color: theme.textFaint }}>—</span>;
  if (status.state === 'connecting') {
    return <span style={{ fontSize: '11.5px', color: theme.textFaint }}>Connecting…</span>;
  }
  const online = status.state === 'online';
  const color = online ? theme.success : theme.danger;
  return (
    <span
      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '11.5px', color }}
      title={online ? undefined : status.error}
    >
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: color, flexShrink: 0 }} />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}

function rowStyle(header: boolean) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: '1.25rem',
    padding: '0.6rem 0.9rem',
    background: header ? theme.panel : 'transparent',
    borderBottom: `1px solid ${theme.border}`,
  } as const;
}

const cellStyle = {
  fontSize: '12.5px',
  color: theme.textMuted,
};

const addButtonStyle = {
  padding: '0.45rem 0.9rem',
  borderRadius: '5px',
  border: 'none',
  background: theme.accent,
  color: theme.accentText,
  fontSize: '12.5px',
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryButtonStyle = {
  padding: '0.45rem 0.9rem',
  borderRadius: '5px',
  border: `1px solid ${theme.borderLight}`,
  background: 'transparent',
  color: theme.text,
  fontSize: '12.5px',
  cursor: 'pointer',
};

const linkButtonStyle = {
  background: 'none',
  border: 'none',
  color: theme.accentHover,
  fontSize: '12px',
  cursor: 'pointer',
  padding: 0,
};
