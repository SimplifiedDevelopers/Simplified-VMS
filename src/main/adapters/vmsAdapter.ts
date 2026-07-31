import type {
  DecodedFrame,
  DeviceSession,
  LoginParams,
  PlaybackCommand,
  RecordingSearchFilter,
  RecordingSegment,
  StreamType,
} from '../../shared/types';

/**
 * One implementation per vendor (Hikvision, Dahua, TVT, Uniview), all wrapping
 * a native N-API addon around that vendor's own service-port SDK. The main
 * process only ever talks to this interface, mirroring SSM's VendorAdapter
 * pattern (src/adapters/registry.ts) conceptually, not as shared code.
 *
 * The playback/backup methods are optional and rolled out per vendor
 * incrementally (Uniview first) rather than added as required methods on
 * every adapter at once — main/ipc/playback.ts checks for their presence and
 * reports "not supported yet" for a vendor that hasn't implemented them,
 * rather than every adapter needing a throwaway stub just to satisfy the
 * interface.
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

  // Pauses/resumes frame delivery for an existing live-view or playback
  // session WITHOUT touching the underlying SDK stream — the native decode
  // session (and, for playback, its position) stays alive, so resuming is
  // instant. Used for a tile that's gone off-screen (hidden behind an
  // expanded tile, or the whole app tab isn't the active one): the native
  // addon skips the YUV->RGBA conversion, buffer copy, and IPC dispatch
  // entirely for a paused session — real, measured CPU/resource savings
  // across a 50+ device fleet where most tiles aren't actually being
  // looked at most of the time. Optional for the same rollout reason as
  // findRecordings/etc. above, though all four vendors implement it.
  setFrameDelivery?(viewHandle: string, enabled: boolean): Promise<void>;

  // Recording search — startMs/endMs bound the search window (typically one
  // calendar day), filters narrows the search to one or more recording
  // types (checkbox multi-select in the UI). `quick` is set by the
  // MiniCalendar's whole-month "which days have anything" query, which only
  // needs a yes/no per day, not accurate per-type classification — vendors
  // whose Motion/Smart search costs multiple extra round trips per query
  // (Uniview's event API takes one call per detection type, no combined
  // bitmask) can skip those and search continuous-only when set. Vendors
  // without that cost can ignore the flag entirely.
  findRecordings?(
    sessionId: string,
    channel: number,
    startMs: number,
    endMs: number,
    filters: RecordingSearchFilter[],
    quick?: boolean,
  ): Promise<RecordingSegment[]>;

  startPlayback?(
    sessionId: string,
    channel: number,
    startMs: number,
    endMs: number,
    onFrame: (frame: DecodedFrame) => void,
  ): Promise<string>;
  controlPlayback?(viewHandle: string, command: PlaybackCommand, value?: number): Promise<void>;
  // Current playback position, for syncing the timeline's scrub cursor while
  // playing — polled from the renderer rather than pushed, since it's only
  // needed while the Playback tab is actually visible and playing.
  getPlaybackTime?(viewHandle: string): Promise<number>;
  stopPlayback?(viewHandle: string): Promise<void>;

  // Exports a time range directly to a local file — the vendor SDK streams
  // straight to disk rather than the app receiving decoded frames, so this
  // is a genuinely separate operation from startPlayback, not a variant of
  // it. Returns a handle for progress polling / cancellation.
  startBackup?(sessionId: string, channel: number, startMs: number, endMs: number, saveFilePath: string): Promise<string>;
  // 0-100. Vendors without a dedicated progress callback derive this by
  // polling current download position against the requested time range.
  getBackupProgress?(downloadHandle: string): Promise<number>;
  stopBackup?(downloadHandle: string): Promise<void>;
}
