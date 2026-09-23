import { theme } from '../theme';
import { Modal } from '../components/Modal';
import { searchButtonStyle, secondaryButtonStyle } from './PlaybackControls';
import { formatTime, type ExportPopupState } from './playbackModel';

interface Props {
  exportPopup: ExportPopupState;
  onChooseExportPath: () => void;
  onCancel: () => void;
  onStartDownload: () => void;
}

// Extracted from Playback.tsx verbatim - same JSX, same styling.
export function ExportPopup({ exportPopup, onChooseExportPath, onCancel, onStartDownload }: Props) {
  return (
    <Modal width={380} onDismiss={onCancel}>
      <div style={{ padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: theme.text }}>Export Recording</div>
        <div style={{ fontSize: '12px', color: theme.textMuted }}>
          {formatTime(exportPopup.startMs)} — {formatTime(exportPopup.endMs)}
        </div>

        <button onClick={onChooseExportPath} disabled={exportPopup.choosing} style={secondaryButtonStyle}>
          {exportPopup.choosing ? 'Choosing…' : exportPopup.path ? 'Change Destination…' : 'Choose Destination…'}
        </button>
        {exportPopup.path && (
          <div style={{ fontSize: '11px', color: theme.textFaint, wordBreak: 'break-all' }}>{exportPopup.path}</div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={onCancel} style={secondaryButtonStyle}>
            Cancel
          </button>
          <button
            onClick={onStartDownload}
            disabled={!exportPopup.path}
            style={{ ...searchButtonStyle, opacity: exportPopup.path ? 1 : 0.5, cursor: exportPopup.path ? 'pointer' : 'not-allowed' }}
          >
            Download
          </button>
        </div>
      </div>
    </Modal>
  );
}
