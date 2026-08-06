// N-API bridge over TVT's real official DVR_NET_SDK (obtained directly from
// the manufacturer). Like Uniview/Dahua, this has a genuinely documented
// decoded-frame path: NET_SDK_SetYUVCallBack registers a per-live-handle
// YUV callback (YUV_DATA_CALLBACK -> DECODE_FRAME_INFO), confirmed via the
// SDK's own header and the bundled SDKDEMO's real LiveDlg.cpp usage — not
// reverse-engineered. Channels are explicitly documented as 0-based
// ("lChannel, starts from 0" in NET_SDK_CLIENTINFO's own comment).
//
// One real difference from the other three vendors: DECODE_FRAME_INFO
// gives a single packed buffer (pData) with no per-plane pointers or
// stride, unlike Hikvision/Uniview/Dahua which all provide explicit Y/U/V
// plane info. Assumed tightly-packed I420 (Y, then U, then V, no row
// padding) since that's the SDK's implied convention absent any stride
// field - unverified against real hardware yet, same as every other
// channel/format assumption made before a vendor's first real test.
#include <napi.h>
#include <windows.h>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "DVR_NET_SDK.h"

namespace {

struct LiveViewSession {
  Napi::ThreadSafeFunction tsfn;
  LONG lUserID = -1;
  POINTERHANDLE lLiveHandle = -1;
  // Playback sessions reuse this same struct/handle map (see
  // FindRecordingsWorker/StartPlaybackWorker below) rather than a separate
  // one, mirroring native/uniview/src/addon.cc's exact pattern - only this
  // flag differs, telling DestroySession which SDK stop call applies to
  // lLiveHandle (NET_SDK_StopLivePlay vs NET_SDK_StopPlayBack).
  bool isPlayback = false;
  // Set from the renderer (liveView:setFrameDelivery) when this tile isn't
  // actually visible - hidden behind an expanded tile, or the app tab
  // isn't the active one. Skips the YUV/I420->RGBA conversion, buffer
  // copy, and IPC dispatch for a frame nobody renders (real, measured
  // waste across a 50+ device fleet) without touching the underlying
  // decode session, so resuming is instant. std::atomic since it's
  // written from the N-API call thread and read from the decode callback.
  std::atomic<bool> framePaused{false};

