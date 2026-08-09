// N-API bridge over Hikvision HCNetSDK (login + real-time preview) and the
// bundled PlayCtrl/PlayM4 decoder. HCNetSDK's REALDATACALLBACK hands us raw
// compressed stream data (NALUs); we feed that into a PlayM4 decode port and
// register PlayM4's own decoded-frame callback (PlayM4_SetDisplayCallBack)
// to get pixel data out instead of having it render into a native window —
// this is what makes painting into an HTML canvas possible at all.
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

#include "HCNetSDK.h"

// MSVC auto-defines _WINDLL for any DLL-type build target (which this addon
// is), which flips plaympeg4.h into its dllexport branch:
//   #define PLAYM4_API extern "C"__declspec(dllexport)
// That missing space makes "C"__declspec parse as an (invalid) C++11
// user-defined string literal under modern MSVC — a real bug in the vendor
// header. Undefining _WINDLL here forces the (correctly spaced) dllimport
// branch instead, which is what we want anyway since we're consuming
// PlayCtrl.dll, not building it.
#ifdef _WINDLL
#undef _WINDLL
#endif
#include "plaympeg4.h"

namespace {

struct LiveViewSession {
  Napi::ThreadSafeFunction tsfn;
  long lUserID = -1;
  long lRealHandle = -1;
  long nPort = -1;
  bool streamOpened = false;
  // Playback sessions reuse this same struct/OnRawData/OnDecodedFrame
  // pipeline (see FindRecordingsWorker/StartPlaybackWorker below) -
  // NET_DVR_SetPlayDataCallBack_V40 has an identical callback signature to
  // NET_DVR_RealPlay_V40's own raw-data callback, so no separate decode
  // path is needed. isPlayback tells DestroySession which SDK stop call
  // applies (NET_DVR_StopRealPlay vs NET_DVR_StopPlayBack); beginMs/endMs
  // are the originally-requested playback window, needed to convert an
  // absolute-time seek into the percentage NET_DVR_PLAYSETPOS actually
  // expects.
  bool isPlayback = false;
  int64_t beginMs = 0;
  int64_t endMs = 0;
  // Set from the renderer (liveView:setFrameDelivery) whenever this tile
  // isn't actually being looked at — hidden behind an expanded tile, or on
  // a background app tab. The SDK's own H.264/H.265 decode still runs
  // regardless (stopping that outright would mean losing the session, the
  // opposite of what tab/expand switching is supposed to feel like), but
  // skipping the YV12->RGBA conversion, the frame buffer copy, and the
  // IPC dispatch for a frame nobody renders was real, measured waste
  // across a 50+ device fleet (found via a resource-usage audit) -
  // std::atomic since it's written from the N-API call thread and read
  // from the decode callback thread.
  std::atomic<bool> framePaused{false};

