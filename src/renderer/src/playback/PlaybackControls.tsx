import type { CSSProperties, ReactNode } from 'react';
import { theme } from '../theme';

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {children}
    </div>
  );
}

export function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
      <span style={{ width: '7px', height: '7px', borderRadius: '2px', background: color }} />
      {label}
    </div>
  );
}

export function ZoomButton({ disabled, onClick, children }: { disabled?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{
        width: '16px',
        height: '16px',
        borderRadius: '3px',
        border: `1px solid ${theme.border}`,
        background: 'transparent',
        color: disabled ? theme.textFaint : theme.textMuted,
        fontSize: '11px',
        lineHeight: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function ToolbarIconButton({
  title,
  disabled,
  danger,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const restColor = disabled ? theme.textFaint : danger ? theme.danger : theme.textMuted;
  const hoverColor = danger ? theme.danger : theme.text;
  const style: CSSProperties = {
    minWidth: '26px',
    height: '26px',
    padding: '0 0.35rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '4px',
    border: 'none',
    background: 'none',
    color: restColor,
    fontSize: '13px',
    fontWeight: danger ? 700 : 400,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={style}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.color = hoverColor;
      }}
      onMouseLeave={(e) => {
        if (!disabled) e.currentTarget.style.color = restColor;
      }}
    >
      {children}
    </button>
  );
}

// Deliberately larger and filled (not the small flat ToolbarIconButton
// style) — this is the main playback control cluster (play/pause,
// frame-step, stop, speed, sync, clip markers), and needs to visually read
// as "the main controls" at a glance rather than blend in with the smaller
// utility icons (layout/close-all/CPU-mem) around it. `primary` gives
// play/pause an accent fill so it's the first thing the eye lands on,
// matching how most media players treat their play button.
export function TransportButton({
  title,
  disabled,
  primary,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  primary?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const style: CSSProperties = {
    minWidth: '40px',
    height: '40px',
    padding: '0 0.5rem',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '8px',
    border: primary ? 'none' : `1px solid ${theme.border}`,
    background: disabled ? theme.surface : primary ? theme.accent : theme.surface,
    color: disabled ? theme.textFaint : primary ? theme.accentText : theme.text,
    fontSize: '16px',
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    flexShrink: 0,
    transition: 'background 100ms ease',
  };
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={style}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = primary ? theme.accentHover : theme.surfaceHover;
      }}
      onMouseLeave={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = primary ? theme.accent : theme.surface;
      }}
    >
      {children}
    </button>
  );
}

export const searchButtonStyle: CSSProperties = {
  padding: '0.5rem',
  borderRadius: '5px',
  border: 'none',
  background: theme.accent,
  color: theme.accentText,
  fontSize: '12.5px',
  fontWeight: 600,
  cursor: 'pointer',
};

export const secondaryButtonStyle: CSSProperties = {
  padding: '0.5rem',
  borderRadius: '5px',
  border: `1px solid ${theme.borderLight}`,
  background: 'transparent',
  color: theme.text,
  fontSize: '12.5px',
  cursor: 'pointer',
  flex: 1,
};

export const popupInputStyle: CSSProperties = {
  padding: '0.5rem 0.6rem',
  borderRadius: '5px',
  border: `1px solid ${theme.border}`,
  background: theme.surface,
  color: theme.text,
  fontSize: '13px',
  outline: 'none',
};
