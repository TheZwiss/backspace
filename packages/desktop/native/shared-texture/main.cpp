#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;
using Clock = std::chrono::steady_clock;

static bool check(HRESULT result, const char* operation) {
  if (SUCCEEDED(result)) return true;
  std::printf("{\"error\":\"%s\",\"code\":%lu}\n", operation, static_cast<unsigned long>(result));
  std::fflush(stdout);
  return false;
}

static std::string base64(const std::vector<unsigned char>& bytes) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string result;
  for (size_t i = 0; i < bytes.size(); i += 3) {
    unsigned int value = bytes[i] << 16;
    if (i + 1 < bytes.size()) value |= bytes[i + 1] << 8;
    if (i + 2 < bytes.size()) value |= bytes[i + 2];
    result += alphabet[(value >> 18) & 63]; result += alphabet[(value >> 12) & 63];
    result += i + 1 < bytes.size() ? alphabet[(value >> 6) & 63] : '=';
    result += i + 2 < bytes.size() ? alphabet[value & 63] : '=';
  }
  return result;
}

// Only the small cursor bitmap visits CPU memory; desktop pixels stay on D3D11.
struct Cursor {
  HCURSOR handle = nullptr;
  int width = 0, height = 0, hotspotX = 0, hotspotY = 0;
  std::string pixels, invertPixels;
  bool update(HCURSOR next) {
    if (next == handle) return false;
    handle = next; pixels.clear(); invertPixels.clear(); width = height = 0;
    ICONINFO icon{};
    if (!GetIconInfo(next, &icon)) return true;
    BITMAP bitmap{};
    GetObject(icon.hbmColor ? icon.hbmColor : icon.hbmMask, sizeof(bitmap), &bitmap);
    width = bitmap.bmWidth; height = icon.hbmColor ? bitmap.bmHeight : bitmap.bmHeight / 2;
    hotspotX = icon.xHotspot; hotspotY = icon.yHotspot;
    if (icon.hbmColor) DeleteObject(icon.hbmColor);
    if (icon.hbmMask) DeleteObject(icon.hbmMask);
    if (width <= 0 || height <= 0 || width > 512 || height > 512) { width = height = 0; return true; }
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width; info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
    void* memory = nullptr;
    HDC dc = CreateCompatibleDC(nullptr);
    HBITMAP dib = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &memory, nullptr, 0);
    if (!dc || !dib || !memory) { if (dib) DeleteObject(dib); if (dc) DeleteDC(dc); width = height = 0; return true; }
    HGDIOBJ previous = SelectObject(dc, dib);
    const size_t length = static_cast<size_t>(width) * height * 4;
    std::memset(memory, 0, length); DrawIconEx(dc, 0, 0, next, width, height, 0, nullptr, DI_NORMAL);
    std::vector<unsigned char> black(static_cast<unsigned char*>(memory), static_cast<unsigned char*>(memory) + length);
    std::memset(memory, 255, length); DrawIconEx(dc, 0, 0, next, width, height, 0, nullptr, DI_NORMAL);
    auto* white = static_cast<unsigned char*>(memory);
    std::vector<unsigned char> rgba(length), invert(length, 0);
    for (size_t i = 0; i < length; i += 4) {
      const int alpha = 255 - std::max({std::abs(int(white[i]) - black[i]), std::abs(int(white[i+1]) - black[i+1]), std::abs(int(white[i+2]) - black[i+2])});
      rgba[i] = alpha ? std::min(255, int(black[i+2]) * 255 / alpha) : 0;
      rgba[i+1] = alpha ? std::min(255, int(black[i+1]) * 255 / alpha) : 0;
      rgba[i+2] = alpha ? std::min(255, int(black[i]) * 255 / alpha) : 0;
      rgba[i+3] = alpha;
      if (black[i] == 255 && black[i+1] == 255 && black[i+2] == 255
          && white[i] == 0 && white[i+1] == 0 && white[i+2] == 0) {
        invert[i] = invert[i+1] = invert[i+2] = invert[i+3] = 255;
      }
    }
    SelectObject(dc, previous); DeleteObject(dib); DeleteDC(dc);
    pixels = base64(rgba);
    invertPixels = base64(invert);
    return true;
  }
};

struct Slot {
  ComPtr<ID3D11Texture2D> texture;
  HANDLE local = nullptr, remote = nullptr;
  HANDLE target = nullptr;
  std::atomic<bool> free{true};
  ~Slot() {
    HANDLE reclaimed = nullptr;
    if (remote && DuplicateHandle(target, remote, GetCurrentProcess(), &reclaimed, 0, FALSE,
        DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE)) CloseHandle(reclaimed);
    if (local) CloseHandle(local);
  }
};

struct ProcessHandle {
  HANDLE value;
  ~ProcessHandle() { if (value) CloseHandle(value); }
};

