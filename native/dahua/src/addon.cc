// N-API bridge over Dahua's General NetSDK. Like Uniview (and unlike
// Hikvision), this SDK has a genuinely documented decoded-frame path:
// CLIENT_SetDecCallBack registers a single GLOBAL callback (not per
// play-handle) that receives NET_FRAME_DECODE_INFO — real YUV plane
// pointers + per-plane stride/width/height — for every active play/login,
// identified by lLoginID/lPlayHandle. No separate decode library needed.
#include <napi.h>
#include <windows.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <ctime>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "dhnetsdk.h"

namespace {

struct LiveViewSession {
  Napi::ThreadSafeFunction tsfn;
  LLONG lLoginID = 0;
  LLONG lRealHandle = 0;
  // Playback sessions reuse this same struct/handle map (see
  // FindRecordingsWorker/StartPlaybackWorker below) - the global decode
  // callback (CLIENT_SetDecCallBack, registered once in Init()) already
  // dispatches by handle regardless of whether it's a live-view or
  // playback handle, so no separate per-handle callback registration is
  // needed for playback frames. Only this flag differs, telling
  // DestroySession which SDK stop call applies (CLIENT_StopRealPlay vs
  // CLIENT_StopPlayBack).
  bool isPlayback = false;
  // Set from the renderer (liveView:setFrameDelivery) when this tile isn't
  // actually visible - hidden behind an expanded tile, or the app tab
  // isn't the active one. Skips the YUV->RGBA conversion, buffer copy,
  // and IPC dispatch for a frame nobody renders (real, measured waste
  // across a 50+ device fleet) without touching the underlying decode
  // session, so resuming is instant. std::atomic since it's written from
  // the N-API call thread and read from the (global) decode callback.
  std::atomic<bool> framePaused{false};

  // Set only by clipExporter.ts's export sessions (see StartPlayback's
  // extra paceToRealtime argument) - same fix, same reasoning, and same
  // confirmed app-hang as native/tvt/src/addon.cc's matching field: this
  // SDK's global decode callback delivers frames as fast as it can decode
  // them, not paced to real time, and on-screen Playback only gets away
  // with that because its own frame-drop/backpressure check is nearly
  // free per callback - an export can't drop a single frame, so it does
  // real work (RGBA conversion, a write into ffmpeg's stdin) on every one,
  // and an unpaced firehose of those floods the main thread badly enough
  // for Windows to kill the whole app as "not responding." Only touched
  // from OnDecodedFrame itself (Dahua's own decode-delivery thread), so -
  // unlike framePaused above - these don't need to be atomic.
  bool paceToRealtime = false;
  bool paceInitialized = false;
  int64_t paceFirstContentMs = 0;
  std::chrono::steady_clock::time_point paceWallStart;
};

std::mutex g_mutex;
std::unordered_map<LLONG, LiveViewSession*> g_sessionsByHandle;

// See the matching note in native/uniview/src/addon.cc. Scoped PER SESSION
// (keyed by lLoginID), not global — a global mutex was tried first and,
// on Uniview, turned a single hung RealPlay call on one device into a
// permanent freeze of every other device sharing that addon, since nothing
// else could ever enter the SDK again. Keying per-session means a stuck
// call only ever blocks further calls against that same device's session.
// Login itself is intentionally NOT serialized by any mutex — different
// devices logging in concurrently is normal, expected usage, and the JS
// side (main/ipc/liveView.ts) already dedupes concurrent logins for the
// SAME device.
std::mutex g_sdkMutexMapGuard;
std::unordered_map<LLONG, std::unique_ptr<std::mutex>> g_sdkMutexBySession;

std::mutex& SdkMutexForSession(LLONG lLoginID) {
  std::lock_guard<std::mutex> lock(g_sdkMutexMapGuard);
  auto& slot = g_sdkMutexBySession[lLoginID];
  if (!slot) slot = std::make_unique<std::mutex>();
  return *slot;
}

struct FrameData {
  int width = 0;
  int height = 0;
  long timestampMs = 0;
  std::vector<uint8_t> pixels;  // RGBA, ready for canvas ImageData
};

// BT.601 limited-range YUV420 -> RGBA, using the real per-plane stride the
// SDK provides rather than assuming tightly-packed rows.
void ConvertYUVToRGBA(const NET_FRAME_DECODE_INFO* info, std::vector<uint8_t>& out) {
  const int width = info->nWidth[0];
  const int height = info->nHeight[0];
  const auto* yPlane = static_cast<const uint8_t*>(info->pVideoData[0]);
  const auto* uPlane = static_cast<const uint8_t*>(info->pVideoData[1]);
  const auto* vPlane = static_cast<const uint8_t*>(info->pVideoData[2]);
  const int yStride = info->nStride[0];
  const int uStride = info->nStride[1];
  const int vStride = info->nStride[2];

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

void CALLBACK OnDecodedFrame(LLONG /*lLoginID*/, LLONG lPlayHandle, NET_FRAME_DECODE_INFO* pFrameDecodeInfo,
                              NET_FRAME_INFO_EX* pFrameInfo, LDWORD /*dwUserData*/, LLONG /*nReserved*/) {
  if (!pFrameDecodeInfo || pFrameDecodeInfo->emFrameType != EM_FRAME_TYPE_VIDEO) return;
  if (pFrameDecodeInfo->nWidth[0] <= 0 || pFrameDecodeInfo->nHeight[0] <= 0) return;

  LiveViewSession* session = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_sessionsByHandle.find(lPlayHandle);
    if (it == g_sessionsByHandle.end()) return;
    session = it->second;
  }
  if (session->framePaused.load(std::memory_order_relaxed)) return;

  const int64_t contentMs = pFrameInfo ? pFrameInfo->nStamp : 0;

  // See LiveViewSession::paceToRealtime's doc comment - throttles THIS
  // callback (Dahua's own decode-delivery thread) to real content pace
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
  frame->width = pFrameDecodeInfo->nWidth[0];
  frame->height = pFrameDecodeInfo->nHeight[0];
  frame->timestampMs = contentMs;
  ConvertYUVToRGBA(pFrameDecodeInfo, frame->pixels);

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
    CLIENT_StopPlayBack(session->lRealHandle);
  } else {
    CLIENT_StopRealPlay(session->lRealHandle);
  }
  session->tsfn.Release();
  delete session;
}

