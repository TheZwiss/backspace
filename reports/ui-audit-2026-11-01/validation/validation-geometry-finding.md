# Finding: staged window geometry contaminates the live share

**Severity:** High — the existing published track can change source while a replacement is only being previewed.

## Evidence

The capture is recorded in [replacement-geometry-contamination.json](replacement-geometry-contamination.json).

- Before replacement, Alice's published video track `a3b9496d-08ae-4690-8798-bdb15037571d` is 822×540.
- While Bob's replacement preview is open, that same published track is 864×540 locally. Bob receives the same track ID at 864×540. A separate staged preview track is also present.
- The geometry snapshots during staging report window bounds `[1965, 120, 1282, 801]`, `foreground: false`, and process `electron.exe` (PID 33780).
- After Cancel, Alice's original track is again 822×540.

This shows the live publication changes during staging and returns after cancellation; the replacement has not been committed.

## Cause

The desktop main process owns one global `geometryWatcher` and one `geometryWatcherSource` in `packages/desktop/src/main.ts`. Starting a watch for a different source kills the previous process and starts another. The native event is broadcast as `window-geometry` without a source ID.

Each `openWindowCropTrack` subscribes to that global event and starts the native watch when the cropped track is created, including staged previews. `handleSnapshot` in `packages/web/src/utils/windowCropCapture.ts` applies every geometry event to its own `current` target; it does not verify which window produced the snapshot. The `setLive` flag changes drawing behavior but does not own or arbitrate the watcher.

As a result, a preview can replace the main process's watcher, and its untagged snapshots can update the live track's crop while both tracks are subscribed.

Relevant code: `main.ts` around `geometryWatcher`/`startWindowGeometryWatch` (approximately lines 650–720); `windowCropCapture.ts` around teardown and native watcher startup (approximately lines 300 and 590–615), plus `handleSnapshot` (approximately lines 550–570); and `screenShare.ts` replacement activation around lines 705–715.

## Proposed correction

Use the existing `setLive` transition as the native watcher lease boundary. A staged preview should use `getWindowCaptureTarget` polling; only the published crop track should subscribe to and start the native 10 Hz watcher. Track teardown should call `stopWindowGeometry` only when that track acquired the native lease. Keep preview polling separate so opening a replacement cannot displace the live track's native watcher.

During replacement, activate the new crop track only after `video.replaceTrack` succeeds. The current call marks it live before the awaited SDK swap, which can hand the watcher to the staged source while the previous publication is still active. The existing per-source reference count can continue to handle same-source handoff: acquire the new lease, then release the old one. This keeps the current IPC API and avoids a larger multi-watcher/source-tag protocol.

No product code was changed as part of documenting this finding.