  // Set only by clipExporter.ts's export sessions (see StartPlayback's
  // extra paceToRealtime argument) - confirmed live as the root cause of a
  // real app hang: on-screen Playback gets away without any pacing here
  // because its own frame-drop/backpressure check (frameBackpressure.ts)
  // is nearly free per callback, but an export can't drop a single frame,
  // so it does real work (RGBA conversion + a write into ffmpeg's stdin)
  // on every single one - and this SDK's own YUV callback delivers frames
  // as fast as it can decode them, not paced to real time. Without this,
  // that firehose floods the ThreadSafeFunction queue with more real work
  // per second than the Electron main thread can drain, starving it of
  // any chance to pump Windows messages - Windows then kills the whole
  // app as "not responding" (Event ID 1002, confirmed live), even though
  // nothing is actually deadlocked. Only touched from OnYUVFrame itself
  // (always the same SDK-owned callback thread for a given handle), so -
  // unlike framePaused above - these don't need to be atomic.
  bool paceToRealtime = false;
  bool paceInitialized = false;
  int64_t paceFirstContentMs = 0;
  std::chrono::steady_clock::time_point paceWallStart;
};

std::mutex g_mutex;
std::unordered_map<POINTERHANDLE, LiveViewSession*> g_sessionsByHandle;

// See the matching note in native/uniview/src/addon.cc. Scoped PER SESSION
// (keyed by lUserID), not global — a global mutex was tried first and, on
// Uniview, turned a single hung LivePlay call on one device into a
// permanent freeze of every other device sharing that addon. Login itself
// is intentionally NOT serialized by any mutex — different devices logging
// in concurrently is normal, expected usage, and the JS side
// (main/ipc/liveView.ts) already dedupes concurrent logins for the SAME
// device.
std::mutex g_sdkMutexMapGuard;
std::unordered_map<LONG, std::unique_ptr<std::mutex>> g_sdkMutexBySession;

std::mutex& SdkMutexForSession(LONG lUserID) {
  std::lock_guard<std::mutex> lock(g_sdkMutexMapGuard);
  auto& slot = g_sdkMutexBySession[lUserID];
  if (!slot) slot = std::make_unique<std::mutex>();
  return *slot;
}

struct FrameData {
  int width = 0;
  int height = 0;
  int64_t timestampMs = 0;
  std::vector<uint8_t> pixels;  // RGBA, ready for canvas ImageData
};

// BT.601 limited-range I420 (assumed tightly-packed, Y-then-U-then-V) -> RGBA.
void ConvertI420ToRGBA(const DECODE_FRAME_INFO& info, std::vector<uint8_t>& out) {
  const int width = info.nWidth;
  const int height = info.nHeight;
  const uint8_t* yPlane = info.pData;
  const uint8_t* uPlane = yPlane + static_cast<size_t>(width) * height;
  const uint8_t* vPlane = uPlane + static_cast<size_t>(width) / 2 * (height / 2);
  const int chromaStride = width / 2;

  out.resize(static_cast<size_t>(width) * height * 4);
  for (int row = 0; row < height; ++row) {
    for (int col = 0; col < width; ++col) {
      const int Y = yPlane[row * width + col];
      const int U = uPlane[(row / 2) * chromaStride + (col / 2)] - 128;
      const int V = vPlane[(row / 2) * chromaStride + (col / 2)] - 128;

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

void CALLBACK OnYUVFrame(POINTERHANDLE lLiveHandle, DECODE_FRAME_INFO frameInfo, void* pUser) {
  if (!frameInfo.pData || frameInfo.nWidth <= 0 || frameInfo.nHeight <= 0) return;
  auto* session = static_cast<LiveViewSession*>(pUser);
  if (!session) return;
  if (session->framePaused.load(std::memory_order_relaxed)) return;

  // frameInfo.time is Unix seconds (~1.79 billion currently) - casting to a
  // 32-bit long before multiplying by 1000 overflowed (confirmed live:
  // negative garbage timestamps), hence the explicit int64_t here.
  const int64_t contentMs = static_cast<int64_t>(frameInfo.time) * 1000;

  // See LiveViewSession::paceToRealtime's doc comment - throttles THIS
  // callback (the SDK's own decode-delivery thread) to real content pace
  // before doing any of the expensive conversion/dispatch work below,
  // rather than trying to throttle after the fact on the JS side (by the
  // time a frame reaches JS, the CPU/memory-bandwidth cost of decoding and
  // converting it has already been paid).
  if (session->paceToRealtime) {
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
      // (or a seek) can make consecutive frames' timestamps jump by more
      // than makes sense to actually sleep for.
      if (aheadMs > 0) Sleep(static_cast<DWORD>(aheadMs > 2000 ? 2000 : aheadMs));
    }
  }

  auto* frame = new FrameData();
  frame->width = frameInfo.nWidth;
  frame->height = frameInfo.nHeight;
  frame->timestampMs = contentMs;
  ConvertI420ToRGBA(frameInfo, frame->pixels);

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
  (void)lLiveHandle;
}

void DestroySession(LiveViewSession* session) {
  if (session->isPlayback) {
    NET_SDK_StopPlayBack(session->lLiveHandle);
  } else {
    NET_SDK_StopLivePlay(session->lLiveHandle);
  }
  session->tsfn.Release();
  delete session;
}

// DD_TIME's fields mirror C's struct tm exactly - year is "current year
// minus 1900" and month is "0-11, January = 0" per the SDK header's own
// comments. Treated as the device's LOCAL time (localtime_s/localtime_r),
// matching how DVR/NVR recording timestamps are conventionally the
// device's own clock, not UTC - unverified against real hardware yet, same
// as every other vendor time-format assumption made before a device's
// first real test.
//
// nTotalseconds was originally assumed to be plain Unix epoch seconds
// (matching NET_SDK_PLAYCTRL_SETPOS's own doc comment, which uses that same
// convention for its own dwInValue parameter) - confirmed WRONG against a
// real device: NET_SDK_FindNextFile always returns nTotalseconds=0 on every
// result, while the broken-down fields (year/month/day/hour/minute/second)
// are all populated correctly. DdTimeToEpochMs reconstructs the epoch from
// those broken-down fields via mktime() instead, ignoring nTotalseconds
// entirely; only EpochMsToDdTime still fills nTotalseconds too, in case
// some other SDK call actually reads it on the way in (untested).
DD_TIME EpochMsToDdTime(int64_t epochMs) {
  const time_t epochSec = static_cast<time_t>(epochMs / 1000);
  struct tm tmVal = {};
#ifdef _WIN32
  localtime_s(&tmVal, &epochSec);
#else
  localtime_r(&epochSec, &tmVal);
#endif
  DD_TIME t = {};
  t.second = static_cast<unsigned char>(tmVal.tm_sec);
  t.minute = static_cast<unsigned char>(tmVal.tm_min);
  t.hour = static_cast<unsigned char>(tmVal.tm_hour);
  t.wday = static_cast<unsigned char>(tmVal.tm_wday);
  t.mday = static_cast<unsigned char>(tmVal.tm_mday);
  t.month = static_cast<unsigned char>(tmVal.tm_mon);
  t.year = static_cast<unsigned short>(tmVal.tm_year);
  t.nTotalseconds = static_cast<int>(epochSec);
  t.nMicrosecond = 0;
  return t;
}

int64_t DdTimeToEpochMs(const DD_TIME& t) {
  struct tm tmVal = {};
  tmVal.tm_year = static_cast<int>(t.year);
  tmVal.tm_mon = static_cast<int>(t.month);
  tmVal.tm_mday = static_cast<int>(t.mday);
  tmVal.tm_hour = static_cast<int>(t.hour);
  tmVal.tm_min = static_cast<int>(t.minute);
  tmVal.tm_sec = static_cast<int>(t.second);
  tmVal.tm_isdst = -1;
  const time_t epochSec = mktime(&tmVal);
  return static_cast<int64_t>(epochSec) * 1000;
}

// DD_RECORD_TYPE is a bitmask (dwrdvstypedef.h) - DD_RECORD_TYPE_INTELLIGENT
// is itself an OR of every AI-detection bit (face/line-cross/perimeter/etc),
// matching this app's 'smart' bucket; DD_RECORD_TYPE_MOTION is basic motion
// detection; everything else (manual/scheduled recording) is 'continuous'.
// A file's dwRecType is checked against the broader category first (smart
// before motion) since some devices may OR multiple bits onto one segment.
std::string ClassifyRecType(DWORD recType) {
  if (recType & DD_RECORD_TYPE_INTELLIGENT) return "smart";
  if (recType & DD_RECORD_TYPE_MOTION) return "motion";
  if (recType & (DD_RECORD_TYPE_MANUAL | DD_RECORD_TYPE_SCHEDULE)) return "continuous";
  return "other";
}

}  // namespace

// See the note above g_sdkMutexBySession for why login/startLiveView run off
// the main thread, and why login is not serialized by any mutex here.
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
    NET_SDK_DEVICEINFO deviceInfo = {};
    lUserID_ = NET_SDK_Login(&host_[0], static_cast<WORD>(port_), &username_[0], &password_[0], &deviceInfo);
    if (lUserID_ < 0) {
      const DWORD err = NET_SDK_GetLastError();
      SetError("TVT login failed (error " + std::to_string(err) + ")");
      return;
    }
    channelCount_ = deviceInfo.videoInputNum;

    // Real camera names, not "Channel N" - unlike Hikvision/Dahua, TVT's SDK
    // returns every channel's configured name in ONE call: lChannel = -1
    // means "all channels" (confirmed via the bundled SDKDEMO's
    // ConfigDlg.cpp, which passes m_currentChannel < 0 for exactly this).
    // Only worth paying for when the name is actually needed - see the
    // matching comment in native/dahua/src/addon.cc.
    if (skipChannelQuery_ || channelCount_ <= 0) return;
    std::vector<DD_CHANNEL_CONFIG> configs(static_cast<size_t>(channelCount_));
    for (auto& cfg : configs) cfg.iSize = sizeof(DD_CHANNEL_CONFIG);
    DWORD bytesReturned = 0;
    const BOOL ok = NET_SDK_GetDVRConfig(lUserID_, DD_CONFIG_ITEM_CHNN_CONFIG, -1, configs.data(),
                                         static_cast<DWORD>(sizeof(DD_CHANNEL_CONFIG) * configs.size()),
                                         &bytesReturned, FALSE);
    if (!ok) {
      fprintf(stderr, "[tvt] channel name fetch failed NET_SDK error=%lu\n",
              static_cast<unsigned long>(NET_SDK_GetLastError()));
      fflush(stderr);
      return;
    }
    for (int i = 0; i < channelCount_; ++i) {
      const size_t len = strnlen(configs[static_cast<size_t>(i)].name, sizeof(configs[static_cast<size_t>(i)].name));
      channelNames_.emplace_back(configs[static_cast<size_t>(i)].name, len);
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    // Channels are documented as 0-based (NET_SDK_CLIENTINFO.lChannel comment).
    Napi::Array channels = Napi::Array::New(env);
    for (int i = 0; i < channelCount_; ++i) {
      const std::string name = (static_cast<size_t>(i) < channelNames_.size()) ? channelNames_[static_cast<size_t>(i)] : "";
      const std::string label = name.empty() ? "Channel " + std::to_string(i) : name;
      Napi::Object entry = Napi::Object::New(env);
      entry.Set("channel", Napi::Number::New(env, i));
      entry.Set("label", Napi::String::New(env, label));
      channels[static_cast<uint32_t>(i)] = entry;
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("sessionId", std::to_string(lUserID_));
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
  LONG lUserID_ = -1;
  int channelCount_ = 0;
  std::vector<std::string> channelNames_;
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

  auto* worker =
      new LoginWorker(env, std::move(host), port, std::move(username), std::move(password), skipChannelQuery);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value Logout(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  NET_SDK_Logout(std::stol(sessionId));
  return env.Undefined();
}

class StartLiveViewWorker : public Napi::AsyncWorker {
 public:
  StartLiveViewWorker(Napi::Env env, LONG lUserID, int channel, std::string streamType,
                       Napi::ThreadSafeFunction tsfn)
      : Napi::AsyncWorker(env), channel_(channel), streamType_(std::move(streamType)),
        deferred_(Napi::Promise::Deferred::New(env)) {
    session_ = new LiveViewSession();
    session_->lUserID = lUserID;
    session_->tsfn = std::move(tsfn);
  }

  void Execute() override {
    // Diagnostic: reported live that a TVT backup download hangs with
    // zero console output - the existing per-call diagnostics only ever
    // print AFTER acquiring this session's shared mutex, so a hang while
    // WAITING for it (e.g. another still-running call for the same
    // session never released it) would look identical to "nothing
    // happened at all." Logging both sides of every mutex acquisition
    // across every TVT worker that touches it, tagged per call site, to
    // see which one is actually holding/waiting on the lock next time.
    fprintf(stderr, "[tvt-lock-diag] StartLiveView ch=%d waiting for session lock...\n", channel_);
    fflush(stderr);
    const ULONGLONG tEnter = GetTickCount64();
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session_->lUserID));
    fprintf(stderr, "[tvt-lock-diag] StartLiveView ch=%d got lock after %llums\n", channel_, GetTickCount64() - tEnter);
    fflush(stderr);

    NET_SDK_CLIENTINFO clientInfo = {};
    clientInfo.lChannel = channel_;
    clientInfo.streamType = (streamType_ == "sub") ? NET_SDK_SUB_STREAM : NET_SDK_MAIN_STREAM;
    clientInfo.hPlayWnd = nullptr;
    clientInfo.bNoDecode = 0;  // 0 = decode - required for the YUV callback to receive real data.

    const POINTERHANDLE lLiveHandle = NET_SDK_LivePlay(session_->lUserID, &clientInfo, nullptr, nullptr);
    if (lLiveHandle == -1) {
      const DWORD err = NET_SDK_GetLastError();
      session_->tsfn.Release();
      delete session_;
      session_ = nullptr;
      SetError("NET_SDK_LivePlay failed (error " + std::to_string(err) + ")");
      return;
    }
    session_->lLiveHandle = lLiveHandle;
    lLiveHandle_ = lLiveHandle;

    {
      std::lock_guard<std::mutex> lock(g_mutex);
      g_sessionsByHandle[lLiveHandle] = session_;
    }

    // pUser is passed straight through to OnYUVFrame - no separate lookup
    // table needed for frame dispatch (unlike Hikvision/Uniview's callbacks,
    // which lack a per-registration user pointer). Still keeping the handle
    // map above for StopLiveView's cleanup path.
    NET_SDK_SetYUVCallBack(lLiveHandle, OnYUVFrame, session_);
  }

  void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), std::to_string(lLiveHandle_))); }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  int channel_;
  std::string streamType_;
  LiveViewSession* session_ = nullptr;
  POINTERHANDLE lLiveHandle_ = -1;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StartLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const std::string streamType = info[2].As<Napi::String>().Utf8Value();
  Napi::Function onFrame = info[3].As<Napi::Function>();

  const LONG lUserID = std::stol(sessionId);
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
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "tvt-frame-callback", 2, 1);

  auto* worker = new StartLiveViewWorker(env, lUserID, channel, streamType, std::move(tsfn));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

