export interface LoginParams {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface DeviceSession {
  sessionId: string;
  channelCount: number;
}

export type StreamType = 'main' | 'sub';

export interface DecodedFrame {
  width: number;
  height: number;
  format: 'rgb32' | 'yuv420p';
  data: Buffer;
  timestampMs: number;
}

/**
 * One implementation per vendor (Hikvision, Dahua, TVT, Uniview), all wrapping
 * a native N-API addon around that vendor's own service-port SDK. The main
 * process only ever talks to this interface, mirroring SSM's VendorAdapter
 * pattern (src/adapters/registry.ts) conceptually, not as shared code.
 */
export interface VmsAdapter {
  readonly vendor: string;

  login(params: LoginParams): Promise<DeviceSession>;
  logout(sessionId: string): Promise<void>;

  startLiveView(
    sessionId: string,
    channel: number,
    streamType: StreamType,
    onFrame: (frame: DecodedFrame) => void,
  ): Promise<string>;
  stopLiveView(viewHandle: string): Promise<void>;
}
