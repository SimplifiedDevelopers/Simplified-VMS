// N-API bridge over Uniview NetDEVSDK. Unlike Hikvision (raw stream data
// out, external PlayCtrl decode step), NETDEV_RealPlay_V30 takes a
// NETDEV_STREAM_DATA_CB_S with dwCBType=NETDEV_STREAM_CB_TYPE_DECODE and
// delivers already-decoded YV12 frames (NETDEV_PICTURE_DATA_S) straight to
// our callback — confirmed via the SDK's own documented
// NETDEV_DECODE_VIDEO_DATA_CALLBACK_PF typedef and doc comments, not
// reverse-engineered. No separate decode library needed.
#include <napi.h>
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "NetDEVSDK.h"

namespace {

struct LiveViewSession {
  Napi::ThreadSafeFunction tsfn;
  LPVOID lUserID = nullptr;
  LPVOID lpPlayHandle = nullptr;
  // Playback (NETDEV_PlayBackByTime_V30) delivers frames through the exact
  // same NETDEV_STREAM_DATA_CB_S/NETDEV_PICTURE_DATA_S pipeline as live view
  // (NETDEV_RealPlay_V30) - confirmed via both functions' matching decode
  // callback parameter type - so this struct and OnDecodedFrame below are
  // shared between the two rather than duplicated. Only the teardown call
  // differs (NETDEV_StopRealPlay vs NETDEV_StopPlayBack), hence this flag.
  bool isPlayback = false;
  // Frame-rate throttle state for playback only (see kPlaybackFrameIntervalMs).
  ULONGLONG lastFrameDeliveredMs = 0;
  // Set from the renderer (liveView:setFrameDelivery) when this tile isn't
  // actually visible - hidden behind an expanded tile, or the app tab
  // isn't the active one. Skips the YUV->RGBA conversion, buffer copy,
  // and IPC dispatch for a frame nobody renders (real, measured waste
  // across a 50+ device fleet) without touching the underlying decode
  // session, so resuming is instant. std::atomic since it's written from
  // the N-API call thread and read from the decode callback thread.
  std::atomic<bool> framePaused{false};

  // Set only by clipExporter.ts's export sessions (see StartPlayback's
  // extra paceToRealtime argument). Unlike on-screen Playback's own
  // kPlaybackFrameIntervalMs cap below (which drops excess frames - fine
  // for a preview nobody needs pixel-complete, wrong for an export that
  // must capture every single one), this instead sleeps to real content
  // pace, same fix/reasoning as every other vendor's matching field: an
  // unpaced firehose of real per-frame work (RGBA conversion, a write
  // into ffmpeg's stdin) floods the main thread badly enough for Windows
  // to kill the whole app as "not responding." Only touched from
  // OnDecodedFrame itself (this session's own decode-delivery thread), so
  // - unlike framePaused above - these don't need to be atomic.
  bool paceToRealtime = false;
  bool paceInitialized = false;
  int64_t paceFirstContentMs = 0;
  std::chrono::steady_clock::time_point paceWallStart;
};

// Reviewing a recording doesn't need every decoded frame the way live
// monitoring does, but with hardware acceleration off (this dev VPS has no
// real GPU - see the disableHardwareAcceleration() note in main/index.ts),
// every frame pays real CPU cost three times over: the YUV->RGBA convert
// below, the full raw-buffer copy through Electron IPC, and a
// CPU-software canvas.putImageData paint in the renderer. Confirmed as a
// real, user-reported problem (CPU and memory both pegged near 90% on this
// VPS while a single recording played) - capping playback's own delivered
// rate skips all three costs proportionally for the frames it drops,
// without touching live view at all (gated on session->isPlayback).
constexpr ULONGLONG kPlaybackFrameIntervalMs = 80;  // ~12.5 fps cap

std::mutex g_mutex;
std::unordered_map<LPVOID, LiveViewSession*> g_sessionsByHandle;

// Recording backup/export (NETDEV_GetFileByTime) has no dedicated progress
// callback - the SDK's own demo polls current position via
// NETDEV_PlayBackControl(handle, GETPLAYTIME, ...) against the originally
// requested range instead (see DlgDownloadInfo/MenuPlayBack.cpp's
// DOWNLOAD_TIME_ID timer handler). Computing a percentage needs the
// original begin/end times kept alongside the download handle.
struct BackupRange {
  INT64 tBeginTime = 0;
  INT64 tEndTime = 0;
};

std::mutex g_backupMutex;
std::unordered_map<LPVOID, BackupRange> g_backupRanges;

// Login/StartLiveView used to be accidentally serialized by running
// synchronously on the main thread (each blocking call had to finish before
// the next could start). Moving them to AsyncWorker lets multiple calls run
// concurrently on libuv's thread pool - fine for the app's responsiveness,
// but NetDEVSDK's own thread-safety for concurrent RealPlay calls against
// the SAME session is undocumented and real hardware showed a crash/hang
// sequence (error 102, then repeated unidentified error 60067, and at least
// once a genuine hang where NETDEV_RealPlay_V30 never returned at all)
// right after "play all channels" fired several startLiveView calls
// back-to-back for one device.
//
// This is deliberately scoped PER SESSION (keyed by lUserID), not global.
// A global mutex was tried first and made things worse: when
// NETDEV_RealPlay_V30 hung for one channel on one device, the held global
// lock permanently blocked every OTHER Uniview device in the app too
// (confirmed live: a second, completely unrelated Uniview NVR froze right
// after the first one got stuck) since nothing else could ever enter the
// SDK again. Keying per-session means a stuck call only ever blocks further
// calls against that same device's session, never sibling devices.
std::mutex g_sdkMutexMapGuard;
std::unordered_map<LPVOID, std::unique_ptr<std::mutex>> g_sdkMutexBySession;

std::mutex& SdkMutexForSession(LPVOID lUserID) {
  std::lock_guard<std::mutex> lock(g_sdkMutexMapGuard);
  auto& slot = g_sdkMutexBySession[lUserID];
  if (!slot) slot = std::make_unique<std::mutex>();
  return *slot;
}

struct FrameData {
  int width = 0;
  int height = 0;
  long timestampMs = 0;
  std::vector<uint8_t> pixels;  // RGBA, ready for canvas ImageData
};

// BT.601 limited-range YV12 -> RGBA, respecting each plane's own line size
// (stride) rather than assuming tightly-packed rows — NETDEV_PICTURE_DATA_S
// provides dwLineSize explicitly, unlike Hikvision's callback which didn't,
// so there's no need to guess here.
void ConvertYV12ToRGBA(const NETDEV_PICTURE_DATA_S* pic, std::vector<uint8_t>& out) {
  const int width = pic->dwPicWidth;
  const int height = pic->dwPicHeight;
  const uint8_t* yPlane = pic->pucData[0];
  const uint8_t* uPlane = pic->pucData[1];
  const uint8_t* vPlane = pic->pucData[2];
  const int yStride = pic->dwLineSize[0];
  const int uStride = pic->dwLineSize[1];
  const int vStride = pic->dwLineSize[2];

  out.resize(static_cast<size_t>(width) * height * 4);
  for (int row = 0; row < height; ++row) {
    for (int col = 0; col < width; ++col) {
      const int Y = yPlane[row * yStride + col];
      const int U = uPlane[(row / 2) * uStride + (col / 2)] - 128;
      const int V = vPlane[(row / 2) * vStride + (col / 2)] - 128;

      int r = Y + ((91881 * V) >> 16);
      int g = Y - ((22554 * U + 46802 * V) >> 16);
      int b = Y + ((116130 * U) >> 16);
      r = r < 0 ? 0 : (r > 255 ? 255 : r);
      g = g < 0 ? 0 : (g > 255 ? 255 : g);
      b = b < 0 ? 0 : (b > 255 ? 255 : b);

      const int outIdx = (row * width + col) * 4;
      out[outIdx + 0] = static_cast<uint8_t>(r);
      out[outIdx + 1] = static_cast<uint8_t>(g);
      out[outIdx + 2] = static_cast<uint8_t>(b);
      out[outIdx + 3] = 255;
    }
  }
}

void STDCALL OnDecodedFrame(LPVOID lpPlayHandle, const NETDEV_PICTURE_DATA_S* pstPictureData, LPVOID /*lpUserParam*/) {
  if (!pstPictureData || pstPictureData->dwPicWidth <= 0 || pstPictureData->dwPicHeight <= 0) return;

  LiveViewSession* session = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_sessionsByHandle.find(lpPlayHandle);
    if (it == g_sessionsByHandle.end()) return;
    session = it->second;
  }
  if (session->framePaused.load(std::memory_order_relaxed)) return;

