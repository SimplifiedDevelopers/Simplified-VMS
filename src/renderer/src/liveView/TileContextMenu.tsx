import { useState, type CSSProperties, type ReactNode } from 'react';
import { theme } from '../theme';
import type { StreamType } from '../../../shared/types';

interface Props {
  x: number;
  y: number;
  hasContent: boolean;
  isExpanded: boolean;
  currentStream: StreamType | undefined;
  anyTilesFilled: boolean;
  onDismiss: () => void;
  onClose: () => void;
  onCloseAll: () => void;
  onFullScreen: () => void;
  onSelectStream: (streamType: StreamType) => void;
}

// Rough menu footprint used to keep it fully on-screen — doesn't need to be
// pixel-perfect, just enough to stop it rendering off the right/bottom edge
// on a right-click near a window border.
const MENU_WIDTH = 200;
const MENU_HEIGHT = 320;

export function TileContextMenu({
  x,
  y,
  hasContent,
  isExpanded,
  currentStream,
  anyTilesFilled,
  onDismiss,
  onClose,
  onCloseAll,
  onFullScreen,
  onSelectStream,
}: Props) {
  const [streamSubmenuOpen, setStreamSubmenuOpen] = useState(false);
  const left = Math.min(x, window.innerWidth - MENU_WIDTH - 8);
  const top = Math.min(y, window.innerHeight - MENU_HEIGHT - 8);

  function runAndDismiss(action: () => void): void {
    action();
    onDismiss();
  }

  return (
    <div
      // Transparent full-screen catcher — clicking anywhere outside the menu
      // itself dismisses it, same "click the backdrop, not the panel" pattern
      // as Modal.tsx, just without the dark overlay a context menu shouldn't
      // have. Also swallows a second right-click so the browser's own native
      // menu never appears underneath.
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
        <MenuItem label="Close" disabled={!hasContent} onClick={() => runAndDismiss(onClose)} />
        <MenuItem label="Close All" disabled={!anyTilesFilled} onClick={() => runAndDismiss(onCloseAll)} />
        <MenuItem
          label={isExpanded ? 'Exit Full Screen' : 'Full Screen'}
          disabled={!hasContent}
          onClick={() => runAndDismiss(onFullScreen)}
        />
        <MenuItem label="Digital Zoom" disabled title="Coming soon" />

        <div
          onMouseEnter={() => hasContent && setStreamSubmenuOpen(true)}
          onMouseLeave={() => setStreamSubmenuOpen(false)}
          style={{ position: 'relative' }}
        >
          <MenuItem label="Select Stream" disabled={!hasContent} arrow />
          {streamSubmenuOpen && hasContent && (
            <div
              style={{
                position: 'absolute',
                left: MENU_WIDTH - 4,
                top: 0,
                width: 150,
                background: theme.panel,
                border: `1px solid ${theme.border}`,
                borderRadius: '6px',
                boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
                padding: '0.3rem',
              }}
            >
              <MenuItem
                label="Main Stream"
                checked={currentStream === 'main'}
                onClick={() => runAndDismiss(() => onSelectStream('main'))}
              />
              <MenuItem
                label="Sub Stream"
                checked={currentStream === 'sub'}
                onClick={() => runAndDismiss(() => onSelectStream('sub'))}
              />
            </div>
          )}
        </div>

        <MenuDivider />
        <MenuItem label="Snapshot" disabled title="Coming soon" />
        <MenuItem label="Snapshot All" disabled title="Coming soon" />
        <MenuItem label="Start Local Recording" disabled title="Coming soon" />
        <MenuDivider />
        <MenuItem label="PTZ Control" disabled title="Coming soon" />
      </div>
    </div>
  );
}

function MenuItem({
  label,
  onClick,
  disabled,
  checked,
  arrow,
  title,
}: {
  label: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  checked?: boolean;
  arrow?: boolean;
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
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.45rem 0.6rem',
          borderRadius: '4px',
          color: disabled ? theme.textFaint : theme.text,
          background: hovered && !disabled ? theme.surfaceHover : 'transparent',
          cursor: disabled ? 'default' : 'pointer',
          userSelect: 'none',
        } as CSSProperties
      }
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        {checked && <span style={{ color: theme.accent, fontSize: '11px' }}>✓</span>}
        {label}
      </span>
      {arrow && <span style={{ color: theme.textFaint, fontSize: '10px' }}>▶</span>}
    </div>
  );
}

function MenuDivider() {
  return <div style={{ height: '1px', background: theme.border, margin: '0.25rem 0' }} />;
}
