# Local text voice (pt-BR)

Enable **Voice settings → Text voice**, or open the speech-bubble control in a
call. Choose automatic processing, CPU or GPU, then click **Prepare voice** once.
Choose Dora, Alex or Santa, enter up to 400 characters, and press Enter to speak.
Shift+Enter inserts a newline. Local preview does not broadcast. Drafts remain in
memory; voice, speed, processing preference and the mode preference persist.

Text-to-speech runs entirely on the speaker's client. There is no synthesis
service, Python requirement, `TTS_URL`, or `/api/tts` route in the Backspace server.
The old worker was removed from the checkout and stopped in the preview. Its
original implementation is recoverable from commit `69a97392`.

## Electron and browser runtimes

Electron owns an isolated, sandboxed, hidden engine window. The preload exposes
bounded synthesis operations, not arbitrary model paths, files, commands or IPC.
Only the primary app window may invoke the controller. Replies are accepted only
from the local engine renderer. A private, secure custom protocol serves an
explicit allowlist of model/runtime files. Node integration is disabled in that
renderer, and its content policy does not allow remote connections or unsafe JS
evaluation. The renderer's model is released after a minute without use, on
explicit release or when the app quits.

The browser uses the same inference core in a dedicated Web Worker. It requires
HTTPS (localhost is also secure), WebAssembly, Workers and Web Crypto. WebGPU
availability depends on browser and graphics drivers. Without it, automatic mode
uses CPU; explicitly selecting unavailable GPU reports that condition instead of
claiming to use a GPU. Browser CPU is typically slower because normal page
isolation limits this worker to one WASM thread.

Both use [Kokoro](https://github.com/hexgrad/kokoro),
[ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html), and
[Echogarden's eSpeak-NG port](https://github.com/echogarden-project/espeak-ng-emscripten)
for actual Portuguese phonemization. The small `phonemizer` npm distribution
contains English voices only and is deliberately not used for pt-BR.

CPU uses INT8 weights (about 95 MB including three voice vectors); GPU uses FP32
(about 330 MB). GPU uses WebGPU, allowing NVIDIA and AMD through the same code
path, rather than requiring CUDA. A few shape/control operators can still run on
CPU. Automatic mode falls back to CPU if GPU loading or later inference fails.
AMD hardware was not available for physical testing; its fallback path is covered
by automated tests. Driver/browser compatibility still requires real AMD testing.

Electron downloads fixed, SHA-256-verified public assets to its user-data
`text-voice` directory. Browser weights are downloaded directly from pinned Hugging
Face URLs and verified before being stored in Cache Storage. Neither weights nor
typed text go through the Backspace server. Initial downloads need Internet;
subsequent preparations reuse local models. Browser caches may be evicted by the
browser, in which case preparing downloads them again. Private browsing can deny
persistent caching while still allowing synthesis for the current session.

The web deployment serves only static runtime/phonemizer assets. They are optional,
not service-worker precache entries, so ordinary users do not automatically fetch
large inference resources. ONNX/eSpeak npm dependencies are build-time dependencies
and do not add a synthesis runtime to the production Node server. Model weights
are never embedded in the application bundle or in the server image.

## Call behavior

Text mode releases actual hardware capture, rejects queued acquisitions, stops
late permission results and skips microphone pre-arming on subsequent joins.
Synthetic samples enter the existing Web Audio microphone destination directly,
bypassing microphone gain, echo cancellation and noise suppression. LiveKit
publishes the user's normal microphone track, so listeners need no TTS support.
This works in server and private calls, including the detached Electron call UI.

Normal mute, deafen, moderator restrictions and leaving the call cancel speech.
Local preview uses only the selected output device. Text is not posted to chat or
kept as a server history. Only synthesized audio is relayed to call participants.
Screen-share audio and soundboards keep their independent existing paths.

Text is split into bounded clauses; the next clause is prepared while the current
one plays. Canceling discards pending results and stops active playback. Inference
already executing inside ONNX is not always interruptible, but results from an
obsolete job cannot play. Disabling the mode can release the engine itself.

## Measurements and checks

Measured on this development machine: Ryzen 5 5600X, RTX 4070 SUPER 12 GB,
NVIDIA 615.78.08, Electron 43.7.5 / ONNX Runtime Web 1.31.1.
Median of three warm generations, including pt-BR phonemization and WAV encoding;
model preparation/download and playback duration are excluded:

| Electron processing | “Oi, tudo bem?” | 56-character sentence |
| --- | ---: | ---: |
| CPU, INT8, two WASM threads | 730 ms | 1,863 ms |
| RTX via WebGPU, FP32 | 192 ms | 484 ms |

The browser worker, tested in an isolated Chromium context **without** the
Electron bridge, generated a 51-character phrase in about 2.8 s on CPU (one thread)
and 0.43–0.63 s on the RTX. These are different utterances and are not a controlled
same-graph CPU/GPU comparison. Phone performance has not been benchmarked.

Sampled aggregate Electron working sets reached roughly 1.06 GiB for CPU and
1.89 GiB after CPU→GPU testing. Those numbers include Electron processes and
shared pages; they are not exclusive model RAM. They must not be presented as
additional physical RAM or as a phone-server cost. Idle release frees the engine
renderer. The former approximately 340 MiB Python service no longer runs.

A real two-client LiveKit probe received synthesized speech about 665 ms after
submission using the Electron-local GPU path, with **zero** `getUserMedia` calls.
The same probe received a server-authorized soundboard event and observed its blue
actor indicator activate and clear after playback. This is local-network transport
and decoded-signal validation, not a Windows/AMD listening test.

Raw measurements: [text-voice-2026-10-28.json](../benchmarks/text-voice-2026-10-28.json).
Focused tests cover input validation, renderer trust, file allowlists, idle unload,
GPU fallback, cancellation, microphone release, private-call eligibility and local
preview isolation. The container-side Python configuration from the earlier design
is no longer needed.