  if (session->isPlayback) {
    if (session->paceToRealtime) {
      // Export: pace to real content time via sleep rather than the
      // interval-drop cap below - an export can't lose a single frame the
      // way a nobody's-watching preview can. See paceToRealtime's own doc
      // comment for the full reasoning (a confirmed app hang otherwise).
      // tRenderTime is a 90kHz PTS tick count (the standard MPEG/RTP video
      // clock rate), NOT milliseconds and NOT an absolute/epoch timestamp -
      // confirmed live: consecutive frames' tRenderTime differed by exactly
      // 3600 ticks (3600/90000 = 40ms = 25fps, a perfectly ordinary camera
      // frame rate), while treating that 3600 as 3600ms made pacing think
      // 3.6 real seconds separated every frame, capping the sleep at 2000ms
      // per frame forever and making exports crawl. /90 converts ticks to
      // real milliseconds (90000 ticks/sec ÷ 1000 ms/sec = 90 ticks/ms).
      const int64_t contentMs = static_cast<int64_t>(pstPictureData->tRenderTime) / 90;
      if (!session->paceInitialized) {
        session->paceInitialized = true;
        session->paceFirstContentMs = contentMs;
        session->paceWallStart = std::chrono::steady_clock::now();
      } else {
        const int64_t elapsedContentMs = contentMs - session->paceFirstContentMs;
        const auto elapsedWall = std::chrono::steady_clock::now() - session->paceWallStart;
        const int64_t elapsedWallMs =
            std::chrono::duration_cast<std::chrono::milliseconds>(elapsedWall).count();
        const int64_t aheadMs = elapsedContentMs - elapsedWallMs;
        // Capped rather than a strict guarantee - a gap in the recording
        // (or a seek) can make consecutive frames' timestamps jump by
        // more than makes sense to actually sleep for.
        if (aheadMs > 0) Sleep(static_cast<DWORD>(aheadMs > 2000 ? 2000 : aheadMs));
      }
    } else {
      const ULONGLONG now = GetTickCount64();
      if (session->lastFrameDeliveredMs != 0 && now - session->lastFrameDeliveredMs < kPlaybackFrameIntervalMs) {
        return;
      }
      session->lastFrameDeliveredMs = now;
    }
  }

  auto* frame = new FrameData();
  frame->width = pstPictureData->dwPicWidth;
  frame->height = pstPictureData->dwPicHeight;
  // tRenderTime is a 90kHz PTS tick count, not milliseconds - see the
  // matching conversion (and its doc comment) in the paceToRealtime block
  // above. Applied here too since this is the value actually exposed to
  // JS as DecodedFrame.timestampMs.
  frame->timestampMs = static_cast<long>(pstPictureData->tRenderTime / 90);
  ConvertYV12ToRGBA(pstPictureData, frame->pixels);

  auto status = session->tsfn.NonBlockingCall(
      frame, [](Napi::Env env, Napi::Function jsCallback, FrameData* f) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("width", f->width);
        obj.Set("height", f->height);
        obj.Set("format", "rgb32");
        obj.Set("timestampMs", f->timestampMs);
        // NewOrCopy hands the already-converted buffer straight to V8
        // (falling back to a copy only if the platform disallows external
        // buffers) instead of Copy's unconditional second full-frame
        // memcpy — real, measured waste per the same resource-usage audit
        // that found the hidden-tile issue. Ownership of `f` (and its
        // pixels vector) transfers to the finalizer, which now owns the
        // `delete` that used to happen unconditionally right after
        // jsCallback.Call below.
        obj.Set("data", Napi::Buffer<uint8_t>::NewOrCopy(
                             env, f->pixels.data(), f->pixels.size(),
                             [](Napi::Env /*env*/, uint8_t* /*data*/, FrameData* frame) { delete frame; }, f));
        jsCallback.Call({obj});
      });
  if (status != napi_ok) delete frame;
}

void DestroySession(LiveViewSession* session) {
  if (session->isPlayback) {
    NETDEV_StopPlayBack(session->lpPlayHandle);
  } else {
    NETDEV_StopRealPlay(session->lpPlayHandle);
  }
  session->tsfn.Release();
  delete session;
}

std::string PointerToId(LPVOID ptr) {
  char buf[32];
  snprintf(buf, sizeof(buf), "%p", ptr);
  return std::string(buf);
}

LPVOID IdToPointer(const std::string& id) {
  void* ptr = nullptr;
  sscanf_s(id.c_str(), "%p", &ptr);
  return ptr;
}

}  // namespace

// See the AsyncWorker note above g_sdkMutexBySession for why
// login/startLiveView run off the main thread. Login itself is NOT
// serialized by any mutex here — different devices logging in concurrently
// is normal, expected usage (e.g. connecting to several NVRs at once), and
// the JS side (main/ipc/liveView.ts) already dedupes concurrent logins for
// the SAME device via its own pendingLogins map.
class LoginWorker : public Napi::AsyncWorker {
 public:
  LoginWorker(Napi::Env env, std::string host, int port, std::string username, std::string password,
              bool skipChannelQuery)
      : Napi::AsyncWorker(env),
        host_(std::move(host)),
        port_(port),
        username_(std::move(username)),
        password_(std::move(password)),
        skipChannelQuery_(skipChannelQuery),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    NETDEV_DEVICE_LOGIN_INFO_S loginInfo = {};
    strncpy_s(loginInfo.szIPAddr, host_.c_str(), _TRUNCATE);
    loginInfo.dwPort = port_;
    strncpy_s(loginInfo.szUserName, username_.c_str(), _TRUNCATE);
    strncpy_s(loginInfo.szPassword, password_.c_str(), _TRUNCATE);
    loginInfo.dwLoginProto = NETDEV_LOGIN_PROTO_PRIVATE;

    NETDEV_SELOG_INFO_S selogInfo = {};
    lUserID_ = NETDEV_Login_V30(&loginInfo, &selogInfo);
    if (!lUserID_) {
      const INT32 err = NETDEV_GetLastError();
      SetError("Uniview login failed (NETDEV error " + std::to_string(err) + ")");
      return;
    }
    if (skipChannelQuery_) return;

    // NETDEV_Login_V30's own output (NETDEV_SELOG_INFO_S) is security-log
    // metadata only - it carries no channel info at all, unlike
    // Hikvision/Dahua/TVT whose login calls return channel counts directly
    // in the same response. This second network round trip is the only way
    // to learn the channel list on this vendor, and roughly doubles
    // observed connect time - skipped whenever the caller already knows
    // the channels (see LoginParams.skipChannelQuery in shared/types.ts).
    chlCount_ = 128;
    chlList_.resize(chlCount_);
    BOOL ok = NETDEV_QueryVideoChlDetailListEx(lUserID_, &chlCount_, chlList_.data());
    if (!ok && chlCount_ > static_cast<INT32>(chlList_.size())) {
      chlList_.assign(chlCount_, {});
      ok = NETDEV_QueryVideoChlDetailListEx(lUserID_, &chlCount_, chlList_.data());
    }
    if (!ok) chlCount_ = 0;

