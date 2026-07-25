import type { DecodedFrame, DeviceSession, LoginParams, StreamType, VmsAdapter } from './vmsAdapter';

/**
 * Wraps the Hikvision HCNetSDK + PlayCtrl native addon (build/hikvision-native).
 * The addon isn't built yet — this throws until that lands so the rest of the
 * app (UI, IPC wiring) can be built and tested against the interface now.
 */
export class HikvisionAdapter implements VmsAdapter {
  readonly vendor = 'hikvision';

  async login(_params: LoginParams): Promise<DeviceSession> {
    throw new Error('Hikvision native addon not built yet');
  }

  async logout(_sessionId: string): Promise<void> {
    throw new Error('Hikvision native addon not built yet');
  }

  async startLiveView(
    _sessionId: string,
    _channel: number,
    _streamType: StreamType,
    _onFrame: (frame: DecodedFrame) => void,
  ): Promise<string> {
    throw new Error('Hikvision native addon not built yet');
  }

  async stopLiveView(_viewHandle: string): Promise<void> {
    throw new Error('Hikvision native addon not built yet');
  }
}
