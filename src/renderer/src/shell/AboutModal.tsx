import { useEffect, useState } from 'react';
import { theme } from '../theme';
import { Modal } from '../components/Modal';
import { Logo } from '../screens/Splash';

interface Props {
  onClose: () => void;
}

export function AboutModal({ onClose }: Props) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    window.ssmVms.system.getAppVersion().then(setVersion);
  }, []);

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
          Unified multi-vendor video management.
          <br />
          © {new Date().getFullYear()} Simplified Developers
        </div>
      </div>
    </Modal>
  );
}
