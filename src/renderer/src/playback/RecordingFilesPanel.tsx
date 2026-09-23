import { theme } from '../theme';
import { PanelChevronIcon } from '../components/icons';
import { DownloadIcon } from './icons';
import { formatTime, TYPE_COLOR } from './playbackModel';
import type { RecordingSegment } from '../../../shared/types';

type FileListFilter = 'all' | 'continuous' | 'motion';

interface Props {
  collapsed: boolean;
  onSetCollapsed: (collapsed: boolean) => void;
  filter: FileListFilter;
  onSetFilter: (filter: FileListFilter) => void;
  hasDeviceSelected: boolean;
  searching: boolean;
  entries: RecordingSegment[];
  onPlaySegment: (seg: RecordingSegment) => void;
  onDownloadSegment: (seg: RecordingSegment) => void;
}

// Right-side recording-files panel — same width as the left device tree
// sidebar, additive to (not a replacement for) the bottom timeline + Mark
// Start/Mark End clip-marker flow above. Lists the selected tile's
// already-fetched segments so a real recorded range can be played or
// downloaded directly, without needing to scrub/mark points manually
// first. Extracted from Playback.tsx verbatim - same JSX, same styling.
export function RecordingFilesPanel({
  collapsed,
  onSetCollapsed,
  filter,
  onSetFilter,
  hasDeviceSelected,
  searching,
  entries,
  onPlaySegment,
  onDownloadSegment,
}: Props) {
  return (
    <div
      style={{
        width: collapsed ? '34px' : '220px',
        flexShrink: 0,
        borderLeft: `1px solid ${theme.border}`,
        padding: collapsed ? '0.5rem 0.25rem' : '0.75rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.6rem',
      }}
    >
      {collapsed ? (
        <button
          onClick={() => onSetCollapsed(false)}
          title="Expand recording files panel"
          style={{
            width: '26px',
            height: '26px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            alignSelf: 'center',
            background: theme.surface,
            border: `1px solid ${theme.border}`,
            borderRadius: '4px',
            color: theme.textMuted,
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = theme.accentHover;
            e.currentTarget.style.borderColor = theme.accentHover;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = theme.textMuted;
            e.currentTarget.style.borderColor = theme.border;
          }}
        >
          <PanelChevronIcon direction="left" />
        </button>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '11px', color: theme.textMuted }}>RECORDING FILES</span>
            <button
              onClick={() => onSetCollapsed(true)}
              title="Collapse recording files panel"
              style={{
                width: '26px',
                height: '26px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: theme.surface,
                border: `1px solid ${theme.border}`,
                borderRadius: '4px',
                color: theme.textMuted,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = theme.accentHover;
                e.currentTarget.style.borderColor = theme.accentHover;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = theme.textMuted;
                e.currentTarget.style.borderColor = theme.border;
              }}
            >
              <PanelChevronIcon direction="right" />
            </button>
          </div>
          <div style={{ display: 'flex', gap: '0.35rem' }}>
            {(['all', 'continuous', 'motion'] as const).map((t) => (
              <button
                key={t}
                onClick={() => onSetFilter(t)}
                style={{
                  flex: 1,
                  padding: '0.3rem 0',
                  borderRadius: '4px',
                  border: `1px solid ${t === filter ? theme.accent : theme.border}`,
                  background: t === filter ? theme.accentFaint : 'transparent',
                  color: t === filter ? theme.accentHover : theme.textMuted,
                  fontSize: '11px',
                  cursor: 'pointer',
                }}
              >
                {t === 'all' ? 'All' : t === 'continuous' ? 'Continuous' : 'Motion'}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {!hasDeviceSelected && (
              <div style={{ fontSize: '11.5px', color: theme.textFaint, padding: '0.5rem' }}>
                No channel selected for this tile.
              </div>
            )}
            {hasDeviceSelected && entries.length === 0 && (
              <div style={{ fontSize: '11.5px', color: theme.textFaint, padding: '0.5rem' }}>
                {searching ? 'Searching…' : 'No recordings found for this day'}
              </div>
            )}
            {entries.map((seg, i) => (
              <div
                key={i}
                onClick={() => onPlaySegment(seg)}
                title="Click to play this recording"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.4rem',
                  padding: '0.4rem 0.5rem',
                  borderRadius: '4px',
                  border: `1px solid ${theme.border}`,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = theme.accentFaint)}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', overflow: 'hidden' }}>
                  <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: TYPE_COLOR[seg.type], flexShrink: 0 }} />
                  <span style={{ fontSize: '11px', color: theme.text, whiteSpace: 'nowrap' }}>
                    {formatTime(seg.startMs)} – {formatTime(seg.endMs)}
                  </span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownloadSegment(seg);
                  }}
                  title="Download this recording"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: theme.textMuted,
                    cursor: 'pointer',
                    padding: '0.15rem',
                    display: 'flex',
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = theme.accentHover)}
                  onMouseLeave={(e) => (e.currentTarget.style.color = theme.textMuted)}
                >
                  <DownloadIcon />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
