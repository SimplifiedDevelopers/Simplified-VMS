import { useEffect, useState } from 'react';
import { theme, THEME_CHANGE_EVENT, getCurrentThemeMode } from '../theme';
import { Logo } from '../screens/Splash';
import { Setup } from '../screens/Setup';
import { Login } from '../screens/Login';
import type { TabKind } from './AppShell';
import type { DeviceConnectionStatus, StoredDevice, SystemStats } from '../../../shared/types';
import teamViewerWhite from '../assets/teamviewer-white.png';
import teamViewerNavy from '../assets/teamviewer-navy.png';

interface Props {
  onOpen: (kind: TabKind) => void;
  onOpenSettings: () => void;
  hasAdmin: boolean | null;
  loggedIn: boolean;
  allowAutoLogin: boolean;
  onAccountCreated: () => void;
  onLoggedIn: () => void;
  onRequestLogout: () => void;
}

interface NavItem {
  title: string;
  description: string;
  glyph: string;
  onClick?: () => void;
  // IVS has no page built yet (explicit choice — nav item only, wired up
  // once there's something behind it) so it stays disabled regardless of
  // login state, not just while logged out like the rest of the list.
  alwaysDisabled?: boolean;
}

export function ControlPanel({
  onOpen,
  onOpenSettings,
  hasAdmin,
  loggedIn,
  allowAutoLogin,
  onAccountCreated,
  onLoggedIn,
  onRequestLogout,
}: Props) {
  const navItems: NavItem[] = [
    { title: 'Live View', description: 'View live video from your cameras.', glyph: '▦', onClick: () => onOpen('liveView') },
    { title: 'Playback', description: 'Search for and play back recordings.', glyph: '▶', onClick: () => onOpen('playback') },
    {
      title: 'IVS',
      description: 'Human, vehicle, LPR & other AI detections.',
      glyph: '◎',
      alwaysDisabled: true,
    },
    {
      title: 'Device Management',
      description: 'Add, edit, and remove DVR/NVR devices.',
      glyph: '⚙',
      onClick: () => onOpen('deviceManagement'),
    },
    {
      title: 'System Configuration',
      description: 'App settings and preferences.',
      glyph: '⛭',
      onClick: onOpenSettings,
    },
  ];

  return (
    <div style={{ height: '100%', display: 'flex' }}>
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1.5rem',
          padding: '2rem',
          overflowY: 'auto',
        }}
      >
        <div style={{ width: '380px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem' }}>
          <Logo height={84} variant="auto" />

          <div style={{ width: '100%' }}>
            {hasAdmin === null && <LoadingBox />}
            {hasAdmin === false && <Setup onCreated={onAccountCreated} />}
            {hasAdmin === true && !loggedIn && <Login onLoggedIn={onLoggedIn} allowAutoLogin={allowAutoLogin} />}
            {hasAdmin === true && loggedIn && <LoggedInPanel onRequestLogout={onRequestLogout} />}
          </div>

          <CompanyInfo />

          <DevicesStatus loggedIn={loggedIn} />

          <SystemStatus />
        </div>
      </div>

      <div
        style={{
          width: '340px',
          flexShrink: 0,
          borderLeft: `1px solid ${theme.border}`,
          padding: '1.75rem 1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.85rem',
          overflowY: 'auto',
        }}
      >
        <div style={{ fontSize: '11.5px', fontWeight: 600, color: theme.textMuted, marginBottom: '0.3rem' }}>MODULES</div>
        {navItems.map((item) => (
          <NavButton key={item.title} item={item} disabled={item.alwaysDisabled || !loggedIn} />
        ))}
      </div>
    </div>
  );
}

