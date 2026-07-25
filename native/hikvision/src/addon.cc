// N-API bridge over Hikvision HCNetSDK (login + real-time preview) and the
// bundled PlayCtrl/PlayM4 decoder. HCNetSDK's REALDATACALLBACK hands us raw
// compressed stream data (NALUs); we feed that into a PlayM4 decode port and
// register PlayM4's own decoded-frame callback (PlayM4_SetDisplayCallBack)
// to get pixel data out instead of having it render into a native window —
// this is what makes painting into an HTML canvas possible at all.
#include <napi.h>
#include <windows.h>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
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
};

std::mutex g_mutex;
// PlayM4_SetDisplayCallBack has no pUser slot, so the decoded-frame callback
// can only identify its session via the decode port number it was given.
std::unordered_map<long, LiveViewSession*> g_sessionsByPort;
std::unordered_map<long, LiveViewSession*> g_sessionsByHandle;

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
        obj.Set("data", Napi::Buffer<uint8_t>::Copy(env, f->pixels.data(), f->pixels.size()));
        jsCallback.Call({obj});
        delete f;
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
  NET_DVR_StopRealPlay(session->lRealHandle);
  PlayM4_Stop(session->nPort);
  PlayM4_CloseStream(session->nPort);
  PlayM4_FreePort(session->nPort);
  session->tsfn.Release();
  delete session;
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
  LoginWorker(Napi::Env env, std::string host, int port, std::string username, std::string password)
      : Napi::AsyncWorker(env),
        host_(std::move(host)),
        port_(port),
        username_(std::move(username)),
        password_(std::move(password)),
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
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    const auto& dev = deviceInfo_.struDeviceV30;

    // Hybrid/NVR devices number analog and digital(IP) channels in two
    // separate ranges — confirmed against real hardware: a pure-IP
    // 16-channel NVR rejected channel 1 (NET_DVR_CHANNEL_ERROR) and only
    // accepted channels starting at byStartDChan (33 on that unit).
    // Building the explicit channel list here (rather than exposing
    // start/count and computing it downstream) keeps the shared
    // DeviceSession shape vendor-agnostic — Uniview's channel IDs aren't a
    // predictable contiguous range at all, so a per-vendor range formula
    // doesn't generalize.
    Napi::Array channels = Napi::Array::New(env);
    uint32_t idx = 0;
    for (int i = 0; i < dev.byChanNum; ++i) channels[idx++] = Napi::Number::New(env, dev.byStartChan + i);
    for (int i = 0; i < dev.byIPChanNum; ++i) channels[idx++] = Napi::Number::New(env, dev.byStartDChan + i);

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
  Napi::Promise::Deferred deferred_;
  LONG lUserID_ = -1;
  NET_DVR_DEVICEINFO_V40 deviceInfo_ = {};
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

  auto* worker = new LoginWorker(env, std::move(host), port, std::move(username), std::move(password));
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
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "hikvision-frame-callback", 0, 1);

  auto* worker = new StartLiveViewWorker(env, lUserID, channel, streamType, std::move(tsfn));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value StopLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string viewHandle = info[0].As<Napi::String>().Utf8Value();
  const long lRealHandle = std::stol(viewHandle);

  LiveViewSession* session = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_sessionsByHandle.find(lRealHandle);
    if (it != g_sessionsByHandle.end()) {
      session = it->second;
      g_sessionsByHandle.erase(it);
      g_sessionsByPort.erase(session->nPort);
    }
  }
  if (session) DestroySession(session);

  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  NET_DVR_Init();
  NET_DVR_SetConnectTime(5000, 3);

  exports.Set("login", Napi::Function::New(env, Login));
  exports.Set("logout", Napi::Function::New(env, Logout));
  exports.Set("startLiveView", Napi::Function::New(env, StartLiveView));
  exports.Set("stopLiveView", Napi::Function::New(env, StopLiveView));
  return exports;
}

NODE_API_MODULE(hikvision_native, Init)
