import { useEffect, useRef, useState, type ReactNode } from 'react';
import { theme, applyThemeMode, getCurrentThemeMode, THEME_CHANGE_EVENT } from '../theme';
import type { PopoutTabKind, ThemeMode } from '../../../shared/types';
import { Logo } from '../screens/Splash';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ControlPanel } from './ControlPanel';
import { LiveView } from '../liveView/LiveView';
import { Playback } from '../playback/Playback';
import { DeviceManagement } from '../devices/DeviceManagement';
import { SettingsModal } from '../settings/SettingsModal';
import { AboutModal } from './AboutModal';
import { SunIcon, MoonIcon, InfoIcon } from './icons';

// Set by the Broadvoice chat teaser script in index.html - lets it stay
// vanilla JS/DOM (outside React's tree, since it wraps a third-party
// widget) while still following activeTab below.
declare global {
  interface Window {
    setChatWidgetVisible?: (visible: boolean) => void;
  }
}

export type TabKind = 'controlPanel' | PopoutTabKind;

const TAB_TITLES: Record<TabKind, string> = {
  controlPanel: 'Home',
  liveView: 'Live View',
  playback: 'Playback',
  deviceManagement: 'Device Management',
};

export function AppShell() {
  const [openTabs, setOpenTabs] = useState<TabKind[]>(['controlPanel']);
  const [activeTab, setActiveTab] = useState<TabKind>('controlPanel');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  // The header icon reflects the actual RESOLVED appearance, not the raw
  // configured setting — themeMode can be 'auto', which isn't a real visual
  // state on its own. Kept live via THEME_CHANGE_EVENT since the theme can
  // now change from elsewhere too (Settings' Others tab, or the OS itself
  // when set to Automatic), not just this header's own toggle.
  const [resolvedThemeMode, setResolvedThemeMode] = useState<'light' | 'dark'>('dark');
  const [aboutOpen, setAboutOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // The whole auth flow (checking for an admin account, first-run setup,
  // login, logout) now lives here instead of a separate full-screen phase
  // per step in App.tsx — the Home tab's main body renders whichever step
  // is needed. Every OTHER tab is gated behind loggedIn: activeTab is
  // forced back to 'controlPanel' on logout, and tab-switching is blocked
  // while logged out, so stepping away from the desk and logging back in
  // behaves like a lock screen rather than a full session reset.
  const [hasAdmin, setHasAdmin] = useState<boolean | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const lastActiveTabBeforeLock = useRef<TabKind>('controlPanel');
  // False only for the one Login screen shown immediately after an explicit
  // logout — stops a saved Auto Login from instantly re-authenticating past
  // the screen the user just deliberately returned to (see Login.tsx's
  // matching doc comment). Reset back to true once logged in again, ready
  // for the next logout/login cycle.
  const [allowAutoLogin, setAllowAutoLogin] = useState(true);
  // "Start App" (settings.restoreLiveViewOnStart) should only ever act once
  // per app launch — not on every lock/unlock mid-session, which would
  // otherwise reopen a Live View tab the user had deliberately closed.
  const hasHandledStartupRestore = useRef(false);

  useEffect(() => {
    window.ssmVms.auth.status().then((status) => setHasAdmin(status.hasAdminAccount));
  }, []);

  // The main process holds the close (header button, OS close control, or
  // taskbar) until this fires — shown as the same themed dialog used
  // elsewhere in the app instead of a native OS confirm box.
  useEffect(() => {
    return window.ssmVms.system.onRequestCloseConfirm(() => setConfirmQuit(true));
  }, []);

  // Chat widget only makes sense on the Home page — hidden everywhere else.
  useEffect(() => {
    window.setChatWidgetVisible?.(activeTab === 'controlPanel');
  }, [activeTab]);

  useEffect(() => {
    window.ssmVms.system.isWindowMaximized().then(setWindowMaximized);
    return window.ssmVms.system.onWindowMaximizedChanged(setWindowMaximized);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setResolvedThemeMode(getCurrentThemeMode());
    function onThemeChange(): void {
      setResolvedThemeMode(getCurrentThemeMode());
    }
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
  }, []);

  // Always picks an explicit light/dark choice (breaking out of "Automatic"
  // if that was configured) — the header's quick-toggle only ever has two
  // states; the 3-way Light/Dark/Automatic control lives in Settings'
  // Others tab.
  async function toggleThemeMode(): Promise<void> {
    const next: ThemeMode = resolvedThemeMode === 'dark' ? 'light' : 'dark';
    applyThemeMode(next);
    await window.ssmVms.settings.set({ themeMode: next });
  }

  function handleAccountCreated(): void {
    // Matches the old Setup→Login flow: creating the account doesn't log
    // you in automatically, it just moves the Home page's main body from
    // the Setup form to the Login form.
    setHasAdmin(true);
  }

  function handleLoggedIn(): void {
    setLoggedIn(true);
    setActiveTab(lastActiveTabBeforeLock.current);
    setAllowAutoLogin(true);

    // "Start App" — only on the very first login of this app process (see
    // hasHandledStartupRestore's doc comment above). Fires after every
    // OTHER state update above, so if the setting is on this simply wins
    // and lands the user on Live View instead of wherever
    // lastActiveTabBeforeLock pointed — there's nothing meaningful to
    // return to on a fresh launch anyway (it's still just its own default,
    // 'controlPanel').
    if (!hasHandledStartupRestore.current) {
      hasHandledStartupRestore.current = true;
      window.ssmVms.settings.get().then(async (settings) => {
        if (!settings.restoreLiveViewOnStart) return;
        // Only actually worth auto-opening Live View if there's a real
        // saved grid to restore — previously navigated there
        // unconditionally whenever the setting was on, even after closing
        // the app with Live View empty (or never opened at all) that
        // session, landing on an empty grid instead of staying on Home.
        // peekLastSessionState is read-only (unlike
        // consumeStartupRestoreState below it), so checking here doesn't
        // use up the one real read LiveView's own mount effect still needs
        // once the tab actually opens.
        const saved = await window.ssmVms.liveView.peekLastSessionState();
        if (!saved || saved.tiles.length === 0) return;
        // Deliberately NOT openTab('liveView') — this callback runs after
        // the settings.get() round trip, by which point `loggedIn` in
        // THIS closure is still the stale, pre-update value from the
        // render handleLoggedIn was called in (React state updates apply
        // asynchronously), so openTab()'s own !loggedIn gate silently
        // no-ops here. Confirmed live: Start App "worked" only once the
        // user manually clicked into Live View themselves, since that's a
        // fresh call with a current, non-stale loggedIn value. We already
        // know a login just genuinely succeeded — that's the only way
        // handleLoggedIn runs at all — so setting tab state directly,
        // bypassing the gate, is correct here.
        setOpenTabs((prev) => (prev.includes('liveView') ? prev : [...prev, 'liveView']));
        setActiveTab('liveView');
      });
    }
  }

  function handleLogout(): void {
    // Deliberately does NOT clear the saved login here — Save Password is a
    // convenience pre-fill (see Login.tsx) that should survive a normal
    // logout on its own; only unchecking it (or logging in without it
    // checked) clears it, from within Login.tsx's own submit logic. Auto
    // Login is different: it's suppressed for exactly the next Login screen
    // via allowAutoLogin below, specifically so an explicit logout isn't
    // instantly undone by it — the whole reason an earlier, cruder version
    // of Auto Login had to be removed from this app before.
    lastActiveTabBeforeLock.current = activeTab;
    setLoggedIn(false);
    setActiveTab('controlPanel');
    setAllowAutoLogin(false);
  }

  function openTab(kind: TabKind): void {
    if (kind !== 'controlPanel' && !loggedIn) return;
    setOpenTabs((prev) => (prev.includes(kind) ? prev : [...prev, kind]));
    setActiveTab(kind);
  }

  function selectTab(kind: TabKind): void {
    if (kind !== 'controlPanel' && !loggedIn) return;
    setActiveTab(kind);
  }

  function closeTab(kind: TabKind): void {
    setOpenTabs((prev) => prev.filter((t) => t !== kind));
    if (activeTab === kind) setActiveTab('controlPanel');
  }

  // Drag-to-detach: dropping a tab outside the main window's bounds pops it
  // into its own standalone window (see main/ipc/windows.ts) and removes it
  // from here — reusing closeTab, which already correctly tears down that
  // tab's mounted Live View/Playback sessions, so nothing keeps playing in
  // both places at once. Dropping back inside the window does nothing extra
  // (no tab-reordering is implemented) — the browser's own default drag
  // behavior just reverts the tab in place.
  async function handleTabDragEnd(kind: PopoutTabKind, e: React.DragEvent): Promise<void> {
    const bounds = await window.ssmVms.system.getWindowBounds();
    const { screenX, screenY } = e;
    const outside =
      screenX < bounds.x || screenY < bounds.y || screenX > bounds.x + bounds.width || screenY > bounds.y + bounds.height;
    if (!outside) return;
    await window.ssmVms.windows.popOutTab(kind, screenX, screenY);
    closeTab(kind);
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: theme.bg }}>
      <div
        // The window is frameless (see main/index.ts) — this bar stands in
        // for the native OS title bar entirely, so it needs to be
        // draggable itself (WebkitAppRegion: 'drag'); every interactive
        // child (tabs, buttons) then opts back out with 'no-drag',
        // otherwise Electron swallows clicks on them as drag gestures.
        //
        // A true 3-column grid (not flex+spacers) so the date/time stays
        // genuinely centered regardless of how many tabs are open or how
        // wide the icon-button group is — same pattern as Playback's own
        // bottom bar.
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr auto 1fr',
          alignItems: 'center',
          height: '46px',
          flexShrink: 0,
          background: theme.panel,
          borderBottom: `1px solid ${theme.border}`,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties}
        onDoubleClick={() => window.ssmVms.system.toggleMaximizeWindow()}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', height: '100%', minWidth: 0, paddingLeft: '0.75rem' }}>
          <button
            title="www.ssmcctv.com"
            onClick={() => window.ssmVms.system.openCompanyLink('website')}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: 0,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              flexShrink: 0,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            <Logo height={22} variant="auto" />
          </button>

          <div
            style={{
              display: 'flex',
              alignItems: 'stretch',
              height: '100%',
              overflowX: 'auto',
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties}
          >
            {openTabs.map((tab) => (
              <div
                key={tab}
                onClick={() => selectTab(tab)}
                draggable={tab !== 'controlPanel'}
                onDragStart={(e) => e.dataTransfer.setData('text/plain', tab)}
                onDragEnd={tab !== 'controlPanel' ? (e) => handleTabDragEnd(tab, e) : undefined}
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
        </div>

        <span style={{ fontSize: '12px', color: theme.textMuted, whiteSpace: 'nowrap', padding: '0 1rem' }}>
          {now.toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
          {'  '}
          {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>

        <div
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', height: '100%', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <IconButton title={resolvedThemeMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleThemeMode}>
            {resolvedThemeMode === 'dark' ? <SunIcon /> : <MoonIcon />}
          </IconButton>
          <IconButton title="About" onClick={() => setAboutOpen(true)}>
            <InfoIcon />
          </IconButton>

          <div style={{ width: '1px', height: '20px', background: theme.border, margin: '0 0.2rem' }} />

          <IconButton title="Minimize" onClick={() => window.ssmVms.system.minimizeWindow()} square>
            &#8722;
          </IconButton>
          <IconButton
            title={windowMaximized ? 'Restore' : 'Maximize'}
            onClick={() => window.ssmVms.system.toggleMaximizeWindow()}
            square
          >
            {windowMaximized ? '❐' : '□'}
          </IconButton>
          <IconButton title="Close" onClick={() => window.ssmVms.system.closeWindow()} square danger>
            &#10005;
          </IconButton>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        {/* Every opened tab stays mounted (just hidden) instead of being
            swapped out — unmounting Live View on every tab switch was
            tearing down its live sessions (its cleanup effect stops every
            playing tile) and losing its tiles/layout state, confirmed live:
            navigating away and back always lost whatever was playing.
            Closing a tab (closeTab) still actually unmounts it, which is
            the one case where tearing down its sessions is correct. */}
        {openTabs.map((tab) => (
          <div key={tab} style={{ display: activeTab === tab ? 'block' : 'none', height: '100%' }}>
            {tab === 'controlPanel' && (
              <ControlPanel
                onOpen={openTab}
                onOpenSettings={() => setSettingsOpen(true)}
                hasAdmin={hasAdmin}
                loggedIn={loggedIn}
                allowAutoLogin={allowAutoLogin}
                onAccountCreated={handleAccountCreated}
                onLoggedIn={handleLoggedIn}
                onRequestLogout={() => setConfirmLogout(true)}
              />
            )}
            {tab === 'liveView' && <LiveView isActive={activeTab === 'liveView'} />}
            {tab === 'playback' && <Playback isActive={activeTab === 'playback'} />}
            {tab === 'deviceManagement' && <DeviceManagement />}
          </div>
        ))}
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {aboutOpen && <AboutModal onClose={() => setAboutOpen(false)} />}

      {confirmLogout && (
        <ConfirmDialog
          title="Message"
          message="Are you sure you want to log out?"
          onCancel={() => setConfirmLogout(false)}
          onConfirm={() => {
            setConfirmLogout(false);
            handleLogout();
          }}
        />
      )}

      {confirmQuit && (
        <ConfirmDialog
          title="Message"
          message="Are you sure you want to exit?"
          onCancel={() => setConfirmQuit(false)}
          onConfirm={() => {
            setConfirmQuit(false);
            window.ssmVms.system.confirmClose();
          }}
        />
      )}
    </div>
  );
}

// Exported for reuse in PopoutWindow.tsx's own slim header — same
// minimize/maximize/close button look, since both windows are frameless
// with custom-drawn title bars.
export function IconButton({
  title,
  onClick,
  children,
  square,
  danger,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  // Window-control buttons (minimize/maximize/close) sit flush against the
  // header, full height, no rounding — matching real title-bar buttons —
  // instead of the normal rounded icon-button look.
  square?: boolean;
  // Close gets the conventional red hover, distinct from the other
  // (non-destructive) window controls next to it.
  danger?: boolean;
}) {
  const restColor = theme.textMuted;
  const hoverColor = danger ? '#fff' : theme.text;
  const hoverBackground = danger ? theme.danger : theme.surfaceHover;
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: square ? '44px' : '28px',
        height: square ? '100%' : '28px',
        borderRadius: square ? 0 : '5px',
        border: 'none',
        background: 'none',
        color: restColor,
        fontSize: '14px',
        cursor: 'pointer',
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = hoverColor;
        if (square) e.currentTarget.style.background = hoverBackground;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = restColor;
        if (square) e.currentTarget.style.background = 'none';
      }}
    >
      {children}
    </button>
  );
}
