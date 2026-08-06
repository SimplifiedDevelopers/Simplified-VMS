import { useState, type CSSProperties } from 'react';
import { theme } from '../theme';

interface Props {
  x: number;
  y: number;
  onDismiss: () => void;
  onRename: () => void;
  onMainStream: () => void;
  onSubStream: () => void;
}

// Right-click menu on an individual channel in the Live View sidebar's
// device tree — distinct from TileContextMenu, which acts on a grid tile
// that's already playing something. This one acts on the channel itself,
// before it's necessarily assigned anywhere.
const MENU_WIDTH = 170;
const MENU_HEIGHT = 160;

export function ChannelContextMenu({ x, y, onDismiss, onRename, onMainStream, onSubStream }: Props) {
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
  const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 8);

  function runAndDismiss(action: () => void): void {
    action();
    onDismiss();
  }

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDismiss();
      }}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: 'fixed', inset: 0, zIndex: 999 }}
    >
      <div
        style={{
          position: 'fixed',
          left,
          top,
          width: MENU_WIDTH,
          background: theme.panel,
          border: `1px solid ${theme.border}`,
          borderRadius: '6px',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
          padding: '0.3rem',
          fontSize: '12.5px',
        }}
      >
        <MenuItem label="Rename" onClick={() => runAndDismiss(onRename)} />
        <MenuItem label="Main Stream" onClick={() => runAndDismiss(onMainStream)} />
        <MenuItem label="Sub Stream" onClick={() => runAndDismiss(onSubStream)} />
        {/* Same "no audio pipeline exists yet" reasoning as the tile
            context menu's own Audio item - real per-vendor native work,
            not a quick toggle. */}
        <MenuItem label="Audio" disabled title="Coming soon" />
      </div>
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  disabled,
  title,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={title}
      style={
        {
          padding: '0.45rem 0.6rem',
          borderRadius: '4px',
          color: disabled ? theme.textFaint : theme.text,
          background: hovered && !disabled ? theme.surfaceHover : 'transparent',
          cursor: disabled ? 'default' : 'pointer',
          userSelect: 'none',
        } as CSSProperties
      }
    >
      {label}
    </div>
  );
}