    // This query is NVR-oriented and can fail outright (ok=false) or come
    // back with zero channels against a standalone IP camera - confirmed
    // live: a real Uniview IPC logs in successfully but this call reports
    // nothing, leaving the device with no selectable channels even though
    // it obviously has exactly one video stream. Fall back to a single
    // synthetic channel 1 whenever the query comes back empty, rather than
    // leaving a successfully-logged-in device with no channels at all.
    if (chlCount_ == 0) {
      chlCount_ = 1;
      chlList_.assign(1, {});
      chlList_[0].dwChannelID = 1;
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array channels = Napi::Array::New(env);
    for (INT32 i = 0; i < chlCount_; ++i) {
      const auto& chl = chlList_[i];
      // szChnName is the device's own configured camera name - already
      // present in the exact struct this call was returning anyway, just
      // unused until now. Not guaranteed to be null-terminated if the
      // device fills the full field, so bound the read with strnlen
      // rather than assuming a trailing '\0'.
      const size_t nameLen = strnlen(chl.szChnName, sizeof(chl.szChnName));
      const std::string name(chl.szChnName, nameLen);

      Napi::Object channelObj = Napi::Object::New(env);
      channelObj.Set("channel", Napi::Number::New(env, chl.dwChannelID));
      channelObj.Set("label", name.empty() ? ("Channel " + std::to_string(chl.dwChannelID)) : name);
      channels[static_cast<uint32_t>(i)] = channelObj;
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("sessionId", PointerToId(lUserID_));
    result.Set("channels", channels);
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  std::string host_;
  int port_;
  std::string username_;
  std::string password_;
  bool skipChannelQuery_;
  Napi::Promise::Deferred deferred_;
  LPVOID lUserID_ = nullptr;
  INT32 chlCount_ = 0;
  std::vector<NETDEV_VIDEO_CHL_DETAIL_INFO_EX_S> chlList_;
};

Napi::Value Login(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "login(params) expects an object").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object params = info[0].As<Napi::Object>();
  std::string host = params.Get("host").As<Napi::String>().Utf8Value();
  const int port = params.Get("port").As<Napi::Number>().Int32Value();
  std::string username = params.Get("username").As<Napi::String>().Utf8Value();
  std::string password = params.Get("password").As<Napi::String>().Utf8Value();
  const bool skipChannelQuery =
      params.Has("skipChannelQuery") && params.Get("skipChannelQuery").As<Napi::Boolean>().Value();

  auto* worker = new LoginWorker(env, std::move(host), port, std::move(username), std::move(password), skipChannelQuery);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value Logout(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  NETDEV_Logout(IdToPointer(sessionId));
  return env.Undefined();
}

class StartLiveViewWorker : public Napi::AsyncWorker {
 public:
  StartLiveViewWorker(Napi::Env env, LPVOID lUserID, int channel, std::string streamType,
                       Napi::ThreadSafeFunction tsfn)
      : Napi::AsyncWorker(env), channel_(channel), streamType_(std::move(streamType)),
        deferred_(Napi::Promise::Deferred::New(env)) {
    session_ = new LiveViewSession();
    session_->lUserID = lUserID;
    session_->tsfn = std::move(tsfn);
  }

  void Execute() override {
    // Temporary diagnostics (project convention for chasing a suspected
    // native hang on real hardware — see the SdkMutexForSession/hang
    // comment above) to see whether a real freeze is stuck WAITING for
    // the per-device mutex (another call on this device is holding it,
    // likely itself hung) vs stuck INSIDE NETDEV_RealPlay_V30 itself.
    const ULONGLONG tEnter = GetTickCount64();
    fprintf(stderr, "[unv-diag] Execute enter ch=%d stream=%s lUserID=%p t=%llu\n", channel_,
            streamType_.c_str(), session_->lUserID, tEnter);
    fflush(stderr);

    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session_->lUserID));

    const ULONGLONG tLocked = GetTickCount64();
    fprintf(stderr, "[unv-diag] ch=%d got sdk lock after %llums\n", channel_, tLocked - tEnter);
    fflush(stderr);

    NETDEV_PREVIEWINFO_S previewInfo = {};
    previewInfo.dwChannelID = channel_;
    previewInfo.dwStreamType =
        (streamType_ == "sub") ? NETDEV_LIVE_STREAM_INDEX_AUX : NETDEV_LIVE_STREAM_INDEX_MAIN;
    previewInfo.dwLinkMode = NETDEV_TRANSPROTOCAL_RTPTCP;
    previewInfo.hPlayWnd = nullptr;

    NETDEV_STREAM_DATA_CB_S streamCB = {};
    streamCB.bDecode = TRUE;
    streamCB.dwCBType = NETDEV_STREAM_CB_TYPE_DECODE;
    streamCB.lpVideoDataCB = reinterpret_cast<LPVOID>(OnDecodedFrame);
    streamCB.lpAudioDataCB = nullptr;
    streamCB.lpUserData = nullptr;

    fprintf(stderr, "[unv-diag] ch=%d calling NETDEV_RealPlay_V30...\n", channel_);
    fflush(stderr);
    LPVOID lpPlayHandle = NETDEV_RealPlay_V30(session_->lUserID, &previewInfo, &streamCB);
    const ULONGLONG tReturned = GetTickCount64();
    fprintf(stderr, "[unv-diag] ch=%d RealPlay_V30 returned %p after %llums (waited %llums for lock)\n",
            channel_, lpPlayHandle, tReturned - tLocked, tLocked - tEnter);
    fflush(stderr);

    if (!lpPlayHandle) {
      const INT32 err = NETDEV_GetLastError();
      fprintf(stderr, "[unv-diag] ch=%d failed, NETDEV error %d\n", channel_, err);
      fflush(stderr);
      session_->tsfn.Release();
      delete session_;
      session_ = nullptr;
      SetError("NETDEV_RealPlay_V30 failed (NETDEV error " + std::to_string(err) + ")");
      return;
    }
    session_->lpPlayHandle = lpPlayHandle;
    lpPlayHandle_ = lpPlayHandle;

    std::lock_guard<std::mutex> lock(g_mutex);
    g_sessionsByHandle[lpPlayHandle] = session_;
  }

  void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), PointerToId(lpPlayHandle_))); }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  int channel_;
  std::string streamType_;
  LiveViewSession* session_ = nullptr;
  LPVOID lpPlayHandle_ = nullptr;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StartLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const std::string streamType = info[2].As<Napi::String>().Utf8Value();
  Napi::Function onFrame = info[3].As<Napi::Function>();

  LPVOID lUserID = IdToPointer(sessionId);
  // maxQueueSize=2 (was 0/unbounded) — confirmed live this was a real,
  // severe memory leak: when the renderer falls behind (heavy multi-
  // channel decode/paint load), an unbounded queue lets every decoded
  // frame pile up forever with nothing to stop it, observed growing to
  // 51GB and taking the whole system down (Windows'
  // Resource-Exhaustion-Detector flagged electron.exe directly). A small
  // bound is also just the *correct* behavior for live video regardless —
  // if the consumer can't keep up, drop stale frames and show the
  // latest one, don't accumulate a backlog. The existing NonBlockingCall
  // caller already does `if (status != napi_ok) delete frame;`, so a
  // frame that doesn't fit in the bounded queue is already cleanly
  // discarded with no extra code needed here.
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "uniview-frame-callback", 2, 1);

  auto* worker = new StartLiveViewWorker(env, lUserID, channel, streamType, std::move(tsfn));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

// Runs off the main thread — DestroySession() calls into the vendor SDK's
// own stop function (NETDEV_StopRealPlay/NETDEV_StopPlayBack), and this
// SDK family has a confirmed real-hardware history of its sibling
// NETDEV_RealPlay_V30 hanging indefinitely with no error (see
// SdkMutexForSession's doc comment above). StopLiveView used to be a
// plain synchronous N-API function — if the stop call ever hung the same
// way, it would block Electron's entire main-process event loop, not
// just this one operation, since nothing else in the app runs while the
// main thread is stuck inside a synchronous native call. Confirmed live:
// double-clicking a tile to expand then immediately collapse (which
// calls assign() -> stop() then start() for that tile) froze the whole
// app, not just that tile.
class StopLiveViewWorker : public Napi::AsyncWorker {
 public:
  StopLiveViewWorker(Napi::Env env, LPVOID lpPlayHandle)
      : Napi::AsyncWorker(env), lpPlayHandle_(lpPlayHandle),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    const ULONGLONG tEnter = GetTickCount64();
    fprintf(stderr, "[unv-diag] Stop Execute enter handle=%p t=%llu\n", lpPlayHandle_, tEnter);
    fflush(stderr);