// NET_TIME for the plain CLIENT_QueryRecordFile/CLIENT_PlayBackByTime API is
// LOCAL device time, not UTC - confirmed by a real side-by-side test against
// a live device (both queries run back-to-back for the exact same real-world
// moment): a local-time query for "today" found all 5 files spanning the
// device's full recorded range so far (00:00-04:04, matching the device's
// own self-reported last-recorded-time via DH_DEVSTATE_RECORD_TIME), while
// a UTC-converted query for the same moment found only 1 file (04:00-04:04),
// silently missing the first 4 hours - shifted into "yesterday" by the
// VPS's UTC offset. A prior attempt to switch this to UTC, based on the
// vendor's own MFC demo (NetSDKDemo.cpp's g_systimetoprivatetime combined
// with MFC's CTime::GetAsSystemTime, which uses gmtime()), turned out not to
// apply to this plain API on real hardware - the demo's UTC conversion
// either targets a different/newer capability-negotiated code path (see
// NET_IN_QUERY_RECORD_FILE_EX's separate bOnlySupportRealUTC-gated fields,
// mutually exclusive with its local-time fields - this device likely doesn't
// report that UTC capability) or the demo itself just doesn't reflect real
// field firmware behavior. Real hardware overrides doc/demo inference here.
// dwMonth is 1-based (still confirmed via the same demo: wMonth copied
// straight from Win32 SYSTEMTIME, which is 1-based - unaffected by the
// local-vs-UTC finding above).
NET_TIME EpochMsToNetTime(int64_t epochMs) {
  const time_t epochSec = static_cast<time_t>(epochMs / 1000);
  struct tm tmVal = {};
#ifdef _WIN32
  localtime_s(&tmVal, &epochSec);
#else
  localtime_r(&epochSec, &tmVal);
#endif
  NET_TIME t = {};
  t.dwYear = static_cast<DWORD>(tmVal.tm_year + 1900);
  t.dwMonth = static_cast<DWORD>(tmVal.tm_mon + 1);
  t.dwDay = static_cast<DWORD>(tmVal.tm_mday);
  t.dwHour = static_cast<DWORD>(tmVal.tm_hour);
  t.dwMinute = static_cast<DWORD>(tmVal.tm_min);
  t.dwSecond = static_cast<DWORD>(tmVal.tm_sec);
  return t;
}

