# Capture and screen-share validation

Date: 2026-11-01

## Results

- Desktop cache and policy tests: `pnpm --filter @backspace/desktop test -- src/screenSourceCache.test.ts src/screenSharePolicy.test.ts` — 2 files, 19 tests passed.
- Desktop TypeScript build: `pnpm --filter @backspace/desktop build:ts` — passed.
- Web capture and screen-share tests: `pnpm --filter @backspace/web test -- src/utils/frameCadence.test.ts src/utils/captureQueue.test.ts src/utils/screenShareSources.test.ts src/utils/screenShare.test.ts src/utils/screenShare.systemAudio.test.ts src/utils/screenShare.stopPaths.test.ts src/utils/screenShare.liveAudio.test.ts src/utils/screenShare.hostLimits.test.ts src/utils/voiceActions.screenShare.test.ts src/components/voice/ScreenShareSetup.test.tsx` — 10 files, 95 tests passed.

## Environment notes

The commands emitted workspace engine warnings because the current Node version is 22.13.0 while two scripts request Node >=22.18. Vitest also emitted existing warnings about Vite native config loading and extensionless imports. Neither warning caused a test or build failure.

No broad desktop suite, CDP session, or client restart was run as part of this validation.