    LiveViewSession* session = nullptr;
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      auto it = g_sessionsByHandle.find(lpPlayHandle_);
      if (it != g_sessionsByHandle.end()) {
        session = it->second;
        g_sessionsByHandle.erase(it);
      }
    }
    if (session) {
      // Acquires the SAME per-device mutex StartLiveView uses — without
      // this, a stop for one channel could run fully concurrently against
      // the SDK with a start (or another stop) for a DIFFERENT channel on
      // the SAME device, since only Start was ever serialized against
      // this lock. Real hardware confirmed to freeze even with no
      // main-stream/expand path involved at all, across multiple
      // different machines (ruling out a single-machine capacity issue) —
      // an unsynchronized stop-vs-start race against this SDK for the
      // same device session is the remaining, more fundamental
      // explanation.
      std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session->lUserID));
      fprintf(stderr, "[unv-diag] Stop handle=%p calling DestroySession (session found)...\n", lpPlayHandle_);
      fflush(stderr);
      DestroySession(session);
      fprintf(stderr, "[unv-diag] Stop handle=%p DestroySession returned after %llums\n", lpPlayHandle_,
              GetTickCount64() - tEnter);
      fflush(stderr);
    } else {
      fprintf(stderr, "[unv-diag] Stop handle=%p no session found (already stopped?)\n", lpPlayHandle_);
      fflush(stderr);
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  LPVOID lpPlayHandle_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StopLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string viewHandle = info[0].As<Napi::String>().Utf8Value();
  LPVOID lpPlayHandle = IdToPointer(viewHandle);

  auto* worker = new StopLiveViewWorker(env, lpPlayHandle);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

// Toggles frame delivery for a session without touching the underlying
// SDK stream at all — used when a tile goes off-screen (hidden behind an
// expanded tile, or the whole app tab isn't the active one) so it can
// resume instantly with no reconnect when it becomes visible again,
// unlike actually stopping the session.
Napi::Value SetFrameDelivery(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string viewHandle = info[0].As<Napi::String>().Utf8Value();
  const bool enabled = info[1].As<Napi::Boolean>().Value();
  LPVOID lpPlayHandle = IdToPointer(viewHandle);

  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_sessionsByHandle.find(lpPlayHandle);
  if (it != g_sessionsByHandle.end()) {
    it->second->framePaused.store(!enabled, std::memory_order_relaxed);
  }
  return env.Undefined();
}

// NETDEV_FINDDATA_S.byFileType (NETDEV_STORE_TYPE_E) was meant to classify
// *why* each segment was recorded, but confirmed live against a real
// device: every single result came back byFileType=255
// (NETDEV_STORE_TYPE_INVALID) regardless of what the segment actually was -
// this device just doesn't populate that field via NETDEV_FindFile_V30, so
// trusting it is a dead end (not a mapping bug, the field itself is unusable
// here).
//
// A second, more fundamental problem surfaced once classification moved to
// "which search found it": searching "Smart" alone (even with a correctly
// narrowed AI-only bitmask, no COMMON/MOTION overlap) still matched nearly
// an entire busy day on a real parking-lot camera. NETDEV_FindFile_V30 is a
// FILE-level search - it returns whatever recording file/chunk boundary
// contains a match, not the actual moment-to-moment span of the triggering
// event. A camera recording in hour-long files where a person/vehicle is
// detected at some point in nearly every hour will report nearly the whole
// day as "matching", even though the real detections are only seconds long.
//
// NETDEV_FindEventRecordList is a genuinely different, EVENT-level search -
// NETDEV_EVENT_RECORD_INFO_S.udwBegin/udwEnd are the actual detection
// event's own start/end, not a file/chunk boundary - so Motion and Smart
// (both fundamentally "when did a detection event happen" questions) now
// use it instead. Continuous recording has no equivalent "event" (it's
// scheduled, not triggered), so it stays on the file search, which is the
// right tool for "what recording files exist" in the first place.
struct TypeSearch {
  std::string label;
  bool isEventSearch;
  // File search: exactly one NETDEV_RECORD_SEARCH_TYPE_E bitmask value.
  // Event search: one NETDEV_FindEventRecordList call PER entry (that API
  // takes a single event type per call, not a combinable bitmask).
  std::vector<UINT32> values;
};

// quick=true skips the event searches (Motion/Smart) entirely, searching
// continuous-only regardless of the requested filters. Used by the
// MiniCalendar's whole-month "which days have anything" query, where a
// yes/no per day is all that's needed - the event API takes one call PER
// detection type (6 separate round trips for Motion+Smart combined, vs. 1
// for the file search), and on real hardware confirmed to often just fail
// outright (NETDEV_E_CONNECT_ERROR) rather than fail fast, so those calls
// were pure wasted time on a query that doesn't need per-type accuracy
// anyway. The day-view search (quick=false/unset) still runs the full set.
std::vector<TypeSearch> DetermineSearches(const std::vector<std::string>& filters, bool quick) {
  bool all = filters.empty();
  for (const auto& f : filters) {
    if (f == "all") all = true;
  }

  auto continuousSearch = TypeSearch{"continuous", false, {static_cast<UINT32>(NETDEV_RECORD_SEARCH_TYPE_COMMON)}};
  if (quick) return {continuousSearch};

  // Was an event search (NETDEV_FindEventRecordList, NETDEV_EVENT_RECORD_
  // TYPE_MOVE_DETECT) - confirmed live to fail with NETDEV_E_CONNECT_ERROR
  // (200) on every single call on real hardware that DOES have genuine
  // motion-recorded footage (confirmed against the device's own official
  // client, which shows it fine in its timeline), so the gap is in this
  // integration, not the device/firmware. Switched to the same file search
  // (NETDEV_FindFile_V30) continuous already uses reliably, with its own
  // dedicated motion bitmask - coarser boundaries (whole recording-file
  // spans, not the precise detection window) but actually returns data.
  auto motionSearch = TypeSearch{"motion", false, {static_cast<UINT32>(NETDEV_RECORD_SEARCH_TYPE_MOTION)}};
  // Human/vehicle/face/line-crossing/area-intrusion detection - matches
  // what the user asked "Smart" to mean, using the SDK's own more granular
  // per-detection-type event enum rather than the file search's much
  // coarser (and, per NETDEV_RECORD_SEARCH_TYPE_SMART_RECORD, actually
  // wrong - it also set the COMMON/MOTION bits) combined bitmask.
  auto smartSearch = TypeSearch{"smart",
                                 true,
                                 {static_cast<UINT32>(NETDEV_EVENT_RECORD_TYPE_HUMAN_DETECTION),
                                  static_cast<UINT32>(NETDEV_EVENT_RECORD_TYPE_FACE_DETECTION),
                                  static_cast<UINT32>(NETDEV_EVENT_RECORD_TYPE_CROSS_LINE_DETECT),
                                  static_cast<UINT32>(NETDEV_EVENT_RECORD_TYPE_INTRUSION_DETECT),
                                  static_cast<UINT32>(NETDEV_EVENT_RECORD_TYPE_INTE_MOTION)}};

  if (all) return {continuousSearch, motionSearch, smartSearch};

  std::vector<TypeSearch> out;
  for (const auto& f : filters) {
    if (f == "continuous") out.push_back(continuousSearch);
    else if (f == "motion") out.push_back(motionSearch);
    else if (f == "smart") out.push_back(smartSearch);
  }
  return out;
}

// A segment can legitimately match more than one search (e.g. a device that
// records "alarm or motion" together) - when the exact same [begin,end)
// range comes back from two different type searches, only the more specific
// classification is kept rather than showing/double-counting it twice.
int TypePriority(const std::string& type) {
  if (type == "smart") return 3;
  if (type == "motion") return 2;
  return 1;  // continuous
}

std::vector<std::pair<INT64, INT64>> SearchByFile(LPVOID lUserID, int channel, INT64 beginTime, INT64 endTime,
                                                   UINT32 fileSearchType) {
  std::vector<std::pair<INT64, INT64>> out;
  NETDEV_FILECOND_S findCond = {};
  findCond.dwChannelID = channel;
  findCond.tBeginTime = beginTime;
  findCond.tEndTime = endTime;
  findCond.dwFileType = static_cast<INT32>(fileSearchType);

  // Locked here (per call) rather than once around the whole FindRecordings
  // Execute() - see SearchByFileChunked's matching comment for why holding
  // this device-wide lock for an entire multi-search/multi-day scan was a
  // real, confirmed-live bug.
  std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(lUserID));
  LPVOID findHandle = NETDEV_FindFile_V30(lUserID, &findCond);
  if (!findHandle) return out;  // no matches - not an error

  NETDEV_FINDDATA_S findData = {};
  while (NETDEV_FindNextFile(findHandle, &findData)) {
    out.push_back({findData.tBeginTime, findData.tEndTime});
  }
  NETDEV_FindClose(findHandle);
  return out;
}

