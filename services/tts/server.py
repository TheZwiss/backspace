"""Private, resident pt-BR synthesis worker. Expose only through Backspace's API."""
import io
import json
import math
import os
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import wave

import numpy as np
import onnxruntime as ort
from kokoro_onnx import Kokoro

VOICES = [
    {'id': 'pf_dora', 'name': 'Dora', 'language': 'pt-BR'},
    {'id': 'pm_alex', 'name': 'Alex', 'language': 'pt-BR'},
    {'id': 'pm_santa', 'name': 'Santa', 'language': 'pt-BR'},
]
MAX_TEXT = 400
lock = threading.Lock()
directory = Path(os.environ.get('TTS_MODEL_DIR', Path(__file__).parent / 'models'))
options = ort.SessionOptions()
options.intra_op_num_threads = max(1, int(os.environ.get('TTS_THREADS', '2')))
options.inter_op_num_threads = 1
model = Kokoro.from_session(ort.InferenceSession(
    str(directory / 'kokoro-v1.0.int8.onnx'), sess_options=options,
    providers=['CPUExecutionProvider'],
), str(directory / 'voices-v1.0.bin'))
# All voices warmed once, before accepting connections. No cold start per message.
for voice in VOICES:
    model.create('Olá.', voice=voice['id'], lang='pt-br')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Never log typed text or request bodies.

    def respond(self, code, body, content_type='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path != '/health':
            return self.respond(404, b'{}')
        self.respond(200, json.dumps({'engine': 'kokoro-int8', 'voices': VOICES}).encode())

    def do_POST(self):
        if self.path != '/synthesize':
            return self.respond(404, b'{}')
        self.connection.settimeout(10)
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 4096:
                return self.respond(400, b'{}')
            body = json.loads(self.rfile.read(size))
            text = body['text'].strip()
            voice = body.get('voice', 'pf_dora')
            speed = body.get('speed', 1)
            if (not text or len(text) > MAX_TEXT or voice not in [v['id'] for v in VOICES]
                    or isinstance(speed, bool) or not math.isfinite(float(speed)) or not 0.8 <= speed <= 1.3):
                return self.respond(400, b'{}')
        except (ValueError, TypeError, KeyError, AttributeError, TimeoutError):
            return self.respond(400, b'{}')
        if not lock.acquire(timeout=2):
            return self.respond(503, b'{}')
        try:
            samples, rate = model.create(text, voice=voice, speed=speed, lang='pt-br')
            if len(samples) > rate * 40:
                return self.respond(400, b'{}')
            output = io.BytesIO()
            with wave.open(output, 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(rate)
                wav.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())
            self.respond(200, output.getvalue(), 'audio/wav')
        except Exception:
            self.respond(503, b'{}')
        finally:
            lock.release()


if __name__ == '__main__':
    address = (os.environ.get('TTS_HOST', '127.0.0.1'), int(os.environ.get('TTS_PORT', '5052')))
    print(f'Kokoro pt-BR ready on {address[0]}:{address[1]}', flush=True)
    ThreadingHTTPServer(address, Handler).serve_forever()
