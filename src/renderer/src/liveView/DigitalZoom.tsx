import { useEffect, useRef, useState, type ReactNode } from 'react';
import { theme } from '../theme';

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const WHEEL_ZOOM_FACTOR = 1.15;
// Below this, a mousedown+mouseup is a click (select the tile), not a
// rubber-band selection — avoids a barely-moved cursor accidentally
// triggering a near-zero-size "zoom".
const MIN_SELECTION_PX = 12;

interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0 };

// Keeps the visible content always covering the container (no black gaps
// at the edges once zoomed) by clamping translation to the range that
// still fully covers [0,width]x[0,height] at the given scale.
function clampTransform(t: Transform, width: number, height: number): Transform {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale));
  const minTx = width - width * scale;
  const minTy = height - height * scale;
  return {
    scale,
    tx: Math.min(0, Math.max(minTx, t.tx)),
    ty: Math.min(0, Math.max(minTy, t.ty)),
  };
}

// Digital zoom on a Live View tile — crop/scale the already-decoded canvas
// entirely client-side. No vendor SDK involvement at all, since this only
// ever operates on pixels VideoCanvas already painted — unlike Audio,
// which would need real per-vendor native work. Two drag behaviors on the
// same gesture, switched on current scale (standard image-viewer
// convention): at 1x, click-drag rubber-bands a region to zoom into; once
// already zoomed in, click-drag instead pans around the cropped view.
// Mouse wheel zooms toward the cursor at any zoom level.
//
// State (scale/pan) is intentionally NOT lifted to LiveView — the caller
// keys this component by the tile's viewHandle, so switching that tile to
// a different channel remounts it fresh at 1x instead of inheriting a
// stale zoom/pan from whatever was playing there before.
export function DigitalZoomLayer({ active, children }: { active: boolean; children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [selection, setSelection] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  // Set instead of relying purely on dragStartRef being null, since a pan
  // drag and a selection drag both need "is a drag in progress" but
  // resolve completely differently on mouseup.
  const panStartRef = useRef<{ mouseX: number; mouseY: number; tx: number; ty: number } | null>(null);

  // Exiting zoom mode (the context menu's "Exit Digital Zoom", or
  // double-clicking the tile) sets `active` false from the parent — reset
  // the actual view back to 1x here, otherwise the tile visually stayed
  // zoomed in even though the menu no longer showed it as active.
  useEffect(() => {
    if (!active) setTransform(IDENTITY);
  }, [active]);

  function containerRect(): { left: number; top: number; width: number; height: number } {
    const r = containerRef.current?.getBoundingClientRect();
    return r ?? { left: 0, top: 0, width: 1, height: 1 };
  }

  function handleWheel(e: React.WheelEvent<HTMLDivElement>): void {
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    const r = containerRect();
    const mouseX = e.clientX - r.left;
    const mouseY = e.clientY - r.top;
    setTransform((prev) => {
      const factor = e.deltaY < 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * factor));
      // Keep the point under the cursor fixed on screen while the scale
      // changes — the standard "zoom toward cursor" transform update.
      const contentX = (mouseX - prev.tx) / prev.scale;
      const contentY = (mouseY - prev.ty) / prev.scale;
      return clampTransform(
        { scale: nextScale, tx: mouseX - contentX * nextScale, ty: mouseY - contentY * nextScale },
        r.width,
        r.height,
      );
    });
  }

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>): void {
    if (!active || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Already zoomed in - a drag here means "pan around", not "select a
    // new region" (there's no sensible larger crop to select once already
    // cropped in). Zoom back out (wheel) to get a rubber-band select again.
    if (transform.scale > 1) {
      panStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, tx: transform.tx, ty: transform.ty };
      return;
    }
    const r = containerRect();
    dragStartRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    setSelection({ x: dragStartRef.current.x, y: dragStartRef.current.y, w: 0, h: 0 });
  }

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>): void {
    if (!active) return;
    if (panStartRef.current) {
      e.stopPropagation();
      const start = panStartRef.current;
      const r = containerRect();
      setTransform((prev) =>
        clampTransform({ ...prev, tx: start.tx + (e.clientX - start.mouseX), ty: start.ty + (e.clientY - start.mouseY) }, r.width, r.height),
      );
      return;
    }
    if (!dragStartRef.current) return;
    e.stopPropagation();
    const r = containerRect();
    const curX = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    const curY = Math.min(Math.max(e.clientY - r.top, 0), r.height);
    const start = dragStartRef.current;
    setSelection({ x: Math.min(start.x, curX), y: Math.min(start.y, curY), w: Math.abs(curX - start.x), h: Math.abs(curY - start.y) });
  }

  function handleMouseUp(e: React.MouseEvent<HTMLDivElement>): void {
    if (!active) return;
    if (panStartRef.current) {
      panStartRef.current = null;
      e.stopPropagation();
      return;
    }
    if (!dragStartRef.current) return;
    e.stopPropagation();
    dragStartRef.current = null;
    const sel = selection;
    setSelection(null);
    if (!sel || sel.w < MIN_SELECTION_PX || sel.h < MIN_SELECTION_PX) return;
    const r = containerRect();
    setTransform((prev) => {
      // Selection rect is in current on-screen coordinates — convert to
      // "content space" (the canvas's own un-transformed coordinates)
      // using the transform that produced what's on screen right now,
      // then compute the scale/pan that makes that content region fill
      // the container, centered (uniform scale, so the crop never
      // stretches/distorts the image).
      const contentX = (sel.x - prev.tx) / prev.scale;
      const contentY = (sel.y - prev.ty) / prev.scale;
      const contentW = sel.w / prev.scale;
      const contentH = sel.h / prev.scale;
      const nextScale = Math.min(r.width / contentW, r.height / contentH);
      return clampTransform(
        {
          scale: nextScale,
          tx: -contentX * nextScale + (r.width - contentW * nextScale) / 2,
          ty: -contentY * nextScale + (r.height - contentH * nextScale) / 2,
        },
        r.width,
        r.height,
      );
    });
  }

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onClick={(e) => {
        // Swallow the click while zoom is active so it doesn't also
        // toggle the tile's own selection outline underneath — this tile
        // is already the dedicated zoom target.
        if (active) e.stopPropagation();
      }}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        cursor: !active ? 'default' : transform.scale > 1 ? 'grab' : 'crosshair',
      }}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          transformOrigin: '0 0',
          transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale})`,
        }}
      >
        {children}
      </div>

      {active && transform.scale > 1 && (
        <div
          style={{
            position: 'absolute',
            bottom: '0.4rem',
            left: '0.4rem',
            fontSize: '10.5px',
            color: '#fff',
            background: 'rgba(0,0,0,0.55)',
            padding: '0.1rem 0.4rem',
            borderRadius: '3px',
            pointerEvents: 'none',
          }}
        >
          {transform.scale.toFixed(1)}x
        </div>
      )}

      {selection && (
        <div
          style={{
            position: 'absolute',
            left: selection.x,
            top: selection.y,
            width: selection.w,
            height: selection.h,
            border: `1px solid ${theme.accentHover}`,
            background: 'rgba(255,255,255,0.15)',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}
