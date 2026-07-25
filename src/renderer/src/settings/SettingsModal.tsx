import { useEffect, useState } from 'react';
import { theme } from '../theme';
import { Modal } from '../components/Modal';
import type { AppSettings } from '../../../shared/types';

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
                color: active === section ? theme.accentHover : theme.textMuted,
                fontSize: '12.5px',
                cursor: 'pointer',
                marginBottom: '0.15rem',
              }}
            >
              {section}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, padding: active === 'System' ? '1.25rem' : 0, display: 'flex' }}>
          {active === 'System' ? (
            <SystemSection />
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: '12.5px', color: theme.textFaint }}>{active} settings — coming soon.</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function SystemSection() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    window.ssmVms.settings.get().then(setSettings);
  }, []);

  async function toggleHardwareAcceleration(): Promise<void> {
    if (!settings) return;
    const updated = await window.ssmVms.settings.set({ hardwareAcceleration: !settings.hardwareAcceleration });
    setSettings(updated);
  }

  if (!settings) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '13px', color: theme.text, fontWeight: 600 }}>Hardware GPU Decoding</div>
            <div style={{ fontSize: '11.5px', color: theme.textMuted, marginTop: '0.2rem', maxWidth: '340px' }}>
              Uses the graphics card to accelerate rendering. Turn this off on underpowered or virtualized machines
              if the app feels unstable.
            </div>
          </div>
          <Toggle checked={settings.hardwareAcceleration} onChange={toggleHardwareAcceleration} />
        </div>
        <div style={{ fontSize: '11px', color: theme.textFaint, marginTop: '0.5rem' }}>
          Takes effect after restarting the app.
        </div>
      </div>

      <button
        onClick={async () => {
          setRestarting(true);
          await window.ssmVms.system.restart();
        }}
        disabled={restarting}
        style={{
          alignSelf: 'flex-start',
          padding: '0.45rem 0.9rem',
          borderRadius: '5px',
          border: `1px solid ${theme.borderLight}`,
          background: 'transparent',
          color: theme.text,
          fontSize: '12.5px',
          cursor: 'pointer',
        }}
      >
        {restarting ? 'Restarting…' : 'Restart Now'}
      </button>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      style={{
        width: '38px',
        height: '20px',
        borderRadius: '10px',
        border: 'none',
        background: checked ? theme.accent : theme.surface,
        position: 'relative',
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'background 120ms ease',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: '2px',
          left: checked ? '20px' : '2px',
          width: '16px',
          height: '16px',
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 120ms ease',
        }}
      />
    </button>
  );
}
