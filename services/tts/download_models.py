"""Download pinned public Kokoro weights; never overwrite an existing model."""
import hashlib
from pathlib import Path
import urllib.request

MODELS = {
    'kokoro-v1.0.int8.onnx': '6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb',
    'voices-v1.0.bin': 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d',
}
BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/'

if __name__ == '__main__':
    directory = Path(__file__).parent / 'models'
    directory.mkdir(exist_ok=True)
    for name, expected in MODELS.items():
        target = directory / name
        if not target.exists():
            print(f'Downloading {name}', flush=True)
            urllib.request.urlretrieve(BASE + name, target)
        if hashlib.file_digest(target.open('rb'), 'sha256').hexdigest() != expected:
            raise RuntimeError(f'Checksum mismatch: {target}. Preserved for inspection; refusing to load.')
        print(f'Verified {name}', flush=True)
