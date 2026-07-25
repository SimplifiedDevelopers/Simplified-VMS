// N-API bridge over Dahua's General NetSDK. Like Uniview (and unlike
// Hikvision), this SDK has a genuinely documented decoded-frame path:
// CLIENT_SetDecCallBack registers a single GLOBAL callback (not per
// play-handle) that receives NET_FRAME_DECODE_INFO — real YUV plane
// pointers + per-plane stride/width/height — for every active play/login,
// identified by lLoginID/lPlayHandle. No separate decode library needed.
#include <napi.h>
#include <windows.h>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "dhnetsdk.h"

namespace {

struct LiveViewSession {
  Napi::ThreadSafeFunction tsfn;
  LLONG lLoginID = 0;
  LLONG lRealHandle = 0;
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

  auto* frame = new FrameData();
  frame->width = pFrameDecodeInfo->nWidth[0];
  frame->height = pFrameDecodeInfo->nHeight[0];
  frame->timestampMs = pFrameInfo ? pFrameInfo->nStamp : 0;
  ConvertYUVToRGBA(pFrameDecodeInfo, frame->pixels);

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

void DestroySession(LiveViewSession* session) {
  CLIENT_StopRealPlay(session->lRealHandle);
  session->tsfn.Release();
  delete session;
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
  LoginWorker(Napi::Env env, std::string host, int port, std::string username, std::string password)
      : Napi::AsyncWorker(env),
        host_(std::move(host)),
        port_(port),
        username_(std::move(username)),
        password_(std::move(password)),
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
  }

  void OnOK() override {
    Napi::Env env = Env();
    // Dahua's device info only reports a total channel count, not per-channel
    // IDs or a start offset (unlike Hikvision/Uniview) - Dahua's documented
    // convention is 0-based channel indexing. Unverified against real
    // hardware yet; adjust here if a real device rejects channel 0.
    Napi::Array channels = Napi::Array::New(env);
    for (int i = 0; i < channelCount_; ++i) {
      channels[static_cast<uint32_t>(i)] = Napi::Number::New(env, i);
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("sessionId", std::to_string(lLoginID_));
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
  LLONG lLoginID_ = 0;
  int channelCount_ = 0;
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
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "dahua-frame-callback", 0, 1);

  auto* worker = new StartLiveViewWorker(env, lLoginID, channel, streamType, std::move(tsfn));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value StopLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string viewHandle = info[0].As<Napi::String>().Utf8Value();
  const LLONG lRealHandle = std::stoll(viewHandle);

  LiveViewSession* session = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_sessionsByHandle.find(lRealHandle);
    if (it != g_sessionsByHandle.end()) {
      session = it->second;
      g_sessionsByHandle.erase(it);
    }
  }
  if (session) DestroySession(session);

  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  CLIENT_Init(nullptr, 0);
  CLIENT_SetDecCallBack(OnDecodedFrame, 0);

  exports.Set("login", Napi::Function::New(env, Login));
  exports.Set("logout", Napi::Function::New(env, Logout));
  exports.Set("startLiveView", Napi::Function::New(env, StartLiveView));
  exports.Set("stopLiveView", Napi::Function::New(env, StopLiveView));
  return exports;
}

NODE_API_MODULE(dahua_native, Init)
