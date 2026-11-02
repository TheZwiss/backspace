#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>

#include <cstdio>
#include <string>

using Microsoft::WRL::ComPtr;

static std::string Utf8(const wchar_t* value) {
  if (!value || !*value) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 1) return {};
  std::string result(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), size, nullptr, nullptr);
  result.resize(static_cast<size_t>(size - 1));
  return result;
}

int wmain() {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  D3D_FEATURE_LEVEL selected{};
  const D3D_FEATURE_LEVEL levels[] = {
    D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0,
    D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0,
  };
  HRESULT hr = D3D11CreateDevice(
    nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    levels, ARRAYSIZE(levels), D3D11_SDK_VERSION,
    &device, &selected, &context
  );
  if (hr == E_INVALIDARG) {
    hr = D3D11CreateDevice(
      nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      levels + 1, ARRAYSIZE(levels) - 1, D3D11_SDK_VERSION,
      &device, &selected, &context
    );
  }
  if (FAILED(hr)) return 2;

  ComPtr<IDXGIDevice> dxgiDevice;
  ComPtr<IDXGIAdapter> adapter;
  if (FAILED(device.As(&dxgiDevice)) || FAILED(dxgiDevice->GetAdapter(&adapter))) return 3;

  for (UINT index = 0;; ++index) {
    ComPtr<IDXGIOutput> output;
    hr = adapter->EnumOutputs(index, &output);
    if (hr == DXGI_ERROR_NOT_FOUND) break;
    if (FAILED(hr)) return 4;

    DXGI_OUTPUT_DESC desc{};
    if (FAILED(output->GetDesc(&desc)) || !desc.AttachedToDesktop) continue;
    const LONG width = desc.DesktopCoordinates.right - desc.DesktopCoordinates.left;
    const LONG height = desc.DesktopCoordinates.bottom - desc.DesktopCoordinates.top;
    const std::string name = Utf8(desc.DeviceName);
    std::printf("%u\t%s\t%ld\t%ld\t%ld\t%ld\n", index, name.c_str(),
      desc.DesktopCoordinates.left, desc.DesktopCoordinates.top, width, height);
  }
  return 0;
}
