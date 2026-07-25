import { useState, type CSSProperties, type FormEvent } from 'react';
import { theme } from '../theme';
import { Modal } from '../components/Modal';
import { VENDOR_LABELS, VENDOR_ORDER, type NewDeviceInput, type StoredDevice, type VendorId } from '../../../shared/types';

const DEFAULT_PORTS: Record<VendorId, number> = {
  tvt: 6036,
  uniview: 80,
  hikvision: 8000,
  dahua: 37777,
};

const SUPPORTED_VENDORS = new Set<VendorId>(['hikvision']);

interface Props {
  initial: StoredDevice | null;
  onSave: (input: NewDeviceInput) => Promise<void>;
  onCancel: () => void;
}

export function DeviceDialog({ initial, onSave, onCancel }: Props) {
  const [vendor, setVendor] = useState<VendorId>(initial?.vendor ?? 'hikvision');
  const [name, setName] = useState(initial?.name ?? '');
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState(String(initial?.port ?? DEFAULT_PORTS[vendor]));
  const [username, setUsername] = useState(initial?.username ?? 'admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function selectVendor(v: VendorId): void {
    setVendor(v);
    if (!initial) setPort(String(DEFAULT_PORTS[v]));
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !host.trim()) {
      setError('Device name and IP/Domain are required.');
      return;
    }
    setBusy(true);
    try {
      await onSave({ name: name.trim(), vendor, host: host.trim(), port: Number(port), username, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal width={440} onDismiss={onCancel}>
      <form onSubmit={handleSubmit}>
        <div style={{ padding: '1.1rem 1.4rem', borderBottom: `1px solid ${theme.border}` }}>
          <span style={{ fontSize: '14px', fontWeight: 600, color: theme.text }}>
            {initial ? 'Edit Device' : 'Add Device'}
          </span>
        </div>

        <div style={{ padding: '1.25rem 1.4rem', display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          <Field label="Adapter">
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              {VENDOR_ORDER.map((v) => {
                const active = v === vendor;
                const supported = SUPPORTED_VENDORS.has(v);
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => selectVendor(v)}
                    title={supported ? undefined : 'Adapter not built yet — saves fine, live view will fail'}
                    style={{
                      flex: 1,
                      padding: '0.45rem 0',
                      borderRadius: '5px',
                      border: `1px solid ${active ? theme.accent : theme.border}`,
                      background: active ? `${theme.accent}1f` : theme.surface,
                      color: active ? theme.accentHover : theme.textMuted,
                      fontSize: '12.5px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      opacity: supported ? 1 : 0.7,
                    }}
                  >
                    {VENDOR_LABELS[v]}
                    {!supported && ' *'}
                  </button>
                );
              })}
            </div>
            <span style={{ fontSize: '10.5px', color: theme.textFaint }}>* adapter not built yet</span>
          </Field>

          <Field label="Device Name">
            <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="IP/Domain">
            <input value={host} onChange={(e) => setHost(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Port">
            <input value={port} onChange={(e) => setPort(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Username">
            <input value={username} onChange={(e) => setUsername(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Password">
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder={initial ? 'Leave blank to keep current password' : ''}
              style={inputStyle}
            />
          </Field>

          {error && <div style={{ fontSize: '12px', color: theme.danger }}>{error}</div>}
        </div>

        <div
          style={{
            padding: '0 1.4rem 1.25rem',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.6rem',
          }}
        >
          <button type="button" onClick={onCancel} style={secondaryButtonStyle}>
            Cancel
          </button>
          <button type="submit" disabled={busy} style={primaryButtonStyle}>
            {busy ? 'Saving…' : initial ? 'Save' : 'Add'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span style={{ fontSize: '11.5px', color: theme.textMuted }}>{label}</span>
      {children}
    </label>
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