int64_t NetTimeToEpochMs(const NET_TIME& t) {
  struct tm tmVal = {};
  tmVal.tm_year = static_cast<int>(t.dwYear) - 1900;
  tmVal.tm_mon = static_cast<int>(t.dwMonth) - 1;
  tmVal.tm_mday = static_cast<int>(t.dwDay);
  tmVal.tm_hour = static_cast<int>(t.dwHour);
  tmVal.tm_min = static_cast<int>(t.dwMinute);
  tmVal.tm_sec = static_cast<int>(t.dwSecond);
  tmVal.tm_isdst = -1;
  const time_t epochSec = mktime(&tmVal);
  return static_cast<int64_t>(epochSec) * 1000;
}

// CLIENT_RealPlayEx with hWnd=NULL never triggered the decode callback at
// all in real testing (confirmed: zero OnDecodedFrame calls, not a lookup
// bug) - unlike Hikvision/Uniview/TVT, Dahua's decoder appears to need a
// genuine window to render into even when the actual output is consumed
// via the separate global decode callback instead. This creates one
// reusable, permanently-hidden top-level window (never shown) to satisfy
// that requirement without putting anything on screen.
HWND GetOrCreateHiddenWindow() {
  static HWND hiddenWnd = nullptr;
  if (hiddenWnd) return hiddenWnd;

  const wchar_t* className = L"SSMVMSDahuaHiddenWindow";
  WNDCLASSW wc = {};
  wc.lpfnWndProc = DefWindowProcW;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = className;
  RegisterClassW(&wc);

  hiddenWnd = CreateWindowExW(0, className, L"", WS_POPUP, 0, 0, 1, 1, nullptr, nullptr, GetModuleHandleW(nullptr),
                               nullptr);
  return hiddenWnd;
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
    // CLIENT_LoginWithHighLevelSecurity (the newer handshake) timed out
    // against a real fleet device with confirmed-correct credentials on a
    // confirmed-reachable port - some older/rebranded Dahua-family units
    // don't support it at all and silently drop the attempt instead of
    // rejecting it cleanly, which looks identical to a network timeout.
    // CLIENT_LoginEx2 is the older, far more universally supported login
    // call and is what actually worked.
    NET_DEVICEINFO_Ex deviceInfo = {};
    int error = 0;
    lLoginID_ = CLIENT_LoginEx2(host_.c_str(), static_cast<WORD>(port_), username_.c_str(), password_.c_str(),
                                 EM_LOGIN_SPEC_CAP_TCP, nullptr, &deviceInfo, &error);
    if (lLoginID_ == 0) {
      SetError("Dahua login failed (error " + std::to_string(error) + ")");
      return;
    }
    channelCount_ = deviceInfo.nChanNum;

    // Real camera names, not "Channel N" - one CLIENT_GetDevConfig round
    // trip per channel (Dahua's SDK, unlike Uniview/TVT, has no bulk
    // "give me every channel's name in one call" option). Only worth
    // paying for when the name is actually needed: the very first
    // successful login for a device, or an explicit resync (see
    // skipChannelQuery in connectionManager.ts) - routine background
    // reconnects (app-boot connectAll(), the 30s heartbeat) skip this
    // entirely once a device's channels are already cached.
    if (skipChannelQuery_) return;
    for (int ch = 0; ch < channelCount_; ++ch) {
      NET_ENCODE_CHANNELTITLE_INFO titleInfo = {};
      titleInfo.dwSize = sizeof(titleInfo);
      // NET_EM_CFG_ENCODE_CHANNELTITLE belongs to NET_EM_CFG_OPERATE_TYPE,
      // the newer config enum consumed by CLIENT_GetConfig — NOT the older
      // DH_DEV_* command IDs CLIENT_GetDevConfig expects. Passing it to
      // CLIENT_GetDevConfig compiles fine (both take a DWORD/int channel id)
      // but fails at runtime with NET_ILLEGAL_PARAM (confirmed live against
      // a real device: CLIENT error=2147483655 == 0x80000007), since the
      // device doesn't recognize a NET_EM_CFG_OPERATE_TYPE value under the
      // legacy command namespace. CLIENT_GetConfig is the right call.
      const BOOL ok =
          CLIENT_GetConfig(lLoginID_, NET_EM_CFG_ENCODE_CHANNELTITLE, ch, &titleInfo, sizeof(titleInfo));
      std::string name;
      if (ok) {
        const size_t len = strnlen(titleInfo.szChannelName, sizeof(titleInfo.szChannelName));
        name.assign(titleInfo.szChannelName, len);
      } else {
        fprintf(stderr, "[dahua] channel name fetch failed ch=%d CLIENT error=%u\n", ch,
                static_cast<unsigned int>(CLIENT_GetLastError()));
        fflush(stderr);
      }
      channels_.push_back({ch, name});
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    // Dahua's device info only reports a total channel count, not per-channel
    // IDs or a start offset (unlike Hikvision/Uniview) - Dahua's documented
    // convention is 0-based channel indexing. Unverified against real
    // hardware yet; adjust here if a real device rejects channel 0.
    Napi::Array channels = Napi::Array::New(env);
    if (channels_.empty()) {
      for (int i = 0; i < channelCount_; ++i) {
        Napi::Object entry = Napi::Object::New(env);
        entry.Set("channel", Napi::Number::New(env, i));
        entry.Set("label", Napi::String::New(env, "Channel " + std::to_string(i)));
        channels[static_cast<uint32_t>(i)] = entry;
      }
    } else {
      for (size_t i = 0; i < channels_.size(); ++i) {
        const auto& entry = channels_[i];
        const std::string label = entry.name.empty() ? "Channel " + std::to_string(entry.channel) : entry.name;
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("channel", Napi::Number::New(env, entry.channel));
        obj.Set("label", Napi::String::New(env, label));
        channels[static_cast<uint32_t>(i)] = obj;
      }
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("sessionId", std::to_string(lLoginID_));
    result.Set("channels", channels);
    deferred_.Resolve(result);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  struct ChannelEntry {
    int channel;
    std::string name;
  };

  std::string host_;
  int port_;
  std::string username_;
  std::string password_;
  bool skipChannelQuery_;
  Napi::Promise::Deferred deferred_;
  LLONG lLoginID_ = 0;
  int channelCount_ = 0;
  std::vector<ChannelEntry> channels_;
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
  CLIENT_Logout(std::stoll(sessionId));
  return env.Undefined();
}

class StartLiveViewWorker : public Napi::AsyncWorker {
 public:
  StartLiveViewWorker(Napi::Env env, LLONG lLoginID, int channel, std::string streamType,
                       Napi::ThreadSafeFunction tsfn)
      : Napi::AsyncWorker(env), channel_(channel), streamType_(std::move(streamType)),
        deferred_(Napi::Promise::Deferred::New(env)) {
    session_ = new LiveViewSession();
    session_->lLoginID = lLoginID;
    session_->tsfn = std::move(tsfn);
  }

  void Execute() override {
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session_->lLoginID));

    const DH_RealPlayType rType = (streamType_ == "sub") ? DH_RType_Realplay_1 : DH_RType_Realplay_0;
    const LLONG lRealHandle = CLIENT_RealPlayEx(session_->lLoginID, channel_, GetOrCreateHiddenWindow(), rType);
    if (lRealHandle == 0) {
      const DWORD err = CLIENT_GetLastError();
      session_->tsfn.Release();
      delete session_;
      session_ = nullptr;
      SetError("CLIENT_RealPlayEx failed (error " + std::to_string(err) + ")");
      return;
    }
    session_->lRealHandle = lRealHandle;
    lRealHandle_ = lRealHandle;

    std::lock_guard<std::mutex> lock(g_mutex);
    g_sessionsByHandle[lRealHandle] = session_;
  }

  void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), std::to_string(lRealHandle_))); }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  int channel_;
  std::string streamType_;
  LiveViewSession* session_ = nullptr;
  LLONG lRealHandle_ = 0;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StartLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const std::string streamType = info[2].As<Napi::String>().Utf8Value();
  Napi::Function onFrame = info[3].As<Napi::Function>();

  const LLONG lLoginID = std::stoll(sessionId);
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
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "dahua-frame-callback", 2, 1);

  auto* worker = new StartLiveViewWorker(env, lLoginID, channel, streamType, std::move(tsfn));
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
  StopLiveViewWorker(Napi::Env env, LLONG lRealHandle)
      : Napi::AsyncWorker(env), lRealHandle_(lRealHandle),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    LiveViewSession* session = nullptr;
    {
      std::lock_guard<std::mutex> lock(g_mutex);
      auto it = g_sessionsByHandle.find(lRealHandle_);
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
      std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session->lLoginID));
      DestroySession(session);
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  LLONG lRealHandle_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StopLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string viewHandle = info[0].As<Napi::String>().Utf8Value();
  const LLONG lRealHandle = std::stoll(viewHandle);

  auto* worker = new StopLiveViewWorker(env, lRealHandle);
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
  const LLONG lRealHandle = std::stoll(viewHandle);

  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_sessionsByHandle.find(lRealHandle);
  if (it != g_sessionsByHandle.end()) {
    it->second->framePaused.store(!enabled, std::memory_order_relaxed);
  }
  return env.Undefined();
}