// Runs off the main thread — see the matching Uniview addon's doc comment
// on this exact same class shape: StopLiveView used to be a plain
// synchronous N-API function, calling directly into the vendor SDK's own
// stop function on Electron's main thread. If that ever hangs (this whole
// family of vendor SDKs has real-hardware-confirmed history of a sibling
// "start" call hanging indefinitely), it blocks the entire app, not just
// this one tile — confirmed live via a double-click expand/collapse
// freezing the whole window, not just the affected channel.
class StopLiveViewWorker : public Napi::AsyncWorker {
 public:
  StopLiveViewWorker(Napi::Env env, POINTERHANDLE lLiveHandle)
      : Napi::AsyncWorker(env), lLiveHandle_(lLiveHandle),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    LiveViewSession* session = nullptr;
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      auto it = g_sessionsByHandle.find(lLiveHandle_);
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
      // this lock. Confirmed as a real, unaddressed gap during real-
      // hardware freeze testing on the Uniview vendor; applied here for
      // consistency even though this exact freeze was only reproduced on
      // Uniview so far.
      fprintf(stderr, "[tvt-lock-diag] StopLiveView waiting for session lock...\n");
      fflush(stderr);
      const ULONGLONG tEnter = GetTickCount64();
      std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session->lUserID));
      fprintf(stderr, "[tvt-lock-diag] StopLiveView got lock after %llums\n", GetTickCount64() - tEnter);
      fflush(stderr);
      DestroySession(session);
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  POINTERHANDLE lLiveHandle_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StopLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string viewHandle = info[0].As<Napi::String>().Utf8Value();
  // POINTERHANDLE is `long long` (64-bit) - std::stol (32-bit long) was
  // silently truncating/misparsing real handle values here, which crashed
  // the process during cleanup (confirmed live: exit code 9 right after
  // stopLiveView, handles like 2818686989344 are far beyond 32-bit range).
  const POINTERHANDLE lLiveHandle = std::stoll(viewHandle);

  auto* worker = new StopLiveViewWorker(env, lLiveHandle);
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
  const POINTERHANDLE lLiveHandle = std::stoll(viewHandle);

  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_sessionsByHandle.find(lLiveHandle);
  if (it != g_sessionsByHandle.end()) {
    it->second->framePaused.store(!enabled, std::memory_order_relaxed);
  }
  return env.Undefined();
}

