import { useState, type CSSProperties, type FormEvent } from 'react';
import { theme } from '../theme';
import { Modal } from '../components/Modal';
import {
  VENDOR_LABELS,
  VENDOR_ORDER,
  type ConnectionTestResult,
  type NewDeviceInput,
  type StoredDevice,
  type VendorId,
} from '../../../shared/types';

const DEFAULT_PORTS: Record<VendorId, number> = {
  tvt: 6036,
  uniview: 80,
  hikvision: 8000,
  dahua: 37777,
  onvif: 80,
};

const SUPPORTED_VENDORS = new Set<VendorId>(['hikvision', 'uniview', 'dahua', 'tvt', 'onvif']);

interface Props {
  initial: StoredDevice | null;
  // Seeds the Add-Device form's fields from a network-discovered device
  // (see DeviceManagement's discovery section) without switching the dialog
  // into edit mode — title, password requirement, and submit label all
  // still behave as a normal "Add", only ignored when `initial` is set.
  prefill?: Partial<NewDeviceInput>;
  onSave: (input: NewDeviceInput) => Promise<void>;
  onCancel: () => void;
}

export function DeviceDialog({ initial, prefill, onSave, onCancel }: Props) {
  const [vendor, setVendor] = useState<VendorId>(initial?.vendor ?? prefill?.vendor ?? 'uniview');
  const [name, setName] = useState(initial?.name ?? prefill?.name ?? '');
  const [host, setHost] = useState(initial?.host ?? prefill?.host ?? '');
  const [port, setPort] = useState(String(initial?.port ?? prefill?.port ?? DEFAULT_PORTS[vendor]));
  const [httpPort, setHttpPort] = useState(String(initial?.httpPort ?? prefill?.httpPort ?? 80));
  const [username, setUsername] = useState(initial?.username ?? prefill?.username ?? 'admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  function selectVendor(v: VendorId): void {
    setVendor(v);
    if (!initial) setPort(String(DEFAULT_PORTS[v]));
    setTestResult(null);
  }

  async function handleTest(): Promise<void> {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.ssmVms.devices.testConnection({
        name: name.trim(),
        vendor,
        host: host.trim(),
        port: Number(port),
        httpPort: Number(httpPort),
        username,
        password,
      });
      setTestResult(result);
    } finally {
      setTesting(false);
    }
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!name.trim() || !host.trim()) {
      setError('Device name and IP/Domain are required.');
      return;
    }
    // Only enforced for a brand-new device — editing an existing one
    // legitimately leaves this blank to keep the current password (see the
    // field's own placeholder). Added after a real report from the field:
    // devices added from the network-scan list have every field pre-filled
    // except this one (discovery has no way to know a device's password),
    // and nothing stopped saving with it still blank — the device would
    // then silently fail to ever connect with a credentials error, easy to
    // miss since everything else on the form already looked "filled in".
    if (!initial && !password.trim()) {
      setError('Password is required.');
      return;
    }
    setBusy(true);
    try {
      await onSave({
        name: name.trim(),
        vendor,
        host: host.trim(),
        port: Number(port),
        httpPort: Number(httpPort),
        username,
        password,
      });
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
                      background: active ? theme.accentFaint : theme.surface,
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
          <Field label="Service Port">
            <input value={port} onChange={(e) => setPort(e.target.value)} style={inputStyle} />
            {prefill && !initial && (
              <span style={{ fontSize: '10.5px', color: theme.warning }}>
                Guessed default for this vendor — network discovery can't detect a device's actual configured SDK
                port. Verify this matches your device's settings before saving.
              </span>
            )}
          </Field>
          <Field label="HTTP Port (for Open in Browser)">
            <input value={httpPort} onChange={(e) => setHttpPort(e.target.value)} style={inputStyle} />
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

          {testResult && (
            <div
              style={{
                fontSize: '12px',
                color: testResult.ok ? theme.success : theme.danger,
                lineHeight: 1.4,
              }}
            >
              {testResult.ok
                ? `✓ Connected — ${testResult.channelCount} channel${testResult.channelCount === 1 ? '' : 's'}`
                : `✗ ${testResult.error}`}
            </div>
          )}

          {error && <div style={{ fontSize: '12px', color: theme.danger }}>{error}</div>}
        </div>

        <div
          style={{
            padding: '0 1.4rem 1.25rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '0.6rem',
          }}
        >
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || !host.trim() || !password}
            title={!password ? 'Enter the password to test' : undefined}
            style={{ ...secondaryButtonStyle, opacity: testing || !host.trim() || !password ? 0.5 : 1 }}
          >
            {testing ? 'Testing…' : 'Test Connection'}
          </button>

          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button type="button" onClick={onCancel} style={secondaryButtonStyle}>
              Cancel
            </button>
            <button type="submit" disabled={busy} style={primaryButtonStyle}>
              {busy ? 'Saving…' : initial ? 'Save' : 'Add'}
            </button>
          </div>
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
