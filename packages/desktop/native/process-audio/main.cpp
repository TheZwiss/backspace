// WASAPI process loopback. No injection, drivers, or modifications to other apps.
#include <windows.h>
#include <audioclient.h>
#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#else
// ABI declarations from the Windows SDK audioclientactivationparams.h.
// MinGW does not yet ship this header; the OS still supplies the actual API.
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
enum PROCESS_LOOPBACK_MODE { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE };
struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { DWORD TargetProcessId; PROCESS_LOOPBACK_MODE ProcessLoopbackMode; };
enum AUDIOCLIENT_ACTIVATION_TYPE { AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK };
struct AUDIOCLIENT_ACTIVATION_PARAMS { AUDIOCLIENT_ACTIVATION_TYPE ActivationType; union { AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; }; };
static_assert(sizeof(AUDIOCLIENT_ACTIVATION_PARAMS) == 12, "Windows SDK activation ABI");
#endif
#include <mmdeviceapi.h>
#include <dwmapi.h>
#include <wrl/client.h>
#include <atomic>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <cstdint>
using Microsoft::WRL::ComPtr;
class Activation final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
    std::atomic<ULONG> references{1};
    ComPtr<IUnknown> marshaler;
public:
    HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    HRESULT result = E_PENDING;
    ComPtr<IAudioClient> client;
    Activation() { CoCreateFreeThreadedMarshaler(static_cast<IActivateAudioInterfaceCompletionHandler*>(this), &marshaler); }
    ~Activation() { if (done) CloseHandle(done); }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        if (iid == __uuidof(IAgileObject)) {
            *out = static_cast<IAgileObject*>(this);
            AddRef();
            return S_OK;
        }
        if (iid == __uuidof(IMarshal) && marshaler) return marshaler->QueryInterface(iid, out);
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references; }
    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG count = --references;
        if (!count) delete this;
        return count;
    }
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        ComPtr<IUnknown> unknown;
        HRESULT activationResult = E_FAIL;
        result = operation->GetActivateResult(&activationResult, &unknown);
        if (SUCCEEDED(result)) result = activationResult;
        if (SUCCEEDED(result)) result = unknown.As(&client);
        SetEvent(done);
        return S_OK;
    }
};
static int fail(const char* stage, HRESULT hr, int code) {
    std::fprintf(stderr, "ERROR stage=%s HRESULT=0x%08lx\n", stage, static_cast<unsigned long>(hr));
    std::fflush(stderr);
    return code;
}
// Coordinates are compared against what Chromium's display capture reports,
// and that is physical pixels. Without this the process is DPI-unaware and
// Windows silently scales every rectangle it hands out — the crop would be
// wrong on exactly the machines that use display scaling.
static void enablePerMonitorDpiAwareness() {
    using SetContextFn = BOOL (WINAPI*)(DPI_AWARENESS_CONTEXT);
    auto setContext = reinterpret_cast<SetContextFn>(
        GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext"));
    if (setContext) setContext(reinterpret_cast<DPI_AWARENESS_CONTEXT>(static_cast<INT_PTR>(-4)));
}

int wmain(int argc, wchar_t** argv) {
    enablePerMonitorDpiAwareness();
    if (argc == 2 && wcscmp(argv[1], L"--self-test") == 0) {
        HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        if (FAILED(hr)) return fail("self-test.CoInitializeEx", hr, 4);
        ComPtr<Activation> completion;
        completion.Attach(new Activation());
        ComPtr<IAgileObject> agile;
        ComPtr<IMarshal> marshaler;
        hr = completion.As(&agile);
        if (FAILED(hr)) return fail("self-test.IAgileObject", hr, 8);
        hr = completion.As(&marshaler);
        if (FAILED(hr)) return fail("self-test.IMarshal", hr, 8);
        std::fprintf(stderr, "SELF_TEST_OK IAgileObject IMarshal\n");
        return 0;
    }
    // Window geometry for the borderless window-capture path: the renderer
    // captures the display the window is on and crops to this rectangle, which
    // is the one way to share a single window on Windows 10 without the yellow
    // capture border (Windows Graphics Capture draws it; display capture does
    // not). Physical pixels, JSON on stdout, one line.
    if (argc == 3 && wcscmp(argv[1], L"geometry") == 0) {
        auto hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(_wcstoui64(argv[2], nullptr, 10)));
        if (!IsWindow(hwnd)) {
            std::fprintf(stderr, "ERROR stage=geometry reason=invalid-window\n");
            return 3;
        }
        RECT frame{};
        // The extended frame bounds are the visible window without the invisible
        // resize border, which is what a viewer expects to see.
        if (FAILED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &frame, sizeof(frame)))
            && !GetWindowRect(hwnd, &frame)) {
            return 3;
        }
        HMONITOR monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        MONITORINFO info{};
        info.cbSize = sizeof(info);
        if (!GetMonitorInfoW(monitor, &info)) return 3;
        // Whether the window is the one the user is working in. A window that is
        // not focused is where the share shows a paused card instead of the
        // pixels on top of it (the capture is of the display, see
        // windowCropCapture.ts).
        const bool foreground = GetForegroundWindow() == GetAncestor(hwnd, GA_ROOT);
        std::fprintf(stdout,
            "{\"window\":[%ld,%ld,%ld,%ld],\"monitor\":[%ld,%ld,%ld,%ld],\"minimized\":%s,\"foreground\":%s}\n",
            static_cast<long>(frame.left), static_cast<long>(frame.top),
            static_cast<long>(frame.right - frame.left), static_cast<long>(frame.bottom - frame.top),
            static_cast<long>(info.rcMonitor.left), static_cast<long>(info.rcMonitor.top),
            static_cast<long>(info.rcMonitor.right - info.rcMonitor.left),
            static_cast<long>(info.rcMonitor.bottom - info.rcMonitor.top),
            IsIconic(hwnd) ? "true" : "false",
            foreground ? "true" : "false");
        return 0;
    }
    if (argc != 3) return 2;
    // Record the actual build on failure; GetVersionEx can report a compatibility version.
    using RtlGetVersionFn = LONG (WINAPI*)(OSVERSIONINFOW*);
    auto rtlGetVersion = reinterpret_cast<RtlGetVersionFn>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
    OSVERSIONINFOW version{};
    version.dwOSVersionInfoSize = sizeof(version);
    if (rtlGetVersion && rtlGetVersion(&version) == 0) {
        std::fprintf(stderr, "INFO windows=%lu.%lu build=%lu\n", version.dwMajorVersion, version.dwMinorVersion, version.dwBuildNumber);
        std::fflush(stderr);
    }
    const bool include = wcscmp(argv[1], L"window") == 0;
    DWORD pid = 0;
    if (include) {
        auto hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(_wcstoui64(argv[2], nullptr, 10)));
        if (!IsWindow(hwnd) || !GetWindowThreadProcessId(hwnd, &pid)) return 3;
    } else if (wcscmp(argv[1], L"exclude") == 0) pid = wcstoul(argv[2], nullptr, 10);
    else return 2;
    if (!pid) return 3;
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) return fail("CoInitializeEx", hr, 4);
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = include ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT variant{};
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(params);
    variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    ComPtr<Activation> completion;
    completion.Attach(new Activation());
    if (!completion->done) return fail("CreateEvent", HRESULT_FROM_WIN32(GetLastError()), 5);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &variant, completion.Get(), &operation);
    if (FAILED(hr)) return fail("ActivateAudioInterfaceAsync", hr, 5);
    if (WaitForSingleObject(completion->done, 10000) != WAIT_OBJECT_0) return fail("activation-timeout", HRESULT_FROM_WIN32(ERROR_TIMEOUT), 5);
    if (FAILED(completion->result)) return fail("activation-result", completion->result, 5);
    auto client = completion->client;
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM; format.nChannels = 2; format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 16; format.nBlockAlign = 4; format.nAvgBytesPerSec = 192000;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 200000, 0, &format, nullptr);
    if (FAILED(hr)) return fail("IAudioClient.Initialize", hr, 6);
    ComPtr<IAudioCaptureClient> capture;
    hr = client->GetService(IID_PPV_ARGS(&capture));
    if (FAILED(hr)) return fail("GetService", hr, 7);
    hr = client->Start();
    if (FAILED(hr)) return fail("IAudioClient.Start", hr, 7);
    _setmode(_fileno(stdout), _O_BINARY);
    std::fprintf(stderr, "READY\n"); std::fflush(stderr);
    while (true) {
        UINT32 next = 0;
        if (FAILED(capture->GetNextPacketSize(&next))) break;
        if (!next) { Sleep(5); continue; }
        BYTE* bytes = nullptr; UINT32 frames = 0; DWORD flags = 0;
        if (FAILED(capture->GetBuffer(&bytes, &frames, &flags, nullptr, nullptr))) break;
        const size_t count = static_cast<size_t>(frames) * format.nBlockAlign;
        std::vector<BYTE> silence;
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) { silence.resize(count, 0); bytes = silence.data(); }
        const bool written = std::fwrite(bytes, 1, count, stdout) == count && std::fflush(stdout) == 0;
        capture->ReleaseBuffer(frames);
        if (!written) break;
    }
    client->Stop();
    return 0;
}
