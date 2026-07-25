import { useEffect, useState } from 'react';
import { theme } from '../theme';

interface Props {
  onDone: () => void;
}

const DURATION_MS = 900;

export function Splash({ onDone }: Props) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const start = performance.now();
    let frame: number;
    const tick = (now: number): void => {
      const pct = Math.min(100, Math.round(((now - start) / DURATION_MS) * 100));
      setProgress(pct);
      if (pct < 100) {
        frame = requestAnimationFrame(tick);
      } else {
        onDone();
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1.75rem',
        background: theme.bg,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <Logo size={40} />
        <span style={{ fontSize: '22px', fontWeight: 700, color: theme.text, letterSpacing: '0.01em' }}>
          SSM VMS
        </span>
      </div>
      <div style={{ width: '260px' }}>
        <div
          style={{
            height: '4px',
            borderRadius: '2px',
            background: theme.surface,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${progress}%`,
              background: theme.accent,
              transition: 'width 60ms linear',
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: `radial-gradient(circle at 35% 30%, ${theme.accentHover}, ${theme.accentPressed} 70%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow: `0 0 0 2px ${theme.border}`,
      }}
    >
      <div
        style={{
          width: size * 0.4,
          height: size * 0.4,
          borderRadius: '50%',
          background: theme.bg,
        }}
      />
    </div>
  );
}
