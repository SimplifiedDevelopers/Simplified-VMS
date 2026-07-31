import { useEffect, useState } from 'react';
import { THEME_CHANGE_EVENT, getCurrentThemeMode } from '../theme';
import logoWhite from '../assets/logo-white.png';
import logoNavy from '../assets/logo-navy.png';

// `variant="auto"` swaps to the navy logo in light mode (the white variant
// is unreadable against a light background) — every screen using this
// component follows the persisted theme, including Splash/Login/Setup,
// since those now inherit the same light/dark background as everywhere
// else (theme.ts is CSS-variable based across the whole app). Defaults to
// plain white so any future call site has to opt in deliberately.
export function Logo({ height = 24, variant = 'white' }: { height?: number; variant?: 'white' | 'auto' }) {
  const [mode, setMode] = useState(getCurrentThemeMode());

  useEffect(() => {
    if (variant !== 'auto') return;
    function onThemeChange(): void {
      setMode(getCurrentThemeMode());
    }
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
  }, [variant]);

  const src = variant === 'auto' && mode === 'light' ? logoNavy : logoWhite;
  return <img src={src} alt="SSM" style={{ height, width: 'auto', flexShrink: 0 }} />;
}
