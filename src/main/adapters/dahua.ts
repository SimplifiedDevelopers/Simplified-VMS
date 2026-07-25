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
  login(params: LoginParams): DeviceSession;
  logout(sessionId: string): void;
  startLiveView(
    sessionId: string,
    channel: number,
    streamType: StreamType,
    onFrame: (frame: NativeFrame) => void,
  ): string;
  stopLiveView(viewHandle: string): void;
}

let cachedNative: NativeAddon | null = null;

function resolveAddonPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'native/dahua/build/Release/dahua_native.node');
  }
  return join(__dirname, '../../native/dahua/build/Release/dahua_native.node');
}

function loadNative(): NativeAddon {
  if (!cachedNative) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedNative = require(resolveAddonPath()) as NativeAddon;
  }
  return cachedNative;
}

export class DahuaAdapter implements VmsAdapter {
  readonly vendor = 'dahua';

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