// Recording search is a real network round trip (same class of call as
// Login/StartLiveView) - runs off the main thread for the same reason.
//
// Dahua's per-file nRecordFileType byte (0=general,1=alarm,2=motion,...) is
// a DIFFERENT, unrelated enum from the EM_QUERY_RECORD_TYPE value passed as
// this call's own search filter - confirmed via the SDK header, which
// documents both separately with non-matching numeric values. A broad
// EM_RECORD_TYPE_ALL search's own per-file byte only ever distinguishes
// general/motion/alarm/etc, never "AI smart" - getting smart/intelligent
// segments needs a SEPARATE call with EM_RECORD_TYPE_ALL_INTELLI_VIDEO as
// the filter instead, merged in afterward (smart labels override
// continuous/motion on a range collision), mirroring the same
// multi-search-then-merge-by-range pattern already used for Uniview.
class FindRecordingsWorker : public Napi::AsyncWorker {
 public:
  FindRecordingsWorker(Napi::Env env, LLONG lLoginID, int channel, int64_t beginMs, int64_t endMs,
                       std::vector<std::string> filters)
      : Napi::AsyncWorker(env),
        lLoginID_(lLoginID),
        channel_(channel),
        beginMs_(beginMs),
        endMs_(endMs),
        filters_(std::move(filters)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(lLoginID_));

