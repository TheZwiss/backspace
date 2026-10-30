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

## Verified on Windows 10 22H2 (build 19045), 2026-10-30

The reported `ActivateAudioInterfaceAsync: 0x8000000e` was fixed by the agile
completion handler described above; on this build it activates and captures.

Evidence, all on a real Windows 10 x64 machine with the helper built from this
source (MinGW-w64, statically linked):

- `--self-test` → `SELF_TEST_OK IAgileObject IMarshal`, exit 0.
- `exclude <pid>` while a 440 Hz WAV played in another process → `READY`, and
  572,160 bytes of PCM in 3 s (~191 kB/s, the expected 48 kHz stereo s16le).
  RMS 6354, peak 9119: the tone is in the capture, not silence.
- Through the app: `startSystemAudio` returned `{ ok: true, pcm: true }`, and
  `onProcessAudio` delivered 756,480 bytes in ~4 s.

The local build needs two flags the CI (MSVC) build does not: `-municode`
(entry point is `wmain`) and `-static -static-libgcc -static-libstdc++` (the
helper is shipped as a single file). `CMakeLists.txt` sets them for MinGW.

## Window geometry and borderless window capture

Windows Graphics Capture draws a yellow border around a captured **window** for
the whole session, and Windows 10 has no API to turn it off (`IsBorderRequired`
arrives with `IGraphicsCaptureSession3` on Windows 11). Display capture draws no
border. OBS shows the border with its WGC method and cannot see GPU-composited
windows (Chrome, Brave, Electron) with BitBlt.

Discord does not show the border, and its `discord_voice.node` explains why: the
capture stack ("wumpus", Rust) has `graphics_capture_window_source`,
`graphics_capture_display_source`, `dxgi_window_source`, `dxgi_display_source`
and `gdi_window_source`, plus `window_validation` and a `WindowOccluded` error.
Its window share is a display duplication cropped to the window rectangle
(`DwmGetWindowAttribute` for the frame bounds), not a window capture.

Backspace does the same: the helper's `geometry <hwnd>` mode prints the
window's physical rectangle and its monitor's rectangle as one JSON line, the
main process maps that monitor to a `desktopCapturer` screen source
(`get-window-capture-target`), the renderer captures that display and crops
each frame to the window on a canvas (`packages/web/src/utils/windowCropCapture.ts`),
and the canvas track is what gets published. Audio still comes from the window's
process tree, named separately in the preselection (`audioSourceId`).

Measured on the same machine, counting yellow pixels on a 1920×1080 screenshot
while a 900×620 Notepad was shared:

| Capture | Yellow pixels |
|---|---|
| Nothing captured | 203 |
| Window capture (WGC) | 694 |
| Display capture cropped to the window | 203 |

Limits, stated rather than hidden: a window on top of the shared one is inside
the crop (as it is in Discord's), the crop follows moves and resizes but a
window dragged to another display ends the track instead of showing the wrong
monitor, and a minimized window freezes the last frame.
