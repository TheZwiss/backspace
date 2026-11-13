# Dialog and stream validation

Date: 2026-11-01

## Focused tests

Command:

```powershell
pnpm exec vitest run src/components/ui/Modal.test.tsx src/components/ui/ImageCropModal.test.tsx src/components/chat/ImagePreview.test.tsx src/components/modals/UserProfileModal.test.tsx src/components/modals/UserProfileModal.roles.test.tsx src/components/voice/IncomingCallModal.test.tsx src/components/voice/StreamTile.test.tsx src/hooks/useLiveKit.streamRepublish.test.ts
```

Result: **8 test files passed, 73 tests passed.** This covers modal focus/stacking and restoration, crop modal behavior, image preview Escape, profile behavior, incoming-call accept/decline/Escape, stream tile continuity and watch toggling, and LiveKit republish tracking.

## Typecheck

Command:

```powershell
pnpm run typecheck
```

Result: **passed** (`tsc --noEmit`).

## Diagnostics

- Vitest printed existing Vite `configLoader: 'native'` extension warnings.
- StreamTile tests printed jsdom's unimplemented `HTMLMediaElement.play()` / `pause()` notices from the LiveKit attach path; the tests still passed.
- No CDP or Electron runtime checks were run in this validation.
