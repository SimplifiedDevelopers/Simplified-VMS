import { join } from 'path';
import { app } from 'electron';
import type {
  DecodedFrame,
  DeviceSession,
  LoginParams,
  PlaybackCommand,
  RecordingSearchFilter,
  RecordingSegment,
  StreamType,
} from '../../shared/types';
import type { VmsAdapter } from './vmsAdapter';

interface NativeFrame {
  width: number;
  height: number;
  format: 'rgb32';
  timestampMs: number;
  data: Buffer;
}

interface NativeRecordingSegment {
  startMs: number;
  endMs: number;
  type: string;
}

interface NativeAddon {
  // login/startLiveView run on a libuv worker thread (Napi::AsyncWorker) and
  // return real Promises — the SDK's own login/connect calls can block for
  // seconds on a slow link, and running them on the N-API call thread
  // directly freezes Electron's main/UI thread for that whole time
  // (confirmed live against a real device).
  login(params: LoginParams): Promise<DeviceSession>;
  logout(sessionId: string): void;
  startLiveView(
    sessionId: string,
    channel: number,
    streamType: StreamType,
    onFrame: (frame: NativeFrame) => void,
  ): Promise<string>;
  stopLiveView(viewHandle: string): Promise<void>;
  setFrameDelivery(viewHandle: string, enabled: boolean): void;

  findRecordings(
    sessionId: string,
    channel: number,
    startMs: number,
    endMs: number,
    filters: RecordingSearchFilter[],
  ): Promise<NativeRecordingSegment[]>;
  startPlayback(
    sessionId: string,
    channel: number,
    startMs: number,
    endMs: number,
    onFrame: (frame: NativeFrame) => void,
    paceToRealtime?: boolean,
  ): Promise<string>;
  controlPlayback(viewHandle: string, command: PlaybackCommand, value?: number): Promise<void>;
  getPlaybackTime(viewHandle: string): Promise<number>;
  stopPlayback(viewHandle: string): Promise<void>;
  startBackup(sessionId: string, channel: number, startMs: number, endMs: number, saveFilePath: string): Promise<string>;
  getBackupProgress(downloadHandle: string): Promise<number>;
  stopBackup(downloadHandle: string): Promise<void>;

  // Genuine UDP broadcast discovery (NET_SDK_DiscoverDevice) - see
  // discoverTvtDevices() below for why this exists as a standalone
  // function rather than a VmsAdapter method, same reasoning as every
  // other vendor's own discovery export.
  discoverDevices(): Promise<NativeDiscoveredDevice[]>;
}

interface NativeDiscoveredDevice {
  host: string;
  port: number;
  httpPort: number;
  mac: string;
  model: string;
  name: string;
}

let cachedNative: NativeAddon | null = null;

function resolveAddonPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'native/tvt/build/Release/tvt_native.node');
  }
  return join(__dirname, '../../native/tvt/build/Release/tvt_native.node');
}

function loadNative(): NativeAddon {
  if (!cachedNative) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedNative = require(resolveAddonPath()) as NativeAddon;
  }
  return cachedNative;
}

export class TvtAdapter implements VmsAdapter {
  readonly vendor = 'tvt';

  async login(params: LoginParams): Promise<DeviceSession> {
    return loadNative().login(params);
  }

  async logout(sessionId: string): Promise<void> {
    loadNative().logout(sessionId);
  }

  async startLiveView(
    sessionId: string,
    channel: number,
    streamType: StreamType,
    onFrame: (frame: DecodedFrame) => void,
  ): Promise<string> {
    return loadNative().startLiveView(sessionId, channel, streamType, (frame) => {
      onFrame({
        width: frame.width,
        height: frame.height,
        format: frame.format,
        data: frame.data,
        timestampMs: frame.timestampMs,
      });
    });
  }

  async stopLiveView(viewHandle: string): Promise<void> {
    // Now a real native AsyncWorker (see the addon's own doc comment) —
    // properly awaited/returned instead of fire-and-forget, so a genuinely
    // hung stop call surfaces as this promise never resolving instead of
    // silently freezing the whole app on Electron's main thread.
    return loadNative().stopLiveView(viewHandle);
  }

  async setFrameDelivery(viewHandle: string, enabled: boolean): Promise<void> {
    loadNative().setFrameDelivery(viewHandle, enabled);
  }

  async findRecordings(
    sessionId: string,
    channel: number,
    startMs: number,
    endMs: number,
    filters: RecordingSearchFilter[],
    // Only Uniview's search is expensive enough to need a quick/full split
    // (see VmsAdapter.findRecordings' doc comment) - accepted here purely to
    // satisfy the shared interface, unused.
    _quick?: boolean,
  ): Promise<RecordingSegment[]> {
    const segments = await loadNative().findRecordings(sessionId, channel, startMs, endMs, filters);
    return segments.map((seg) => ({
      startMs: seg.startMs,
      endMs: seg.endMs,
      type: seg.type === 'continuous' || seg.type === 'motion' || seg.type === 'smart' ? seg.type : 'other',
    }));
  }

  async startPlayback(
    sessionId: string,
    channel: number,
    startMs: number,
    endMs: number,
    onFrame: (frame: DecodedFrame) => void,
    // Only clipExporter.ts's export sessions pass true - see the native
    // addon's LiveViewSession::paceToRealtime doc comment for why this
    // exists (a real app hang, otherwise): on-screen Playback leaves this
    // unset, preserving its existing behavior exactly.
    paceToRealtime?: boolean,
  ): Promise<string> {
    return loadNative().startPlayback(sessionId, channel, startMs, endMs, (frame) => {
      onFrame({
        width: frame.width,
        height: frame.height,
        format: frame.format,
        data: frame.data,
        timestampMs: frame.timestampMs,
      });
    }, paceToRealtime);
  }

  async controlPlayback(viewHandle: string, command: PlaybackCommand, value?: number): Promise<void> {
    return loadNative().controlPlayback(viewHandle, command, value);
  }

  async getPlaybackTime(viewHandle: string): Promise<number> {
    return loadNative().getPlaybackTime(viewHandle);
  }

  async stopPlayback(viewHandle: string): Promise<void> {
    return loadNative().stopPlayback(viewHandle);
  }

  async startBackup(sessionId: string, channel: number, startMs: number, endMs: number, saveFilePath: string): Promise<string> {
    return loadNative().startBackup(sessionId, channel, startMs, endMs, saveFilePath);
  }

  async getBackupProgress(downloadHandle: string): Promise<number> {
    return loadNative().getBackupProgress(downloadHandle);
  }

  async stopBackup(downloadHandle: string): Promise<void> {
    return loadNative().stopBackup(downloadHandle);
  }
}

export interface TvtDiscoveredDevice {
  host: string;
  port: number;
  httpPort: number;
  mac: string;
  model: string;
  name: string;
}

// Genuine UDP broadcast the device itself answers directly - no
// login/credentials involved. NET_SDK_DiscoverDevice waits internally
// (its own default 3s, matching this project's other discovery methods'
// collection window) and returns whatever it found in one call - unlike
// Uniview's/Dahua's callback-based discovery, no manual start/stop/timer
// needed here at all.
export async function discoverTvtDevices(): Promise<TvtDiscoveredDevice[]> {
  return loadNative().discoverDevices();
}
