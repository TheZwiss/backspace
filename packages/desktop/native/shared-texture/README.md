# DXGI shared texture helper

Windows helper for the GPU capture path. It captures a selected output through
Desktop Duplication, copies into a bounded pool of three shared D3D11 BGRA
textures and duplicates their NT handles into the Electron main process. Desktop
pixels never cross stdout: only handles, timestamps and small cursor bitmaps do.

Build locally from the repository root:

```powershell
./packages/desktop/native/shared-texture/build.ps1
pnpm --filter @backspace/desktop build:ts
```

The local x64 build supports MinGW g++; Visual Studio/CMake supports x64 and
ARM64. Release CI builds and packages both Windows architectures. Linux and
macOS retain their existing capture paths.

Arguments: main-process PID, DXGI output index on the default hardware adapter,
initial FPS. Commands over stdin: `release <slot>`, `fps <1..120>`, `quit`.
Stdout contains newline-delimited JSON frames or a fatal error. Slots become
reusable only after Electron's `allReferencesReleased` callback.

The sandboxed preload composites onto an owned OffscreenCanvas before creating
the transferable VideoFrame. Never feed the imported frame directly to WebRTC:
Electron 43.7.5 crashed during cloned-frame readback in that configuration.
Only one transferred output frame awaits a writer acknowledgement at a time.
A two-second consumer timeout tears down the session.

The renderer keeps its published generator track when the helper fails and
switches to the existing DXGI/H.264 bridge. Initial failures (missing binary,
unsupported output rotation/format, access denied) use that bridge immediately.
Window sharing retains the existing geometry/crop/paused-card behavior. Audio
continues through the independent process-audio capture, including exclusion of
Backspace. Cursor Auto/Show/Hide follows the existing game detection rules;
the helper sends cursor pixels separately and the preload applies visibility.

This helper does not change the LiveKit server or force a hardware vendor's
encoder: Chromium/WebRTC still selects the final encoder available on the GPU.
HDR, rotated outputs and non-default adapter configurations must use fallback
when they cannot be represented by this BGRA path.
