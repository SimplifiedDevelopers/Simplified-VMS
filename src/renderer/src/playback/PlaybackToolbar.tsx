import { theme } from '../theme';
import { PauseIcon, PlayIcon, ScissorsIcon, StepForwardIcon, StopIcon } from './icons';
import { ToolbarIconButton, TransportButton } from './PlaybackControls';
import { formatTime, LAYOUTS, resourceLevelColor, type DownloadItem } from './playbackModel';
import type { PlaybackSpeed, SystemStats } from '../../../shared/types';

interface Props {
  layout: (typeof LAYOUTS)[number];
  onChangeLayout: (layout: (typeof LAYOUTS)[number]) => void;
  onCloseAll: () => void;
  isPaused: boolean;
  hasViewHandle: boolean;
  onPlayPause: () => void;
  onFrameStep: () => void;
  onStopAll: () => void;
  canResume: boolean;
  onResumeFromStop: () => void;
  speed: PlaybackSpeed;
  onSpeedCycle: () => void;
  canSync: boolean;
  onSync: () => void;
  canMarkEnd: boolean;
  onMarkStart: () => void;
  onMarkEnd: () => void;
  downloads: DownloadItem[];
  onOpenDownloadsPopup: () => void;
  actionMessage: { text: string; path?: string } | null;
  onOpenActionMessageLocation: (path: string) => void;
  currentMs: number | null;
  stats: SystemStats | null;
}

