import { useState, type CSSProperties } from 'react';
import { theme } from '../theme';
import { Modal } from '../components/Modal';
import type { StoredDevice } from '../../../shared/types';

interface Props {
  devices: StoredDevice[];
  onAssign: (deviceId: string, channel: number) => void;
  onCancel: () => void;
}

export function AssignDeviceDialog({ devices, onAssign, onCancel }: Props) {
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? '');
  const [channel, setChannel] = useState('1');

  return (
    <Modal width={340} onDismiss={onCancel}>
      <div style={{ padding: '1.1rem 1.3rem', borderBottom: `1px solid ${theme.border}` }}>
        <span style={{ fontSize: '13.5px', fontWeight: 600, color: theme.text }}>Add Camera</span>
      </div>
      <div style={{ padding: '1.1rem 1.3rem', display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
        {devices.length === 0 ? (
          <span style={{ fontSize: '12.5px', color: theme.textMuted }}>
            No devices yet — add one in Device Management first.
          </span>
        ) : (
          <>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <span style={{ fontSize: '11.5px', color: theme.textMuted }}>Device</span>
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} style={inputStyle}>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              <span style={{ fontSize: '11.5px', color: theme.textMuted }}>Channel</span>
              <input value={channel} onChange={(e) => setChannel(e.target.value)} style={inputStyle} />
            </label>
          </>
        )}
      </div>
      <div style={{ padding: '0 1.3rem 1.1rem', display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
        <button onClick={onCancel} style={secondaryButtonStyle}>
          Cancel
        </button>
        {devices.length > 0 && (
          <button onClick={() => onAssign(deviceId, Number(channel) || 1)} style={primaryButtonStyle}>
            Connect
          </button>
        )}
      </div>
    </Modal>
  );
}

const inputStyle: CSSProperties = {
  padding: '0.5rem 0.6rem',
  borderRadius: '5px',
  border: `1px solid ${theme.border}`,
  background: theme.surface,
  color: theme.text,
  fontSize: '13px',
  outline: 'none',
};

const primaryButtonStyle: CSSProperties = {
  padding: '0.5rem 1.1rem',
  borderRadius: '5px',
  border: 'none',
  background: theme.accent,
  color: theme.accentText,
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryButtonStyle: CSSProperties = {
  padding: '0.5rem 1.1rem',
  borderRadius: '5px',
  border: `1px solid ${theme.borderLight}`,
  background: 'transparent',
  color: theme.text,
  fontSize: '13px',
  cursor: 'pointer',
};
