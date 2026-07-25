import { useEffect, useState } from 'react';
import { theme } from '../theme';
import logoWhite from '../assets/logo-white.png';

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
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem' }}>
        <Logo height={54} />
        <span
          style={{
            fontSize: '14px',
            fontWeight: 700,
            color: theme.accentHover,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
          }}
        >
          VMS
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

export function Logo({ height = 24 }: { height?: number }) {
  return <img src={logoWhite} alt="SSM" style={{ height, width: 'auto', flexShrink: 0 }} />;
}