// Recording search is a real network round trip (same class of call as
// Login/StartLiveView) - runs off the main thread for the same reason.
class FindRecordingsWorker : public Napi::AsyncWorker {
 public:
  FindRecordingsWorker(Napi::Env env, LONG lUserID, int channel, int64_t beginMs, int64_t endMs, DWORD recTypeMask)
      : Napi::AsyncWorker(env),
        lUserID_(lUserID),
        channel_(channel),
        beginMs_(beginMs),
        endMs_(endMs),
        recTypeMask_(recTypeMask),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    fprintf(stderr, "[tvt-lock-diag] FindRecordings ch=%d waiting for session lock...\n", channel_);
    fflush(stderr);
    const ULONGLONG tEnter = GetTickCount64();
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(lUserID_));
    fprintf(stderr, "[tvt-lock-diag] FindRecordings ch=%d got lock after %llums\n", channel_, GetTickCount64() - tEnter);
    fflush(stderr);

    DD_TIME begin = EpochMsToDdTime(beginMs_);
    DD_TIME end = EpochMsToDdTime(endMs_);

    const POINTERHANDLE hFind = NET_SDK_FindFile(lUserID_, channel_, &begin, &end);
    if (hFind == -1) {
      const DWORD err = NET_SDK_GetLastError();
      SetError("NET_SDK_FindFile failed (error " + std::to_string(err) + ")");
      return;
    }

    NET_SDK_REC_FILE fileInfo = {};
    for (;;) {
      const LONG ret = NET_SDK_FindNextFile(hFind, &fileInfo);
      if (ret == NET_SDK_NOMOREFILE || ret == NET_SDK_FILE_NOFIND) break;
      if (ret != NET_SDK_FILE_SUCCESS) {
        SetError("NET_SDK_FindNextFile failed (error " + std::to_string(ret) + ")");
        NET_SDK_FindClose(hFind);
        return;
      }
      if (recTypeMask_ == 0 || (fileInfo.dwRecType & recTypeMask_)) {
        segments_.push_back({DdTimeToEpochMs(fileInfo.startTime), DdTimeToEpochMs(fileInfo.stopTime),
                              ClassifyRecType(fileInfo.dwRecType)});
      }
    }
    NET_SDK_FindClose(hFind);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array result = Napi::Array::New(env);
    for (size_t i = 0; i < segments_.size(); ++i) {
      const auto& seg = segments_[i];
      Napi::Object obj = Napi::Object::New(env);
      obj.Set("startMs", Napi::Number::New(env, static_cast<double>(seg.startMs)));
      obj.Set("endMs", Napi::Number::New(env, static_cast<double>(seg.endMs)));
      obj.Set("type", seg.type);
      result[static_cast<uint32_t>(i)] = obj;
    }
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  struct Segment {
    int64_t startMs;
    int64_t endMs;
    std::string type;
  };

  LONG lUserID_;
  int channel_;
  int64_t beginMs_;
  int64_t endMs_;
  DWORD recTypeMask_;
  Napi::Promise::Deferred deferred_;
  std::vector<Segment> segments_;
};

// filters ('all'|'continuous'|'motion'|'smart') -> a single DD_RECORD_TYPE
// bitmask checked against each found file's own dwRecType, rather than
// issuing one search per type like Uniview does - TVT's NET_SDK_FindFile has
// no per-type search parameter at all (only a time range), so every search
// already returns every type and filtering happens client-side against the
// mask instead.
DWORD FiltersToRecTypeMask(const std::vector<std::string>& filters) {
  DWORD mask = 0;
  for (const auto& f : filters) {
    if (f == "all") return 0;  // 0 means "no filtering" below
    if (f == "continuous") mask |= (DD_RECORD_TYPE_MANUAL | DD_RECORD_TYPE_SCHEDULE);
    if (f == "motion") mask |= DD_RECORD_TYPE_MOTION;
    if (f == "smart") mask |= DD_RECORD_TYPE_INTELLIGENT;
  }
  return mask;
}

