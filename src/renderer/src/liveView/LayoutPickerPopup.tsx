import { Fragment } from 'react';
import { theme } from '../theme';
import { LAYOUTS, getLayoutShape } from './layoutDefs';

interface Props {
  current: number;
  onSelect: (layout: (typeof LAYOUTS)[number]) => void;
  onDismiss: () => void;
}

// Opens directly above the toolbar's layout icon. The click-outside
// catcher and the actual popup panel are deliberately SIBLINGS, not
// parent/child (first attempt nested the panel inside the fixed,
// full-viewport catcher — its own `bottom: 100%` then resolved against
// that catcher's full-screen containing block instead of the icon's own
// small `position:relative` wrapper in LiveView.tsx, pushing the whole
// popup off-screen above the visible window). As siblings, both render as
// direct children of that same relatively-positioned wrapper (this
// component returns a Fragment, so no extra DOM node comes between them
// and it) — the catcher still covers the full viewport via `position:
// fixed` regardless of its ancestor, while the panel's `position:
// absolute` now correctly anchors to the small wrapper right around the
// icon. The panel's higher z-index means clicks on it never fall through
// to the catcher's onMouseDown, so dismiss-on-outside-click still works.
export function LayoutPickerPopup({ current, onSelect, onDismiss }: Props) {
  return (
    <Fragment>
      <div onMouseDown={onDismiss} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />
      <div
        style={{
          position: 'absolute',
          zIndex: 1000,
          bottom: 'calc(100% + 8px)',
          left: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: '0.4rem',
          padding: '0.6rem',
          background: theme.panel,
          border: `1px solid ${theme.border}`,
          borderRadius: '6px',
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5)',
        }}
      >
        {LAYOUTS.map((n) => {
          const active = n === current;
          return (
            <button
              key={n}
              title={`${n === 1 ? 'Single' : `${n}-channel`} layout`}
              onClick={() => {
                onSelect(n);
                onDismiss();
              }}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '0.3rem',
                padding: '0.4rem',
                width: '52px',
                borderRadius: '5px',
                border: `1px solid ${active ? theme.accent : 'transparent'}`,
                background: active ? theme.accentFaint : 'transparent',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                if (!active) e.currentTarget.style.background = theme.surfaceHover;
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = 'transparent';
              }}
            >
              <LayoutThumbnail layout={n} active={active} />
              <span style={{ fontSize: '11px', fontWeight: 600, color: active ? theme.accentHover : theme.textMuted }}>
                {n}
              </span>
            </button>
          );
        })}
      </div>
    </Fragment>
  );
}

// Renders a real miniature of the layout via the exact same shape data the
// full grid uses (layoutDefs.ts) — never hand-drawn/hardcoded per layout,
// so it can't visually drift from what selecting it actually produces.
function LayoutThumbnail({ layout, active }: { layout: number; active: boolean }) {
  const shape = getLayoutShape(layout);
  const cellColor = active ? theme.accent : theme.textFaint;
  const cells = shape.cells ?? Array.from({ length: layout }, (_, i) => ({ col: 0, row: 0, colSpan: 1, rowSpan: 1, index: i }));
  return (
    <div
      style={{
        width: '34px',
        height: '34px',
        display: 'grid',
        gridTemplateColumns: `repeat(${shape.columns}, 1fr)`,
        gridTemplateRows: `repeat(${shape.rows}, 1fr)`,
        gap: '1.5px',
      }}
    >
      {cells.map((cell, i) => (
        <div
          key={i}
          style={{
            gridColumn: shape.cells ? `${cell.col} / span ${cell.colSpan}` : undefined,
            gridRow: shape.cells ? `${cell.row} / span ${cell.rowSpan}` : undefined,
            background: cellColor,
            opacity: 0.7,
            borderRadius: '1px',
          }}
        />
      ))}
    </div>
  );
}
