import { type MouseEvent } from 'react';
import { theme } from '../theme';
import { Legend, ZoomButton } from './PlaybackControls';
import { DAY_MS, formatTime, TYPE_COLOR, ZOOM_LEVELS, zoomLabel, type ClipMark } from './playbackModel';
import type { RecordingSegment } from '../../../shared/types';

interface Props {
  zoom: (typeof ZOOM_LEVELS)[number];
  onZoomChange: (zoom: (typeof ZOOM_LEVELS)[number]) => void;
  deviceName: string | null;
  channelLabel: string | null;
  searching: boolean;
  segments: RecordingSegment[];
  dayStartMs: number;
  onTimelineClick: (e: MouseEvent<HTMLDivElement>) => void;
  onTimelineHover: (e: MouseEvent<HTMLDivElement>) => void;
  timelineHoverX: number | null;
  timelineHoverMs: number | null;
  onTimelineMouseLeave: () => void;
  clipMark: ClipMark | null;
  markMatchesSelectedTile: boolean;
  currentMs: number | null;
  hasDeviceSelected: boolean;
}

// Full-width timeline (24h ruler, recording segments, hover time, clip
// marker, playhead) plus its zoom/legend header row — extracted from
// Playback.tsx verbatim, same JSX and styling, moved here (below the tile
// grid) instead of a cramped sidebar strip so it has real room.
export function PlaybackTimeline({
  zoom,
  onZoomChange,
  deviceName,
  channelLabel,
  searching,
  segments,
  dayStartMs,
  onTimelineClick,
  onTimelineHover,
  timelineHoverX,
  timelineHoverMs,
  onTimelineMouseLeave,
  clipMark,
  markMatchesSelectedTile,
  currentMs,
  hasDeviceSelected,
}: Props) {
  return (
    <div style={{ borderTop: `1px solid ${theme.border}`, padding: '0.5rem 0.9rem 0.3rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', marginBottom: '0.35rem' }}>
        <div style={{ display: 'flex', gap: '0.6rem', fontSize: '10px', color: theme.textFaint }}>
          <Legend color={TYPE_COLOR.continuous} label="Continuous" />
          <Legend color={TYPE_COLOR.motion} label="Motion" />
          <Legend color={TYPE_COLOR.smart} label="Smart" />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '10px', color: theme.textFaint }}>
          <ZoomButton
            disabled={zoom === ZOOM_LEVELS[0]}
            onClick={() => onZoomChange(ZOOM_LEVELS[Math.max(0, ZOOM_LEVELS.indexOf(zoom) - 1)])}
          >
            −
          </ZoomButton>
          <span style={{ minWidth: '38px', textAlign: 'center', color: theme.textMuted }}>{zoomLabel(zoom)}</span>
          <ZoomButton
            disabled={zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
            onClick={() => onZoomChange(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, ZOOM_LEVELS.indexOf(zoom) + 1)])}
          >
            +
          </ZoomButton>
        </div>

        <span style={{ justifySelf: 'end', fontSize: '11px', color: theme.textMuted }}>
          {deviceName ? `${deviceName} · ${channelLabel}${searching ? ' — searching…' : ''}` : 'No channel selected for this tile'}
        </span>
      </div>

      {/* Zoom widens this inner wrapper (not the outer container) and lets
          it scroll horizontally — a short motion clip that's a couple of
          pixels wide at 1x becomes proportionally easier to click at higher
          zoom. onTimelineClick's fraction math (offsetX / rect.width) needs
          no changes for this to work: rect.width and clientX are both
          already viewport-relative and account for scroll position
          automatically. */}
      <div style={{ overflowX: zoom > 1 ? 'auto' : 'hidden' }}>
        <div style={{ width: `${zoom * 100}%`, minWidth: '100%' }}>
          <div
            onClick={onTimelineClick}
            onMouseMove={onTimelineHover}
            onMouseLeave={onTimelineMouseLeave}
            style={{
              height: '52px',
              borderRadius: '3px',
              background: theme.surface,
              border: `1px solid ${theme.border}`,
              position: 'relative',
              cursor: segments.length > 0 ? 'pointer' : 'default',
              overflow: 'hidden',
            }}
          >
            {segments.map((seg, i) => {
              const left = ((seg.startMs - dayStartMs) / DAY_MS) * 100;
              const width = ((seg.endMs - seg.startMs) / DAY_MS) * 100;
              return (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: `${left}%`,
                    width: `${Math.max(width, 0.15)}%`,
                    top: 0,
                    bottom: 0,
                    background: TYPE_COLOR[seg.type],
                    opacity: 0.75,
                  }}
                />
              );
            })}
            {timelineHoverX !== null && timelineHoverMs !== null && (
              <div
                style={{
                  position: 'absolute',
                  left: `${timelineHoverX}px`,
                  top: 0,
                  bottom: 0,
                  width: '1px',
                  background: theme.textFaint,
                  pointerEvents: 'none',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    top: '3px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    whiteSpace: 'nowrap',
                    fontSize: '10.5px',
                    color: theme.text,
                    background: theme.panel,
                    border: `1px solid ${theme.border}`,
                    borderRadius: '3px',
                    padding: '0.1rem 0.35rem',
                    pointerEvents: 'none',
                  }}
                >
                  {formatTime(timelineHoverMs)}
                </span>
              </div>
            )}
            {clipMark && markMatchesSelectedTile && (
              <div
                title={`Clip start: ${formatTime(clipMark.startMs)}`}
                style={{
                  position: 'absolute',
                  left: `${((clipMark.startMs - dayStartMs) / DAY_MS) * 100}%`,
                  top: 0,
                  bottom: 0,
                  width: '2px',
                  background: theme.success,
                }}
              />
            )}
            {currentMs !== null && (
              <div
                style={{
                  position: 'absolute',
                  left: `${((currentMs - dayStartMs) / DAY_MS) * 100}%`,
                  top: 0,
                  bottom: 0,
                  width: '2px',
                  background: theme.text,
                }}
              />
            )}
            {segments.length === 0 && (searching || hasDeviceSelected) && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '10.5px',
                  color: theme.textFaint,
                }}
              >
                {searching ? 'Searching…' : 'No recordings found for this day'}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9.5px', color: theme.textFaint, marginTop: '2px' }}>
            {Array.from({ length: 13 }, (_, i) => (
              <span key={i}>{String(i * 2).padStart(2, '0')}:00</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
