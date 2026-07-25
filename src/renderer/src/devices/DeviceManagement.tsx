import { useEffect, useState } from 'react';
import { theme } from '../theme';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { VENDOR_LABELS, type ConnectionTestResult, type NewDeviceInput, type StoredDevice } from '../../../shared/types';
import { DeviceDialog } from './DeviceDialog';

type Status = ConnectionTestResult | 'checking' | undefined;

export function DeviceManagement() {
  const [devices, setDevices] = useState<StoredDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<'add' | StoredDevice | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StoredDevice | null>(null);
  const [statusById, setStatusById] = useState<Record<string, Status>>({});

  async function refresh(): Promise<void> {
    const list = await window.ssmVms.devices.list();
    setDevices(list);
    setLoading(false);
    checkAllStatuses(list);
  }

  function checkAllStatuses(list: StoredDevice[]): void {
    setStatusById((prev) => {
      const next = { ...prev };
      list.forEach((d) => (next[d.id] = 'checking'));
      return next;
    });
    list.forEach((device) => {
      window.ssmVms.devices.checkStatus(device.id).then((result) => {
        setStatusById((prev) => ({ ...prev, [device.id]: result }));
      });
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleSave(input: NewDeviceInput): Promise<void> {
    if (dialog && dialog !== 'add') {
      await window.ssmVms.devices.update(dialog.id, input);
    } else {
      await window.ssmVms.devices.add(input);
    }
    setDialog(null);
    await refresh();
  }

  async function handleDelete(): Promise<void> {
    if (!pendingDelete) return;
    await window.ssmVms.devices.delete(pendingDelete.id);
    setPendingDelete(null);
    await refresh();
  }

  return (
    <div style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: theme.text }}>
          Managed Devices ({devices.length})
        </span>
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <button onClick={() => checkAllStatuses(devices)} style={secondaryButtonStyle}>
            Refresh Status
          </button>
          <button onClick={() => setDialog('add')} style={addButtonStyle}>
            + Add
          </button>
        </div>
      </div>

      <div style={{ border: `1px solid ${theme.border}`, borderRadius: '6px', overflow: 'hidden' }}>
        <div style={rowStyle(true)}>
          <span style={{ ...cellStyle, flex: 1.2 }}>Status</span>
          <span style={{ ...cellStyle, flex: 2 }}>Name</span>
          <span style={{ ...cellStyle, flex: 1 }}>Adapter</span>
          <span style={{ ...cellStyle, flex: 2 }}>IP/Domain</span>
          <span style={{ ...cellStyle, flex: 1 }}>Port</span>
          <span style={{ ...cellStyle, flex: 1.5 }}>Username</span>
          <span style={{ ...cellStyle, flex: 1.5, textAlign: 'right' }}>Actions</span>
        </div>

        {!loading && devices.length === 0 && (
          <div style={{ padding: '1.5rem', textAlign: 'center', color: theme.textFaint, fontSize: '12.5px' }}>
            No devices yet — click Add to connect your first DVR/NVR.
          </div>
        )}

        {devices.map((device) => (
          <div key={device.id} style={rowStyle(false)}>
            <span style={{ ...cellStyle, flex: 1.2 }}>
              <StatusBadge status={statusById[device.id]} />
            </span>
            <span style={{ ...cellStyle, flex: 2, color: theme.text }}>{device.name}</span>
            <span style={{ ...cellStyle, flex: 1 }}>{VENDOR_LABELS[device.vendor]}</span>
            <span style={{ ...cellStyle, flex: 2 }}>{device.host}</span>
            <span style={{ ...cellStyle, flex: 1 }}>{device.port}</span>
            <span style={{ ...cellStyle, flex: 1.5 }}>{device.username}</span>
            <span style={{ ...cellStyle, flex: 1.5, textAlign: 'right', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button onClick={() => window.ssmVms.system.openInBrowser(device.host, device.httpPort)} style={linkButtonStyle}>
                Open
              </button>
              <button onClick={() => setDialog(device)} style={linkButtonStyle}>
                Edit
              </button>
              <button onClick={() => setPendingDelete(device)} style={{ ...linkButtonStyle, color: theme.danger }}>
                Delete
              </button>
            </span>
          </div>
        ))}
      </div>

      {dialog && <DeviceDialog initial={dialog === 'add' ? null : dialog} onSave={handleSave} onCancel={() => setDialog(null)} />}

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

function StatusBadge({ status }: { status: Status }) {
  if (!status) return <span style={{ fontSize: '11.5px', color: theme.textFaint }}>—</span>;
  if (status === 'checking') {
    return <span style={{ fontSize: '11.5px', color: theme.textFaint }}>Checking…</span>;
  }
  const color = status.ok ? theme.success : theme.danger;
  return (
    <span
      style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '11.5px', color }}
      title={status.ok ? undefined : status.error}
    >
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: color, flexShrink: 0 }} />
      {status.ok ? 'Online' : 'Offline'}
    </span>
  );
}

function rowStyle(header: boolean) {
  return {
    display: 'flex',
    alignItems: 'center',
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
