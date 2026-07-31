// Single source of truth for every grid layout's shape — both the real
// Live View grid (LiveView.tsx) and the layout-picker popup's mini preview
// icons (LayoutPickerPopup.tsx) read from this, so a preview icon can never
// drift out of sync with what actually renders.

export interface LayoutCell {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export interface LayoutShape {
  columns: number;
  rows: number;
  // Present only for a "mixed" layout (some tiles bigger than others) —
  // one entry per tile index, in order. Absent for a uniform layout, which
  // relies on CSS Grid's own auto-placement instead (every tile the same
  // size, filled in DOM order) — same as how every layout worked before
  // mixed ones existed.
  cells?: LayoutCell[];
}

export const LAYOUTS = [1, 4, 6, 9, 10, 12, 16, 25, 36, 64] as const;

// 6 = "1+5": one large tile (top-left, spanning a 2x2 block of a 3x3 base
// grid) plus 5 small ones filling the rest — the industry-standard "1+5"
// shape used across most VMS software. 10 = "2+8", per explicit request:
// two large tiles side by side across the top (each a 2x2 block of a 4x4
// base grid) with 8 small tiles filling the two rows below. 12 needs no
// entry here at all — Math.ceil(Math.sqrt(12))=4 columns, Math.ceil(12/4)=3
// rows already produces a plain 4x3 grid via the existing uniform-layout
// math, exactly the shape requested, with zero special-casing.
const MIXED_SHAPES: Partial<Record<number, LayoutShape>> = {
  6: {
    columns: 3,
    rows: 3,
    cells: [
      { col: 1, row: 1, colSpan: 2, rowSpan: 2 },
      { col: 3, row: 1, colSpan: 1, rowSpan: 1 },
      { col: 3, row: 2, colSpan: 1, rowSpan: 1 },
      { col: 1, row: 3, colSpan: 1, rowSpan: 1 },
      { col: 2, row: 3, colSpan: 1, rowSpan: 1 },
      { col: 3, row: 3, colSpan: 1, rowSpan: 1 },
    ],
  },
  10: {
    columns: 4,
    rows: 4,
    cells: [
      { col: 1, row: 1, colSpan: 2, rowSpan: 2 },
      { col: 3, row: 1, colSpan: 2, rowSpan: 2 },
      { col: 1, row: 3, colSpan: 1, rowSpan: 1 },
      { col: 2, row: 3, colSpan: 1, rowSpan: 1 },
      { col: 3, row: 3, colSpan: 1, rowSpan: 1 },
      { col: 4, row: 3, colSpan: 1, rowSpan: 1 },
      { col: 1, row: 4, colSpan: 1, rowSpan: 1 },
      { col: 2, row: 4, colSpan: 1, rowSpan: 1 },
      { col: 3, row: 4, colSpan: 1, rowSpan: 1 },
      { col: 4, row: 4, colSpan: 1, rowSpan: 1 },
    ],
  },
};

export function getLayoutShape(layout: number): LayoutShape {
  const mixed = MIXED_SHAPES[layout];
  if (mixed) return mixed;
  const columns = Math.ceil(Math.sqrt(layout));
  const rows = Math.ceil(layout / columns);
  return { columns, rows };
}