// NETDEV_FindFile_V30's own server-side cost scales with the WIDTH of the
// queried time range, not just the result count - confirmed live: the
// identical query for a single day (channel with a lot of continuous
// recording) returned in 406ms, but widened to a full month it took over
// 10 seconds and came back with a NULL handle - a genuine timeout/failure,
// not "zero matches" (NETDEV_FindFile_V30 returning null is documented as
// meaning either, with no way to tell which from the return value alone).
//
// Two faster attempts were tried and both confirmed live to lose real data:
// week-sized chunks (fully enumerated) still silently dropped whole days on
// a sufficiently busy channel, and a "slow-null means it was actually a
// timeout, so bisect" heuristic on top of that still didn't fully recover
// them. Correctness matters more than speed here.
//
// NOTE: the "nothing is waiting on it synchronously" reasoning this comment
// used to end on is now WRONG and left here as a warning, not a rationale -
// it assumed the connectionManager.ts per-device prefetch (mentioned above)
// that used to warm this cache in the background right after connect, well
// before a user ever opened the calendar. That prefetch was reverted (see
// connectionManager.ts's loginOnce) once it was confirmed to compete for
// this exact device-wide lock against ordinary Live View channel starts.
// What actually calls this today is MiniCalendar's own month-wide query,
// fired live whenever a device/channel/date is picked in Playback - and
// held the device's ONE shared SdkMutexForSession lock for this entire
// multi-day loop (confirmed live: a user's explicit Play/Download click on
// the very next line would queue up behind however long this scan took,
// sometimes minutes). Locking is now scoped per-day inside the loop below
// instead, so a foreground call can interleave between days rather than
// wait for the whole month. Early-exiting each day's enumeration after the
// first match still keeps this a genuine "yes/no per day" probe rather than
// wastefully collecting every segment, which the calendar dots don't need.
std::vector<std::pair<INT64, INT64>> SearchByFileChunked(LPVOID lUserID, int channel, INT64 beginTime, INT64 endTime,
                                                          UINT32 fileSearchType) {
  std::vector<std::pair<INT64, INT64>> out;
  const INT64 kDaySeconds = 24 * 60 * 60;

  for (INT64 dayStart = beginTime; dayStart < endTime; dayStart += kDaySeconds) {
    const INT64 rawDayEnd = dayStart + kDaySeconds;
    const INT64 dayEnd = (rawDayEnd < endTime) ? rawDayEnd : endTime;

    NETDEV_FILECOND_S findCond = {};
    findCond.dwChannelID = channel;
    findCond.tBeginTime = dayStart;
    findCond.tEndTime = dayEnd;
    findCond.dwFileType = static_cast<INT32>(fileSearchType);

    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(lUserID));
    LPVOID findHandle = NETDEV_FindFile_V30(lUserID, &findCond);
    if (!findHandle) continue;  // no match this day, or this one day timed out - move on regardless

    NETDEV_FINDDATA_S findData = {};
    if (NETDEV_FindNextFile(findHandle, &findData)) {
      out.push_back({findData.tBeginTime, findData.tEndTime});
    }
    NETDEV_FindClose(findHandle);
  }
  return out;
}

std::vector<std::pair<INT64, INT64>> SearchByEvent(LPVOID lUserID, UINT32 channel, INT64 beginTime, INT64 endTime,
                                                    UINT32 eventType) {
  std::vector<std::pair<INT64, INT64>> out;
  UINT32 channelArr[1] = {channel};
  NETDEV_EVENT_RECORD_PARAM_S param = {};
  param.udwNum = 1;
  param.pudwChannels = channelArr;
  param.udwRecordType = eventType;
  param.tBegin = beginTime;
  param.tEnd = endTime;
  // No pagination yet (udwPage always 0) - a generous single-page cap
  // instead. NETDEV_BATCH_OPERATE_BASIC_S.udwTotal would reveal if a real
  // device ever has more events than this in one day, worth revisiting if
  // truncation shows up in practice.
  param.udwLimit = 2000;
  param.udwPage = 0;

  // Locked here (per call), not once around the whole FindRecordings
  // Execute() - see SearchByFileChunked's matching comment.
  std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(lUserID));
  NETDEV_BATCH_OPERATE_BASIC_S resultInfo = {};
  LPVOID findHandle = NETDEV_FindEventRecordList(lUserID, &param, &resultInfo);
  if (!findHandle) {
    // Confirmed live: NETDEV_FindEventRecordList fails with
    // NETDEV_E_CONNECT_ERROR (200) on the very first call after a fresh
    // connect, on every event type tried - not occasional, not specific to
    // Motion. A brief pause + one retry recovers this on real hardware
    // (same "first call after connect is flaky, retry succeeds" shape as
    // onvif.ts's own ffprobe retry).
    Sleep(300);
    findHandle = NETDEV_FindEventRecordList(lUserID, &param, &resultInfo);
  }
  if (!findHandle) {
    fprintf(stderr, "[unv-event-diag] NETDEV_FindEventRecordList NULL after retry eventType=%u error=%d\n", eventType,
            NETDEV_GetLastError());
    fflush(stderr);
    return out;
  }

  NETDEV_EVENT_RECORD_INFO_S info = {};
  while (NETDEV_FindNextEventRecordInfo(findHandle, &info)) {
    out.push_back({static_cast<INT64>(info.udwBegin), static_cast<INT64>(info.udwEnd)});
  }
  NETDEV_FindCloseEventRecordList(findHandle);
  fprintf(stderr, "[unv-event-diag] eventType=%u resultInfo.udwTotal=%u collected=%zu\n", eventType,
          resultInfo.udwTotal, out.size());
  fflush(stderr);
  return out;
}

// Recording search is a real network round trip to the device (confirmed
// via the SDK's own demo treating file search as a might-take-a-moment
// call, same class of operation as Login) - run off the main thread like
// Login/StartLiveView rather than risk freezing the app for however long a
// day's worth of segments takes to enumerate.
class FindRecordingsWorker : public Napi::AsyncWorker {
 public:
  FindRecordingsWorker(Napi::Env env, LPVOID lUserID, int channel, INT64 beginTime, INT64 endTime,
                       std::vector<TypeSearch> searches, bool quick)
      : Napi::AsyncWorker(env),
        lUserID_(lUserID),
        channel_(channel),
        beginTime_(beginTime),
        endTime_(endTime),
        searches_(std::move(searches)),
        quick_(quick),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    // No longer locked here for the whole call - SearchByFile/
    // SearchByFileChunked/SearchByEvent below each take the device's
    // SdkMutexForSession themselves, scoped to their own individual native
    // call(s), so a multi-day/multi-search scan here can't monopolize the
    // device's one shared lock against a foreground Play/Download click for
    // however long the whole thing takes. See SearchByFileChunked's comment
    // for the confirmed-live symptom this fixed.
    //
    // continuous is a FILE-level search (wide chunk boundaries, e.g. a
    // whole hour-long file) while motion/smart are EVENT-level (the
    // precise, much narrower detection window, typically nested INSIDE a
    // continuous file's span) - confirmed live these two almost never
    // share an identical [begin,end) pair. An exact-range dedup (the
    // previous approach here) therefore never actually merges them: both
    // the wide continuous segment and the narrow nested motion segment
    // survive as two separate, overlapping segments, and whichever the
    // renderer happens to paint on top visually wins - confirmed live as
    // exactly the bug reported (motion segments showing as a muddied
    // blue/gray instead of their real orange, painted over by the wider
    // continuous segment covering the same span). Fixed with a proper
    // priority sweep: every point in time is covered by whichever
    // overlapping interval has the highest TypePriority, same "more
    // specific classification wins" intent as before, now actually
    // correct for overlapping (not just identical) ranges.
    struct RawInterval { INT64 begin; INT64 end; int priority; };
    std::vector<RawInterval> raw;

    for (const auto& search : searches_) {
      std::vector<std::pair<INT64, INT64>> ranges;
      if (search.isEventSearch) {
        for (UINT32 eventType : search.values) {
          auto eventRanges = SearchByEvent(lUserID_, static_cast<UINT32>(channel_), beginTime_, endTime_, eventType);
          ranges.insert(ranges.end(), eventRanges.begin(), eventRanges.end());
        }
      } else if (quick_) {
        ranges = SearchByFileChunked(lUserID_, channel_, beginTime_, endTime_, search.values[0]);
      } else {
        ranges = SearchByFile(lUserID_, channel_, beginTime_, endTime_, search.values[0]);
      }

      // Diagnostic only (not yet confirmed live): whether real Uniview
      // motion/smart events ever come back as zero-width (begin==end) or
      // inverted (end<begin) ranges is unknown, so nothing is filtered out
      // here based on width - unlike an earlier version of this fix, which
      // speculatively dropped non-positive-width ranges and needs to be
      // ruled out as the cause if "Motion" alone still comes back empty.
      const int priority = TypePriority(search.label);
      fprintf(stderr, "[unv-diag] findRecordings type=%s isEvent=%d rawCount=%zu\n", search.label.c_str(),
              search.isEventSearch ? 1 : 0, ranges.size());
      int logged = 0;
      for (const auto& range : ranges) {
        if (logged < 10) {
          fprintf(stderr, "[unv-diag]   range begin=%lld end=%lld width=%lld\n", static_cast<long long>(range.first),
                  static_cast<long long>(range.second), static_cast<long long>(range.second - range.first));
          logged++;
        }
        raw.push_back({range.first, range.second, priority});
      }
    }

    // Sweep-line over start/end events, sorted by time. Only 3 priority
    // levels exist (continuous=1, motion=2, smart=3), so tracking an
    // active-count per level and taking the highest non-zero one is O(1)
    // per event rather than needing a full multiset.
    struct SweepEvent { INT64 time; int priority; int delta; };
    std::vector<SweepEvent> events;
    events.reserve(raw.size() * 2);
    for (const auto& r : raw) {
      events.push_back({r.begin, r.priority, +1});
      events.push_back({r.end, r.priority, -1});
    }
    std::sort(events.begin(), events.end(), [](const SweepEvent& a, const SweepEvent& b) { return a.time < b.time; });

