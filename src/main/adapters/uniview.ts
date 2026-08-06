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
    quick?: boolean,
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
  // Global, SDK-wide (not per-session) - see the comment on the exported
  // configureGpuDecode() below for why this exists as a standalone function
  // rather than a VmsAdapter method.
  setGpuDecode(enable: boolean): boolean;

  // Genuine UDP broadcast discovery (NETDEV_Discovery/NETDEV_SetDiscoveryCallBack)
  // - see discoverUniviewDevices() below for why this exists as a standalone
  // function, same reasoning as setGpuDecode above.
  startDiscovery(onDevice: (device: NativeDiscoveredDevice) => void): void;
  stopDiscovery(): void;
}

interface NativeDiscoveredDevice {
  host: string;
  port: number;
  model: string;
  serialNumber: string;
  mac: string;
  name: string;
  manufacturer: string;
}

let cachedNative: NativeAddon | null = null;

function resolveAddonPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'native/uniview/build/Release/uniview_native.node');
  }
  return join(__dirname, '../../native/uniview/build/Release/uniview_native.node');
}

function loadNative(): NativeAddon {
  if (!cachedNative) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedNative = require(resolveAddonPath()) as NativeAddon;
  }
  return cachedNative;
}

export class UniviewAdapter implements VmsAdapter {
  readonly vendor = 'uniview';

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
    quick?: boolean,
  ): Promise<RecordingSegment[]> {
    const segments = await loadNative().findRecordings(sessionId, channel, startMs, endMs, filters, quick);
    return segments.map((seg) => ({
      startMs: seg.startMs,
      endMs: seg.endMs,
      type: (seg.type === 'continuous' || seg.type === 'motion' || seg.type === 'smart' ? seg.type : 'other'),
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
    // exists (a real app hang, otherwise) and how it differs from this
    // vendor's own kPlaybackFrameIntervalMs cap: on-screen Playback leaves
    // this unset, preserving its existing capped behavior exactly.
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

// NETDEV_EnabledGPUDecodeEx is a global SDK switch, not tied to any one
// device/session — doesn't fit the per-device VmsAdapter interface, so it's
// a standalone function instead. Called once at startup (see main/index.ts)
// from the persisted AppSettings.univiewGpuDecode setting, matching the
// existing Chromium hardware-acceleration toggle's "takes effect after
// restart" pattern rather than trying to live-toggle already-open sessions.
export function configureGpuDecode(enable: boolean): boolean {
  return loadNative().setGpuDecode(enable);
}

export interface UniviewDiscoveredDevice {
  host: string;
  port: number;
  model: string;
  serialNumber: string;
  mac: string;
  name: string;
  manufacturer: string;
}

// Fixed collection window rather than an explicit "scan complete" signal
// from the SDK (NETDEV_Discovery doesn't appear to have one - devices just
// arrive via the callback as their broadcast responses come in) - matches
// services/discovery.ts's existing ONVIF WS-Discovery pattern, same
// reasoning: a few seconds is enough for every device on a real LAN to
// answer, real vendor tools (SADP etc.) land in the same few-second range.
const DISCOVERY_DURATION_MS = 3000;

// Genuine UDP broadcast the device itself answers directly - no
// login/credentials involved at all, the same mechanism Uniview's own
// device-manager tool uses (confirmed via NetDEVSDK.h's demo app,
// DlgDiscovery.cpp). Replaces an earlier TCP-port-scan-plus-login-guess
// approach that was both far slower and less accurate.
export async function discoverUniviewDevices(): Promise<UniviewDiscoveredDevice[]> {
  const results: UniviewDiscoveredDevice[] = [];
  loadNative().startDiscovery((device) => results.push(device));
  await new Promise((resolve) => setTimeout(resolve, DISCOVERY_DURATION_MS));
  loadNative().stopDiscovery();
  return results;
}