function NavButton({ item, disabled }: { item: NavItem; disabled: boolean }) {
  return (
    <button
      onClick={item.onClick}
      disabled={disabled}
      title={item.alwaysDisabled ? 'Coming soon' : disabled ? 'Log in to use this' : undefined}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.9rem',
        padding: '1.1rem 1.1rem',
        borderRadius: '10px',
        border: `1px solid ${theme.border}`,
        background: theme.panel,
        color: theme.text,
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        width: '100%',
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.borderColor = theme.accent;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = theme.border;
      }}
    >
      <span style={{ fontSize: '26px', color: theme.accentHover, flexShrink: 0, width: '30px', textAlign: 'center' }}>
        {item.glyph}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 0 }}>
        <span style={{ fontSize: '14px', fontWeight: 600 }}>{item.title}</span>
        <span style={{ fontSize: '11.5px', color: theme.textMuted, lineHeight: 1.4 }}>{item.description}</span>
      </span>
    </button>
  );
}

// The small rectangle standing in for the old full-screen Splash — the auth
// check it waits on is a near-instant local lookup, so this is normally on
// screen only very briefly.
function LoadingBox() {
  return (
    <div
      style={{
        border: `1px solid ${theme.border}`,
        borderRadius: '8px',
        background: theme.panel,
        padding: '2rem 1.5rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span style={{ fontSize: '12px', color: theme.textMuted }}>Loading…</span>
    </div>
  );
}

// Permanent auth widget — always occupies the same spot in the main body
// (Login form when logged out, this panel when logged in) rather than
// disappearing once authenticated, so the page's layout doesn't shift
// around depending on auth state.
function LoggedInPanel({ onRequestLogout }: { onRequestLogout: () => void }) {
  return (
    <div
      style={{
        border: `1px solid ${theme.border}`,
        borderRadius: '8px',
        background: theme.panel,
        padding: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '1rem',
      }}
    >
      <span style={{ fontSize: '13px', fontWeight: 600, color: theme.success }}>&#10003; Logged in</span>
      <button onClick={onRequestLogout} style={secondaryButtonStyle}>
        Log Out
      </button>
    </div>
  );
}

// system:stats is broadcast from the main process unconditionally from app
// startup (see main/index.ts's startStatsBroadcast call, outside any auth
// check) — so unlike DevicesStatus below, this never gates on loggedIn: CPU
// and memory are host-machine stats, not device data, and staff wanted them
// visible/reporting on Home even before logging in.
function SystemStatus() {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => window.ssmVms.system.onStats(setStats), []);

  return (
    <div
      style={{
        width: '100%',
        border: `1px solid ${theme.border}`,
        borderRadius: '8px',
        background: theme.panel,
        padding: '0.85rem 1.25rem',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <span style={{ fontSize: '10.5px', fontWeight: 600, color: theme.textMuted }}>SYSTEM RESOURCES</span>
      <div style={{ display: 'flex', gap: '1.25rem' }}>
        <span style={{ fontSize: '11px', color: theme.textFaint, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          CPU
          <strong style={{ color: stats ? resourceLevelColor(stats.cpuPercent) : theme.textMuted, fontWeight: 700 }}>
            {stats ? `${stats.cpuPercent}%` : '—'}
          </strong>
        </span>
        <span style={{ fontSize: '11px', color: theme.textFaint, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          Memory
          <strong style={{ color: stats ? resourceLevelColor(stats.memPercent) : theme.textMuted, fontWeight: 700 }}>
            {stats ? `${stats.memPercent}%` : '—'}
          </strong>
        </span>
      </div>
    </div>
  );
}

function resourceLevelColor(percent: number): string {
  if (percent >= 85) return theme.danger;
  if (percent >= 60) return theme.warning;
  return theme.success;
}

// Reuses the exact same status data Device Management and Live View already
// track (connectionManager's persistent per-device sessions) — no new
// backend needed, just another subscriber to devices.onStatusChanged.
// Always rendered (unlike the old Fleet Status, which only existed once
// logged in) — just grayed out while logged out, matching the rest of the
// page's "everything visible, functionality gated" approach.
function DevicesStatus({ loggedIn }: { loggedIn: boolean }) {
  const [devices, setDevices] = useState<StoredDevice[]>([]);
  const [statusById, setStatusById] = useState<Record<string, DeviceConnectionStatus | undefined>>({});

  useEffect(() => {
    if (!loggedIn) return;
    window.ssmVms.devices.list().then((list) => {
      setDevices(list);
      list.forEach((d) => {
        window.ssmVms.devices.getStatus(d.id).then((status) => {
          setStatusById((prev) => ({ ...prev, [d.id]: status }));
        });
      });
    });
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn) return;
    return window.ssmVms.devices.onStatusChanged((deviceId, status) => {
      setStatusById((prev) => ({ ...prev, [deviceId]: status }));
    });
  }, [loggedIn]);

  const total = devices.length;
  const online = devices.filter((d) => statusById[d.id]?.state === 'online').length;
  const offline = devices.filter((d) => statusById[d.id]?.state === 'offline').length;

  return (
    <div
      style={{
        width: '100%',
        border: `1px solid ${theme.border}`,
        borderRadius: '8px',
        background: theme.panel,
        padding: '0.85rem 1.25rem',
        opacity: loggedIn ? 1 : 0.4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <span style={{ fontSize: '10.5px', fontWeight: 600, color: theme.textMuted }}>SYSTEMS STATUS</span>
      <div style={{ display: 'flex', gap: '1.25rem' }}>
        <MiniStat label="Total" value={total} color={theme.text} />
        <MiniStat label="Online" value={online} color={theme.success} />
        <MiniStat label="Offline" value={offline} color={theme.danger} />
      </div>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
      <span style={{ fontSize: '15px', fontWeight: 700, color }}>{value}</span>
      <span style={{ fontSize: '10px', color: theme.textFaint }}>{label}</span>
    </div>
  );
}

function CompanyInfo() {
  return (
    <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem' }}>
      <span style={{ fontSize: '12.5px', fontWeight: 600, color: theme.text }}>Security Systems &amp; More</span>
      <CompanyLink kind="phone" label="(561) 693-2624" />
      <CompanyLink kind="website" label="www.ssmcctv.com" />
      <CompanyLink kind="email" label="office@ssmcctv.com" />
      <button
        onClick={() => window.ssmVms.system.openCompanyLink('support')}
        style={{
          marginTop: '0.5rem',
          padding: 0,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
        }}
        title="Request Remote Support"
      >
        <TeamViewerBanner />
      </button>
    </div>
  );
}

// Swaps to the navy variant in light mode, same convention as Logo (see
// Splash.tsx) — the white variant is unreadable against a light background.
function TeamViewerBanner() {
  const [mode, setMode] = useState(getCurrentThemeMode());

  useEffect(() => {
    function onThemeChange(): void {
      setMode(getCurrentThemeMode());
    }
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
  }, []);

  return <img src={mode === 'light' ? teamViewerNavy : teamViewerWhite} alt="TeamViewer" style={{ height: '20px', width: 'auto' }} />;
}

function CompanyLink({ kind, label }: { kind: 'website' | 'email' | 'phone'; label: string }) {
  return (
    <button
      onClick={() => window.ssmVms.system.openCompanyLink(kind)}
      style={{ background: 'none', border: 'none', padding: 0, color: theme.textMuted, fontSize: '11px', cursor: 'pointer' }}
      onMouseEnter={(e) => (e.currentTarget.style.color = theme.accentHover)}
      onMouseLeave={(e) => (e.currentTarget.style.color = theme.textMuted)}
    >
      {label}
    </button>
  );
}

const secondaryButtonStyle = {
  padding: '0.45rem 0.9rem',
  borderRadius: '5px',
  border: `1px solid ${theme.borderLight}`,
  background: 'transparent',
  color: theme.text,
  fontSize: '11.5px',
  cursor: 'pointer',
};
