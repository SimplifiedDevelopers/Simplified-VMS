import { useEffect, useRef } from 'react';
import type { DecodedFrame } from '../../../shared/types';

interface Props {
  viewHandle: string;
  // Defaults to Live View's frame channel — Playback passes
  // window.ssmVms.playback.onFrame instead, since the two features push
  // frames on separate IPC channels but share this exact same
  // decode-to-canvas paint logic.
  subscribe?: (viewHandle: string, callback: (frame: DecodedFrame) => void) => () => void;
  // Hands the live <canvas> element back up to the caller (keyed by
  // viewHandle in LiveView's own ref map) so Snapshot/Record can grab
  // exactly what's on screen via canvas.toBlob()/captureStream() —
  // reusing the already-painted canvas means snapshots/recordings are
  // guaranteed to match what the tech actually sees, with no separate
  // decode path to keep in sync.
  onCanvasRef?: (canvas: HTMLCanvasElement | null) => void;
}

export function VideoCanvas({ viewHandle, subscribe = window.ssmVms.liveView.onFrame, onCanvasRef }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Reused across frames instead of allocating a new Uint8ClampedArray +
  // ImageData every single frame — confirmed live on real (older, weaker)
  // hardware: for a full main-stream feed (much higher resolution than the
  // sub-stream normally used in the multi-tile grid — main only kicks in
  // while a tile is expanded), reallocating+copying an ~8MB buffer 25-30
  // times a second was heavy enough to keep the renderer's main thread
  // busy almost continuously. That looked exactly like a real freeze —
  // double-clicking to collapse back out of the expanded view could sit
  // unprocessed for many seconds, reported by Windows as "Not
  // Responding" — even though no native call was actually stuck (ruled
  // out with native-side diagnostic logging first). `.set()` copies
  // straight into the already-allocated buffer via a native, much cheaper
  // operation instead of allocating fresh objects every frame.
  const imageDataRef = useRef<ImageData | null>(null);

  useEffect(() => {
    const unsubscribe = subscribe(viewHandle, (frame: DecodedFrame) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
        imageDataRef.current = null; // dimensions changed — recreate at the new size below
      }
      const ctx = canvas.getContext('2d');
      if (!ctx || frame.format !== 'rgb32') return;
      if (!imageDataRef.current) {
        imageDataRef.current = ctx.createImageData(frame.width, frame.height);
      }
      imageDataRef.current.data.set(frame.data);
      ctx.putImageData(imageDataRef.current, 0, 0);
    });
    return unsubscribe;
  }, [viewHandle, subscribe]);

  return (
    <canvas
      ref={(el) => {
        canvasRef.current = el;
        onCanvasRef?.(el);
      }}
      style={{ width: '100%', height: '100%', background: '#000', display: 'block' }}
    />
  );
}
