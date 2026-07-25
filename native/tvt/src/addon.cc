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
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "DVR_NET_SDK.h"

namespace {

struct LiveViewSession {
  Napi::ThreadSafeFunction tsfn;
  LONG lUserID = -1;
  POINTERHANDLE lLiveHandle = -1;
};

std::mutex g_mutex;
std::unordered_map<POINTERHANDLE, LiveViewSession*> g_sessionsByHandle;

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

  auto* frame = new FrameData();
  frame->width = frameInfo.nWidth;
  frame->height = frameInfo.nHeight;
  // frameInfo.time is Unix seconds (~1.79 billion currently) - casting to a
  // 32-bit long before multiplying by 1000 overflowed (confirmed live:
  // negative garbage timestamps), hence the explicit int64_t here.
  frame->timestampMs = static_cast<int64_t>(frameInfo.time) * 1000;
  ConvertI420ToRGBA(frameInfo, frame->pixels);

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
  (void)lLiveHandle;
}

void DestroySession(LiveViewSession* session) {
  NET_SDK_StopLivePlay(session->lLiveHandle);
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
  std::string host = params.Get("host").As<Napi::String>().Utf8Value();
  const int port = params.Get("port").As<Napi::Number>().Int32Value();
  std::string username = params.Get("username").As<Napi::String>().Utf8Value();
  std::string password = params.Get("password").As<Napi::String>().Utf8Value();

  NET_SDK_DEVICEINFO deviceInfo = {};
  const LONG lUserID = NET_SDK_Login(&host[0], static_cast<WORD>(port), &username[0], &password[0], &deviceInfo);
  if (lUserID < 0) {
    const DWORD err = NET_SDK_GetLastError();
    Napi::Error::New(env, "TVT login failed (error " + std::to_string(err) + ")").ThrowAsJavaScriptException();
    return env.Null();
  }

  // Channels are documented as 0-based (NET_SDK_CLIENTINFO.lChannel comment).
  const int channelCount = deviceInfo.videoInputNum;
  Napi::Array channels = Napi::Array::New(env);
  for (int i = 0; i < channelCount; ++i) {
    channels[static_cast<uint32_t>(i)] = Napi::Number::New(env, i);
  }

  Napi::Object result = Napi::Object::New(env);
  result.Set("sessionId", std::to_string(lUserID));
  result.Set("channels", channels);
  return result;
}

Napi::Value Logout(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  NET_SDK_Logout(std::stol(sessionId));
  return env.Undefined();
}

Napi::Value StartLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string sessionId = info[0].As<Napi::String>().Utf8Value();
  const int channel = info[1].As<Napi::Number>().Int32Value();
  const std::string streamType = info[2].As<Napi::String>().Utf8Value();
  Napi::Function onFrame = info[3].As<Napi::Function>();

  const LONG lUserID = std::stol(sessionId);

  auto* session = new LiveViewSession();
  session->lUserID = lUserID;
  session->tsfn = Napi::ThreadSafeFunction::New(env, onFrame, "tvt-frame-callback", 0, 1);

  NET_SDK_CLIENTINFO clientInfo = {};
  clientInfo.lChannel = channel;
  clientInfo.streamType = (streamType == "sub") ? NET_SDK_SUB_STREAM : NET_SDK_MAIN_STREAM;
  clientInfo.hPlayWnd = nullptr;
  clientInfo.bNoDecode = 0;  // 0 = decode - required for the YUV callback to receive real data.

  const POINTERHANDLE lLiveHandle = NET_SDK_LivePlay(lUserID, &clientInfo, nullptr, nullptr);
  if (lLiveHandle == -1) {
    const DWORD err = NET_SDK_GetLastError();
    session->tsfn.Release();
    delete session;
    Napi::Error::New(env, "NET_SDK_LivePlay failed (error " + std::to_string(err) + ")").ThrowAsJavaScriptException();
    return env.Null();
  }
  session->lLiveHandle = lLiveHandle;

  {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_sessionsByHandle[lLiveHandle] = session;
  }

  // pUser is passed straight through to OnYUVFrame - no separate lookup
  // table needed for frame dispatch (unlike Hikvision/Uniview's callbacks,
  // which lack a per-registration user pointer). Still keeping the handle
  // map above for StopLiveView's cleanup path.
  NET_SDK_SetYUVCallBack(lLiveHandle, OnYUVFrame, session);

  return Napi::String::New(env, std::to_string(lLiveHandle));
}

Napi::Value StopLiveView(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const std::string viewHandle = info[0].As<Napi::String>().Utf8Value();
  // POINTERHANDLE is `long long` (64-bit) - std::stol (32-bit long) was
  // silently truncating/misparsing real handle values here, which crashed
  // the process during cleanup (confirmed live: exit code 9 right after
  // stopLiveView, handles like 2818686989344 are far beyond 32-bit range).
  const POINTERHANDLE lLiveHandle = std::stoll(viewHandle);

  LiveViewSession* session = nullptr;
  {
    std::lock_guard<std::mutex> lock(g_mutex);
    auto it = g_sessionsByHandle.find(lLiveHandle);
    if (it != g_sessionsByHandle.end()) {
      session = it->second;
      g_sessionsByHandle.erase(it);
    }
  }
  if (session) DestroySession(session);

  return env.Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  NET_SDK_Init();

  exports.Set("login", Napi::Function::New(env, Login));
  exports.Set("logout", Napi::Function::New(env, Logout));
  exports.Set("startLiveView", Napi::Function::New(env, StartLiveView));
  exports.Set("stopLiveView", Napi::Function::New(env, StopLiveView));
  return exports;
}

NODE_API_MODULE(tvt_native, Init)