Napi::Value FindRecordings(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const int64_t beginMs = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
  const int64_t endMs = static_cast<int64_t>(info[3].As<Napi::Number>().DoubleValue());

  Napi::Array filtersArr = info[4].As<Napi::Array>();
  std::vector<std::string> filters;
  for (uint32_t i = 0; i < filtersArr.Length(); ++i) {
    filters.push_back(filtersArr.Get(i).As<Napi::String>().Utf8Value());
  }

  const LONG lUserID = std::stol(sessionId);
  auto* worker = new FindRecordingsWorker(env, lUserID, channel, beginMs, endMs, FiltersToRecTypeMask(filters));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class StartPlaybackWorker : public Napi::AsyncWorker {
 public:
  StartPlaybackWorker(Napi::Env env, LONG lUserID, int channel, int64_t beginMs, int64_t endMs,
                       Napi::ThreadSafeFunction tsfn, bool paceToRealtime)
      : Napi::AsyncWorker(env), channel_(channel), beginMs_(beginMs), endMs_(endMs),
        deferred_(Napi::Promise::Deferred::New(env)) {
    session_ = new LiveViewSession();
    session_->lUserID = lUserID;
    session_->tsfn = std::move(tsfn);
    session_->isPlayback = true;
    session_->paceToRealtime = paceToRealtime;
  }

  void Execute() override {
    fprintf(stderr, "[tvt-lock-diag] StartPlayback ch=%d waiting for session lock...\n", channel_);
    fflush(stderr);
    const ULONGLONG tEnter = GetTickCount64();
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session_->lUserID));
    fprintf(stderr, "[tvt-lock-diag] StartPlayback ch=%d got lock after %llums\n", channel_, GetTickCount64() - tEnter);
    fflush(stderr);

    DD_TIME begin = EpochMsToDdTime(beginMs_);
    DD_TIME end = EpochMsToDdTime(endMs_);
    LONG channelArr[1] = {static_cast<LONG>(channel_)};
    // No native window rendering (matching StartLiveView's hPlayWnd=nullptr
    // pattern) - a real HWND slot is still required by the signature even
    // though it stays unused, so this is a valid one-element array of NULL
    // rather than a null array pointer.
    HWND hwndArr[1] = {nullptr};

    const POINTERHANDLE lPlayHandle = NET_SDK_PlayBackByTime(session_->lUserID, channelArr, 1, &begin, &end, hwndArr);
    if (lPlayHandle == -1) {
      const DWORD err = NET_SDK_GetLastError();
      session_->tsfn.Release();
      delete session_;
      session_ = nullptr;
      SetError("NET_SDK_PlayBackByTime failed (error " + std::to_string(err) + ")");
      return;
    }
    session_->lLiveHandle = lPlayHandle;
    lPlayHandle_ = lPlayHandle;

    {
      std::lock_guard<std::mutex> lock(g_mutex);
      g_sessionsByHandle[lPlayHandle] = session_;
    }

    NET_SDK_SetPlayYUVCallBack(lPlayHandle, OnYUVFrame, session_);
  }

  void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), std::to_string(lPlayHandle_))); }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  int channel_;
  int64_t beginMs_;
  int64_t endMs_;
  LiveViewSession* session_ = nullptr;
  POINTERHANDLE lPlayHandle_ = -1;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StartPlayback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const int64_t beginMs = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
  const int64_t endMs = static_cast<int64_t>(info[3].As<Napi::Number>().DoubleValue());
  Napi::Function onFrame = info[4].As<Napi::Function>();
  // Optional - only clipExporter.ts's export sessions pass true (see
  // LiveViewSession::paceToRealtime's doc comment). Absent/false preserves
  // on-screen Playback's existing, already-working behavior exactly.
  const bool paceToRealtime = info.Length() > 5 && info[5].IsBoolean() && info[5].As<Napi::Boolean>().Value();

  const LONG lUserID = std::stol(sessionId);
  // maxQueueSize=2 (was 0/unbounded) — see the matching comment on the
  // live-view StartLiveView's own tsfn creation above for why.
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "tvt-playback-frame-callback", 2, 1);

  auto* worker = new StartPlaybackWorker(env, lUserID, channel, beginMs, endMs, std::move(tsfn), paceToRealtime);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

// See the matching note in native/uniview/src/addon.cc - every one of these
// runs via AsyncWorker rather than synchronously on the N-API thread, since
// any real SDK call (even one that looks cheap, like a control command
// against an already-open handle) can unpredictably hang against a slow or
// uncooperative device.
class ControlPlaybackWorker : public Napi::AsyncWorker {
 public:
  ControlPlaybackWorker(Napi::Env env, POINTERHANDLE lPlayHandle, std::string command, DWORD seekEpochSec,
                         DWORD speedValue)
      : Napi::AsyncWorker(env),
        lPlayHandle_(lPlayHandle),
        command_(std::move(command)),
        seekEpochSec_(seekEpochSec),
        speedValue_(speedValue),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    BOOL ok = FALSE;
    DWORD outValue = 0;
    if (command_ == "pause") {
      ok = NET_SDK_PlayBackControl(lPlayHandle_, NET_SDK_PLAYCTRL_PAUSE, 0, &outValue);
    } else if (command_ == "resume") {
      ok = NET_SDK_PlayBackControl(lPlayHandle_, NET_SDK_PLAYCTRL_RESUME, 0, &outValue);
    } else if (command_ == "seek") {
      ok = NET_SDK_PlayBackControl(lPlayHandle_, NET_SDK_PLAYCTRL_SETPOS, seekEpochSec_, &outValue);
    } else if (command_ == "setSpeed") {
      // No documented explicit speed-multiplier parameter for FF (unlike
      // Uniview's dedicated forward-speed enum) - the SDK header only shows
      // FF as a step control, called repeatedly to cycle through the
      // device's own internal speed levels. speedValue_ (1/2/4, see
      // SpeedMultiplierToFfSteps below) is treated as "how many times to
      // call FF from a fresh normal-speed baseline" - unverified against
      // real hardware yet.
      ok = NET_SDK_PlayBackControl(lPlayHandle_, NET_SDK_PLAYCTRL_NORMAL, 0, &outValue);
      for (DWORD i = 0; ok && i < speedValue_; ++i) {
        ok = NET_SDK_PlayBackControl(lPlayHandle_, NET_SDK_PLAYCTRL_FF, 0, &outValue);
      }
    } else if (command_ == "stepFrame") {
      ok = NET_SDK_PlayBackControl(lPlayHandle_, NET_SDK_PLAYCTRL_FRAME, 0, &outValue);
    }
    if (!ok) {
      const DWORD err = NET_SDK_GetLastError();
      SetError("NET_SDK_PlayBackControl failed (error " + std::to_string(err) + ")");
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  POINTERHANDLE lPlayHandle_;
  std::string command_;
  DWORD seekEpochSec_;
  DWORD speedValue_;
  Napi::Promise::Deferred deferred_;
};

// speedMultiplier (1/2/4) -> number of FF steps from normal speed - see the
// matching comment on ControlPlaybackWorker's "setSpeed" branch.
DWORD SpeedMultiplierToFfSteps(int multiplier) {
  switch (multiplier) {
    case 2: return 1;
    case 4: return 2;
    default: return 0;
  }
}

Napi::Value ControlPlayback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const POINTERHANDLE lPlayHandle = std::stoll(info[0].As<Napi::String>().Utf8Value());
  const std::string command = info[1].As<Napi::String>().Utf8Value();
  const DWORD seekEpochSec =
      (command == "seek") ? static_cast<DWORD>(info[2].As<Napi::Number>().DoubleValue() / 1000.0) : 0;
  const DWORD speedValue =
      (command == "setSpeed") ? SpeedMultiplierToFfSteps(info[2].As<Napi::Number>().Int32Value()) : 0;

