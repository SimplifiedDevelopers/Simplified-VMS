// N-API bridge over Hikvision HCNetSDK (login + real-time preview) and the
// bundled PlayCtrl/PlayM4 decoder. HCNetSDK's REALDATACALLBACK hands us raw
// compressed stream data (NALUs); we feed that into a PlayM4 decode port and
// register PlayM4's own decoded-frame callback (PlayM4_SetDisplayCallBack)
// to get pixel data out instead of having it render into a native window —
// this is what makes painting into an HTML canvas possible at all.
#include <napi.h>
#include <windows.h>
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

  NET_DVR_USER_LOGIN_INFO loginInfo = {};
  strncpy_s(loginInfo.sDeviceAddress, host.c_str(), _TRUNCATE);
  loginInfo.wPort = static_cast<WORD>(port);
  strncpy_s(loginInfo.sUserName, username.c_str(), _TRUNCATE);
  strncpy_s(loginInfo.sPassword, password.c_str(), _TRUNCATE);
  loginInfo.bUseAsynLogin = FALSE;

  NET_DVR_DEVICEINFO_V40 deviceInfo = {};
  const LONG lUserID = NET_DVR_Login_V40(&loginInfo, &deviceInfo);
  if (lUserID < 0) {
    const DWORD err = NET_DVR_GetLastError();
    Napi::Error::New(env, "Hikvision login failed (NET_DVR error " + std::to_string(err) + ")")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  const int channelCount = deviceInfo.struDeviceV30.byChanNum + deviceInfo.struDeviceV30.byIPChanNum;

  Napi::Object result = Napi::Object::New(env);
  result.Set("sessionId", std::to_string(lUserID));
  result.Set("channelCount", channelCount);
  return result;
}

Napi::Value Logout(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  NET_DVR_Logout(std::stol(sessionId));
  return env.Undefined();
}

Napi::Value StartLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const std::string streamType = info[2].As<Napi::String>().Utf8Value();
  Napi::Function onFrame = info[3].As<Napi::Function>();

  const long lUserID = std::stol(sessionId);

  LONG nPort = -1;
  if (!PlayM4_GetPort(&nPort)) {
    Napi::Error::New(env, "PlayM4_GetPort failed").ThrowAsJavaScriptException();
    return env.Null();
  }

  auto* session = new LiveViewSession();
  session->lUserID = lUserID;
  session->nPort = nPort;
  session->tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "hikvision-frame-callback", 0, 1);

  NET_DVR_PREVIEWINFO previewInfo = {};
  previewInfo.lChannel = channel;
  previewInfo.dwStreamType = (streamType == "sub") ? 1 : 0;
  previewInfo.dwLinkMode = 0;  // TCP
  previewInfo.hPlayWnd = nullptr;
  previewInfo.bBlocked = 1;
  previewInfo.byProtoType = 0;
  previewInfo.dwDisplayBufNum = 1;

  const LONG lRealHandle = NET_DVR_RealPlay_V40(lUserID, &previewInfo, OnRawData, session);
  if (lRealHandle < 0) {
    const DWORD err = NET_DVR_GetLastError();
    session->tsfn.Release();
    PlayM4_FreePort(nPort);
    delete session;
    Napi::Error::New(env, "NET_DVR_RealPlay_V40 failed (NET_DVR error " + std::to_string(err) + ")")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  session->lRealHandle = lRealHandle;

  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_sessionsByPort[nPort] = session;
    g_sessionsByHandle[lRealHandle] = session;
  }

  return Napi::String::New(env, std::to_string(lRealHandle));
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