    int activeCount[4] = {0, 0, 0, 0};  // indices 1..3
    auto typeForPriority = [](int p) -> std::string {
      if (p == 3) return "smart";
      if (p == 2) return "motion";
      return "continuous";
    };

    std::vector<std::pair<INT64, INT64>> merged;
    std::vector<std::string> mergedTypes;
    INT64 lastTime = events.empty() ? 0 : events.front().time;
    size_t idx = 0;
    while (idx < events.size()) {
      const INT64 t = events[idx].time;
      if (t > lastTime) {
        const int winner = activeCount[3] > 0 ? 3 : activeCount[2] > 0 ? 2 : activeCount[1] > 0 ? 1 : 0;
        if (winner > 0) {
          const std::string type = typeForPriority(winner);
          if (!mergedTypes.empty() && mergedTypes.back() == type && merged.back().second == lastTime) {
            merged.back().second = t;
          } else {
            merged.push_back({lastTime, t});
            mergedTypes.push_back(type);
          }
        }
        lastTime = t;
      }
      while (idx < events.size() && events[idx].time == t) {
        activeCount[events[idx].priority] += events[idx].delta;
        idx++;
      }
    }

    for (size_t i = 0; i < merged.size(); ++i) {
      segments_.push_back({merged[i].first, merged[i].second, mergedTypes[i]});
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array result = Napi::Array::New(env);
    for (size_t i = 0; i < segments_.size(); ++i) {
      const auto& seg = segments_[i];
      Napi::Object obj = Napi::Object::New(env);
      // Seconds (SDK convention, confirmed via the demo's own time_t-based
      // GetTime()/mktime() helpers) -> milliseconds (this app's convention
      // everywhere else, e.g. DecodedFrame.timestampMs).
      obj.Set("startMs", Napi::Number::New(env, static_cast<double>(seg.beginTime) * 1000.0));
      obj.Set("endMs", Napi::Number::New(env, static_cast<double>(seg.endTime) * 1000.0));
      obj.Set("type", seg.type);
      result[static_cast<uint32_t>(i)] = obj;
    }
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  struct Segment {
    INT64 beginTime;
    INT64 endTime;
    std::string type;
  };

  LPVOID lUserID_;
  int channel_;
  INT64 beginTime_;
  INT64 endTime_;
  std::vector<TypeSearch> searches_;
  bool quick_;
  Napi::Promise::Deferred deferred_;
  std::vector<Segment> segments_;
};

Napi::Value FindRecordings(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const INT64 beginTime = static_cast<INT64>(info[2].As<Napi::Number>().DoubleValue() / 1000.0);
  const INT64 endTime = static_cast<INT64>(info[3].As<Napi::Number>().DoubleValue() / 1000.0);

  Napi::Array filtersArr = info[4].As<Napi::Array>();
  std::vector<std::string> filters;
  for (uint32_t i = 0; i < filtersArr.Length(); ++i) {
    filters.push_back(filtersArr.Get(i).As<Napi::String>().Utf8Value());
  }
  const bool quick = info.Length() > 5 && info[5].IsBoolean() && info[5].As<Napi::Boolean>().Value();

  LPVOID lUserID = IdToPointer(sessionId);
  auto* worker = new FindRecordingsWorker(env, lUserID, channel, beginTime, endTime, DetermineSearches(filters, quick),
                                           quick);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

// Mirrors StartLiveViewWorker almost exactly - same session bookkeeping,
// same per-session SDK mutex, same decode callback - only the actual SDK
// call and the resulting isPlayback flag differ. See the note on
// LiveViewSession::isPlayback above for why this doesn't need its own
// separate frame-conversion path.
class StartPlaybackWorker : public Napi::AsyncWorker {
 public:
  StartPlaybackWorker(Napi::Env env, LPVOID lUserID, int channel, INT64 beginTime, INT64 endTime,
                       Napi::ThreadSafeFunction tsfn, bool paceToRealtime)
      : Napi::AsyncWorker(env),
        channel_(channel),
        beginTime_(beginTime),
        endTime_(endTime),
        deferred_(Napi::Promise::Deferred::New(env)) {
    session_ = new LiveViewSession();
    session_->lUserID = lUserID;
    session_->tsfn = std::move(tsfn);
    session_->isPlayback = true;
    session_->paceToRealtime = paceToRealtime;
  }

  void Execute() override {
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session_->lUserID));

    NETDEV_PLAYBACKCOND_S playBackCond = {};
    playBackCond.dwChannelID = channel_;
    playBackCond.tBeginTime = beginTime_;
    playBackCond.tEndTime = endTime_;
    playBackCond.dwLinkMode = NETDEV_TRANS_PROTOCAL_TCP;
    playBackCond.hPlayWnd = nullptr;
    playBackCond.dwPlaySpeed = NETDEV_PLAY_STATUS_1_FORWARD;

    NETDEV_STREAM_DATA_CB_S streamCB = {};
    streamCB.bDecode = TRUE;
    streamCB.dwCBType = NETDEV_STREAM_CB_TYPE_DECODE;
    streamCB.lpVideoDataCB = reinterpret_cast<LPVOID>(OnDecodedFrame);
    streamCB.lpAudioDataCB = nullptr;
    streamCB.lpUserData = nullptr;

    LPVOID lpPlayHandle = NETDEV_PlayBackByTime_V30(session_->lUserID, &playBackCond, &streamCB);
    if (!lpPlayHandle) {
      const INT32 err = NETDEV_GetLastError();
      session_->tsfn.Release();
      delete session_;
      session_ = nullptr;
      SetError("NETDEV_PlayBackByTime_V30 failed (NETDEV error " + std::to_string(err) + ")");
      return;
    }
    session_->lpPlayHandle = lpPlayHandle;
    lpPlayHandle_ = lpPlayHandle;

    std::lock_guard<std::mutex> lock(g_mutex);
    g_sessionsByHandle[lpPlayHandle] = session_;
  }

  void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), PointerToId(lpPlayHandle_))); }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  int channel_;
  INT64 beginTime_;
  INT64 endTime_;
  LiveViewSession* session_ = nullptr;
  LPVOID lpPlayHandle_ = nullptr;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StartPlayback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const INT64 beginTime = static_cast<INT64>(info[2].As<Napi::Number>().DoubleValue() / 1000.0);
  const INT64 endTime = static_cast<INT64>(info[3].As<Napi::Number>().DoubleValue() / 1000.0);
  Napi::Function onFrame = info[4].As<Napi::Function>();
  // Optional - only clipExporter.ts's export sessions pass true (see
  // LiveViewSession::paceToRealtime's doc comment). Absent/false preserves
  // on-screen Playback's existing kPlaybackFrameIntervalMs-capped behavior
  // exactly.
  const bool paceToRealtime = info.Length() > 5 && info[5].IsBoolean() && info[5].As<Napi::Boolean>().Value();

  LPVOID lUserID = IdToPointer(sessionId);
  // maxQueueSize=2 (was 0/unbounded) — see the matching comment on the
  // live-view StartLiveView's own tsfn creation above for why.
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "uniview-playback-frame-callback", 2, 1);

  auto* worker = new StartPlaybackWorker(env, lUserID, channel, beginTime, endTime, std::move(tsfn), paceToRealtime);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