  auto* worker = new ControlPlaybackWorker(env, lPlayHandle, command, seekEpochSec, speedValue);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class GetPlaybackTimeWorker : public Napi::AsyncWorker {
 public:
  GetPlaybackTimeWorker(Napi::Env env, POINTERHANDLE lPlayHandle)
      : Napi::AsyncWorker(env), lPlayHandle_(lPlayHandle), deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    DD_TIME osdTime = {};
    if (NET_SDK_GetPlayBackOsdTime(lPlayHandle_, &osdTime)) {
      playTimeMs_ = DdTimeToEpochMs(osdTime);
    }
  }

  void OnOK() override { deferred_.Resolve(Napi::Number::New(Env(), static_cast<double>(playTimeMs_))); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  POINTERHANDLE lPlayHandle_;
  int64_t playTimeMs_ = 0;
  Napi::Promise::Deferred deferred_;
};

Napi::Value GetPlaybackTime(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const POINTERHANDLE lPlayHandle = std::stoll(info[0].As<Napi::String>().Utf8Value());
  auto* worker = new GetPlaybackTimeWorker(env, lPlayHandle);
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
  const POINTERHANDLE lPlayHandle = std::stoll(info[0].As<Napi::String>().Utf8Value());

  LiveViewSession* session = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_sessionsByHandle.find(lPlayHandle);
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

// Finds the real file record (from NET_SDK_FindFile/FindNextFile, same
// search FindRecordingsWorker above already uses) overlapping the
// requested range, and returns its exact startTime/stopTime. The vendor's
// own demo (SDKDEMO/BackupDlg.cpp) never passes an arbitrary range at all
// to a backup call, only a real file's own exact boundaries - snapping to
// those first was step one of diagnosing the 0-byte export bug below (it
// alone did not fix it, but stays: it's still a closer match to the
// vendor's own usage than an arbitrary clip-marker range, and is cheap).
bool FindContainingFile(LONG lUserID, int channel, int64_t targetBeginMs, int64_t targetEndMs, DD_TIME* outBegin,
                         DD_TIME* outEnd) {
  DD_TIME searchBegin = EpochMsToDdTime(targetBeginMs);
  DD_TIME searchEnd = EpochMsToDdTime(targetEndMs);
  const POINTERHANDLE hFind = NET_SDK_FindFile(lUserID, channel, &searchBegin, &searchEnd);
  if (hFind == -1) return false;

  bool found = false;
  NET_SDK_REC_FILE fileInfo = {};
  const LONG ret = NET_SDK_FindNextFile(hFind, &fileInfo);
  if (ret == NET_SDK_FILE_SUCCESS) {
    *outBegin = fileInfo.startTime;
    *outEnd = fileInfo.stopTime;
    found = true;
  }
  NET_SDK_FindClose(hFind);
  return found;
}

// Real per-download state, updated only by RunTvtDownload's own dedicated
// thread (see below) and read by GetBackupProgress/StopBackup - atomics
// instead of a mutex since every field is a single scalar with no
// cross-field invariant to protect.
struct TvtDownloadState {
  std::atomic<int> percent{0};
  std::atomic<bool> done{false};
  std::atomic<bool> failed{false};
  std::atomic<bool> stopRequested{false};
};

std::mutex g_tvtDownloadsMutex;
std::unordered_map<std::string, std::shared_ptr<TvtDownloadState>> g_tvtDownloads;
std::atomic<int64_t> g_tvtDownloadCounter{0};

// Context for TvtBackupDataCallback below - one per in-flight download,
// owned by RunTvtDownload's stack frame for the download's whole lifetime.
struct TvtCallbackContext {
  FILE* file = nullptr;
  std::mutex fileMutex;  // guards fwrite in case the SDK calls back from more than one internal thread
  int channel = 0;
  std::atomic<int64_t> totalBytes{0};
  std::atomic<int> callCount{0};
};

// Decisive test for whether any real data ever reaches this process at all:
// bUseCallBack=FALSE (the vendor demo's own default, and everything tried
// so far) asks the SDK to write the file itself, silently, with no way to
// observe whether real bytes ever moved - only the time-based
// GetDownloadPos estimate, which climbs to "complete" regardless. This
// callback mode hands us the raw bytes directly as the SDK receives them,
// so counting real invocations/bytes here proves - one way or the other -
// whether the 0-byte result is a network/device-side problem (callback
// never fires) or purely a bug in the SDK's own silent file-write path
// (callback fires with real data, and writing it ourselves produces a real
// file).
void CALLBACK TvtBackupDataCallback(POINTERHANDLE lFileHandle, UINT dataType, BYTE* pBuffer, UINT dataLen,
                                     void* pUser) {
  auto* ctx = static_cast<TvtCallbackContext*>(pUser);
  const int n = ctx->callCount.fetch_add(1);
  if (n < 8) {
    fprintf(stderr, "[tvt-backup-diag] ch=%d callback #%d dataType=%u dataLen=%u\n", ctx->channel, n,
            static_cast<unsigned>(dataType), static_cast<unsigned>(dataLen));
    fflush(stderr);
  }

  if (dataType == NET_DVR_BACKUP_DATA_TYPE_NULL) {
    const int status = (pBuffer && dataLen >= sizeof(int)) ? *reinterpret_cast<int*>(pBuffer) : -1;
    fprintf(stderr,
            "[tvt-backup-diag] ch=%d callback status-frame status=%d (0=STOP,1=END) totalBytes=%lld "
            "callCount=%d\n",
            ctx->channel, status, static_cast<long long>(ctx->totalBytes.load()), ctx->callCount.load());
    fflush(stderr);
    return;
  }

  if (pBuffer && dataLen > 0 && ctx->file) {
    std::lock_guard<std::mutex> lock(ctx->fileMutex);
    fwrite(pBuffer, 1, dataLen, ctx->file);
    ctx->totalBytes += dataLen;
  }
}

// Root cause of the 0-byte export bug, found by comparing real behavior
// against NET_SDK_GetDownloadPos's own doc comment: its "progress" is
// computed purely from wall-clock time elapsed vs. the requested file's
// own duration ("进度=（当前下载到的时间-文件开始时间）/（文件结束时间-文件开始
// 时间）") - it is NEVER based on actual bytes received. That explains why
// every earlier fix attempt (arbitrary range, exact file boundary, legacy
// GetFileByTime vs the V2 API, explicitly finalizing via StopGetFile once
// "complete") produced the identical result: GetDownloadPos confidently
// reporting done while the file stayed permanently 0 bytes, confirmed
// directly on disk (not just via the app's own progress UI) across many
// separate attempts on multiple channels.
//
// This SDK family (TVT/Hikvision/Dahua-derived clones) commonly dispatches
// socket/backup internals through a hidden window's message queue tied to
// whichever OS thread made the call - a plain Napi::AsyncWorker runs
// Execute() on a transient libuv threadpool thread that never pumps
// Windows messages at all, so if that's what's happening here, the actual
// data transfer would never be serviced no matter how long it's polled
// from other calls, while the pure time-based progress estimate would
// still climb and "complete" on its own regardless.
//
// This function owns one download's entire lifecycle on ONE dedicated,
// persistent OS thread (not the shared libuv threadpool) so that thread can
// pump its own message queue for as long as the download runs, in case
// that is what a hidden window created by GetFileByTimeExV2 needs serviced.
// GetDownloadPos/StopGetFile are called from this SAME thread throughout,
// never from a separately-dispatched call on a different thread, in case
// the SDK's internal state is itself thread-affine.
void RunTvtDownload(LONG lUserID, int channel, int64_t beginMs, int64_t endMs, std::string saveFilePath,
                     std::shared_ptr<TvtDownloadState> state) {
  DD_TIME begin = EpochMsToDdTime(beginMs);
  DD_TIME end = EpochMsToDdTime(endMs);
  DD_TIME fileBegin{}, fileEnd{};

  TvtCallbackContext ctx;
  ctx.channel = channel;
  ctx.file = fopen(saveFilePath.c_str(), "wb");
  if (!ctx.file) {
    fprintf(stderr, "[tvt-backup-diag] ch=%d failed to open destination file for writing: %s\n", channel,
            saveFilePath.c_str());
    fflush(stderr);
    state->failed = true;
    state->done = true;
    return;
  }

  POINTERHANDLE handle;
  {
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(lUserID));
    const bool usedFileBoundary = FindContainingFile(lUserID, channel, beginMs, endMs, &fileBegin, &fileEnd);
    if (usedFileBoundary) {
      begin = fileBegin;
      end = fileEnd;
    }
    fprintf(stderr, "[tvt-backup-diag] ch=%d usedFileBoundary=%d path=%s\n", channel, usedFileBoundary ? 1 : 0,
            saveFilePath.c_str());
    fflush(stderr);

    // bUseCallBack=TRUE: the SDK hands us raw bytes via TvtBackupDataCallback
    // as it receives them, instead of silently writing the file itself -
    // see that callback's doc comment for why. sSavedFileName is still
    // passed (some SDK builds use it for internal bookkeeping even in
    // callback mode); the real bytes on disk come entirely from our own
    // fwrite in the callback now.
    //
    // bFirstStream=TRUE (main stream) - deliberate, permanent choice: every
    // one of this company's DVR/NVR units is configured to record main
    // stream only wherever the option exists, so main stream is always the
    // correct (and only real) request regardless of what any one file's
    // own test result suggested.
    handle = NET_SDK_GetFileByTimeExV2(lUserID, channel, &begin, &end, const_cast<char*>(saveFilePath.c_str()),
                                        /*recFormat=*/0, /*bFirstStream=*/TRUE, /*bUseCallBack=*/TRUE,
                                        /*fBackupDataCallBack=*/TvtBackupDataCallback, /*pUser=*/&ctx);
  }
  fprintf(stderr, "[tvt-backup-diag] ch=%d dedicated-thread GetFileByTimeExV2 handle=%lld\n", channel,
          static_cast<long long>(handle));
  fflush(stderr);
  if (handle == -1) {
    fclose(ctx.file);
    state->failed = true;
    state->done = true;
    return;
  }

  // Bounded well past any realistic file length so a genuinely stuck
  // handle can't leak this thread forever, without cutting off a real
  // multi-minute transfer early.
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(10);
  while (std::chrono::steady_clock::now() < deadline) {
    // Services any message posted to a hidden window this thread may have
    // caused the SDK to create - nothing else in the app ever pumps
    // messages on this thread, since it isn't the Electron main thread and
    // isn't a normal AsyncWorker thread either.
    MSG msg;
    while (PeekMessage(&msg, NULL, 0, 0, PM_REMOVE)) {
      TranslateMessage(&msg);
      DispatchMessage(&msg);
    }

    if (state->stopRequested.load()) break;

    int pos;
    {
      std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(lUserID));
      pos = NET_SDK_GetDownloadPos(handle);
    }
    fprintf(stderr, "[tvt-backup-diag] ch=%d dedicated-thread handle=%lld GetDownloadPos raw=%d\n", channel,
            static_cast<long long>(handle), pos);
    fflush(stderr);

    if (pos < 0 || pos > 100) {
      state->percent = 100;
      break;
    }
    state->percent = pos;
    if (pos >= 100) break;

    std::this_thread::sleep_for(std::chrono::milliseconds(300));
  }