    const bool wantAll = filters_.empty() || std::find(filters_.begin(), filters_.end(), "all") != filters_.end();
    const bool wantContinuous =
        wantAll || std::find(filters_.begin(), filters_.end(), "continuous") != filters_.end();
    const bool wantMotion = wantAll || std::find(filters_.begin(), filters_.end(), "motion") != filters_.end();
    const bool wantSmart = wantAll || std::find(filters_.begin(), filters_.end(), "smart") != filters_.end();

    std::map<std::pair<int64_t, int64_t>, std::string> byRange;
    std::vector<NET_RECORDFILE_INFO> buffer(2000);

    // CLIENT_QueryRecordFile caps out well under the buffer/maxlen capacity
    // on real hardware (confirmed live: a single call for a full day with
    // continuous hourly-rotated recording only ever returned ~10 files,
    // silently truncating the rest of the day with no error) - the maxlen
    // parameter bounds the buffer, not a guarantee the device sends
    // everything in one round trip. Paginate: after each call, resume the
    // query from the latest file's own end time and keep going until a
    // call returns nothing more or the requested range is exhausted.
    // kMaxIterations is just a runaway-loop guard, not an expected ceiling.
    auto queryPaged = [&](int recordFileType, const char* label) {
      int64_t cursorMs = beginMs_;
      const int kMaxIterations = 2000;
      for (int iter = 0; iter < kMaxIterations && cursorMs < endMs_; ++iter) {
        NET_TIME begin = EpochMsToNetTime(cursorMs);
        NET_TIME end = EpochMsToNetTime(endMs_);
        int fileCount = 0;
        const BOOL ok = CLIENT_QueryRecordFile(lLoginID_, channel_, recordFileType, &begin, &end, nullptr,
                                                buffer.data(), static_cast<int>(buffer.size()), &fileCount, 5000,
                                                FALSE);
        if (!ok || fileCount <= 0) break;

        int64_t maxEndMs = cursorMs;
        for (int i = 0; i < fileCount && i < static_cast<int>(buffer.size()); ++i) {
          const auto& file = buffer[static_cast<size_t>(i)];
          const int64_t fStart = NetTimeToEpochMs(file.starttime);
          const int64_t fEnd = NetTimeToEpochMs(file.endtime);
          const std::string type = (label != nullptr) ? label : ((file.nRecordFileType == 2) ? "motion" : "continuous");
          if (label == nullptr && ((type == "motion" && !wantMotion) || (type == "continuous" && !wantContinuous))) {
            if (fEnd > maxEndMs) maxEndMs = fEnd;
            continue;
          }
          byRange[{fStart, fEnd}] = type;
          if (fEnd > maxEndMs) maxEndMs = fEnd;
        }
        if (maxEndMs <= cursorMs) break;  // no forward progress - avoid looping forever
        cursorMs = maxEndMs + 1;
      }
    };

