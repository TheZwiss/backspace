// WASAPI process loopback. No injection, drivers, or modifications to other apps.
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <wrl.h>
#include <wrl/implements.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <cstdint>
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;
using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::FtmBase;
class Activation final : public RuntimeClass<RuntimeClassFlags<ClassicCom>, IActivateAudioInterfaceCompletionHandler, FtmBase> {
public:
    HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    HRESULT result = E_PENDING;
    ComPtr<IAudioClient> client;
    ~Activation() { CloseHandle(done); }
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
int wmain(int argc, wchar_t** argv) {
    if (argc != 3) return 2;
    const bool include = wcscmp(argv[1], L"window") == 0;
    DWORD pid = 0;
    if (include) {
        auto hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(_wcstoui64(argv[2], nullptr, 10)));
        if (!IsWindow(hwnd) || !GetWindowThreadProcessId(hwnd, &pid)) return 3;
    } else if (wcscmp(argv[1], L"exclude") == 0) pid = wcstoul(argv[2], nullptr, 10);
    else return 2;
    if (!pid) return 3;
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) return 4;
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = include ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT variant{};
    variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(params);
    variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    auto completion = Microsoft::WRL::Make<Activation>();
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &variant, completion.Get(), &operation);
    if (FAILED(hr) || WaitForSingleObject(completion->done, 10000) != WAIT_OBJECT_0 || FAILED(completion->result)) return 5;
    auto client = completion->client;
    WAVEFORMATEX format{};
    format.wFormatTag = WAVE_FORMAT_PCM; format.nChannels = 2; format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 16; format.nBlockAlign = 4; format.nAvgBytesPerSec = 192000;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, 200000, 0, &format, nullptr);
    if (FAILED(hr)) return 6;
    ComPtr<IAudioCaptureClient> capture;
    if (FAILED(client->GetService(IID_PPV_ARGS(&capture))) || FAILED(client->Start())) return 7;
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