int main(int argc, char** argv) {
  if (argc != 4) return 1;
  ProcessHandle process{OpenProcess(PROCESS_DUP_HANDLE, FALSE, std::strtoul(argv[1], nullptr, 10))};
  HANDLE target = process.value;
  if (!target) return 2;
  const unsigned int monitor = std::strtoul(argv[2], nullptr, 10);
  std::atomic<int> fps{std::clamp(std::atoi(argv[3]), 1, 120)};
  SetProcessDPIAware();
  ComPtr<ID3D11Device> device; ComPtr<ID3D11DeviceContext> context;
  if (!check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &context), "device")) return 3;
  ComPtr<IDXGIDevice> dxgi; ComPtr<IDXGIAdapter> adapter; ComPtr<IDXGIOutput> output; ComPtr<IDXGIOutput1> output1;
  if (!check(device.As(&dxgi), "dxgi") || !check(dxgi->GetAdapter(&adapter), "adapter")
      || !check(adapter->EnumOutputs(monitor, &output), "output") || !check(output.As(&output1), "output1")) return 4;
  DXGI_OUTPUT_DESC desktop{}; output->GetDesc(&desktop);
  ComPtr<IDXGIOutputDuplication> duplication;
  if (!check(output1->DuplicateOutput(device.Get(), &duplication), "duplicate")) return 5;
  DXGI_OUTDUPL_DESC captured{}; duplication->GetDesc(&captured);
  if (captured.Rotation != DXGI_MODE_ROTATION_IDENTITY && captured.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
    check(E_NOTIMPL, "rotated-output"); return 6;
  }
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = captured.ModeDesc.Width; desc.Height = captured.ModeDesc.Height;
  desc.MipLevels = desc.ArraySize = desc.SampleDesc.Count = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
  std::array<Slot, 3> slots;
  for (auto& slot : slots) {
    slot.target = target;
    ComPtr<IDXGIResource1> resource;
    if (!check(device->CreateTexture2D(&desc, nullptr, &slot.texture), "texture")
        || !check(slot.texture.As(&resource), "resource")
        || !check(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &slot.local), "handle")
        || !DuplicateHandle(GetCurrentProcess(), slot.local, target, &slot.remote, 0, FALSE, DUPLICATE_SAME_ACCESS)) return 7;
  }
  D3D11_QUERY_DESC queryDesc{D3D11_QUERY_EVENT, 0}; ComPtr<ID3D11Query> query;
  if (!check(device->CreateQuery(&queryDesc, &query), "query")) return 8;
  std::atomic<bool> stopped{false};
  std::thread commands([&] {
    char line[128];
    while (std::fgets(line, sizeof(line), stdin)) {
      int value = -1;
      if (std::sscanf(line, "release %d", &value) == 1 && value >= 0 && value < 3) slots[value].free.store(true);
      else if (std::sscanf(line, "fps %d", &value) == 1) fps.store(std::clamp(value, 1, 120));
      else if (std::strncmp(line, "quit", 4) == 0) break;
    }
    stopped.store(true);
  });
  Cursor cursor; bool pointerVisible = false;
  unsigned long long frames = 0, drops = 0;
  const auto started = Clock::now(); auto next = started;
  while (!stopped.load()) {
    const auto period = std::chrono::microseconds(1000000 / fps.load());
    next += period;
    if (next + period < Clock::now()) next = Clock::now();
    std::this_thread::sleep_until(next);
    int index = -1;
    for (int i = 0; i < 3; ++i) { bool free = true; if (slots[i].free.compare_exchange_strong(free, false)) { index = i; break; } }
    if (index < 0) { ++drops; continue; }
    auto& slot = slots[index];
    DXGI_OUTDUPL_FRAME_INFO info{}; ComPtr<IDXGIResource> resource;
    HRESULT result = duplication->AcquireNextFrame(20, &info, &resource);
    if (result == DXGI_ERROR_WAIT_TIMEOUT) { slot.free.store(true); continue; }
    if (!check(result, "acquire")) break;
    ComPtr<ID3D11Texture2D> frame;
    if (!check(resource.As(&frame), "frame")) { duplication->ReleaseFrame(); break; }
    D3D11_TEXTURE2D_DESC frameDesc{}; frame->GetDesc(&frameDesc);
    if (frameDesc.Width != desc.Width || frameDesc.Height != desc.Height || frameDesc.Format != desc.Format) {
      duplication->ReleaseFrame(); check(E_FAIL, "format-changed"); break;
    }
    context->CopyResource(slot.texture.Get(), frame.Get());
    context->End(query.Get()); context->Flush();
    const auto deadline = Clock::now() + std::chrono::seconds(2);
    while ((result = context->GetData(query.Get(), nullptr, 0, 0)) == S_FALSE && !stopped.load() && Clock::now() < deadline) Sleep(1);
    duplication->ReleaseFrame();
    if (result != S_OK) { check(FAILED(result) ? result : E_FAIL, "gpu-timeout"); break; }
    if (info.LastMouseUpdateTime.QuadPart) pointerVisible = info.PointerPosition.Visible;
    CURSORINFO pointer{sizeof(CURSORINFO)};
    const bool visible = GetCursorInfo(&pointer) && (pointer.flags & CURSOR_SHOWING) && pointerVisible;
    const bool shapeChanged = visible && cursor.update(pointer.hCursor);
    const auto timestamp = std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - started).count();
    std::printf("{\"slot\":%d,\"handle\":\"%llu\",\"width\":%u,\"height\":%u,\"timestamp\":%lld,\"sequence\":%llu,\"poolDrops\":%llu,\"cursor\":{\"visible\":%s,\"x\":%ld,\"y\":%ld",
      index, static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(slot.remote)), desc.Width, desc.Height,
      static_cast<long long>(timestamp), ++frames, drops, visible ? "true" : "false",
      pointer.ptScreenPos.x - desktop.DesktopCoordinates.left - cursor.hotspotX,
      pointer.ptScreenPos.y - desktop.DesktopCoordinates.top - cursor.hotspotY);
    if (shapeChanged) std::printf(",\"width\":%d,\"height\":%d,\"pixels\":\"%s\",\"invertPixels\":\"%s\"", cursor.width, cursor.height, cursor.pixels.c_str(), cursor.invertPixels.c_str());
    std::printf("}}\n"); std::fflush(stdout);
  }
  // The controller closes stdin on a fatal result, releasing the reader thread.
  if (commands.joinable()) commands.join();
  return 0;
}
