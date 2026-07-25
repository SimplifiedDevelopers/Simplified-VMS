// N-API bridge over Dahua's General NetSDK. Like Uniview (and unlike
// Hikvision), this SDK has a genuinely documented decoded-frame path:
// CLIENT_SetDecCallBack registers a single GLOBAL callback (not per
// play-handle) that receives NET_FRAME_DECODE_INFO — real YUV plane
// pointers + per-plane stride/width/height — for every active play/login,
// identified by lLoginID/lPlayHandle. No separate decode library needed.
#include <napi.h>
#include <windows.h>
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

  NET_IN_LOGIN_WITH_HIGHLEVEL_SECURITY inParam = {};
  inParam.dwSize = sizeof(inParam);
  strncpy_s(inParam.szIP, host.c_str(), _TRUNCATE);
  inParam.nPort = port;
  strncpy_s(inParam.szUserName, username.c_str(), _TRUNCATE);
  strncpy_s(inParam.szPassword, password.c_str(), _TRUNCATE);
  inParam.emSpecCap = EM_LOGIN_SPEC_CAP_TCP;

  NET_OUT_LOGIN_WITH_HIGHLEVEL_SECURITY outParam = {};
  outParam.dwSize = sizeof(outParam);

  const LLONG lLoginID = CLIENT_LoginWithHighLevelSecurity(&inParam, &outParam);
  if (lLoginID == 0) {
    Napi::Error::New(env, "Dahua login failed (error " + std::to_string(outParam.nError) + ")")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Dahua's device info only reports a total channel count, not per-channel
  // IDs or a start offset (unlike Hikvision/Uniview) - Dahua's documented
  // convention is 0-based channel indexing. Unverified against real
  // hardware yet; adjust here if a real device rejects channel 0.
  const int channelCount = outParam.stuDeviceInfo.nChanNum;
  Napi::Array channels = Napi::Array::New(env);
  for (int i = 0; i < channelCount; ++i) {
    channels[static_cast<uint32_t>(i)] = Napi::Number::New(env, i);
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("sessionId", std::to_string(lLoginID));
  result.Set("channels", channels);
  return result;
}

Napi::Value Logout(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  CLIENT_Logout(std::stoll(sessionId));
  return env.Undefined();
}

Napi::Value StartLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const std::string streamType = info[2].As<Napi::String>().Utf8Value();
  Napi::Function onFrame = info[3].As<Napi::Function>();

  const LLONG lLoginID = std::stoll(sessionId);

  auto* session = new LiveViewSession();
  session->lLoginID = lLoginID;
  session->tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "dahua-frame-callback", 0, 1);

  const DH_RealPlayType rType = (streamType == "sub") ? DH_RType_Realplay_1 : DH_RType_Realplay_0;
  const LLONG lRealHandle = CLIENT_RealPlayEx(lLoginID, channel, nullptr, rType);
  if (lRealHandle == 0) {
    const DWORD err = CLIENT_GetLastError();
    session->tsfn.Release();
    delete session;
    Napi::Error::New(env, "CLIENT_RealPlayEx failed (error " + std::to_string(err) + ")").ThrowAsJavaScriptException();
    return env.Null();
  }
  session->lRealHandle = lRealHandle;

  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_sessionsByHandle[lRealHandle] = session;
  }

  return Napi::String::New(env, std::to_string(lRealHandle));
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