  // Set only by clipExporter.ts's export sessions (see StartPlayback's
  // extra paceToRealtime argument) - same fix, same reasoning, and same
  // confirmed app-hang as native/tvt/src/addon.cc's matching field: PlayM4
  // delivers decoded frames as fast as it can decode them, not paced to
  // real time, and on-screen Playback only gets away with that because
  // its own frame-drop/backpressure check is nearly free per callback - an
  // export can't drop a single frame, so it does real work (RGBA
  // conversion, a write into ffmpeg's stdin) on every one, and an unpaced
  // firehose of those floods the main thread badly enough for Windows to
  // kill the whole app as "not responding." Only touched from
  // OnDecodedFrame itself (PlayM4's own decode-delivery thread for this
  // port), so - unlike framePaused above - these don't need to be atomic.
  bool paceToRealtime = false;
  bool paceInitialized = false;
  int64_t paceFirstContentMs = 0;
  std::chrono::steady_clock::time_point paceWallStart;
};

std::mutex g_mutex;
// PlayM4_SetDisplayCallBack has no pUser slot, so the decoded-frame callback
// can only identify its session via the decode port number it was given.
std::unordered_map<long, LiveViewSession*> g_sessionsByPort;
std::unordered_map<long, LiveViewSession*> g_sessionsByHandle;
// How many NET_DVR_PLAYFAST steps are currently applied per playback view
// handle (absent/0 = normal speed) - see ControlPlaybackWorker's "setSpeed"
// branch. A separate map (not a field on LiveViewSession) so
// ControlPlaybackWorker never needs to hold a raw LiveViewSession* across
// the async gap to its own Execute() call - it looks this up fresh, under
// g_mutex, from inside Execute() itself, so a concurrent StopPlayback
// deleting the session in between can't leave it pointing at freed memory.
// Erased on stop, same as g_sessionsByHandle.
std::unordered_map<long, int> g_speedStepsByHandle;

// See the matching note in native/uniview/src/addon.cc. Scoped PER SESSION
// (keyed by lUserID), not global — a global mutex was tried first and, on
// Uniview, turned a single hung RealPlay call on one device into a
// permanent freeze of every other device sharing that addon. Login itself
// is intentionally NOT serialized by any mutex — different devices logging
// in concurrently is normal, expected usage, and the JS side
// (main/ipc/liveView.ts) already dedupes concurrent logins for the SAME
// device.
std::mutex g_sdkMutexMapGuard;
std::unordered_map<long, std::unique_ptr<std::mutex>> g_sdkMutexBySession;

std::mutex& SdkMutexForSession(long lUserID) {
  std::lock_guard<std::mutex> lock(g_sdkMutexMapGuard);
  auto& slot = g_sdkMutexBySession[lUserID];
  if (!slot) slot = std::make_unique<std::mutex>();
  return *slot;
}

struct FrameData {
  int width = 0;
  int height = 0;
  long timestampMs = 0;
  std::vector<uint8_t> pixels; // RGBA, ready for canvas ImageData
};

// BT.601 limited-range YV12 (planar Y, then V, then U — V before U is what
// distinguishes YV12 from I420) -> RGBA, fixed-point. Confirmed against real
// hardware that PlayM4_SetDisplayCallBack delivers YV12 (nType=3) here, not
// RGB32 (nType=7) — the SDK's software decoder never actually produces
// RGB32 through this callback despite T_RGB32 existing as a named constant.
void ConvertYV12ToRGBA(const uint8_t* src, long width, long height, std::vector<uint8_t>& out) {
  const long frameSize = width * height;
  const uint8_t* yPlane = src;
  const uint8_t* vPlane = src + frameSize;
  const uint8_t* uPlane = src + frameSize + frameSize / 4;

  out.resize(static_cast<size_t>(frameSize) * 4);
  for (long row = 0; row < height; ++row) {
    for (long col = 0; col < width; ++col) {
      const long yIndex = row * width + col;
      const long uvIndex = (row / 2) * (width / 2) + (col / 2);
      const int Y = yPlane[yIndex];
      const int U = uPlane[uvIndex] - 128;
      const int V = vPlane[uvIndex] - 128;

      int r = Y + ((91881 * V) >> 16);
      int g = Y - ((22554 * U + 46802 * V) >> 16);
      int b = Y + ((116130 * U) >> 16);
      r = r < 0 ? 0 : (r > 255 ? 255 : r);
      g = g < 0 ? 0 : (g > 255 ? 255 : g);
      b = b < 0 ? 0 : (b > 255 ? 255 : b);

      const long outIdx = yIndex * 4;
      out[outIdx + 0] = static_cast<uint8_t>(r);
      out[outIdx + 1] = static_cast<uint8_t>(g);
      out[outIdx + 2] = static_cast<uint8_t>(b);
      out[outIdx + 3] = 255;
    }
  }
}

void CALLBACK OnDecodedFrame(long nPort, char* pBuf, long nSize, long nWidth, long nHeight, long nStamp,
                              long nType, long /*nReserved*/) {
  if (nType != T_YV12 || nSize <= 0 || nWidth <= 0 || nHeight <= 0) return;

  LiveViewSession* session = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_sessionsByPort.find(nPort);
    if (it == g_sessionsByPort.end()) return;
    session = it->second;
  }
  if (session->framePaused.load(std::memory_order_relaxed)) return;

