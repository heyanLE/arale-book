#!/usr/bin/env python3
"""Validate the installed Linux runtime and model files before accepting OCR work."""
import argparse
import hashlib
import importlib.metadata
import json
import platform
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def verify(root=ROOT, probe=False):
    manifest = json.loads((root / 'model-manifest.json').read_text())
    for name, expected in manifest['files'].items():
        if Path(name).name != name:
            raise ValueError('Invalid model path')
        checksum = hashlib.sha256()
        with open(root / 'models' / name, 'rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                checksum.update(chunk)
        if checksum.hexdigest() != expected:
            raise ValueError(f'Model checksum mismatch: {name}')
    import onnxruntime as ort
    if 'CPUExecutionProvider' not in ort.get_available_providers():
        raise RuntimeError('ONNX Runtime CPUExecutionProvider unavailable')
    if probe:
        sys.path.insert(0, str(root / 'ocr'))
        from ocr_run import PageOcr
        engine = PageOcr()
        if engine.detector.get_providers() != ['CPUExecutionProvider']:
            raise RuntimeError('Unexpected OCR execution provider')
    return {'kind': 'runtime', 'ok': True, 'platform': platform.system(),
            'arch': platform.machine(), 'python': platform.python_version(),
            'provider': 'CPUExecutionProvider', 'models': len(manifest['files']),
            'versions': {name: importlib.metadata.version(name) for name in (
                'onnxruntime', 'numpy', 'opencv-python-headless', 'scipy',
                'pillow', 'pyclipper', 'shapely', 'jaconv')}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(verify(probe=args.probe)), flush=True)
    except Exception as error:
        print(json.dumps({'kind': 'runtime', 'ok': False, 'error': str(error)}), flush=True)
        sys.exit(1)
