import { useEffect, useState } from 'react';
import { theme, applyThemeMode } from '../theme';
import { Modal } from '../components/Modal';
import { Logo } from '../screens/Splash';
import type { AppSettings, BackupResult, ThemeMode, UpdateStatus } from '../../../shared/types';

const SECTIONS = ['System', 'Video', 'Backup/Restore', 'About'];

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

      <div style={{ display: 'flex', height: '520px' }}>
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
                background: active === section ? theme.accentFaint : 'transparent',
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

        <div style={{ flex: 1, padding: '1.25rem 1.25rem 3rem', display: 'flex', overflowY: 'auto' }}>
          {active === 'System' && <SystemSection />}
          {active === 'Video' && <VideoSection />}
          {active === 'Backup/Restore' && <BackupRestoreSection />}
          {active === 'About' && <AboutSection />}
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

  async function handleThemeChange(themeMode: ThemeMode): Promise<void> {
    if (!settings) return;
    applyThemeMode(themeMode);
    const updated = await window.ssmVms.settings.set({ themeMode });
    setSettings(updated);
  }

  async function toggleRestoreLiveViewOnStart(): Promise<void> {
    if (!settings) return;
    const updated = await window.ssmVms.settings.set({ restoreLiveViewOnStart: !settings.restoreLiveViewOnStart });
    setSettings(updated);
  }

  async function toggleHardwareAcceleration(): Promise<void> {
    if (!settings) return;
    const updated = await window.ssmVms.settings.set({ hardwareAcceleration: !settings.hardwareAcceleration });
    setSettings(updated);
  }

  async function toggleUniviewGpuDecode(): Promise<void> {
    if (!settings) return;
    const updated = await window.ssmVms.settings.set({ univiewGpuDecode: !settings.univiewGpuDecode });
    setSettings(updated);
  }

  async function toggleAutoConnectAllDevices(): Promise<void> {
    if (!settings) return;
    const updated = await window.ssmVms.settings.set({ autoConnectAllDevices: !settings.autoConnectAllDevices });
    setSettings(updated);
  }

  if (!settings) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', width: '100%' }}>
      <SettingsField label="Theme">
        <SegmentedControl
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'auto', label: 'Automatic' },
          ]}
          value={settings.themeMode}
          onChange={handleThemeChange}
        />
      </SettingsField>

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

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '13px', color: theme.text, fontWeight: 600 }}>Uniview Decode Acceleration</div>
            <div style={{ fontSize: '11.5px', color: theme.textMuted, marginTop: '0.2rem', maxWidth: '340px' }}>
              Lets Uniview devices use GPU-accelerated video decoding (separate from the rendering setting above).
              Turn this off if playback or live view struggles on a machine without a real GPU.
            </div>
          </div>
          <Toggle checked={settings.univiewGpuDecode} onChange={toggleUniviewGpuDecode} />
        </div>
        <div style={{ fontSize: '11px', color: theme.textFaint, marginTop: '0.5rem' }}>
          Takes effect after restarting the app.
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '13px', color: theme.text, fontWeight: 600 }}>Auto-Connect All Devices</div>
            <div style={{ fontSize: '11.5px', color: theme.textMuted, marginTop: '0.2rem', maxWidth: '340px' }}>
              Logs into every saved device on startup and keeps them alive. Turn this off if you've added a large
              number of devices you only need to pull up occasionally — devices still connect on demand when you
              open them, or via "Refresh Status" in Device Management.
            </div>
          </div>
          <Toggle checked={settings.autoConnectAllDevices} onChange={toggleAutoConnectAllDevices} />
        </div>
        <div style={{ fontSize: '11px', color: theme.textFaint, marginTop: '0.5rem' }}>
          Takes effect after restarting the app.
        </div>
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '13px', color: theme.text, fontWeight: 600 }}>Start App</div>
            <div style={{ fontSize: '11.5px', color: theme.textMuted, marginTop: '0.2rem', maxWidth: '340px' }}>
              Opens Live View with the same layout and channels that were playing when the app was last closed.
              With Auto Login also enabled (see the login screen's checkboxes), this happens automatically with no
              clicks needed — otherwise the layout is still restored, it just won't connect or play anything until
              you log in, same as every other tab.
            </div>
          </div>
          <Toggle checked={settings.restoreLiveViewOnStart} onChange={toggleRestoreLiveViewOnStart} />
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

// Only playMainStreamInSingleView and defaultStreamType have any bearing on
// existing Live View code today (its layout===1?'main':'sub' logic), and
// even those aren't wired up to read from these yet — stored/persisted now,
// functionality to follow, per the user's own explicit call.
function VideoSection() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browsingExport, setBrowsingExport] = useState(false);
  const [browsingLocalRecording, setBrowsingLocalRecording] = useState(false);

  useEffect(() => {
    window.ssmVms.settings.get().then(setSettings);
  }, []);

  async function update(partial: Partial<AppSettings>): Promise<void> {
    const updated = await window.ssmVms.settings.set(partial);
    setSettings(updated);
  }

  async function handleBrowse(): Promise<void> {
    setBrowsing(true);
    try {
      const path = await window.ssmVms.settings.chooseSnapshotFolder();
      if (path) await update({ snapshotPath: path });
    } finally {
      setBrowsing(false);
    }
  }

  async function handleBrowseExport(): Promise<void> {
    setBrowsingExport(true);
    try {
      const path = await window.ssmVms.settings.chooseExportFolder();
      if (path) await update({ exportPath: path });
    } finally {
      setBrowsingExport(false);
    }
  }

  async function handleBrowseLocalRecording(): Promise<void> {
    setBrowsingLocalRecording(true);
    try {
      const path = await window.ssmVms.settings.chooseLocalRecordingFolder();
      if (path) await update({ localRecordingPath: path });
    } finally {
      setBrowsingLocalRecording(false);
    }
  }

  if (!settings) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem', width: '100%' }}>
      <SettingsField label="Play Mode">
        <SegmentedControl
          options={[
            { value: 'balanced', label: 'Balanced' },
            { value: 'minDelay', label: 'Min. Delay' },
            { value: 'fluent', label: 'Fluent' },
          ]}
          value={settings.playMode}
          onChange={(playMode) => update({ playMode })}
        />
      </SettingsField>

      <SettingsField label="Stream Type">
        <SegmentedControl
          options={[
            { value: 'main', label: 'Main' },
            { value: 'sub', label: 'Sub' },
          ]}
          value={settings.defaultStreamType}
          onChange={(defaultStreamType) => update({ defaultStreamType })}
        />
      </SettingsField>

      <SettingsField label="Playback Mode">
        <SegmentedControl
          options={[
            { value: 'hd', label: 'HD' },
            { value: 'sd', label: 'SD' },
          ]}
          value={settings.playbackQuality}
          onChange={(playbackQuality) => update({ playbackQuality })}
        />
      </SettingsField>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '13px', color: theme.text, fontWeight: 600 }}>Play Main Stream in 1 Channel View</span>
        <Toggle
          checked={settings.playMainStreamInSingleView}
          onChange={() => update({ playMainStreamInSingleView: !settings.playMainStreamInSingleView })}
        />
      </div>

      <SettingsField label="Snapshot Path">
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            value={settings.snapshotPath}
            readOnly
            placeholder="Not set"
            style={{
              flex: 1,
              padding: '0.5rem 0.6rem',
              borderRadius: '5px',
              border: `1px solid ${theme.border}`,
              background: theme.surface,
              color: theme.text,
              fontSize: '12.5px',
              outline: 'none',
            }}
          />
          <button
            onClick={handleBrowse}
            disabled={browsing}
            style={{
              padding: '0.45rem 0.9rem',
              borderRadius: '5px',
              border: `1px solid ${theme.borderLight}`,
              background: 'transparent',
              color: theme.text,
              fontSize: '12.5px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {browsing ? 'Choosing…' : 'Browse'}
          </button>
        </div>
      </SettingsField>

      <SettingsField label="Video Backup Path">
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            value={settings.exportPath}
            readOnly
            placeholder="Not set"
            style={{
              flex: 1,
              padding: '0.5rem 0.6rem',
              borderRadius: '5px',
              border: `1px solid ${theme.border}`,
              background: theme.surface,
              color: theme.text,
              fontSize: '12.5px',
              outline: 'none',
            }}
          />
          <button
            onClick={handleBrowseExport}
            disabled={browsingExport}
            style={{
              padding: '0.45rem 0.9rem',
              borderRadius: '5px',
              border: `1px solid ${theme.borderLight}`,
              background: 'transparent',
              color: theme.text,
              fontSize: '12.5px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {browsingExport ? 'Choosing…' : 'Browse'}
          </button>
        </div>
      </SettingsField>

      <SettingsField label="Local Recording Path">
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            value={settings.localRecordingPath}
            readOnly
            placeholder="Not set"
            style={{
              flex: 1,
              padding: '0.5rem 0.6rem',
              borderRadius: '5px',
              border: `1px solid ${theme.border}`,
              background: theme.surface,
              color: theme.text,
              fontSize: '12.5px',
              outline: 'none',
            }}
          />
          <button
            onClick={handleBrowseLocalRecording}
            disabled={browsingLocalRecording}
            style={{
              padding: '0.45rem 0.9rem',
              borderRadius: '5px',
              border: `1px solid ${theme.borderLight}`,
              background: 'transparent',
              color: theme.text,
              fontSize: '12.5px',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {browsingLocalRecording ? 'Choosing…' : 'Browse'}
          </button>
        </div>
      </SettingsField>
    </div>
  );
}

function BackupRestoreSection() {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  async function run(action: string, fn: () => Promise<BackupResult>, describe: (result: BackupResult) => string, restart = false): Promise<void> {
    setBusy(action);
    setMessage(null);
    try {
      const result = await fn();
      if (result.ok) {
        setMessage(describe(result));
        if (restart) setNeedsRestart(true);
      } else if (result.error) {
        setMessage(`Failed: ${result.error}`);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.4rem', width: '100%' }}>
      <div>
        <div style={{ fontSize: '13px', color: theme.text, fontWeight: 600, marginBottom: '0.3rem' }}>
          Backup / Restore Configuration
        </div>
        <div style={{ fontSize: '11.5px', color: theme.textMuted, marginBottom: '0.6rem', maxWidth: '400px' }}>
          Backs up every setting, saved device, and login credential into one file — restoring it brings all of
          that back, including on a different install. Passwords are stored in plain, readable text inside that
          file so it actually works on another machine, so keep it somewhere secure.
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => run('backup', () => window.ssmVms.backup.exportConfig(), () => 'Backup saved.')}
            disabled={busy !== null}
            style={secondaryButtonStyle}
          >
            {busy === 'backup' ? 'Backing up…' : 'Backup Configuration'}
          </button>
          <button
            onClick={() =>
              run(
                'restore',
                () => window.ssmVms.backup.importConfig(),
                () => 'Configuration restored.',
                true,
              )
            }
            disabled={busy !== null}
            style={secondaryButtonStyle}
          >
            {busy === 'restore' ? 'Restoring…' : 'Restore Configuration'}
          </button>
        </div>
      </div>

      <div>
        <div style={{ fontSize: '13px', color: theme.text, fontWeight: 600, marginBottom: '0.3rem' }}>
          Import / Export Devices List
        </div>
        <div style={{ fontSize: '11.5px', color: theme.textMuted, marginBottom: '0.6rem', maxWidth: '400px' }}>
          Exports just the saved devices (with real, readable passwords) to a file, or imports one back in on
          another workstation running this same app — merges into whatever's already saved there.
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <button
            onClick={() =>
              run('exportDevices', () => window.ssmVms.backup.exportDevices(), () => 'Devices list exported.')
            }
            disabled={busy !== null}
            style={secondaryButtonStyle}
          >
            {busy === 'exportDevices' ? 'Exporting…' : 'Export Devices List'}
          </button>
          <button
            onClick={() =>
              run(
                'importDevices',
                () => window.ssmVms.backup.importDevices(),
                (r) => `Imported ${r.count ?? 0} device${r.count === 1 ? '' : 's'}.`,
              )
            }
            disabled={busy !== null}
            style={secondaryButtonStyle}
          >
            {busy === 'importDevices' ? 'Importing…' : 'Import Devices List'}
          </button>
        </div>
      </div>

      {message && <div style={{ fontSize: '12px', color: theme.text }}>{message}</div>}

      {needsRestart && (
        <button
          onClick={async () => {
            setRestarting(true);
            await window.ssmVms.system.restart();
          }}
          disabled={restarting}
          style={{ ...secondaryButtonStyle, alignSelf: 'flex-start' }}
        >
          {restarting ? 'Restarting…' : 'Restart Now to Finish Restoring'}
        </button>
      )}
    </div>
  );
}

function AboutSection() {
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    window.ssmVms.system.getAppVersion().then(setVersion);
  }, []);

  useEffect(() => window.ssmVms.updates.onStatus(setStatus), []);

  const checking = status?.state === 'checking';

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.6rem',
        textAlign: 'center',
        width: '100%',
        paddingTop: '0.5rem',
      }}
    >
      <Logo height={40} variant="auto" />
      <div style={{ fontSize: '15px', fontWeight: 700, color: theme.text }}>Simplified VMS</div>
      <div style={{ fontSize: '12.5px', color: theme.textMuted }}>Version {version ?? '—'}</div>
      <div style={{ fontSize: '11.5px', color: theme.textFaint, marginTop: '0.3rem', lineHeight: 1.5 }}>
        Unified multi-vendor video management.
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

function SettingsField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: '11.5px', color: theme.textMuted, marginBottom: '0.4rem' }}>{label}</div>
      {children}
    </div>
  );
}

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: '0.4rem' }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              padding: '0.4rem 0.9rem',
              borderRadius: '5px',
              border: `1px solid ${active ? theme.accent : theme.border}`,
              background: active ? theme.accentFaint : theme.surface,
              color: active ? theme.accentHover : theme.textMuted,
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        );
      })}
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