    if (wantContinuous || wantMotion) {
      queryPaged(EM_RECORD_TYPE_ALL, nullptr);
    }
    if (wantSmart) {
      queryPaged(EM_RECORD_TYPE_ALL_INTELLI_VIDEO, "smart");
    }

    for (const auto& entry : byRange) {
      segments_.push_back({entry.first.first, entry.first.second, entry.second});
    }
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

  LLONG lLoginID_;
  int channel_;
  int64_t beginMs_;
  int64_t endMs_;
  std::vector<std::string> filters_;
  Napi::Promise::Deferred deferred_;
  std::vector<Segment> segments_;
};

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

  const LLONG lLoginID = std::stoll(sessionId);
  auto* worker = new FindRecordingsWorker(env, lLoginID, channel, beginMs, endMs, std::move(filters));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class StartPlaybackWorker : public Napi::AsyncWorker {
 public:
  StartPlaybackWorker(Napi::Env env, LLONG lLoginID, int channel, int64_t beginMs, int64_t endMs,
                       Napi::ThreadSafeFunction tsfn, bool paceToRealtime)
      : Napi::AsyncWorker(env), channel_(channel), beginMs_(beginMs), endMs_(endMs),
        deferred_(Napi::Promise::Deferred::New(env)) {
    session_ = new LiveViewSession();
    session_->lLoginID = lLoginID;
    session_->tsfn = std::move(tsfn);
    session_->isPlayback = true;
    session_->paceToRealtime = paceToRealtime;
  }

  void Execute() override {
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session_->lLoginID));

    NET_TIME begin = EpochMsToNetTime(beginMs_);
    NET_TIME end = EpochMsToNetTime(endMs_);

    // Same hidden-window requirement as live view (see GetOrCreateHiddenWindow's
    // comment) - the decode callback is the actual frame source either way.
    const LLONG lPlayHandle =
        CLIENT_PlayBackByTime(session_->lLoginID, channel_, &begin, &end, GetOrCreateHiddenWindow(), nullptr, 0);
    if (lPlayHandle == 0) {
      const DWORD err = CLIENT_GetLastError();
      session_->tsfn.Release();
      delete session_;
      session_ = nullptr;
      SetError("CLIENT_PlayBackByTime failed (error " + std::to_string(err) + ")");
      return;
    }
    session_->lRealHandle = lPlayHandle;
    lPlayHandle_ = lPlayHandle;

    std::lock_guard<std::mutex> lock(g_mutex);
    g_sessionsByHandle[lPlayHandle] = session_;
  }

  void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), std::to_string(lPlayHandle_))); }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  int channel_;
  int64_t beginMs_;
  int64_t endMs_;
  LiveViewSession* session_ = nullptr;
  LLONG lPlayHandle_ = 0;
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
  const bool paceToRealtime = info.Length() > 5 && info[5].As<Napi::Boolean>().Value();

  const LLONG lLoginID = std::stoll(sessionId);
  // maxQueueSize=2 (was 0/unbounded) — see the matching comment on the
  // live-view StartLiveView's own tsfn creation above for why.
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "dahua-playback-frame-callback", 2, 1);

  auto* worker = new StartPlaybackWorker(env, lLoginID, channel, beginMs, endMs, std::move(tsfn), paceToRealtime);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

