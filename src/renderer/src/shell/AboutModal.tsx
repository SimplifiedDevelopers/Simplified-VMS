import { useEffect, useState } from 'react';
import { theme } from '../theme';
import { Modal } from '../components/Modal';
import { Logo } from '../screens/Splash';
import type { UpdateStatus } from '../../../shared/types';

interface Props {
  onClose: () => void;
}

export function AboutModal({ onClose }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    window.ssmVms.system.getAppVersion().then(setVersion);
  }, []);

  // Same update-check flow as Settings' own About section (updates.check/
  // download/install + onStatus), just reachable from the header without
  // opening Settings first.
  useEffect(() => window.ssmVms.updates.onStatus(setStatus), []);

  const checking = status?.state === 'checking';

  return (
    <Modal width={380} onDismiss={onClose}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '1rem 1.3rem',
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        <span style={{ fontSize: '14px', fontWeight: 600, color: theme.text }}>About</span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: theme.textMuted, fontSize: '16px', cursor: 'pointer' }}
        >
          &times;
        </button>
      </div>

      <div style={{ padding: '1.5rem 1.3rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem', textAlign: 'center' }}>
        <Logo height={40} variant="auto" />
        <div style={{ fontSize: '15px', fontWeight: 700, color: theme.text }}>Simplified VMS</div>
        <div style={{ fontSize: '12.5px', color: theme.textMuted }}>Version {version ?? '—'}</div>
        <div style={{ fontSize: '11.5px', color: theme.textFaint, marginTop: '0.5rem', lineHeight: 1.5 }}>
          Unified Multi-Vendor Video Management.
          <br />
          © {new Date().getFullYear()} Simplified Developers
        </div>

        <button
          onClick={() => window.ssmVms.updates.check()}
          disabled={checking || status?.state === 'downloading'}
          style={{ ...secondaryButtonStyle, marginTop: '0.75rem' }}
        >
          {checking ? 'Checking…' : 'Check for Updates'}
        </button>

        {status?.state === 'not-available' && (
          <div style={{ fontSize: '12px', color: theme.success }}>This is the Latest Version</div>
        )}

        {status?.state === 'available' && (
          <>
            <div style={{ fontSize: '12px', color: theme.text }}>Update available: v{status.version}</div>
            <button onClick={() => window.ssmVms.updates.download()} style={secondaryButtonStyle}>
              Download Update
            </button>
          </>
        )}

        {status?.state === 'downloading' && (
          <div style={{ fontSize: '12px', color: theme.textMuted }}>Downloading… {status.percent}%</div>
        )}

        {status?.state === 'downloaded' && (
          <>
            <div style={{ fontSize: '12px', color: theme.success }}>Update ready — v{status.version}</div>
            <button onClick={() => window.ssmVms.updates.install()} style={secondaryButtonStyle}>
              Restart &amp; Install
            </button>
          </>
        )}

        {status?.state === 'error' && <div style={{ fontSize: '12px', color: theme.danger }}>{status.message}</div>}
      </div>
    </Modal>
  );
}

const secondaryButtonStyle = {
  padding: '0.45rem 0.9rem',
  borderRadius: '5px',
  border: `1px solid ${theme.borderLight}`,
  background: 'transparent',
  color: theme.text,
  fontSize: '12.5px',
  cursor: 'pointer',
};
