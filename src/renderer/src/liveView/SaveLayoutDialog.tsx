import { useState, type CSSProperties } from 'react';
import { theme } from '../theme';
import { Modal } from '../components/Modal';

interface Props {
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}

export function SaveLayoutDialog({ onSave, onCancel }: Props) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Guards against the exact bug this was added for: clicking Save twice in
  // quick succession fired two save requests before the first one's
  // response came back and closed the dialog, creating two identical
  // layouts. Disabling the button the instant a save starts closes that
  // window; the name-uniqueness check in layoutStore.ts is the other half
  // (stops duplicates even if two different dialogs somehow raced).
  const [submitting, setSubmitting] = useState(false);

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSave(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Modal width={340} onDismiss={onCancel}>
      <div style={{ padding: '1.1rem 1.3rem', borderBottom: `1px solid ${theme.border}` }}>
        <span style={{ fontSize: '13.5px', fontWeight: 600, color: theme.text }}>Save Custom Layout</span>
      </div>
      <div style={{ padding: '1.1rem 1.3rem', display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          <span style={{ fontSize: '11.5px', color: theme.textMuted }}>Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder="e.g. Front Gate Cluster"
            style={inputStyle}
          />
        </label>
        {error && <span style={{ fontSize: '12px', color: theme.danger }}>{error}</span>}
      </div>
      <div style={{ padding: '0 1.3rem 1.1rem', display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
        <button onClick={onCancel} style={secondaryButtonStyle}>
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!name.trim() || submitting}
          style={{ ...primaryButtonStyle, opacity: name.trim() && !submitting ? 1 : 0.5 }}
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}

const inputStyle: CSSProperties = {
  padding: '0.5rem 0.6rem',
  borderRadius: '5px',
  border: `1px solid ${theme.border}`,
  background: theme.surface,
  color: theme.text,
  fontSize: '13px',
  outline: 'none',
};

const primaryButtonStyle: CSSProperties = {
  padding: '0.5rem 1.1rem',
  borderRadius: '5px',
  border: 'none',
  background: theme.accent,
  color: theme.accentText,
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryButtonStyle: CSSProperties = {
  padding: '0.5rem 1.1rem',
  borderRadius: '5px',
  border: `1px solid ${theme.borderLight}`,
  background: 'transparent',
  color: theme.text,
  fontSize: '13px',
  cursor: 'pointer',
};
