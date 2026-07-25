import { join } from 'path';
import { app } from 'electron';
import type { DecodedFrame, DeviceSession, LoginParams, StreamType } from '../../shared/types';
import type { VmsAdapter } from './vmsAdapter';

interface NativeFrame {
  width: number;
  height: number;
  format: 'rgb32';
  timestampMs: number;
  data: Buffer;
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
  stopLiveView(viewHandle: string): void;
}

let cachedNative: NativeAddon | null = null;

function resolveAddonPath(): string {
  // Packaged builds ship the addon under extraResources (see
  // electron-builder.yml) — it must stay outside app.asar since Windows
  // can't LoadLibrary a DLL from inside an asar archive.
  if (app.isPackaged) {
    return join(process.resourcesPath, 'native/hikvision/build/Release/hikvision_native.node');
  }
  return join(__dirname, '../../native/hikvision/build/Release/hikvision_native.node');
}

function loadNative(): NativeAddon {
  if (!cachedNative) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedNative = require(resolveAddonPath()) as NativeAddon;
  }
  return cachedNative;
}

export class HikvisionAdapter implements VmsAdapter {
  readonly vendor = 'hikvision';

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
    loadNative().stopLiveView(viewHandle);
  }
}
