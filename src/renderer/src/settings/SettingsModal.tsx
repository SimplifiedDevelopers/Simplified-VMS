import { useState } from 'react';
import { theme } from '../theme';
import { Modal } from '../components/Modal';

const SECTIONS = ['Video', 'Recording', 'System', 'Users', 'Alarms'];

interface Props {
  onClose: () => void;
}

export function SettingsModal({ onClose }: Props) {
  const [active, setActive] = useState(SECTIONS[0]);

  return (
    <Modal width={620} onDismiss={onClose}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '1rem 1.3rem',
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        <span style={{ fontSize: '14px', fontWeight: 600, color: theme.text }}>System Configuration</span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: theme.textMuted, fontSize: '16px', cursor: 'pointer' }}
        >
          &times;
        </button>
      </div>

      <div style={{ display: 'flex', height: '360px' }}>
        <div style={{ width: '160px', borderRight: `1px solid ${theme.border}`, padding: '0.75rem' }}>
          {SECTIONS.map((section) => (
            <button
              key={section}
              onClick={() => setActive(section)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '0.5rem 0.6rem',
                borderRadius: '5px',
                border: 'none',
                background: active === section ? `${theme.accent}1f` : 'transparent',
                color: active === section ? theme.accent : theme.textMuted,
                fontSize: '12.5px',
                cursor: 'pointer',
                marginBottom: '0.15rem',
              }}
            >
              {section}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ fontSize: '12.5px', color: theme.textFaint }}>
            {active} settings — coming soon.
          </span>
        </div>
      </div>
    </Modal>
  );
}