// See the matching note in native/uniview/src/addon.cc - every one of these
// runs via AsyncWorker rather than synchronously on the N-API thread, since
// any real SDK call can unpredictably hang against a slow or uncooperative
// device.
class ControlPlaybackWorker : public Napi::AsyncWorker {
 public:
  ControlPlaybackWorker(Napi::Env env, LLONG lPlayHandle, std::string command, NET_TIME seekTime, double speed)
      : Napi::AsyncWorker(env),
        lPlayHandle_(lPlayHandle),
        command_(std::move(command)),
        seekTime_(seekTime),
        speed_(speed),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    BOOL ok = FALSE;
    if (command_ == "pause") {
      ok = CLIENT_PausePlayBack(lPlayHandle_, TRUE);
    } else if (command_ == "resume") {
      ok = CLIENT_PausePlayBack(lPlayHandle_, FALSE);
    } else if (command_ == "seek") {
      ok = CLIENT_SeekPlayBackByTime(lPlayHandle_, &seekTime_);
    } else if (command_ == "setSpeed") {
      // Unlike TVT, Dahua's SDK gives a real explicit multiplier here - no
      // step-cycling workaround needed.
      ok = CLIENT_SetPlayBackSpeedEx(lPlayHandle_, speed_);
    } else if (command_ == "stepFrame") {
      // bStop=FALSE assumed to mean "advance one frame" (vs. TRUE stopping
      // the stepping mode) based on the parameter name alone - unverified
      // against real hardware yet.
      ok = CLIENT_StepPlayBack(lPlayHandle_, FALSE);
    }
    if (!ok) {
      const DWORD err = CLIENT_GetLastError();
      SetError("Dahua playback control failed (error " + std::to_string(err) + ")");
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  LLONG lPlayHandle_;
  std::string command_;
  NET_TIME seekTime_;
  double speed_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value ControlPlayback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const LLONG lPlayHandle = std::stoll(info[0].As<Napi::String>().Utf8Value());
  const std::string command = info[1].As<Napi::String>().Utf8Value();
  NET_TIME seekTime = {};
  double speed = 1.0;
  if (command == "seek") {
    seekTime = EpochMsToNetTime(static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue()));
  } else if (command == "setSpeed") {
    speed = static_cast<double>(info[2].As<Napi::Number>().Int32Value());
  }

  auto* worker = new ControlPlaybackWorker(env, lPlayHandle, command, seekTime, speed);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class GetPlaybackTimeWorker : public Napi::AsyncWorker {
 public:
  GetPlaybackTimeWorker(Napi::Env env, LLONG lPlayHandle)
      : Napi::AsyncWorker(env), lPlayHandle_(lPlayHandle), deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    NET_TIME osdTime = {};
    NET_TIME startTime = {};
    NET_TIME endTime = {};
    if (CLIENT_GetPlayBackOsdTime(lPlayHandle_, &osdTime, &startTime, &endTime)) {
      playTimeMs_ = NetTimeToEpochMs(osdTime);
    }
  }