  {
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(lUserID));
    NET_SDK_StopGetFile(handle);
  }
  fclose(ctx.file);
  fprintf(stderr,
          "[tvt-backup-diag] ch=%d dedicated-thread handle=%lld finalized totalBytes=%lld callCount=%d\n",
          channel, static_cast<long long>(handle), static_cast<long long>(ctx.totalBytes.load()),
          ctx.callCount.load());
  fflush(stderr);
  state->percent = 100;
  state->done = true;
}

// Only does fast, non-blocking bookkeeping on the calling thread (string
// alloc + map insert + spawning the detached thread) - every real SDK call
// happens inside RunTvtDownload on its own dedicated thread above, so this
// never risks blocking Electron's main thread the way a direct synchronous
// SDK call here would.
//
// Known, narrow residual risk: if the app quits while a download's
// dedicated thread is still active, that thread isn't tracked by
// playback.ts's pendingCalls/quitting mechanism (see its own doc comment on
// the FATAL ERROR napi_throw class that mechanism exists to prevent) since
// this thread never touches N-API/V8 at all - only the underlying SDK
// session. The 10-minute bound above and this being a real, human-timed
// gap (quitting mid-download) rather than a routine race keep this
// acceptable for now.
Napi::Value StartBackup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const int64_t beginMs = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
  const int64_t endMs = static_cast<int64_t>(info[3].As<Napi::Number>().DoubleValue());
  const std::string saveFilePath = info[4].As<Napi::String>().Utf8Value();
  const LONG lUserID = std::stol(sessionId);

  const std::string myHandle = "tvtdl-" + std::to_string(g_tvtDownloadCounter.fetch_add(1));
  auto state = std::make_shared<TvtDownloadState>();
  {
    std::lock_guard<std::mutex> lock(g_tvtDownloadsMutex);
    g_tvtDownloads[myHandle] = state;
  }

  std::thread(RunTvtDownload, lUserID, channel, beginMs, endMs, saveFilePath, state).detach();

  auto deferred = Napi::Promise::Deferred::New(env);
  deferred.Resolve(Napi::String::New(env, myHandle));
  return deferred.Promise();
}

