import { theme } from '../theme';
import type { TabKind } from './AppShell';

interface Props {
  onOpen: (kind: TabKind) => void;
}

const cards: Array<{ kind: TabKind; title: string; description: string; glyph: string }> = [
  { kind: 'liveView', title: 'Live View', description: 'View live video from your cameras.', glyph: '▦' },
  { kind: 'playback', title: 'Playback', description: 'Search for and play back recordings.', glyph: '▶' },
  {
    kind: 'deviceManagement',
    title: 'Device Management',
    description: 'Add, edit, and remove DVR/NVR devices.',
    glyph: '⚙',
  },
];

export function ControlPanel({ onOpen }: Props) {
  return (
    <div style={{ padding: '2rem' }}>
      <div style={{ fontSize: '12px', fontWeight: 600, color: theme.textMuted, marginBottom: '0.9rem' }}>
        COMMON
      </div>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        {cards.map((card) => (
          <button
            key={card.kind}
            onClick={() => onOpen(card.kind)}
            style={{
              width: '220px',
              padding: '1.5rem 1.25rem',
              borderRadius: '8px',
              border: `1px solid ${theme.border}`,
              background: theme.panel,
              color: theme.text,
              textAlign: 'left',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '0.75rem',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = theme.accent)}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = theme.border)}
          >
            <span style={{ fontSize: '30px', color: theme.accent }}>{card.glyph}</span>
            <span style={{ fontSize: '14px', fontWeight: 600 }}>{card.title}</span>
            <span style={{ fontSize: '11.5px', color: theme.textMuted, textAlign: 'center', lineHeight: 1.4 }}>
              {card.description}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
