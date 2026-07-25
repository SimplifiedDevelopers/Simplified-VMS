import { useEffect, useState } from 'react';
import { theme } from '../theme';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { VENDOR_LABELS, type NewDeviceInput, type StoredDevice } from '../../../shared/types';
import { DeviceDialog } from './DeviceDialog';

export function DeviceManagement() {
  const [devices, setDevices] = useState<StoredDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<'add' | StoredDevice | null>(null);
  const [pendingDelete, setPendingDelete] = useState<StoredDevice | null>(null);

  async function refresh(): Promise<void> {
    setDevices(await window.ssmVms.devices.list());
    setLoading(false);
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
        <button onClick={() => setDialog('add')} style={addButtonStyle}>
          + Add
        </button>
      </div>

      <div style={{ border: `1px solid ${theme.border}`, borderRadius: '6px', overflow: 'hidden' }}>
        <div style={rowStyle(true)}>
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
            <span style={{ ...cellStyle, flex: 2, color: theme.text }}>{device.name}</span>
            <span style={{ ...cellStyle, flex: 1 }}>{VENDOR_LABELS[device.vendor]}</span>
            <span style={{ ...cellStyle, flex: 2 }}>{device.host}</span>
            <span style={{ ...cellStyle, flex: 1 }}>{device.port}</span>
            <span style={{ ...cellStyle, flex: 1.5 }}>{device.username}</span>
            <span style={{ ...cellStyle, flex: 1.5, textAlign: 'right', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
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

const linkButtonStyle = {
  background: 'none',
  border: 'none',
  color: theme.accentHover,
  fontSize: '12px',
  cursor: 'pointer',
  padding: 0,
};
