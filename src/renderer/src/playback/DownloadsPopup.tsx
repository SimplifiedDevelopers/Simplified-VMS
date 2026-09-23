import { theme } from '../theme';
import { Modal } from '../components/Modal';
import { secondaryButtonStyle } from './PlaybackControls';
import type { DownloadItem } from './playbackModel';

interface Props {
  downloads: DownloadItem[];
  onClose: () => void;
  onOpenLocation: (path: string) => void;
  onDismiss: (handle: string) => void;
  onPause: (handle: string) => void;
  onResume: (handle: string) => void;
  onStop: (handle: string) => void;
}

// Extracted from Playback.tsx verbatim - same JSX, same styling.
export function DownloadsPopup({ downloads, onClose, onOpenLocation, onDismiss, onPause, onResume, onStop }: Props) {
  return (
    <Modal width={420} onDismiss={onClose}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '1rem 1.25rem',
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        <span style={{ fontSize: '14px', fontWeight: 600, color: theme.text }}>Downloads</span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: theme.textMuted, fontSize: '16px', cursor: 'pointer' }}
        >
          &times;
        </button>
      </div>
      <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {downloads.length === 0 && <div style={{ fontSize: '12px', color: theme.textFaint }}>No downloads.</div>}
        {downloads.map((d) => (
          <div
            key={d.handle}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.4rem',
              padding: '0.6rem',
              borderRadius: '5px',
              border: `1px solid ${theme.border}`,
            }}
          >
            <div style={{ fontSize: '12.5px', color: theme.text, fontWeight: 600 }}>
              {d.deviceName} · {d.channelLabel}
            </div>
            <div style={{ fontSize: '11px', color: theme.textFaint, wordBreak: 'break-all' }}>{d.path}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ flex: 1, height: '6px', borderRadius: '3px', background: theme.border, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${d.progress}%`,
                    height: '100%',
                    background: d.error ? theme.danger : d.done ? theme.success : d.paused ? theme.warning : theme.accent,
                    transition: 'width 0.2s',
                  }}
                />
              </div>
              <span style={{ fontSize: '11px', color: theme.textMuted, width: '32px', textAlign: 'right' }}>
                {Math.round(d.progress)}%
              </span>
            </div>
            {d.paused && !d.error && <div style={{ fontSize: '11px', color: theme.warning }}>Paused</div>}
            {d.error && <div style={{ fontSize: '11px', color: theme.danger }}>{d.error}</div>}
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button onClick={() => onOpenLocation(d.path)} style={secondaryButtonStyle}>
                Open
              </button>
              {d.done ? (
                <button onClick={() => onDismiss(d.handle)} style={secondaryButtonStyle}>
                  Dismiss
                </button>
              ) : (
                <>
                  {d.paused ? (
                    <button onClick={() => onResume(d.handle)} style={secondaryButtonStyle}>
                      Resume
                    </button>
                  ) : (
                    <button onClick={() => onPause(d.handle)} style={secondaryButtonStyle}>
                      Pause
                    </button>
                  )}
                  <button onClick={() => onStop(d.handle)} style={secondaryButtonStyle}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
