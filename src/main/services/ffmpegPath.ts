import { join } from 'path';
import { app } from 'electron';

// Shared between the ONVIF adapter's RTSP decode pipeline (onvif.ts) and
// clipExporter.ts's own ffmpeg-encode pipeline — both need the same
// packaged-vs-dev binary resolution, so it lives here once instead of
// twice.
export function resolveFfmpegPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'ffmpeg.exe');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('ffmpeg-static') as string;
}

export function resolveFfprobePath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'ffprobe.exe');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require('ffprobe-static') as { path: string }).path;
}
