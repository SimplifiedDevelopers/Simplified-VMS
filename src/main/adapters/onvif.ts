import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import type { DecodedFrame, DeviceSession, LoginParams, StreamType } from '../../shared/types';
import type { VmsAdapter } from './vmsAdapter';
import { getProfiles, getStreamUri, withRtspCredentials, type OnvifAuth, type OnvifProfile } from '../services/onvifClient';
import { resolveFfmpegPath, resolveFfprobePath } from '../services/ffmpegPath';
import { killProcessTree } from '../services/processTree';

// Unlike the other 4 vendors, ONVIF has no proprietary SDK to wrap in a
// native addon — it's just a standard way to log in and ask for an RTSP
// stream URL. There's no decoder included, so real live view needs an
// actual decoding pipeline: ffmpeg, spawned per-stream, decoding RTSP into
// raw RGBA frames (the ffmpeg spawn/kill conventions here — ffmpegPath.ts,
// processTree.ts — are shared with services/clipExporter.ts's own
// encode-direction ffmpeg pipeline).
//
// ffmpeg is told to output raw RGBA directly (`-pix_fmt rgba`) so the
// result slots into the exact same DecodedFrame{format:'rgb32', ...}
// contract every other vendor already produces — zero renderer changes.

interface OnvifSession {
  host: string;
  port: number;
  auth: OnvifAuth;
  profiles: OnvifProfile[];
}

interface OnvifStream {
  sessionId: string;
  process: ChildProcess;
  enabled: boolean;
  width: number;
  height: number;
  buffer: Buffer;
}

const sessions = new Map<string, OnvifSession>();
const streams = new Map<string, OnvifStream>();

interface StreamDimensions {
  width: number;
  height: number;
}

// RTSP handshakes can be slow on some cameras — ffprobe gets a generous
// timeout plus one retry before giving up, rather than failing a channel
// open on a single slow negotiation.
function probeDimensions(rtspUrl: string): Promise<StreamDimensions> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveFfprobePath(), [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-rtsp_transport', 'tcp',
      rtspUrl,
    ]);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('ffprobe timed out resolving stream dimensions'));
    }, 6000);
    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
          streams?: { codec_type?: string; width?: number; height?: number }[];
        };
        const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
        if (!videoStream?.width || !videoStream.height) {
          reject(new Error('ffprobe did not report video stream dimensions'));
          return;
        }
        resolve({ width: videoStream.width, height: videoStream.height });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

async function probeDimensionsWithRetry(rtspUrl: string): Promise<StreamDimensions> {
  try {
    return await probeDimensions(rtspUrl);
  } catch {
    return probeDimensions(rtspUrl);
  }
}

export class OnvifAdapter implements VmsAdapter {
  readonly vendor = 'onvif';

  async login(params: LoginParams): Promise<DeviceSession> {
    const auth: OnvifAuth = { username: params.username, password: params.password };
    // Doubles as the credential/reachability check — ONVIF services
    // require the WS-Security header to succeed before returning profiles.
    const profiles = await getProfiles(params.host, params.port, auth);
    const sessionId = randomUUID();
    sessions.set(sessionId, { host: params.host, port: params.port, auth, profiles });
    return {
      sessionId,
      channels: profiles.map((profile, index) => ({
        channel: index + 1,
        label: profile.name || `Channel ${index + 1}`,
      })),
    };
  }

  async logout(sessionId: string): Promise<void> {
    const handles = Array.from(streams.entries()).filter(([, stream]) => stream.sessionId === sessionId);
    await Promise.all(handles.map(([handle]) => this.stopLiveView(handle)));
    sessions.delete(sessionId);
  }

  async startLiveView(
    sessionId: string,
    channel: number,
    // streamType is only honored if the device happens to expose separate
    // main/sub ONVIF profiles for the same physical channel — otherwise
    // every channel is just whatever profile the device configured at that
    // index. A documented simplification, not a gap to solve here.
    _streamType: StreamType,
    onFrame: (frame: DecodedFrame) => void,
  ): Promise<string> {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('ONVIF session not found — device may have been logged out');
    const profile = session.profiles[channel - 1];
    if (!profile) throw new Error(`ONVIF channel ${channel} not found`);

    const rawUri = await getStreamUri(session.host, session.port, session.auth, profile.token);
    const rtspUrl = withRtspCredentials(rawUri, session.auth);
    const { width, height } = await probeDimensionsWithRetry(rtspUrl);

    const proc = spawn(resolveFfmpegPath(), [
      '-rtsp_transport', 'tcp',
      '-i', rtspUrl,
      '-an',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-vsync', '0',
      '-',
    ]);

    const viewHandle = randomUUID();
    const stream: OnvifStream = { sessionId, process: proc, enabled: true, width, height, buffer: Buffer.alloc(0) };
    streams.set(viewHandle, stream);

    const frameSize = width * height * 4;
    proc.stdout.on('data', (chunk: Buffer) => {
      stream.buffer = stream.buffer.length ? Buffer.concat([stream.buffer, chunk]) : chunk;
      while (stream.buffer.length >= frameSize) {
        const frameData = stream.buffer.subarray(0, frameSize);
        stream.buffer = stream.buffer.subarray(frameSize);
        if (stream.enabled) {
          onFrame({ width, height, format: 'rgb32', data: Buffer.from(frameData), timestampMs: Date.now() });
        }
      }
    });
    // A dropped/ended stream just stops delivering frames — the renderer's
    // existing per-tile timeout/error handling surfaces this the same way
    // it would for any other vendor's channel going silent.
    proc.on('error', () => streams.delete(viewHandle));
    proc.on('close', () => streams.delete(viewHandle));

    return viewHandle;
  }

  async stopLiveView(viewHandle: string): Promise<void> {
    const stream = streams.get(viewHandle);
    if (!stream) return;
    streams.delete(viewHandle);
    await killProcessTree(stream.process);
  }

  async setFrameDelivery(viewHandle: string, enabled: boolean): Promise<void> {
    const stream = streams.get(viewHandle);
    if (stream) stream.enabled = enabled;
  }
}
