# Text voice (pt-BR)

**Voice settings → Text voice** enables a persistent alternative to hardware
microphone capture. The same switch and composer are available from the speech
bubble button in server calls, private calls and the detached desktop call window.
The UI calls the feature “Voz por texto”.

Choose Dora, Alex or Santa, type up to 400 characters, and press Enter or **Speak
in call**. Shift+Enter inserts a newline. **Listen privately** previews the voice
without publishing it. The three quick phrases insert Brazilian Portuguese text,
even when interface labels use another language. Drafts survive closing the panel
but are kept in memory only. Voice, speed and the mode preference persist.

In text mode the actual microphone is released. Pending capture results are
stopped and subsequent device-acquisition calls are blocked. Joining another call
also skips microphone pre-arming. Disabling text mode restores the normal input
pipeline. Mute, deafen, moderator restrictions, channel permissions and leaving the
call apply to synthetic speech; muting cancels pending synthesis and playback.

## Synthesis worker

The optional worker uses [Kokoro ONNX](https://github.com/thewh1teagle/kokoro-onnx)
0.6.1 with the int8 [Kokoro 82M](https://github.com/hexgrad/kokoro) model. It runs on
CPU with two inference threads by default and holds the model and all three pt-BR
voices in memory. No PyTorch, GPU, voice recording or commercial API is needed.
Pinned weights total approximately 115 MiB; the downloader verifies SHA-256.
Kokoro weights use Apache-2.0 and the ONNX wrapper uses MIT.

[Piper](https://github.com/OHF-Voice/piper1-gpl) was also evaluated as an alternative
(current release 1.8.0, September 2026). The local int8 Kokoro benchmark synthesized
a greeting in about 0.3 seconds and a longer sentence in 0.8 seconds with peak RSS
around 274 MiB for one voice. The resident worker reached approximately 340 MiB
after exercising all three voices. Kokoro provides the desired Brazilian voice
choices without the full PyTorch stack. These are measurements on the development PC, not a promise
for phone hardware.

From the repository root, with Python 3.10–3.13 and venv available:

```sh
sh services/tts/setup.sh
services/tts/.venv/bin/python services/tts/server.py
```

Configure the Backspace **server's** environment and restart it:

```env
TTS_URL=http://127.0.0.1:5052
```

The worker binds to loopback by default. For Termux, run it inside the existing
Debian environment, whose glibc/ARM64 Python wheels are supported by the inference
stack; native Android/bionic wheel availability is not assumed. The existing
Backspace and LiveKit configuration continues working when the optional worker is
absent. No new public port or Tailscale rule is needed: clients use the normal
authenticated Backspace API. Phone deployment has not been benchmarked here.

An optional independent container is also provided:

```sh
docker compose -f services/tts/compose.yaml up -d --build
```

That publishes `127.0.0.1:5052` on the host. A Backspace container must instead use
the worker's private service address on a shared Docker network; `127.0.0.1`
inside a container is that container itself. Keep the worker private; its HTTP
endpoint delegates authentication to Backspace's proxy. `TTS_HOST`, `TTS_PORT`,
`TTS_MODEL_DIR` and `TTS_THREADS` configure the worker if needed. The container
recipe is provided but the local validation used the Python environment directly.

## Audio and request lifecycle

`GET /api/tts` reports availability. `POST /api/tts/speech` authenticates the user,
validates text, fixed voice IDs and speed (0.8–1.3), and proxies only to configured
`TTS_URL`. It limits each user to one active request and 45 chunks/minute, with four
requests globally. Worker requests time out and returned audio is capped at 2 MB.
Responses are not cached, and neither service logs typed text.

The client splits text into clauses of at most 120 characters. It starts the next
request while playing the current clause, reducing time to first audio and gaps.
Audio enters the existing Web Audio microphone destination directly, bypassing
microphone gain, noise suppression and echo cancellation. LiveKit publishes it as
the user's normal microphone track, so other clients need no TTS support. Screen
audio and soundboards retain their existing paths. Local preview connects only to
the selected output device. Regular synthesis is not locally monitored, avoiding
a second copy of the speaker's voice.

The local integration probe used two isolated Electron renderer contexts and a
real LiveKit room. Remote decoded audio measured approximately 425 ms to the first
signal, with zero calls to `getUserMedia`. This timing covers synthesis, HTTP,
publication and reception on the local development network; other hosts and
connections may differ.

Stopping, muting, changing rooms or disabling text mode invalidates the job, aborts
pending HTTP requests and stops the active source. Stale downloads cannot play
afterward. Canceling a request does not necessarily interrupt inference already
running inside ONNX, but its result is discarded and the request is bounded.