// Bottom transport bar — a true 3-column grid (not flex+spacers) so the
// center transport cluster stays visually centered regardless of how wide
// the left/right groups are. Layout/Close-all live on the left; the
// transport controls themselves (play/pause, frame-step, stop, speed,
// sync, clip markers) are the visually prominent center group — larger
// and filled, unlike the small flat icon buttons elsewhere, so they read
// as "the main controls" at a glance. Extracted from Playback.tsx
// verbatim, same JSX and styling.
export function PlaybackToolbar({
  layout,
  onChangeLayout,
  onCloseAll,
  isPaused,
  hasViewHandle,
  onPlayPause,
  onFrameStep,
  onStopAll,
  canResume,
  onResumeFromStop,
  speed,
  onSpeedCycle,
  canSync,
  onSync,
  canMarkEnd,
  onMarkStart,
  onMarkEnd,
  downloads,
  onOpenDownloadsPopup,
  actionMessage,
  onOpenActionMessageLocation,
  currentMs,
  stats,
}: Props) {
  return (
    <div
      style={{
        borderTop: `1px solid ${theme.border}`,
        padding: '0.6rem 0.9rem',
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
        {LAYOUTS.map((n) => (
          <button
            key={n}
            onClick={() => onChangeLayout(n)}
            style={{
              padding: '0.3rem 0.55rem',
              borderRadius: '4px',
              border: `1px solid ${n === layout ? theme.accent : theme.border}`,
              background: n === layout ? theme.accentFaint : 'transparent',
              color: n === layout ? theme.accentHover : theme.textMuted,
              fontSize: '11.5px',
              cursor: 'pointer',
            }}
          >
            {n}
          </button>
        ))}
        <div style={{ width: '1px', alignSelf: 'stretch', margin: '0.15rem 0.4rem', background: theme.border }} />
        <ToolbarIconButton title="Close all" danger onClick={onCloseAll}>
          &#10005;
        </ToolbarIconButton>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <TransportButton title={isPaused ? 'Play' : 'Pause'} disabled={!hasViewHandle} onClick={onPlayPause}>
          {isPaused ? <PlayIcon /> : <PauseIcon />}
        </TransportButton>
        <TransportButton title="Frame by frame" disabled={!isPaused} onClick={onFrameStep}>
          <StepForwardIcon />
        </TransportButton>
        <TransportButton title="Stop" disabled={!hasViewHandle} onClick={onStopAll}>
          <StopIcon />
        </TransportButton>
        <TransportButton title="Resume from where it was stopped" disabled={!canResume} onClick={onResumeFromStop}>
          <PlayIcon />
        </TransportButton>
        <TransportButton title={`Speed: ${speed}x (click to cycle 1x → 2x → 4x → 8x)`} disabled={!hasViewHandle} onClick={onSpeedCycle}>
          {speed}x
        </TransportButton>
        <TransportButton title="Sync playback position across cameras" disabled={!canSync} onClick={onSync}>
          &#8646;
        </TransportButton>

        <div style={{ width: '1px', alignSelf: 'stretch', margin: '0.1rem 0.2rem', background: theme.border }} />

        <TransportButton title="Mark Start Point to Download" disabled={!hasViewHandle} onClick={onMarkStart}>
          <ScissorsIcon />
        </TransportButton>
        <TransportButton title="Mark End Point to Download" disabled={!canMarkEnd} onClick={onMarkEnd}>
          <ScissorsIcon />
        </TransportButton>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.6rem' }}>
        {/* Centered in the gap between the transport controls and the
            playback time/CPU/Memory readout, rather than tacked onto the
            end of the tightly-packed transport button group. */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          {downloads.length > 0 &&
            (() => {
              // Only the downloads still actually in flight — averaging in
              // ones that already finished (sitting at 100%) or failed
              // (sitting at 0%) was reporting a number that didn't match
              // the transfer actually happening right now.
              const activeDownloads = downloads.filter((d) => !d.done);
              const avgProgress =
                activeDownloads.length > 0
                  ? activeDownloads.reduce((sum, d) => sum + d.progress, 0) / activeDownloads.length
                  : 100;
              return (
                <button
                  onClick={onOpenDownloadsPopup}
                  title={`${downloads.filter((d) => !d.done).length} download(s) in progress — click for details`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    padding: '0.3rem 0.5rem',
                    borderRadius: '4px',
                    border: `1px solid ${theme.border}`,
                    background: 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ width: '40px', height: '5px', borderRadius: '3px', background: theme.border, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${avgProgress}%`,
                        height: '100%',
                        background: downloads.some((d) => !d.done)
                          ? theme.accent
                          : downloads.some((d) => d.error)
                            ? theme.danger
                            : theme.success,
                        transition: 'width 0.2s',
                      }}
                    />
                  </div>
                  <span style={{ fontSize: '10.5px', color: theme.textMuted }}>{Math.round(avgProgress)}%</span>
                </button>
              );
            })()}
        </div>
        {actionMessage && (
          <span
            title={actionMessage.path ? 'Click to open file location' : undefined}
            onClick={actionMessage.path ? () => onOpenActionMessageLocation(actionMessage.path!) : undefined}
            style={{
              fontSize: '11px',
              color: actionMessage.path ? theme.accentHover : theme.textMuted,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '320px',
              cursor: actionMessage.path ? 'pointer' : 'default',
              textDecoration: actionMessage.path ? 'underline' : 'none',
            }}
          >
            {actionMessage.text}
          </span>
        )}
        <span style={{ fontSize: '11.5px', color: theme.textMuted }}>
          {currentMs ? formatTime(currentMs) : '--:--:--'}
        </span>
        <div style={{ width: '1px', alignSelf: 'stretch', margin: '0.1rem 0.2rem', background: theme.border }} />
        <span style={{ fontSize: '11px', color: theme.textFaint, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          CPU
          <strong style={{ color: stats ? resourceLevelColor(stats.cpuPercent) : theme.textMuted, fontWeight: 600 }}>
            {stats ? `${stats.cpuPercent}%` : '—'}
          </strong>
        </span>
        <span style={{ fontSize: '11px', color: theme.textFaint, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          Memory
          <strong style={{ color: stats ? resourceLevelColor(stats.memPercent) : theme.textMuted, fontWeight: 600 }}>
            {stats ? `${stats.memPercent}%` : '—'}
          </strong>
        </span>
      </div>
    </div>
  );
}