  // See LiveViewSession::paceToRealtime's doc comment - throttles THIS
  // callback (PlayM4's own decode-delivery thread) to real content pace
  // before doing any of the expensive conversion/dispatch work below,
  // rather than trying to throttle after the fact on the JS side (by the
  // time a frame reaches JS, the CPU/memory-bandwidth cost of decoding and
  // converting it has already been paid).
  if (session->paceToRealtime) {
    if (!session->paceInitialized) {
      session->paceInitialized = true;
      session->paceFirstContentMs = nStamp;
      session->paceWallStart = std::chrono::steady_clock::now();
    } else {
      const int64_t elapsedContentMs = static_cast<int64_t>(nStamp) - session->paceFirstContentMs;
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
  frame->width = nWidth;
  frame->height = nHeight;
  frame->timestampMs = nStamp;
  ConvertYV12ToRGBA(reinterpret_cast<const uint8_t*>(pBuf), nWidth, nHeight, frame->pixels);

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

void CALLBACK OnRawData(LONG /*lPlayHandle*/, DWORD dwDataType, BYTE* pBuffer, DWORD dwBufSize, void* pUser) {
  auto* session = static_cast<LiveViewSession*>(pUser);
  if (!session || dwBufSize == 0) return;

  switch (dwDataType) {
    case NET_DVR_SYSHEAD:
      if (!session->streamOpened && PlayM4_OpenStream(session->nPort, pBuffer, dwBufSize, 2 * 1024 * 1024)) {
        PlayM4_SetDisplayCallBack(session->nPort, OnDecodedFrame);
        PlayM4_Play(session->nPort, nullptr);
        session->streamOpened = true;
      }
      break;
    case NET_DVR_STREAMDATA:
      if (session->streamOpened) {
        PlayM4_InputData(session->nPort, pBuffer, dwBufSize);
      }
      break;
    default:
      break;
  }
}

void DestroySession(LiveViewSession* session) {
  if (session->isPlayback) {
    NET_DVR_StopPlayBack(session->lRealHandle);
  } else {
    NET_DVR_StopRealPlay(session->lRealHandle);
  }
  PlayM4_Stop(session->nPort);
  PlayM4_CloseStream(session->nPort);
  PlayM4_FreePort(session->nPort);
  session->tsfn.Release();
  delete session;
}

// NET_DVR_TIME's fields are a plain broken-down local time (dwYear is the
// real 4-digit year), assumed 1-based month (standard calendar convention)
// since the header gives no explicit 0-based note the way TVT's DD_TIME
// does - unverified against real hardware yet, same as every other vendor
// time-format assumption made before a device's first real test. Treated
// as the device's own LOCAL clock, not UTC, matching the same convention
// already used for Dahua/TVT.
NET_DVR_TIME EpochMsToNetDvrTime(int64_t epochMs) {
  const time_t epochSec = static_cast<time_t>(epochMs / 1000);
  struct tm tmVal = {};
#ifdef _WIN32
  localtime_s(&tmVal, &epochSec);
#else
  localtime_r(&epochSec, &tmVal);
#endif
  NET_DVR_TIME t = {};
  t.dwYear = static_cast<DWORD>(tmVal.tm_year + 1900);
  t.dwMonth = static_cast<DWORD>(tmVal.tm_mon + 1);
  t.dwDay = static_cast<DWORD>(tmVal.tm_mday);
  t.dwHour = static_cast<DWORD>(tmVal.tm_hour);
  t.dwMinute = static_cast<DWORD>(tmVal.tm_min);
  t.dwSecond = static_cast<DWORD>(tmVal.tm_sec);
  return t;
}

int64_t NetDvrTimeToEpochMs(const NET_DVR_TIME& t) {
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

// NET_DVR_FINDDATA_V30.byFileType: 0=scheduled,6=manual -> continuous;
// 1=motion,3=motion|alarm,4=motion&alarm -> motion; 9=VCA (video content
// analysis, Hikvision's AI-detection category),14=intelligent
// transportation -> smart; everything else (alarm, command trigger, PIR,
// wireless, callhelp) -> other.
std::string ClassifyFileType(BYTE byFileType) {
  switch (byFileType) {
    case 0:
    case 6:
      return "continuous";
    case 1:
    case 3:
    case 4:
      return "motion";
    case 9:
    case 14:
      return "smart";
    default:
      return "other";
  }
}

}  // namespace

// Login and StartLiveView both do a real blocking network handshake
// (NET_DVR_Login_V40/NET_DVR_RealPlay_V40 can take seconds on a slow link) -
// running them directly on the N-API call thread means the calling thread
// (Electron's main/UI thread) is frozen for the duration. Confirmed live:
// a slow-connecting device froze the entire app, not just the dialog that
// triggered the login. AsyncWorker moves the actual SDK call onto a libuv
// worker thread; OnOK/OnError resolve the real Promise back on the main
// thread once it's done.
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
    NET_DVR_USER_LOGIN_INFO loginInfo = {};
    strncpy_s(loginInfo.sDeviceAddress, host_.c_str(), _TRUNCATE);
    loginInfo.wPort = static_cast<WORD>(port_);
    strncpy_s(loginInfo.sUserName, username_.c_str(), _TRUNCATE);
    strncpy_s(loginInfo.sPassword, password_.c_str(), _TRUNCATE);
    loginInfo.bUseAsynLogin = FALSE;

    lUserID_ = NET_DVR_Login_V40(&loginInfo, &deviceInfo_);
    if (lUserID_ < 0) {
      const DWORD err = NET_DVR_GetLastError();
      SetError("Hikvision login failed (NET_DVR error " + std::to_string(err) + ")");
      return;
    }

    // Hybrid/NVR devices number analog and digital(IP) channels in two
    // separate ranges — confirmed against real hardware: a pure-IP
    // 16-channel NVR rejected channel 1 (NET_DVR_CHANNEL_ERROR) and only
    // accepted channels starting at byStartDChan (33 on that unit).
    const auto& dev = deviceInfo_.struDeviceV30;
    std::vector<int> channelNumbers;
    for (int i = 0; i < dev.byChanNum; ++i) channelNumbers.push_back(dev.byStartChan + i);
    for (int i = 0; i < dev.byIPChanNum; ++i) channelNumbers.push_back(dev.byStartDChan + i);

    // Unlike Uniview (one bulk call lists every channel's name at once),
    // HCNetSDK only exposes a channel's configured name through a
    // per-channel picture/OSD config query - one real network round trip
    // PER CHANNEL, not a single list call. Confirmed acceptable by the
    // user specifically because it only runs once (cached to disk
    // afterward, see deviceStore/connectionManager) and can be re-run on
    // demand via "Refresh Status", not on every routine reconnect -
    // skipChannelQuery_ gates this exactly like Uniview's extra round
    // trip. Unverified against real hardware whether PICCFG_V40 works the
    // same way for IP/digital channels as analog ones; a failed query
    // just falls back to a plain "Channel N" label for that channel
    // rather than erroring the whole login.
    for (int ch : channelNumbers) {
      std::string name;
      if (!skipChannelQuery_) {
        NET_DVR_PICCFG_V40 piccfg = {};
        piccfg.dwSize = sizeof(piccfg);
        DWORD bytesReturned = 0;
        if (NET_DVR_GetDVRConfig(lUserID_, NET_DVR_GET_PICCFG_V40, ch, &piccfg, sizeof(piccfg), &bytesReturned)) {
          const auto* raw = reinterpret_cast<const char*>(piccfg.sChanName);
          const size_t nameLen = strnlen(raw, sizeof(piccfg.sChanName));
          name.assign(raw, nameLen);
        } else {
          fprintf(stderr, "[hikvision] channel name fetch failed ch=%d NET_DVR error=%lu\n", ch,
                  static_cast<unsigned long>(NET_DVR_GetLastError()));
          fflush(stderr);
        }
      }
      channels_.push_back({ch, name});
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array channels = Napi::Array::New(env);
    for (size_t i = 0; i < channels_.size(); ++i) {
      const auto& ch = channels_[i];
      Napi::Object channelObj = Napi::Object::New(env);
      channelObj.Set("channel", Napi::Number::New(env, ch.channel));
      channelObj.Set("label", ch.name.empty() ? ("Channel " + std::to_string(ch.channel)) : ch.name);
      channels[static_cast<uint32_t>(i)] = channelObj;
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("sessionId", std::to_string(lUserID_));
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
  LONG lUserID_ = -1;
  NET_DVR_DEVICEINFO_V40 deviceInfo_ = {};
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

  auto* worker = new LoginWorker(env, std::move(host), port, std::move(username), std::move(password), skipChannelQuery);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value Logout(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  NET_DVR_Logout(std::stol(sessionId));
  return env.Undefined();
}

class StartLiveViewWorker : public Napi::AsyncWorker {
 public:
  StartLiveViewWorker(Napi::Env env, long lUserID, int channel, std::string streamType, Napi::ThreadSafeFunction tsfn)
      : Napi::AsyncWorker(env),
        channel_(channel),
        streamType_(std::move(streamType)),
        deferred_(Napi::Promise::Deferred::New(env)) {
    session_ = new LiveViewSession();
    session_->lUserID = lUserID;
    session_->tsfn = std::move(tsfn);
  }

  void Execute() override {
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session_->lUserID));

    LONG nPort = -1;
    if (!PlayM4_GetPort(&nPort)) {
      session_->tsfn.Release();
      delete session_;
      session_ = nullptr;
      SetError("PlayM4_GetPort failed");
      return;
    }
    session_->nPort = nPort;

    NET_DVR_PREVIEWINFO previewInfo = {};
    previewInfo.lChannel = channel_;
    previewInfo.dwStreamType = (streamType_ == "sub") ? 1 : 0;
    previewInfo.dwLinkMode = 0;  // TCP
    previewInfo.hPlayWnd = nullptr;
    previewInfo.bBlocked = 1;
    previewInfo.byProtoType = 0;
    previewInfo.dwDisplayBufNum = 1;

    const LONG lRealHandle = NET_DVR_RealPlay_V40(session_->lUserID, &previewInfo, OnRawData, session_);
    if (lRealHandle < 0) {
      const DWORD err = NET_DVR_GetLastError();
      session_->tsfn.Release();
      PlayM4_FreePort(nPort);
      delete session_;
      session_ = nullptr;
      SetError("NET_DVR_RealPlay_V40 failed (NET_DVR error " + std::to_string(err) + ")");
      return;
    }
    session_->lRealHandle = lRealHandle;
    lRealHandle_ = lRealHandle;

    std::lock_guard<std::mutex> lock(g_mutex);
    g_sessionsByPort[nPort] = session_;
    g_sessionsByHandle[lRealHandle] = session_;
  }

  void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), std::to_string(lRealHandle_))); }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  int channel_;
  std::string streamType_;
  LiveViewSession* session_ = nullptr;
  LONG lRealHandle_ = -1;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StartLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const std::string streamType = info[2].As<Napi::String>().Utf8Value();
  Napi::Function onFrame = info[3].As<Napi::Function>();

  const long lUserID = std::stol(sessionId);
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
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "hikvision-frame-callback", 2, 1);

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
  StopLiveViewWorker(Napi::Env env, long lRealHandle)
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
        g_sessionsByPort.erase(session->nPort);
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
      std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session->lUserID));
      DestroySession(session);
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  long lRealHandle_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StopLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string viewHandle = info[0].As<Napi::String>().Utf8Value();
  const long lRealHandle = std::stol(viewHandle);

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
  const long lRealHandle = std::stol(viewHandle);

  std::lock_guard<std::mutex> lock(g_mutex);
  auto it = g_sessionsByHandle.find(lRealHandle);
  if (it != g_sessionsByHandle.end()) {
    it->second->framePaused.store(!enabled, std::memory_order_relaxed);
  }
  return env.Undefined();
}