// Plain map lookups now (no native SDK call, no AsyncWorker needed) - the
// real GetDownloadPos polling already happens inside RunTvtDownload's own
// loop above; this just reads the atomic it last wrote.
Napi::Value GetBackupProgress(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string myHandle = info[0].As<Napi::String>().Utf8Value();
  std::shared_ptr<TvtDownloadState> state;
  {
    std::lock_guard<std::mutex> lock(g_tvtDownloadsMutex);
    auto it = g_tvtDownloads.find(myHandle);
    if (it != g_tvtDownloads.end()) state = it->second;
  }
  auto deferred = Napi::Promise::Deferred::New(env);
  const int pct = (!state || state->failed.load()) ? 100 : state->percent.load();
  deferred.Resolve(Napi::Number::New(env, pct));
  return deferred.Promise();
}

// Signals RunTvtDownload's loop to stop and finalize (NET_SDK_StopGetFile)
// on its own dedicated thread, rather than calling StopGetFile directly
// here - see RunTvtDownload's doc comment on why every SDK call for one
// download stays on that one thread.
Napi::Value StopBackup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string myHandle = info[0].As<Napi::String>().Utf8Value();
  {
    std::lock_guard<std::mutex> lock(g_tvtDownloadsMutex);
    auto it = g_tvtDownloads.find(myHandle);
    if (it != g_tvtDownloads.end()) it->second->stopRequested = true;
  }
  auto deferred = Napi::Promise::Deferred::New(env);
  deferred.Resolve(env.Undefined());
  return deferred.Promise();
}

// Device discovery — NET_SDK_DiscoverDevice, a genuine UDP broadcast the
// device itself answers, no login/credentials involved. NOTE: the SDK
// header also documents a multi-vendor search (NET_SDK_DiscoverDeviceStart
// with a SearchTypeMask covering TVT's own protocol plus ONVIF/UPnP plus
// emulated Dahua/Hikvision/Uniview protocols all at once) that looked like
// it could cover every vendor through one call - confirmed NOT actually
// usable, though: it's declared behind `#ifdef DVR_NET_SDK_EXPORTS` in
// DVR_NET_SDK.h, a macro only defined when TVT builds the SDK's own DLL
// internally, not by a third-party consumer - the linker can't find it in
// the .lib we were given ("identifier not found"), so it's effectively an
// internal-only symbol despite being visible in the header. This function
// is the one that's actually exported and callable; it only finds TVT's
// own devices, same scope as every other vendor's discovery in this
// project (no multi-vendor coverage from a single call after all).
//
// A single blocking call with its own internal wait, unlike
// Uniview's/Dahua's callback-based discovery - runs on an AsyncWorker
// (same reasoning as LoginWorker above: a blocking SDK call would freeze
// Electron's main thread otherwise), no manual start/stop/timer needed.
constexpr int kDiscoveryMaxRecords = 256;
constexpr int kDiscoveryWaitSeconds = 3;

std::string SafeFieldString(const char* field, size_t fieldSize) {
  return std::string(field, strnlen(field, fieldSize));
}

std::string FormatMac(const unsigned char* mac) {
  char buf[24];
  snprintf(buf, sizeof(buf), "%02X-%02X-%02X-%02X-%02X-%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return std::string(buf);
}

class DiscoverDevicesWorker : public Napi::AsyncWorker {
 public:
  explicit DiscoverDevicesWorker(Napi::Env env) : Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    devices_.resize(kDiscoveryMaxRecords);
    const int count = NET_SDK_DiscoverDevice(devices_.data(), kDiscoveryMaxRecords, kDiscoveryWaitSeconds);
    devices_.resize(count > 0 ? static_cast<size_t>(count) : 0);
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array result = Napi::Array::New(env);
    for (size_t i = 0; i < devices_.size(); ++i) {
      const auto& d = devices_[i];
      Napi::Object obj = Napi::Object::New(env);
      obj.Set("host", SafeFieldString(d.strIP, sizeof(d.strIP)));
      obj.Set("port", Napi::Number::New(env, d.netPort));
      obj.Set("httpPort", Napi::Number::New(env, d.httpPort));
      obj.Set("mac", FormatMac(d.byMac));
      obj.Set("model", SafeFieldString(d.productType, sizeof(d.productType)));
      obj.Set("name", SafeFieldString(d.devName, sizeof(d.devName)));
      result[static_cast<uint32_t>(i)] = obj;
    }
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  Napi::Promise::Deferred deferred_;
  std::vector<NET_SDK_DEVICE_DISCOVERY_INFO> devices_;
};

Napi::Value DiscoverDevices(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* worker = new DiscoverDevicesWorker(env);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  NET_SDK_Init();

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
  exports.Set("discoverDevices", Napi::Function::New(env, DiscoverDevices));
  return exports;
}

NODE_API_MODULE(tvt_native, Init)