// Pause/resume/seek/GETPLAYTIME/GetFileByTime/StopGetFile were all
// initially assumed safe to call synchronously on the N-API thread, on the
// theory that they're cheap calls against an already-open handle (the SDK's
// own demo just polls GETPLAYTIME on a 1s UI timer with no apparent
// threading concerns). That assumption was wrong: confirmed live, switching
// to a different recording froze the entire app hard enough to need a force
// quit, with no NETDEV error logged at all - the exact signature of a
// blocked main thread, not a normal SDK error path. The demo's own MFC UI
// would show the identical symptom (its message loop is just as single
// threaded) if one of these ever hung against a slow/uncooperative device,
// so its apparent safety never actually proved anything. Every one of these
// now runs via AsyncWorker instead, matching Login/StartLiveView/
// StartPlayback/FindRecordings - the same "any real SDK call can
// unpredictably hang, so it never runs on the thread Electron's UI depends
// on" rule already established from Live View's own RealPlay hang.
class ControlPlaybackWorker : public Napi::AsyncWorker {
 public:
  ControlPlaybackWorker(Napi::Env env, LPVOID lUserID, LPVOID lpPlayHandle, std::string command, INT64 seekTime,
                         INT32 speedValue)
      : Napi::AsyncWorker(env),
        lUserID_(lUserID),
        lpPlayHandle_(lpPlayHandle),
        command_(std::move(command)),
        seekTime_(seekTime),
        speedValue_(speedValue),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    // Every other native call for this device (Start/StopRealPlay, Start/
    // StopPlayback, FindRecordings) acquires this same per-device lock -
    // this one was the exception, running fully unsynchronized against
    // whatever else touches this device's SDK session concurrently (most
    // notably the decode callback thread). Confirmed on TVT (the identical
    // gap there) as the cause of an app crash when changing playback speed
    // - applied here too before it gets a chance to surface the same way.
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(lUserID_));
    BOOL ok = FALSE;
    if (command_ == "pause") {
      ok = NETDEV_PlayBackControl(lpPlayHandle_, NETDEV_PLAY_CTRL_PAUSE, nullptr);
    } else if (command_ == "resume") {
      ok = NETDEV_PlayBackControl(lpPlayHandle_, NETDEV_PLAY_CTRL_RESUME, nullptr);
    } else if (command_ == "seek") {
      ok = NETDEV_PlayBackControl(lpPlayHandle_, NETDEV_PLAY_CTRL_SETPLAYTIME, &seekTime_);
    } else if (command_ == "setSpeed") {
      ok = NETDEV_PlayBackControl(lpPlayHandle_, NETDEV_PLAY_CTRL_SETPLAYSPEED, &speedValue_);
    } else if (command_ == "stepFrame") {
      // Confirmed real usage via the SDK's own demo (MenuPlayBack.cpp's
      // OnBnClickedButtonPlaybackNextframe) - NETDEV_PLAY_STATUS_1_FRAME_FORWD
      // is the only value ever passed here, not a generic speed value.
      INT32 frameForward = NETDEV_PLAY_STATUS_1_FRAME_FORWD;
      ok = NETDEV_PlayBackControl(lpPlayHandle_, NETDEV_PLAY_CTRL_SET_SINGLE_FRAME_SPEED, &frameForward);
    }
    if (!ok) {
      const INT32 err = NETDEV_GetLastError();
      SetError("NETDEV_PlayBackControl failed (NETDEV error " + std::to_string(err) + ")");
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  LPVOID lUserID_;
  LPVOID lpPlayHandle_;
  std::string command_;
  INT64 seekTime_;
  INT32 speedValue_;
  Napi::Promise::Deferred deferred_;
};

// speedMultiplier (1/2/4/8) -> NETDEV_VOD_PLAY_STATUS_E's forward-speed
// values - the enum has a lot more entries (backward, I-frame-only variants
// at higher speeds, etc.) but only forward 1x/2x/4x/8x were ever requested.
INT32 SpeedMultiplierToNetdevStatus(int multiplier) {
  switch (multiplier) {
    case 2: return NETDEV_PLAY_STATUS_2_FORWARD;
    case 4: return NETDEV_PLAY_STATUS_4_FORWARD;
    case 8: return NETDEV_PLAY_STATUS_8_FORWARD;
    default: return NETDEV_PLAY_STATUS_1_FORWARD;
  }
}

Napi::Value ControlPlayback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  LPVOID lpPlayHandle = IdToPointer(info[0].As<Napi::String>().Utf8Value());
  const std::string command = info[1].As<Napi::String>().Utf8Value();
  const INT64 seekTime =
      (command == "seek") ? static_cast<INT64>(info[2].As<Napi::Number>().DoubleValue() / 1000.0) : 0;
  const INT32 speedValue =
      (command == "setSpeed") ? SpeedMultiplierToNetdevStatus(info[2].As<Napi::Number>().Int32Value()) : 0;

  LPVOID lUserID = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_sessionsByHandle.find(lpPlayHandle);
    if (it != g_sessionsByHandle.end()) lUserID = it->second->lUserID;
  }

  auto* worker = new ControlPlaybackWorker(env, lUserID, lpPlayHandle, command, seekTime, speedValue);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class GetPlaybackTimeWorker : public Napi::AsyncWorker {
 public:
  GetPlaybackTimeWorker(Napi::Env env, LPVOID lpPlayHandle)
      : Napi::AsyncWorker(env), lpPlayHandle_(lpPlayHandle), deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    if (!NETDEV_PlayBackControl(lpPlayHandle_, NETDEV_PLAY_CTRL_GETPLAYTIME, &playTime_)) playTime_ = 0;
  }

  void OnOK() override { deferred_.Resolve(Napi::Number::New(Env(), static_cast<double>(playTime_) * 1000.0)); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  LPVOID lpPlayHandle_;
  INT64 playTime_ = 0;
  Napi::Promise::Deferred deferred_;
};

Napi::Value GetPlaybackTime(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  LPVOID lpPlayHandle = IdToPointer(info[0].As<Napi::String>().Utf8Value());
  auto* worker = new GetPlaybackTimeWorker(env, lpPlayHandle);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class StopPlaybackWorker : public Napi::AsyncWorker {
 public:
  StopPlaybackWorker(Napi::Env env, LiveViewSession* session)
      : Napi::AsyncWorker(env), session_(session), deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    if (session_) DestroySession(session_);
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  LiveViewSession* session_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StopPlayback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  LPVOID lpPlayHandle = IdToPointer(info[0].As<Napi::String>().Utf8Value());

  // The map lookup/erase itself is cheap and non-blocking (no SDK call) -
  // only DestroySession's NETDEV_StopPlayBack needs to move off-thread, so
  // this part stays synchronous.
  LiveViewSession* session = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_sessionsByHandle.find(lpPlayHandle);
    if (it != g_sessionsByHandle.end()) {
      session = it->second;
      g_sessionsByHandle.erase(it);
    }
  }

  auto* worker = new StopPlaybackWorker(env, session);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class StartBackupWorker : public Napi::AsyncWorker {
 public:
  StartBackupWorker(Napi::Env env, LPVOID lUserID, int channel, INT64 beginTime, INT64 endTime,
                     std::string saveFilePath)
      : Napi::AsyncWorker(env),
        lUserID_(lUserID),
        channel_(channel),
        beginTime_(beginTime),
        endTime_(endTime),
        saveFilePath_(std::move(saveFilePath)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    NETDEV_PLAYBACKCOND_S playBackCond = {};
    playBackCond.dwChannelID = channel_;
    playBackCond.tBeginTime = beginTime_;
    playBackCond.tEndTime = endTime_;
    playBackCond.hPlayWnd = nullptr;
    playBackCond.dwDownloadSpeed = NETDEV_DOWNLOAD_SPEED_EIGHT;
    playBackCond.dwLinkMode = NETDEV_TRANS_PROTOCAL_TCP;

    downloadHandle_ = NETDEV_GetFileByTime(lUserID_, &playBackCond, const_cast<CHAR*>(saveFilePath_.c_str()),
                                            NETDEV_MEDIA_FILE_MP4);
    if (!downloadHandle_) {
      const INT32 err = NETDEV_GetLastError();
      SetError("NETDEV_GetFileByTime failed (NETDEV error " + std::to_string(err) + ")");
      return;
    }
    std::lock_guard<std::mutex> lock(g_backupMutex);
    g_backupRanges[downloadHandle_] = {beginTime_, endTime_};
  }

  void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), PointerToId(downloadHandle_))); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  LPVOID lUserID_;
  int channel_;
  INT64 beginTime_;
  INT64 endTime_;
  std::string saveFilePath_;
  LPVOID downloadHandle_ = nullptr;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StartBackup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const INT64 beginTime = static_cast<INT64>(info[2].As<Napi::Number>().DoubleValue() / 1000.0);
  const INT64 endTime = static_cast<INT64>(info[3].As<Napi::Number>().DoubleValue() / 1000.0);
  const std::string saveFilePath = info[4].As<Napi::String>().Utf8Value();

  LPVOID lUserID = IdToPointer(sessionId);
  auto* worker = new StartBackupWorker(env, lUserID, channel, beginTime, endTime, saveFilePath);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class GetBackupProgressWorker : public Napi::AsyncWorker {
 public:
  GetBackupProgressWorker(Napi::Env env, LPVOID downloadHandle)
      : Napi::AsyncWorker(env), downloadHandle_(downloadHandle), deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    BackupRange range;
    {
      std::lock_guard<std::mutex> lock(g_backupMutex);
      auto it = g_backupRanges.find(downloadHandle_);
      if (it == g_backupRanges.end()) {
        percent_ = 100;
        return;
      }
      range = it->second;
    }

    INT64 playTime = 0;
    // A failed GETPLAYTIME against a download handle reliably means the
    // transfer already finished and the SDK released its internal state
    // (confirmed via the demo's own DOWNLOAD_TIME_ID timer handler, which
    // treats this exact failure as "done" and calls NETDEV_StopGetFile at
    // that point) - reported as 100% complete rather than an error.
    if (!NETDEV_PlayBackControl(downloadHandle_, NETDEV_PLAY_CTRL_GETPLAYTIME, &playTime)) {
      percent_ = 100;
      return;
    }

    const INT64 span = range.tEndTime - range.tBeginTime;
    double percent = (span <= 0) ? 100.0 : (static_cast<double>(playTime - range.tBeginTime) / span) * 100.0;
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    percent_ = percent;
  }

  void OnOK() override { deferred_.Resolve(Napi::Number::New(Env(), percent_)); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  LPVOID downloadHandle_;
  double percent_ = 0;
  Napi::Promise::Deferred deferred_;
};