// Recording search is a real network round trip (same class of call as
// Login/StartLiveView) - runs off the main thread for the same reason.
// NET_DVR_FindFile_V30's dwFileType=0xff searches every type in one call;
// each result's own byFileType is classified afterward rather than issuing
// one search per type (unlike Uniview/Dahua, which need separate searches
// since their SDKs don't return a reliable per-file type on a broad
// search).
class FindRecordingsWorker : public Napi::AsyncWorker {
 public:
  FindRecordingsWorker(Napi::Env env, long lUserID, int channel, int64_t beginMs, int64_t endMs, DWORD typeMask)
      : Napi::AsyncWorker(env),
        lUserID_(lUserID),
        channel_(channel),
        beginMs_(beginMs),
        endMs_(endMs),
        typeMask_(typeMask),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(lUserID_));

    NET_DVR_FILECOND cond = {};
    cond.lChannel = channel_;
    cond.dwFileType = 0xff;
    cond.dwIsLocked = 0xff;
    cond.dwUseCardNo = 0;
    cond.struStartTime = EpochMsToNetDvrTime(beginMs_);
    cond.struStopTime = EpochMsToNetDvrTime(endMs_);

    const LONG hFind = NET_DVR_FindFile_V30(lUserID_, &cond);
    if (hFind < 0) {
      const DWORD err = NET_DVR_GetLastError();
      SetError("NET_DVR_FindFile_V30 failed (NET_DVR error " + std::to_string(err) + ")");
      return;
    }

    NET_DVR_FINDDATA_V30 fileData = {};
    for (;;) {
      const LONG ret = NET_DVR_FindNextFile_V30(hFind, &fileData);
      if (ret == NET_DVR_FILE_SUCCESS) {
        const std::string type = ClassifyFileType(fileData.byFileType);
        const DWORD bit = (type == "continuous")  ? 1
                           : (type == "motion")    ? 2
                           : (type == "smart")     ? 4
                                                    : 8;
        if (typeMask_ == 0 || (typeMask_ & bit)) {
          segments_.push_back({NetDvrTimeToEpochMs(fileData.struStartTime), NetDvrTimeToEpochMs(fileData.struStopTime),
                                type});
        }
      } else if (ret == NET_DVR_FILE_NOFIND || ret == NET_DVR_NOMOREFILE) {
        break;
      } else if (ret == NET_DVR_ISFINDING) {
        continue;
      } else {
        SetError("NET_DVR_FindNextFile_V30 failed (result " + std::to_string(ret) + ")");
        NET_DVR_FindClose_V30(hFind);
        return;
      }
    }
    NET_DVR_FindClose_V30(hFind);
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

  long lUserID_;
  int channel_;
  int64_t beginMs_;
  int64_t endMs_;
  DWORD typeMask_;
  Napi::Promise::Deferred deferred_;
  std::vector<Segment> segments_;
};

