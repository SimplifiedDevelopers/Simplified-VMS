// N-API bridge over Uniview NetDEVSDK. Unlike Hikvision (raw stream data
// out, external PlayCtrl decode step), NETDEV_RealPlay_V30 takes a
// NETDEV_STREAM_DATA_CB_S with dwCBType=NETDEV_STREAM_CB_TYPE_DECODE and
// delivers already-decoded YV12 frames (NETDEV_PICTURE_DATA_S) straight to
// our callback — confirmed via the SDK's own documented
// NETDEV_DECODE_VIDEO_DATA_CALLBACK_PF typedef and doc comments, not
// reverse-engineered. No separate decode library needed.
#include <napi.h>
#include <windows.h>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "NetDEVSDK.h"

namespace {

struct LiveViewSession {
  Napi::ThreadSafeFunction tsfn;
  LPVOID lUserID = nullptr;
  LPVOID lpPlayHandle = nullptr;
};

std::mutex g_mutex;
std::unordered_map<LPVOID, LiveViewSession*> g_sessionsByHandle;

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

  auto* frame = new FrameData();
  frame->width = pstPictureData->dwPicWidth;
  frame->height = pstPictureData->dwPicHeight;
  frame->timestampMs = static_cast<long>(pstPictureData->tRenderTime);
  ConvertYV12ToRGBA(pstPictureData, frame->pixels);

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
  NETDEV_StopRealPlay(session->lpPlayHandle);
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
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::Array channels = Napi::Array::New(env);
    for (INT32 i = 0; i < chlCount_; ++i) {
      channels[static_cast<uint32_t>(i)] = Napi::Number::New(env, chlList_[i].dwChannelID);
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
    std::lock_guard<std::mutex> sdkLock(SdkMutexForSession(session_->lUserID));

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

    LPVOID lpPlayHandle = NETDEV_RealPlay_V30(session_->lUserID, &previewInfo, &streamCB);
    if (!lpPlayHandle) {
      const INT32 err = NETDEV_GetLastError();
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
  Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "uniview-frame-callback", 0, 1);

  auto* worker = new StartLiveViewWorker(env, lUserID, channel, streamType, std::move(tsfn));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

Napi::Value StopLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string viewHandle = info[0].As<Napi::String>().Utf8Value();
  LPVOID lpPlayHandle = IdToPointer(viewHandle);

  LiveViewSession* session = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_sessionsByHandle.find(lpPlayHandle);
    if (it != g_sessionsByHandle.end()) {
      session = it->second;
      g_sessionsByHandle.erase(it);
    }
  }
  if (session) DestroySession(session);

  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  NETDEV_Init();

  exports.Set("login", Napi::Function::New(env, Login));
  exports.Set("logout", Napi::Function::New(env, Logout));
  exports.Set("startLiveView", Napi::Function::New(env, StartLiveView));
  exports.Set("stopLiveView", Napi::Function::New(env, StopLiveView));
  return exports;
}

NODE_API_MODULE(uniview_native, Init)