Napi::Value GetBackupProgress(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  LPVOID downloadHandle = IdToPointer(info[0].As<Napi::String>().Utf8Value());
  auto* worker = new GetBackupProgressWorker(env, downloadHandle);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class StopBackupWorker : public Napi::AsyncWorker {
 public:
  StopBackupWorker(Napi::Env env, LPVOID downloadHandle)
      : Napi::AsyncWorker(env), downloadHandle_(downloadHandle), deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    NETDEV_StopGetFile(downloadHandle_);
    std::lock_guard<std::mutex> lock(g_backupMutex);
    g_backupRanges.erase(downloadHandle_);
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  LPVOID downloadHandle_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StopBackup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  LPVOID downloadHandle = IdToPointer(info[0].As<Napi::String>().Utf8Value());
  auto* worker = new StopBackupWorker(env, downloadHandle);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

// NETDEV_EnabledGPUDecodeEx is a global, SDK-wide switch (not per-session) -
// confirmed real, user-reported symptom: the VPS's "GPU" usage pinned to
// 100% during playback on a machine with no real GPU (same underlying class
// of problem as the Chromium hardware-acceleration toggle in Settings,
// which controls a completely different subsystem - this one is the
// Uniview SDK's own H.264/H.265 decode path, not Chromium's rendering).
// Called once at startup from the persisted setting (see
// AppSettings.univiewGpuDecode) rather than exposed as a live per-call
// toggle, matching how the existing hardware-acceleration setting also
// requires a restart to take effect.
Napi::Value SetGpuDecode(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const bool enable = info[0].As<Napi::Boolean>().Value();
  NETDEV_GPU_ABLESTATE_S state = {};
  const BOOL ok = NETDEV_EnabledGPUDecodeEx(enable ? TRUE : FALSE, &state);
  return Napi::Boolean::New(env, ok);
}

// Device discovery — a genuine UDP broadcast the device itself answers
// (NETDEV_Discovery), not a login attempt. Replaces an earlier
// TCP-port-scan-plus-login-guess approach entirely (removed from the app —
// confirmed live to be both far slower and less accurate than just asking
// each vendor's own broadcast protocol directly, the same way vendor tools
// like SADP do). Global rather than per-call since NETDEV_SetDiscoveryCallBack
// itself is a single, SDK-wide registration, not a per-invocation handle —
// only one discovery scan is ever expected to run at a time (one "Scan
// Network" click), so this isn't a meaningful limitation in practice.
Napi::ThreadSafeFunction g_discoveryTsfn;
// Guards both g_discoveryTsfn and g_discoveryActive together - the SDK's
// discovery broadcast can keep delivering late responses after the JS side
// has already finished its fixed collection window and called
// StopDiscovery(), and OnDeviceDiscovered fires on an SDK-internal thread,
// not the N-API call thread. Without this, a late callback could call
// NonBlockingCall on an already-Release()'d ThreadSafeFunction - undefined
// behavior, and a very plausible cause of an otherwise-unexplained crash
// on real hardware. Checking/using the flag and the tsfn under the same
// lock closes that window completely, not just narrows it.
std::mutex g_discoveryMutex;
bool g_discoveryActive = false;

// Bounded (not 0/unbounded) even though every discovered device matters
// here, unlike a dropped stale video frame — the earlier, real 51GB memory
// leak this whole project had was caused by exactly this mistake elsewhere
// in this file. A real LAN scan turning up more than a few dozen devices
// within one scan window is already an unrealistic edge case, so 64 is
// generous headroom, not a practical limit.
constexpr size_t kDiscoveryQueueSize = 64;

std::string SafeFieldString(const char* field, size_t fieldSize) {
  return std::string(field, strnlen(field, fieldSize));
}

void STDCALL OnDeviceDiscovered(LPNETDEV_DISCOVERY_DEVINFO_S pstDevInfo, LPVOID /*lpUserData*/) {
  if (!pstDevInfo) return;
  // Temporary diagnostics (same project convention used to chase every
  // other real hardware bug this engagement) - this is the first time
  // real discovery response data has been observed live, since the field
  // layout was taken from the SDK header, not verified against a real
  // device yet.
  fprintf(stderr, "[unv-discovery-diag] raw addr=%s port=%u model=%s mac=%s mfr=%s\n", pstDevInfo->szDevAddr,
          pstDevInfo->dwDevPort, pstDevInfo->szDevModule, pstDevInfo->szDevMac, pstDevInfo->szManuFacturer);
  fflush(stderr);

  std::lock_guard<std::mutex> lock(g_discoveryMutex);
  if (!g_discoveryActive) return;
  auto* info = new NETDEV_DISCOVERY_DEVINFO_S(*pstDevInfo);
  auto status = g_discoveryTsfn.NonBlockingCall(
      info, [](Napi::Env env, Napi::Function jsCallback, NETDEV_DISCOVERY_DEVINFO_S* d) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("host", SafeFieldString(d->szDevAddr, sizeof(d->szDevAddr)));
        obj.Set("port", Napi::Number::New(env, d->dwDevPort));
        obj.Set("model", SafeFieldString(d->szDevModule, sizeof(d->szDevModule)));
        obj.Set("serialNumber", SafeFieldString(d->szDevSerailNum, sizeof(d->szDevSerailNum)));
        obj.Set("mac", SafeFieldString(d->szDevMac, sizeof(d->szDevMac)));
        obj.Set("name", SafeFieldString(d->szDevName, sizeof(d->szDevName)));
        obj.Set("manufacturer", SafeFieldString(d->szManuFacturer, sizeof(d->szManuFacturer)));
        jsCallback.Call({obj});
        delete d;
      });
  if (status != napi_ok) delete info;
}

Napi::Value StartDiscovery(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Function onDevice = info[0].As<Napi::Function>();
  {
    std::lock_guard<std::mutex> lock(g_discoveryMutex);
    // A scan already in flight when another one starts shouldn't leak the
    // previous ThreadSafeFunction — release it first, same as any other
    // resource replacement in this file.
    if (g_discoveryActive) {
      g_discoveryActive = false;
      g_discoveryTsfn.Release();
    }
    g_discoveryTsfn = Napi::ThreadSafeFunction::New(env, onDevice, "uniview-discovery-callback", kDiscoveryQueueSize, 1);
    g_discoveryActive = true;
  }
  NETDEV_SetDiscoveryCallBack(OnDeviceDiscovered, nullptr);
  // The SDK's own doc comment: passing "0.0.0.0" for both begin and end IP
  // triggers a full local-network broadcast rather than a specific range.
  char beginIp[] = "0.0.0.0";
  char endIp[] = "0.0.0.0";
  NETDEV_Discovery(beginIp, endIp);
  return env.Undefined();
}

Napi::Value StopDiscovery(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(g_discoveryMutex);
  if (g_discoveryActive) {
    g_discoveryActive = false;
    g_discoveryTsfn.Release();
  }
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  NETDEV_Init();

  exports.Set("login", Napi::Function::New(env, Login));
  exports.Set("logout", Napi::Function::New(env, Logout));
  exports.Set("startLiveView", Napi::Function::New(env, StartLiveView));
  exports.Set("stopLiveView", Napi::Function::New(env, StopLiveView));
  exports.Set("setFrameDelivery", Napi::Function::New(env, SetFrameDelivery));
  exports.Set("findRecordings", Napi::Function::New(env, FindRecordings));
  exports.Set("startPlayback", Napi::Function::New(env, StartPlayback));
  exports.Set("controlPlayback", Napi::Function::New(env, ControlPlayback));
  exports.Set("getPlaybackTime", Napi::Function::New(env, GetPlaybackTime));
  exports.Set("stopPlayback", Napi::Function::New(env, StopPlayback));
  exports.Set("startBackup", Napi::Function::New(env, StartBackup));
  exports.Set("getBackupProgress", Napi::Function::New(env, GetBackupProgress));
  exports.Set("stopBackup", Napi::Function::New(env, StopBackup));
  exports.Set("setGpuDecode", Napi::Function::New(env, SetGpuDecode));
  exports.Set("startDiscovery", Napi::Function::New(env, StartDiscovery));
  exports.Set("stopDiscovery", Napi::Function::New(env, StopDiscovery));
  return exports;
}

NODE_API_MODULE(uniview_native, Init)