DWORD FiltersToTypeMask(const std::vector<std::string>& filters) {
  DWORD mask = 0;
  for (const auto& f : filters) {
    if (f == "all") return 0;
    if (f == "continuous") mask |= 1;
    if (f == "motion") mask |= 2;
    if (f == "smart") mask |= 4;
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

  const long lUserID = std::stol(sessionId);
  auto* worker = new FindRecordingsWorker(env, lUserID, channel, beginMs, endMs, FiltersToTypeMask(filters));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class StartPlaybackWorker : public Napi::AsyncWorker {
 public:
  StartPlaybackWorker(Napi::Env env, long lUserID, int channel, int64_t beginMs, int64_t endMs,
                       Napi::ThreadSafeFunction tsfn, bool paceToRealtime)
      : Napi::AsyncWorker(env), channel_(channel), beginMs_(beginMs), endMs_(endMs),
        deferred_(Napi::Promise::Deferred::New(env)) {
    session_ = new LiveViewSession();
    session_->lUserID = lUserID;
    session_->tsfn = std::move(tsfn);
    session_->isPlayback = true;
    session_->beginMs = beginMs;
    session_->endMs = endMs;
    session_->paceToRealtime = paceToRealtime;
  }

  void Execute() override {
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session_->lUserID));

    LONG nPort = -1;
    if (!PlayM4_GetPort(&nPort)) {
      session_->tsfn.Release();
      delete session_;
      session_ = nullptr;
      SetError("PlayM4_GetPort failed");
      return;
    }
    session_->nPort = nPort;

    NET_DVR_TIME begin = EpochMsToNetDvrTime(beginMs_);
    NET_DVR_TIME end = EpochMsToNetDvrTime(endMs_);

    // Same "no native window, decode via PlayM4 instead" approach as live
    // view (see StartLiveViewWorker) - Hikvision's SDK, unlike Dahua's,
    // doesn't require a real window handle for the decode callback to fire.
    const LONG lPlayHandle = NET_DVR_PlayBackByTime(session_->lUserID, channel_, &begin, &end, nullptr);
    if (lPlayHandle < 0) {
      const DWORD err = NET_DVR_GetLastError();
      session_->tsfn.Release();
      PlayM4_FreePort(nPort);
      delete session_;
      session_ = nullptr;
      SetError("NET_DVR_PlayBackByTime failed (NET_DVR error " + std::to_string(err) + ")");
      return;
    }
    session_->lRealHandle = lPlayHandle;
    lPlayHandle_ = lPlayHandle;

    // NET_DVR_SetPlayDataCallBack_V40 has an identical signature to
    // NET_DVR_RealPlay_V40's own raw-data callback - OnRawData (already
    // written for live view) is reused completely unchanged, it only ever
    // reads pUser (the session pointer), never lPlayHandle/lRealHandle.
    if (!NET_DVR_SetPlayDataCallBack_V40(lPlayHandle, OnRawData, session_)) {
      const DWORD err = NET_DVR_GetLastError();
      NET_DVR_StopPlayBack(lPlayHandle);
      session_->tsfn.Release();
      PlayM4_FreePort(nPort);
      delete session_;
      session_ = nullptr;
      SetError("NET_DVR_SetPlayDataCallBack_V40 failed (NET_DVR error " + std::to_string(err) + ")");
      return;
    }

    // With hWnd=nullptr (no native display window), NET_DVR_PlayBackByTime
    // opens the handle but does not itself push data into the raw-data
    // callback - confirmed against real hardware (search/download worked,
    // but the callback never fired and the canvas stayed black until this
    // explicit start command was added). Must run after the callback is
    // registered, otherwise the first frames race the registration.
    DWORD startOutValue = 0;
    if (!NET_DVR_PlayBackControl(lPlayHandle, NET_DVR_PLAYSTART, 0, &startOutValue)) {
      const DWORD err = NET_DVR_GetLastError();
      NET_DVR_StopPlayBack(lPlayHandle);
      session_->tsfn.Release();
      PlayM4_FreePort(nPort);
      delete session_;
      session_ = nullptr;
      SetError("NET_DVR_PlayBackControl(PLAYSTART) failed (NET_DVR error " + std::to_string(err) + ")");
      return;
    }

    std::lock_guard<std::mutex> lock(g_mutex);
    g_sessionsByPort[nPort] = session_;
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
  LONG lPlayHandle_ = -1;
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

  const long lUserID = std::stol(sessionId);
  // maxQueueSize=2 (was 0/unbounded) — see the matching comment on the
  // live-view StartLiveView's own tsfn creation above for why.
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "hikvision-playback-frame-callback", 2, 1);

  auto* worker = new StartPlaybackWorker(env, lUserID, channel, beginMs, endMs, std::move(tsfn), paceToRealtime);
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
  ControlPlaybackWorker(Napi::Env env, long lUserID, long lPlayHandle, std::string command, DWORD seekPercent,
                         int speedSteps)
      : Napi::AsyncWorker(env),
        lUserID_(lUserID),
        lPlayHandle_(lPlayHandle),
        command_(std::move(command)),
        seekPercent_(seekPercent),
        speedSteps_(speedSteps),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    // Every other native call for this device (Start/StopLiveView, Start/
    // StopPlayback, FindRecordings) acquires this same per-device lock -
    // this one was the exception, running fully unsynchronized against
    // whatever else touches this device's SDK session concurrently (most
    // notably the decode callback thread). Confirmed on TVT (the identical
    // gap there) as the cause of an app crash when changing playback speed
    // - applied here too before it gets a chance to surface the same way,
    // since setSpeed's multi-call loop below is the widest unsynchronized
    // window of any command handled here.
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(lUserID_));
    BOOL ok = FALSE;
    DWORD outValue = 0;
    if (command_ == "pause") {
      ok = NET_DVR_PlayBackControl(lPlayHandle_, NET_DVR_PLAYPAUSE, 0, &outValue);
    } else if (command_ == "resume") {
      ok = NET_DVR_PlayBackControl(lPlayHandle_, NET_DVR_PLAYRESTART, 0, &outValue);
    } else if (command_ == "seek") {
      ok = NET_DVR_PlayBackControl(lPlayHandle_, NET_DVR_PLAYSETPOS, seekPercent_, &outValue);
    } else if (command_ == "setSpeed") {
      // No documented explicit speed-multiplier parameter for PLAYFAST
      // (same situation as TVT's NET_SDK_PLAYCTRL_FF). speedSteps_ (1/2/4/8,
      // see SpeedMultiplierToSteps below) is the TARGET absolute step
      // count, not a delta. Confirmed live (via a temporary frame-arrival-
      // rate diagnostic, since removed) that this vendor's fast-forward
      // works by skipping ahead through keyframes rather than smoothly
      // accelerating decode - content visibly jumps forward a few seconds
      // at a time rather than looking like continuous fast motion (unlike
      // Dahua/Uniview's real speed-multiplier APIs). Resetting to NORMAL
      // then calling FAST that many times every call (the original
      // approach) made this jumpy behavior noticeably worse/less reliable,
      // the same shape of problem as TVT's NORMAL-then-immediately-FF
      // sequence, which there caused an outright crash inside the vendor
      // SDK. Applying the identical fix here: NORMAL still resets to 1x
      // when requested, but for an accelerated target,
      // g_speedStepsByHandle tracks what's already applied so only the
      // DELTA of additional FAST calls is made, without ever touching
      // NORMAL again until the next reset to 1x. Only needs to handle the
      // forward-only 1x->2x->4x->8x->1x cycle Playback.tsx actually drives;
      // delta<=0 can't happen from that UI, so it's treated as a no-op.
      if (speedSteps_ == 0) {
        ok = NET_DVR_PlayBackControl(lPlayHandle_, NET_DVR_PLAYNORMAL, 0, &outValue);
        if (ok) {
          std::lock_guard<std::mutex> lock(g_mutex);
          g_speedStepsByHandle[lPlayHandle_] = 0;
        }
      } else {
        int current = 0;
        {
          std::lock_guard<std::mutex> lock(g_mutex);
          auto it = g_speedStepsByHandle.find(lPlayHandle_);
          if (it != g_speedStepsByHandle.end()) current = it->second;
        }
        const int delta = (speedSteps_ > current) ? (speedSteps_ - current) : 0;
        ok = TRUE;
        for (int i = 0; ok && i < delta; ++i) {
          ok = NET_DVR_PlayBackControl(lPlayHandle_, NET_DVR_PLAYFAST, 0, &outValue);
        }
        if (ok) {
          std::lock_guard<std::mutex> lock(g_mutex);
          g_speedStepsByHandle[lPlayHandle_] = speedSteps_;
        }
      }
    } else if (command_ == "stepFrame") {
      ok = NET_DVR_PlayBackControl(lPlayHandle_, NET_DVR_PLAYFRAME, 0, &outValue);
    }
    if (!ok) {
      const DWORD err = NET_DVR_GetLastError();
      SetError("NET_DVR_PlayBackControl failed (NET_DVR error " + std::to_string(err) + ")");
    }
  }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  long lUserID_;
  long lPlayHandle_;
  std::string command_;
  DWORD seekPercent_;
  int speedSteps_;
  Napi::Promise::Deferred deferred_;
};

