import { ipcMain } from 'electron';

// Shared backpressure tracking for both liveView and playback frame
// delivery. The native decode callback's own queue (Napi::ThreadSafeFunction)
// is already bounded (maxQueueSize=2, see native/*/src/addon.cc) — that
// protects the native-thread-to-main-process handoff. But forwarding a
// decoded frame from the main process to the renderer via
// `sender.send(...)` has no equivalent bound at all: it's fire-and-forget,
// so if the renderer's own event loop falls behind painting (a real risk
// with many simultaneous channels, each frame carrying a multi-MB raw RGBA
// buffer), frames pile up in Electron's own IPC transport with nothing to
// stop it. Confirmed live: a clean run where all 16 channels opened
// successfully (every native call completing normally, per the existing
// [unv-diag] logging) was followed by the whole system freezing for
// several minutes with zero native-layer activity in between — pointing
// squarely at this exact, previously-unprotected layer, not the native
// SDK calls themselves.
//
// Fix mirrors the native queue's own approach: track whether the renderer
// has acknowledged the last frame sent for a given viewHandle, and simply
// drop (don't send) any new frame that arrives before that ack comes back
// — always show the latest frame the renderer can actually keep up with,
// never build a backlog it doesn't want anyway.
const awaitingAck = new Set<string>();

export function shouldSendFrame(viewHandle: string): boolean {
  if (awaitingAck.has(viewHandle)) return false;
  awaitingAck.add(viewHandle);
  return true;
}

export function forgetFrameHandle(viewHandle: string): void {
  awaitingAck.delete(viewHandle);
}

// One shared ack channel for both liveView and playback frames — viewHandle
// values are already unique across the whole app, so there's no need for
// separate channels per feature.
export function registerFrameAckHandler(): void {
  ipcMain.on('frame:ack', (_event, viewHandle: string) => {
    awaitingAck.delete(viewHandle);
  });
}