  void OnOK() override { deferred_.Resolve(Napi::Number::New(Env(), static_cast<double>(playTimeMs_))); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  LLONG lPlayHandle_;
  int64_t playTimeMs_ = 0;
  Napi::Promise::Deferred deferred_;
};

Napi::Value GetPlaybackTime(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const LLONG lPlayHandle = std::stoll(info[0].As<Napi::String>().Utf8Value());
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
  const LLONG lPlayHandle = std::stoll(info[0].As<Napi::String>().Utf8Value());

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

// Device discovery — CLIENT_StartSearchDevices/CLIENT_StopSearchDevices, a
// genuine UDP broadcast the device itself answers, no login/credentials
// involved. Same shape and same safety pattern as Uniview's
// NETDEV_Discovery/NETDEV_SetDiscoveryCallBack in native/uniview/src/addon.cc
// (start returns a handle, results arrive via callback over time, stop
// tears it down) — including the same mutex-guarded active flag, for the
// same reason: the SDK's broadcast can keep delivering late responses
// after the JS side's fixed collection window ends and calls
// StopDiscovery(), and the callback fires on an SDK-internal thread, not
// the N-API call thread. Calling NonBlockingCall on an already-Release()'d
// ThreadSafeFunction is undefined behavior - this was a confirmed, real
// crash risk for Uniview's discovery and there's no reason to assume this
// callback-based discovery is any different.
Napi::ThreadSafeFunction g_discoveryTsfn;
std::mutex g_discoveryMutex;
bool g_discoveryActive = false;
LLONG g_discoveryHandle = 0;

// Bounded, not 0/unbounded - see the matching comment in Uniview's
// addon.cc for why (this project's own real 51GB memory leak).
constexpr size_t kDiscoveryQueueSize = 64;

std::string SafeFieldString(const char* field, size_t fieldSize) {
  return std::string(field, strnlen(field, fieldSize));
}

void CALLBACK OnDeviceDiscovered(DEVICE_NET_INFO_EX* pDevNetInfo, void* /*pUserData*/) {
  if (!pDevNetInfo) return;
  // Temporary diagnostics (same project convention used to chase every
  // other real hardware bug this engagement) - first time this device's
  // real response data has been observed live.
  fprintf(stderr,
          "[dahua-discovery-diag] ip=%s port=%d mac=%s vendor=%s detailType=%s model=%s httpPort=%hu "
          "manuFactory=%d ipVersion=%d\n",
          pDevNetInfo->szIP, pDevNetInfo->nPort, pDevNetInfo->szMac, pDevNetInfo->szVendor,
          pDevNetInfo->szDetailType, pDevNetInfo->szDeviceType, pDevNetInfo->nHttpPort,
          static_cast<int>(pDevNetInfo->byManuFactory), static_cast<int>(pDevNetInfo->emIPVersionFrom));
  fflush(stderr);

  // A dual-stack device answers the search broadcast twice - once with a
  // dotted-decimal IPv4 szIP, once with an IPv6-formatted one (confirmed
  // live: "2008::6/112" alongside "192.168.1.11" for the same physical
  // device/MAC). emIPVersionFrom was tried first as the filter signal
  // (its own doc comment: "0:form IPv4 Multicast 1:form IPv6 Multicast")
  // but real diagnostic data proved it unreliable - both the IPv4 and the
  // IPv6-formatted responses came back with emIPVersionFrom=0. Checking
  // szIP's own content directly is the actual reliable signal: a real
  // IPv4 address never contains ':', an IPv6 one always does. Nothing
  // downstream in this app supports IPv6 hosts (ARP lookup, camera URL
  // construction, etc. all assume dotted-decimal IPv4), so this drops the
  // IPv6 response before it can surface as a bogus duplicate "device".
  if (std::strchr(pDevNetInfo->szIP, ':') != nullptr) return;

  std::lock_guard<std::mutex> lock(g_discoveryMutex);
  if (!g_discoveryActive) return;

  auto* info = new DEVICE_NET_INFO_EX(*pDevNetInfo);
  auto status = g_discoveryTsfn.NonBlockingCall(
      info, [](Napi::Env env, Napi::Function jsCallback, DEVICE_NET_INFO_EX* d) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("host", SafeFieldString(d->szIP, sizeof(d->szIP)));
        obj.Set("port", Napi::Number::New(env, d->nPort));
        obj.Set("httpPort", Napi::Number::New(env, d->nHttpPort));
        obj.Set("mac", SafeFieldString(d->szMac, sizeof(d->szMac)));
        obj.Set("model", SafeFieldString(d->szDetailType, sizeof(d->szDetailType)));
        obj.Set("vendor", SafeFieldString(d->szVendor, sizeof(d->szVendor)));
        obj.Set("name", SafeFieldString(d->szDevName, sizeof(d->szDevName)));
        // byManuFactory (EM_IPC_TYPE) is the real "is this genuinely a
        // Dahua device" signal - DH_IPC_PRIVATE (0) means the device
        // speaks Dahua's own private protocol natively. szVendor is
        // documented as "OEM type" and is populated only for third-party
        // hardware OEM'd under Dahua's system - it's blank on genuine
        // Dahua-branded units (confirmed live: a real Dahua device's own
        // vendor field came back empty), so it can't be used the same way
        // Uniview's manufacturer field is used.
        obj.Set("manuFactory", Napi::Number::New(env, static_cast<int>(d->byManuFactory)));
        jsCallback.Call({obj});
        delete d;
      });
  if (status != napi_ok) delete info;
}

Napi::Value StartDiscovery(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Function onDevice = info[0].As<Napi::Function>();
  std::lock_guard<std::mutex> lock(g_discoveryMutex);
  // A scan already in flight when another one starts shouldn't leak the
  // previous ThreadSafeFunction or leave the SDK's own search running -
  // same reasoning as every other resource replacement in this file.
  if (g_discoveryActive) {
    CLIENT_StopSearchDevices(g_discoveryHandle);
    g_discoveryActive = false;
    g_discoveryTsfn.Release();
  }
  g_discoveryTsfn = Napi::ThreadSafeFunction::New(env, onDevice, "dahua-discovery-callback", kDiscoveryQueueSize, 1);
  g_discoveryActive = true;
  g_discoveryHandle = CLIENT_StartSearchDevices(OnDeviceDiscovered, nullptr);
  return env.Undefined();
}

Napi::Value StopDiscovery(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> lock(g_discoveryMutex);
  if (g_discoveryActive) {
    CLIENT_StopSearchDevices(g_discoveryHandle);
    g_discoveryActive = false;
    g_discoveryTsfn.Release();
  }
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  CLIENT_Init(nullptr, 0);
  CLIENT_SetDecCallBack(OnDecodedFrame, 0);

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
  exports.Set("startDiscovery", Napi::Function::New(env, StartDiscovery));
  exports.Set("stopDiscovery", Napi::Function::New(env, StopDiscovery));
  return exports;
}

NODE_API_MODULE(dahua_native, Init)
