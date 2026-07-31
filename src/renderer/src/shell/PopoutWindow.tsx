import { useEffect, useState } from 'react';
import { theme } from '../theme';
import { LiveView } from '../liveView/LiveView';
import { Playback } from '../playback/Playback';
import { DeviceManagement } from '../devices/DeviceManagement';
import { IconButton } from './AppShell';
import type { PopoutTabKind } from '../../../shared/types';

const TITLES: Record<PopoutTabKind, string> = {
  liveView: 'Live View',
  playback: 'Playback',
  deviceManagement: 'Device Management',
};

// Rendered instead of AppShell when this window was spawned by dragging a
// tab out of the main window (see AppShell.tsx's onDragEnd and
// main/ipc/windows.ts) — just that one tab's content, full-bleed, under a
// slim header matching AppShell's own (this window is frameless too, see
// windows.ts — the native OS title bar looked out of place next to the
// app's dark chrome). No tab strip here since a pop-out only ever shows one
// tab; the title text stands in for it.
export function PopoutWindow({ kind }: { kind: PopoutTabKind }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    document.title = `${TITLES[kind]} — Simplified VMS`;
  }, [kind]);

  useEffect(() => {
    window.ssmVms.system.isWindowMaximized().then(setMaximized);
    return window.ssmVms.system.onWindowMaximizedChanged(setMaximized);
  }, []);

  // The chat widget (see index.html) belongs only to the main window's Home
  // page — this window loads the same renderer bundle, so without this it
  // would show up here too. There's no Home page in a pop-out window to
  // toggle it back on, so this is unconditional, unlike AppShell's own
  // activeTab-based toggle.
  useEffect(() => {
    window.setChatWidgetVisible?.(false);
  }, []);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: theme.bg }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: '46px',
          flexShrink: 0,
          background: theme.panel,
          borderBottom: `1px solid ${theme.border}`,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
        onDoubleClick={() => window.ssmVms.system.toggleMaximizeWindow()}
      >
        <span style={{ fontSize: '12.5px', color: theme.text, paddingLeft: '0.9rem' }}>{TITLES[kind]}</span>

        <div style={{ display: 'flex', alignItems: 'center', height: '100%', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <IconButton title="Minimize" onClick={() => window.ssmVms.system.minimizeWindow()} square>
            &#8722;
          </IconButton>
          <IconButton title={maximized ? 'Restore' : 'Maximize'} onClick={() => window.ssmVms.system.toggleMaximizeWindow()} square>
            {maximized ? '❐' : '□'}
          </IconButton>
          <IconButton title="Close" onClick={() => window.ssmVms.system.closeWindow()} square danger>
            &#10005;
          </IconButton>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {kind === 'liveView' && <LiveView />}
        {kind === 'playback' && <Playback />}
        {kind === 'deviceManagement' && <DeviceManagement />}
      </div>
    </div>
  );
}
