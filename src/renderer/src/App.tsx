import { useEffect } from 'react';
import { AppShell } from './shell/AppShell';
import { PopoutWindow } from './shell/PopoutWindow';
import { applyThemeMode, reapplyIfAuto, setSystemPrefersDark } from './theme';
import type { PopoutTabKind } from '../../shared/types';

const POPOUT_KINDS: readonly PopoutTabKind[] = ['liveView', 'playback', 'deviceManagement'];

// A window spawned by dragging a tab out of the main window (see
// AppShell.tsx's onDragEnd) loads this same renderer bundle with a
// #popout=<kind> hash instead of a fresh app instance, so it can render
// just that one tab's content rather than the full AppShell.
function getPopoutKind(): PopoutTabKind | null {
  const match = window.location.hash.match(/popout=([a-zA-Z]+)/);
  const kind = match?.[1];
  return POPOUT_KINDS.includes(kind as PopoutTabKind) ? (kind as PopoutTabKind) : null;
}

// The auth flow (checking for an admin account, first-run setup, login,
// logout) now lives entirely inside AppShell's Home tab instead of a
// separate full-screen phase per step — the app's chrome (header, tabs)
// renders immediately, and the Home page's main body shows whichever step
// is needed, so the window never visibly "jumps" between different
// full-page screens the way Splash → Setup → Login → AppShell used to.
export function App() {
  useEffect(() => {
    Promise.all([window.ssmVms.settings.get(), window.ssmVms.system.getSystemPrefersDark()]).then(
      ([settings, prefersDark]) => {
        setSystemPrefersDark(prefersDark);
        applyThemeMode(settings.themeMode);
      },
    );
    // Keeps an "Automatic" theme choice actually following the OS live,
    // rather than only picking up a change on next launch.
    const unsubscribeSystemTheme = window.ssmVms.system.onSystemThemeChanged((prefersDark) => {
      setSystemPrefersDark(prefersDark);
      reapplyIfAuto();
    });
    // Every BrowserWindow (main or a popped-out tab, see PopoutWindow below)
    // only ever read settings once, above, at its own mount time — without
    // this, changing the theme in one window left every OTHER already-open
    // window on the stale mode (confirmed live: toggling light/dark in the
    // main window didn't affect an already-detached tab). This one push
    // subscription keeps every window's theme in sync with whichever one
    // last changed it, matching every other cross-window push in this app
    // (devices:statusChanged, system:stats).
    const unsubscribeSettings = window.ssmVms.settings.onChanged((settings) => {
      applyThemeMode(settings.themeMode);
    });
    return () => {
      unsubscribeSystemTheme();
      unsubscribeSettings();
    };
  }, []);

  const popoutKind = getPopoutKind();
  return popoutKind ? <PopoutWindow kind={popoutKind} /> : <AppShell />;
}
