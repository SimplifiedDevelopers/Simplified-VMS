import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { MediaSaveResult } from '../../shared/types';

function sanitizeForFilename(input: string): string {
  return input.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'device';
}

function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Shared by liveView:saveSnapshot/saveRecording and playback:saveSnapshot —
// all three are "write this already-encoded buffer from the renderer into
// the folder configured in Settings" with nothing vendor- or
// feature-specific left to do (the renderer captured the snapshot/
// recording straight off the tile's own <canvas>, so it already matches
// exactly what's on screen).
export function saveMediaFile(basePath: string, deviceName: string, channel: number, ext: string, data: Buffer): MediaSaveResult {
  if (!basePath) return { ok: false, error: 'Set a path in Settings first.' };
  try {
    mkdirSync(basePath, { recursive: true });
    const filePath = join(basePath, `${sanitizeForFilename(deviceName)}_ch${channel}_${timestampForFilename()}.${ext}`);
    writeFileSync(filePath, data);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