int SpeedMultiplierToSteps(int multiplier) {
  switch (multiplier) {
    case 2: return 1;
    case 4: return 2;
    case 8: return 3;
    default: return 0;
  }
}

Napi::Value ControlPlayback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const long lPlayHandle = std::stol(info[0].As<Napi::String>().Utf8Value());
  const std::string command = info[1].As<Napi::String>().Utf8Value();

  LiveViewSession* session = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_sessionsByHandle.find(lPlayHandle);
    if (it != g_sessionsByHandle.end()) session = it->second;
  }
  const long lUserID = session ? session->lUserID : -1;

  DWORD seekPercent = 0;
  if (command == "seek") {
    const int64_t seekMs = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
    if (session && session->endMs > session->beginMs) {
      double percent = static_cast<double>(seekMs - session->beginMs) /
                        static_cast<double>(session->endMs - session->beginMs) * 100.0;
      if (percent < 0) percent = 0;
      if (percent > 100) percent = 100;
      seekPercent = static_cast<DWORD>(percent);
    }
  }
  const int speedSteps = (command == "setSpeed") ? SpeedMultiplierToSteps(info[2].As<Napi::Number>().Int32Value()) : 0;

  auto* worker = new ControlPlaybackWorker(env, lUserID, lPlayHandle, command, seekPercent, speedSteps);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class GetPlaybackTimeWorker : public Napi::AsyncWorker {
 public:
  GetPlaybackTimeWorker(Napi::Env env, long lPlayHandle)
      : Napi::AsyncWorker(env), lPlayHandle_(lPlayHandle), deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    NET_DVR_TIME osdTime = {};
    if (NET_DVR_GetPlayBackOsdTime(lPlayHandle_, &osdTime)) {
      playTimeMs_ = NetDvrTimeToEpochMs(osdTime);
    }
  }

  void OnOK() override { deferred_.Resolve(Napi::Number::New(Env(), static_cast<double>(playTimeMs_))); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  long lPlayHandle_;
  int64_t playTimeMs_ = 0;
  Napi::Promise::Deferred deferred_;
};

