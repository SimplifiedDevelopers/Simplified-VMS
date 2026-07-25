import { useEffect, useRef } from 'react';
import type { DecodedFrame } from '../../shared/types';

interface Props {
  sessionId: string;
  viewHandle: string;
}

export function VideoTile({ sessionId, viewHandle }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const unsubscribe = window.vms.onFrame((incomingHandle, frame: DecodedFrame) => {
      if (incomingHandle !== viewHandle) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== frame.width || canvas.height !== frame.height) {
        canvas.width = frame.width;
        canvas.height = frame.height;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx || frame.format !== 'rgb32') return;
      const imageData = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
      ctx.putImageData(imageData, 0, 0);
    });
    return unsubscribe;
  }, [viewHandle]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', background: '#000', display: 'block' }}
      onDoubleClick={() => window.vms.stopLiveView(sessionId, viewHandle)}
    />
  );
}
