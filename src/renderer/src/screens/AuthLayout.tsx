import type { ReactNode } from 'react';
import { theme } from '../theme';
import { Logo } from './Splash';

interface Props {
  children: ReactNode;
}

export function AuthLayout({ children }: Props) {
  return (
    <div style={{ height: '100vh', display: 'flex', background: theme.bg }}>
      <div
        style={{
          width: '38%',
          minWidth: '320px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '2rem',
          background: theme.panel,
          borderRight: `1px solid ${theme.border}`,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', zIndex: 1 }}>
          <Logo size={30} />
          <span style={{ fontSize: '16px', fontWeight: 700, color: theme.text }}>SSM VMS</span>
        </div>

        <div style={{ zIndex: 1, display: 'flex', justifyContent: 'center' }}>
          <CameraGridGlyph />
        </div>

        <div style={{ fontSize: '11.5px', color: theme.textFaint, zIndex: 1 }}>
          Unified live view &amp; playback across your camera fleet
        </div>

        <BackgroundGlow />
      </div>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: '340px' }}>{children}</div>
      </div>
    </div>
  );
}

function CameraGridGlyph() {
  const cells = Array.from({ length: 9 });
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '10px',
        width: '160px',
      }}
    >
      {cells.map((_, i) => (
        <div
          key={i}
          style={{
            aspectRatio: '1',
            borderRadius: '4px',
            border: `1px solid ${theme.borderLight}`,
            background: i === 4 ? `${theme.accent}22` : 'transparent',
            boxShadow: i === 4 ? `0 0 0 1px ${theme.accent}` : undefined,
          }}
        />
      ))}
    </div>
  );
}

function BackgroundGlow() {
  return (
    <div
      style={{
        position: 'absolute',
        width: '420px',
        height: '420px',
        borderRadius: '50%',
        background: `radial-gradient(circle, ${theme.accent}14, transparent 70%)`,
        bottom: '-200px',
        left: '-140px',
        pointerEvents: 'none',
      }}
    />
  );
}