Napi::Value GetPlaybackTime(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const long lPlayHandle = std::stol(info[0].As<Napi::String>().Utf8Value());
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
  const long lPlayHandle = std::stol(info[0].As<Napi::String>().Utf8Value());

  LiveViewSession* session = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_sessionsByHandle.find(lPlayHandle);
    if (it != g_sessionsByHandle.end()) {
      session = it->second;
      g_sessionsByHandle.erase(it);
      g_sessionsByPort.erase(session->nPort);
    }
    // g_speedStepsByHandle otherwise keeps an entry per view handle forever
    // - handles are never reused, so this would grow unbounded over a long
    // session with many channel switches, same class of leak fixed
    // recently on the renderer's own videoHealthByHandle map.
    g_speedStepsByHandle.erase(lPlayHandle);
  }

  auto* worker = new StopPlaybackWorker(env, session);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class StartBackupWorker : public Napi::AsyncWorker {
 public:
  StartBackupWorker(Napi::Env env, long lUserID, int channel, int64_t beginMs, int64_t endMs,
                     std::string saveFilePath)
      : Napi::AsyncWorker(env),
        lUserID_(lUserID),
        channel_(channel),
        beginMs_(beginMs),
        endMs_(endMs),
        saveFilePath_(std::move(saveFilePath)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(lUserID_));

    NET_DVR_TIME begin = EpochMsToNetDvrTime(beginMs_);
    NET_DVR_TIME end = EpochMsToNetDvrTime(endMs_);

    downloadHandle_ =
        NET_DVR_GetFileByTime(lUserID_, channel_, &begin, &end, const_cast<char*>(saveFilePath_.c_str()));
    if (downloadHandle_ < 0) {
      const DWORD err = NET_DVR_GetLastError();
      SetError("NET_DVR_GetFileByTime failed (NET_DVR error " + std::to_string(err) + ")");
    }
  }

  void OnOK() override { deferred_.Resolve(Napi::String::New(Env(), std::to_string(downloadHandle_))); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  long lUserID_;
  int channel_;
  int64_t beginMs_;
  int64_t endMs_;
  std::string saveFilePath_;
  LONG downloadHandle_ = -1;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StartBackup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const int64_t beginMs = static_cast<int64_t>(info[2].As<Napi::Number>().DoubleValue());
  const int64_t endMs = static_cast<int64_t>(info[3].As<Napi::Number>().DoubleValue());
  const std::string saveFilePath = info[4].As<Napi::String>().Utf8Value();

  const long lUserID = std::stol(sessionId);
  auto* worker = new StartBackupWorker(env, lUserID, channel, beginMs, endMs, saveFilePath);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

// NET_DVR_GetDownloadPos mirrors TVT's NET_SDK_GetDownloadPos exactly -
// returns 0-100 directly, no manual percentage computation needed (unlike
// Uniview/Dahua). A negative result is treated as "done" (the same
// failed-poll-means-finished convention used everywhere else in this
// engagement for a download handle).
class GetBackupProgressWorker : public Napi::AsyncWorker {
 public:
  GetBackupProgressWorker(Napi::Env env, long downloadHandle)
      : Napi::AsyncWorker(env), downloadHandle_(downloadHandle), deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override {
    const LONG pos = NET_DVR_GetDownloadPos(downloadHandle_);
    if (pos < 0 || pos > 100) {
      percent_ = 100;
    } else {
      percent_ = pos;
    }
  }

  void OnOK() override { deferred_.Resolve(Napi::Number::New(Env(), percent_)); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  long downloadHandle_;
  double percent_ = 0;
  Napi::Promise::Deferred deferred_;
};

Napi::Value GetBackupProgress(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const long downloadHandle = std::stol(info[0].As<Napi::String>().Utf8Value());
  auto* worker = new GetBackupProgressWorker(env, downloadHandle);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

class StopBackupWorker : public Napi::AsyncWorker {
 public:
  StopBackupWorker(Napi::Env env, long downloadHandle)
      : Napi::AsyncWorker(env), downloadHandle_(downloadHandle), deferred_(Napi::Promise::Deferred::New(env)) {}

  void Execute() override { NET_DVR_StopGetFile(downloadHandle_); }

  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }
  Napi::Promise GetPromise() { return deferred_.Promise(); }

 private:
  long downloadHandle_;
  Napi::Promise::Deferred deferred_;
};

Napi::Value StopBackup(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const long downloadHandle = std::stol(info[0].As<Napi::String>().Utf8Value());
  auto* worker = new StopBackupWorker(env, downloadHandle);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  NET_DVR_Init();
  NET_DVR_SetConnectTime(5000, 3);

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
  return exports;
}

NODE_API_MODULE(hikvision_native, Init)
