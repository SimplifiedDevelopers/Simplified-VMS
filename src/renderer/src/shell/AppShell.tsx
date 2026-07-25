import { useState } from 'react';
import { theme } from '../theme';
import { Logo } from '../screens/Splash';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ControlPanel } from './ControlPanel';
import { LiveView } from '../liveView/LiveView';
import { Playback } from '../playback/Playback';
import { DeviceManagement } from '../devices/DeviceManagement';
import { SettingsModal } from '../settings/SettingsModal';

export type TabKind = 'controlPanel' | 'liveView' | 'playback' | 'deviceManagement';

const TAB_TITLES: Record<TabKind, string> = {
  controlPanel: 'Control Panel',
  liveView: 'Live View',
  playback: 'Playback',
  deviceManagement: 'Device Management',
};

interface Props {
  onLoggedOut: () => void;
}

export function AppShell({ onLoggedOut }: Props) {
  const [openTabs, setOpenTabs] = useState<TabKind[]>(['controlPanel']);
  const [activeTab, setActiveTab] = useState<TabKind>('controlPanel');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  function openTab(kind: TabKind): void {
    setOpenTabs((prev) => (prev.includes(kind) ? prev : [...prev, kind]));
    setActiveTab(kind);
  }

  function closeTab(kind: TabKind): void {
    setOpenTabs((prev) => prev.filter((t) => t !== kind));
    if (activeTab === kind) setActiveTab('controlPanel');
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: theme.bg }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          height: '46px',
          flexShrink: 0,
          background: theme.panel,
          borderBottom: `1px solid ${theme.border}`,
          padding: '0 0.75rem',
          gap: '0.6rem',
        }}
      >
        <Logo height={22} />
        <span
          style={{
            fontSize: '10.5px',
            fontWeight: 700,
            color: theme.accentHover,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            marginRight: '0.75rem',
          }}
        >
          VMS
        </span>

        <div style={{ display: 'flex', alignItems: 'stretch', height: '100%', flex: 1, overflowX: 'auto' }}>
          {openTabs.map((tab) => (
            <div
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0 0.9rem',
                fontSize: '12.5px',
                cursor: 'pointer',
                color: activeTab === tab ? theme.text : theme.textMuted,
                borderBottom: activeTab === tab ? `2px solid ${theme.accent}` : '2px solid transparent',
                whiteSpace: 'nowrap',
              }}
            >
              {TAB_TITLES[tab]}
              {tab !== 'controlPanel' && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab);
                  }}
                  style={{ color: theme.textFaint, fontSize: '13px', lineHeight: 1 }}
                >
                  &times;
                </span>
              )}
            </div>
          ))}
        </div>

        <IconButton title="Settings" onClick={() => setSettingsOpen(true)}>
          &#9881;
        </IconButton>
        <IconButton title="Log out" onClick={() => setConfirmLogout(true)}>
          &#9211;
        </IconButton>
      </div>

      <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {activeTab === 'controlPanel' && <ControlPanel onOpen={openTab} />}
        {activeTab === 'liveView' && <LiveView />}
        {activeTab === 'playback' && <Playback />}
        {activeTab === 'deviceManagement' && <DeviceManagement />}
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}

      {confirmLogout && (
        <ConfirmDialog
          title="Message"
          message="Are you sure you want to log out?"
          onCancel={() => setConfirmLogout(false)}
          onConfirm={() => {
            setConfirmLogout(false);
            onLoggedOut();
          }}
        />
      )}
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: string }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '28px',
        height: '28px',
        borderRadius: '5px',
        border: 'none',
        background: 'none',
        color: theme.textMuted,
        fontSize: '14px',
        cursor: 'pointer',
        flexShrink: 0,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = theme.text)}
      onMouseLeave={(e) => (e.currentTarget.style.color = theme.textMuted)}
    >
      {children}
    </button>
  );
}
