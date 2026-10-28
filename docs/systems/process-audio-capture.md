# Process audio capture

Requested behavior: sharing a window captures its application's audio; sharing a
screen captures all application playback except Backspace. This applies to the
Electron client. Browser capture remains controlled by the browser picker.

## Research and compatibility

- Microsoft sample: https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/
  Documents process-tree include/exclude activation and an official build 20348 minimum.
- OBS implementation: https://github.com/bozbez/win-capture-audio
  Reports support on updated Windows 10 2004 and newer, despite the official minimum.
- OBS community forum: https://obsproject.com/forum/resources/win-capture-audio.1338/
  Also specifies updated Windows 10 2004+ support.
- Maintainer/community investigation: https://github.com/bozbez/win-capture-audio/issues/14
  Reports using the same activation API on Windows 10 2004 without DLL injection.
- Community failure report: https://github.com/bozbez/win-capture-audio/issues/30
  Reports gaps on Windows 10 build 19043; actual machine validation remains necessary.
- Linux implementation and settings: https://github.com/Vencord/Vesktop/blob/main/src/main/venmic.ts
- PipeWire routing library: https://github.com/Vencord/venmic
  Installed version 7.2.3 supports include/exclude property matches, mute,
  only_speakers and only_default_speakers. Its mute option defaults true.

These sources were inspected on 2026-10-28. No universal Windows 10 compatibility
claim follows from a README: runtime activation must succeed on the target machine.

## Implementation

Windows helper `packages/desktop/native/process-audio` uses WASAPI process-tree
loopback. The selected desktop-capture window handle is resolved with
GetWindowThreadProcessId. A window includes that process tree; a screen excludes
the Electron main process tree (including the audio-service process). The helper
outputs stereo 48 kHz signed 16-bit little-endian PCM. Main reassembles complete
frames, and a bounded AudioWorklet feeds a MediaStreamAudioDestinationNode for
LiveKit, without local audio playback. Closing/reloading/stopping releases the helper.
Activation failure is reported rather than silently sharing the unfiltered system mix.

The Windows release job compiles x64 and ARM64 helpers with the Windows SDK and
packages them as extraResources. Local Windows builds must compile the helper
with CMake into native/process-audio/bin/<arch>/ before packaging. The helper has
not been compiled or exercised on Windows in this Linux development environment.

Linux uses venmic include filters for a selected audio-process PID, or all original
Stream/Output/Audio application nodes for screen sharing. In both modes it excludes
Backspace PIDs/binary, virtual aggregate/DSP nodes, and input streams. It does not
require hardware/default-speaker links, so applications routed through virtual DSP
outputs remain eligible. The capture sink starts unmuted.

Wayland portals do not reliably expose the process belonging to the selected
window. The setup therefore exposes an explicit audio-application selector; this
is not automatic window-to-process mapping. With the system video picker, users
choose the audio application or all system playback except Backspace independently.
Applications appear while they have an audio stream. Multiple windows/tabs sharing
an audio process are captured together; tab-level isolation is not implemented.

## Verification limits

TypeScript and controller/worklet tests cover routing arguments, frame boundaries,
cleanup and PCM conversion. Linux routing is also probed using separate synthetic
440 Hz and 880 Hz playback processes in a temporary null sink, captured from the
virtual share source and removed afterward. This is routing evidence, not an
end-to-end remote LiveKit listening test. Windows 10/11 hardware/runtime testing,
native compilation, and end-to-end audio/video synchronization remain required.

Measured Linux probe (2026-10-28): application-only capture received the 440 Hz
source and rejected the excluded 880 Hz source by 74.2 dB. System-minus-excluded
capture rejected it by 70.1 dB. These are synthetic routing measurements, not
network performance or an end-to-end call measurement. Temporary test sink and
playback processes were removed by the probe cleanup.


### Windows test build: readiness protocol

The Windows CRT writes stderr in text mode, translating the helper's READY line
into CRLF. The original bridge accepted LF only and timed out even if native
capture had started. The reader now accepts both formats, including chunk splits.
A Windows CRT probe executed under Wine reproduced CRLF; this verifies the
protocol mismatch, not WASAPI capture on real Windows.

Native activation and initialization failures now emit a stage and HRESULT. The
main process records helper startup failures in
`%APPDATA%/Backspace/windows-process-audio.log`, without PCM or credentials.
The native COM completion handler also builds with LLVM-MinGW using the SDK ABI
fallback definitions when audioclientactivationparams.h is absent.


### Windows activation callback agility

The Windows 10 test returned `ActivateAudioInterfaceAsync: 0x8000000e`
(`E_ILLEGAL_METHOD_CALL`). Microsoft's API documentation identifies COM apartment
or callback agility as possible causes. The portable callback delegated IMarshal
but failed QueryInterface for IAgileObject; it now explicitly implements both.
`--self-test` checks both queries without starting capture and succeeds under Wine.
This is evidence of COM interface exposure, not proof of capture on Windows 10.
Native startup diagnostics include the real Windows build from RtlGetVersion.
Reference: https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-activateaudiointerfaceasync


### Modern OBS plugin comparison

Inspected Ayrton09/win-capture-audio at commit
40358fd6d6acba7890774a03396b48491a8c7147. Its helper uses the same process-loopback
activation parameters, with a refcounted WRL FtmBase completion handler and COM
initialization on the capture thread. This supports investigating callback agility
for the reported activation error; it does not prove the target OS supports capture.
The fork checks Windows build 19041 and newer, uses event-driven float/extensible
capture, and retries device failures. Those later stream-management differences do
not explain a failure returned directly by ActivateAudioInterfaceAsync.

References:
- https://github.com/Ayrton09/win-capture-audio/blob/40358fd6d6acba7890774a03396b48491a8c7147/src/audio-capture-helper.hpp
- https://github.com/Ayrton09/win-capture-audio/blob/40358fd6d6acba7890774a03396b48491a8c7147/src/audio-capture-helper.cpp
- https://github.com/Ayrton09/win-capture-audio/blob/40358fd6d6acba7890774a03396b48491a8c7147/src/plugin.cpp
