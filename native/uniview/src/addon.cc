// N-API bridge over Uniview NetDEVSDK. Unlike Hikvision (raw stream data
// out, external PlayCtrl decode step), NETDEV_RealPlay_V30 takes a
// NETDEV_STREAM_DATA_CB_S with dwCBType=NETDEV_STREAM_CB_TYPE_DECODE and
// delivers already-decoded YV12 frames (NETDEV_PICTURE_DATA_S) straight to
// our callback — confirmed via the SDK's own documented
// NETDEV_DECODE_VIDEO_DATA_CALLBACK_PF typedef and doc comments, not
// reverse-engineered. No separate decode library needed.
#include <napi.h>
#include <windows.h>
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

Napi::Value Login(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "login(params) expects an object").ThrowAsJavaScriptException();
    return env.Null();
  }
  Napi::Object params = info[0].As<Napi::Object>();
  const std::string host = params.Get("host").As<Napi::String>().Utf8Value();
  const int port = params.Get("port").As<Napi::Number>().Int32Value();
  const std::string username = params.Get("username").As<Napi::String>().Utf8Value();
  const std::string password = params.Get("password").As<Napi::String>().Utf8Value();

  NETDEV_DEVICE_LOGIN_INFO_S loginInfo = {};
  strncpy_s(loginInfo.szIPAddr, host.c_str(), _TRUNCATE);
  loginInfo.dwPort = port;
  strncpy_s(loginInfo.szUserName, username.c_str(), _TRUNCATE);
  strncpy_s(loginInfo.szPassword, password.c_str(), _TRUNCATE);
  loginInfo.dwLoginProto = NETDEV_LOGIN_PROTO_PRIVATE;

  NETDEV_SELOG_INFO_S selogInfo = {};
  LPVOID lUserID = NETDEV_Login_V30(&loginInfo, &selogInfo);
  if (!lUserID) {
    const INT32 err = NETDEV_GetLastError();
    Napi::Error::New(env, "Uniview login failed (NETDEV error " + std::to_string(err) + ")")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  INT32 chlCount = 128;
  std::vector<NETDEV_VIDEO_CHL_DETAIL_INFO_EX_S> chlList(chlCount);
  BOOL ok = NETDEV_QueryVideoChlDetailListEx(lUserID, &chlCount, chlList.data());
  if (!ok && chlCount > static_cast<INT32>(chlList.size())) {
    chlList.assign(chlCount, {});
    ok = NETDEV_QueryVideoChlDetailListEx(lUserID, &chlCount, chlList.data());
  }

  Napi::Array channels = Napi::Array::New(env);
  if (ok) {
    for (INT32 i = 0; i < chlCount; ++i) {
      channels[static_cast<uint32_t>(i)] = Napi::Number::New(env, chlList[i].dwChannelID);
    }
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("sessionId", PointerToId(lUserID));
  result.Set("channels", channels);
  return result;
}

Napi::Value Logout(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  NETDEV_Logout(IdToPointer(sessionId));
  return env.Undefined();
}

Napi::Value StartLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const std::string streamType = info[2].As<Napi::String>().Utf8Value();
  Napi::Function onFrame = info[3].As<Napi::Function>();

  LPVOID lUserID = IdToPointer(sessionId);

  auto* session = new LiveViewSession();
  session->lUserID = lUserID;
  session->tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "uniview-frame-callback", 0, 1);

  NETDEV_PREVIEWINFO_S previewInfo = {};
  previewInfo.dwChannelID = channel;
  previewInfo.dwStreamType = (streamType == "sub") ? NETDEV_LIVE_STREAM_INDEX_AUX : NETDEV_LIVE_STREAM_INDEX_MAIN;
  previewInfo.dwLinkMode = NETDEV_TRANSPROTOCAL_RTPTCP;
  previewInfo.hPlayWnd = nullptr;

  NETDEV_STREAM_DATA_CB_S streamCB = {};
  streamCB.bDecode = TRUE;
  streamCB.dwCBType = NETDEV_STREAM_CB_TYPE_DECODE;
  streamCB.lpVideoDataCB = reinterpret_cast<LPVOID>(OnDecodedFrame);
  streamCB.lpAudioDataCB = nullptr;
  streamCB.lpUserData = nullptr;

  LPVOID lpPlayHandle = NETDEV_RealPlay_V30(lUserID, &previewInfo, &streamCB);
  if (!lpPlayHandle) {
    const INT32 err = NETDEV_GetLastError();
    session->tsfn.Release();
    delete session;
    Napi::Error::New(env, "NETDEV_RealPlay_V30 failed (NETDEV error " + std::to_string(err) + ")")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  session->lpPlayHandle = lpPlayHandle;

  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_sessionsByHandle[lpPlayHandle] = session;
  }

  return Napi::String::New(env, PointerToId(lpPlayHandle));
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
