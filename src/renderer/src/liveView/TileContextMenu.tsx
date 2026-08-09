import { useState, type CSSProperties, type ReactNode } from 'react';
import { theme } from '../theme';
import type { StreamType } from '../../../shared/types';

interface Props {
  x: number;
  y: number;
  hasContent: boolean;
  // Real OS-level borderless fullscreen (same state as the bottom-right
  // toolbar icon) - NOT the single-tile "expand to fill the grid" state,
  // which this menu item used to trigger before. Drives the "Full
  // Screen"/"Exit Full Screen" label swap.
  isGridFullscreen: boolean;
  // Whether THIS tile (the one right-clicked, not necessarily the
  // toolbar's selected tile) is the one currently recording — drives the
  // "Start"/"Stop Local Recording" label swap the same way. Omit (along
  // with onToggleRecording) to hide the Local Recording item entirely —
  // Playback's tiles have no local-recording concept.
  isRecordingThisTile?: boolean;
  // Whether THIS tile is the one currently listening for Digital Zoom's
  // wheel/drag gestures — drives the "Digital Zoom"/"Exit Digital Zoom"
  // label swap the same way Full Screen does (no checkmark, matching that
  // same precedent).
  isZoomedTile: boolean;
  // Select Stream (main/sub) is a live-view-only concept — recorded
  // playback has no stream-type selection (see VmsAdapter.startPlayback's
  // own doc comment). Omit currentStream/onSelectStream together to hide
  // this whole section for Playback's menu.
  currentStream?: StreamType;
  anyTilesFilled: boolean;
  // PTZ has no implementation for either feature yet, but Playback (past
  // recordings) has no sensible use for camera-movement controls at all —
  // defaults to true (Live View keeps showing the placeholder) so this is
  // only ever passed false explicitly.
  showPtz?: boolean;
  onDismiss: () => void;
  onClose: () => void;
  onCloseAll: () => void;
  onFullScreen: () => void;
  onSelectStream?: (streamType: StreamType) => void;
  onSnapshot: () => void;
  onSnapshotAll: () => void;
  onToggleRecording?: () => void;
  onToggleZoom: () => void;
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
  isGridFullscreen,
  isRecordingThisTile,
  isZoomedTile,
  currentStream,
  anyTilesFilled,
  showPtz = true,
  onDismiss,
  onClose,
  onCloseAll,
  onFullScreen,
  onSelectStream,
  onSnapshot,
  onSnapshotAll,
  onToggleRecording,
  onToggleZoom,
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
          label={isGridFullscreen ? 'Exit Full Screen' : 'Full Screen'}
          onClick={() => runAndDismiss(onFullScreen)}
        />
        <MenuItem
          label={isZoomedTile ? 'Exit Digital Zoom' : 'Digital Zoom'}
          disabled={!hasContent}
          onClick={() => runAndDismiss(onToggleZoom)}
        />
        {/* No audio pipeline exists anywhere in the app yet (no audio
            frame type, no IPC channel, no playback code) — Uniview's SDK
            has an unused audio callback slot ready to wire up, but
            Hikvision/Dahua/TVT haven't even been checked for what they
            expose. Real per-vendor native work, not a quick toggle. */}
        <MenuItem label="Audio" disabled title="Coming soon" />

        {onSelectStream && (
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
        )}

        <MenuDivider />
        <MenuItem label="Snapshot" disabled={!hasContent} onClick={() => runAndDismiss(onSnapshot)} />
        <MenuItem label="Snapshot All" disabled={!anyTilesFilled} onClick={() => runAndDismiss(onSnapshotAll)} />
        {onToggleRecording && (
          <MenuItem
            label={isRecordingThisTile ? 'Stop Local Recording' : 'Start Local Recording'}
            disabled={!hasContent}
            onClick={() => runAndDismiss(onToggleRecording)}
          />
        )}
        {showPtz && (
          <>
            <MenuDivider />
            <MenuItem label="PTZ Control" disabled title="Coming soon" />
          </>
        )}
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
