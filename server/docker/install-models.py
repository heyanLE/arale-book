#!/usr/bin/env python3
"""Install only locked, platform-neutral weights; never copy a desktop Python runtime."""
import argparse
import hashlib
import json
import os
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path


def digest(path):
    checksum = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
    return checksum.hexdigest()


def install(manifest, source, target, release):
    files = json.loads(Path(manifest).read_text())['files']
    if not files or any(Path(name).name != name or len(expected) != 64 for name, expected in files.items()):
        raise ValueError('Invalid model manifest')
    source, target = Path(source), Path(target)
    target.mkdir(parents=True, exist_ok=True)
    missing = [name for name in files if not (source / name).is_file()]
    for name, expected in files.items():
        if (source / name).is_file() and digest(source / name) != expected:
            raise ValueError(f'Local model checksum mismatch: {name}')
    with tempfile.TemporaryDirectory() as scratch:
        archive = None
        if missing:
            asset = json.loads(Path(release).read_text())
            url = asset['urls'][0]
            if not url.startswith('https://'):
                raise ValueError('Model source must use HTTPS')
            package = Path(scratch) / 'weights-source.zip'
            print('Downloading verified model source:', url, flush=True)
            with urllib.request.urlopen(url, timeout=60) as response, open(package, 'wb') as output:
                if not response.geturl().startswith('https://'):
                    raise ValueError('Insecure model download redirect')
                total = 0
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > asset['bytes']:
                        raise ValueError('Model source exceeds locked size')
                    output.write(chunk)
            if total != asset['bytes'] or digest(package) != asset['sha256']:
                raise ValueError('Model source archive checksum mismatch')
            archive = zipfile.ZipFile(package)
        try:
            for name, expected in files.items():
                output = target / (name + '.tmp')
                try:
                    if (source / name).is_file():
                        shutil.copyfile(source / name, output)
                    else:
                        matches = [entry for entry in archive.infolist()
                                   if entry.filename == 'models/' + name or entry.filename.endswith('/models/' + name)]
                        if len(matches) != 1 or matches[0].file_size > 512 * 1024 * 1024:
                            raise ValueError(f'Invalid archived model: {name}')
                        with archive.open(matches[0]) as src, open(output, 'wb') as dst:
                            shutil.copyfileobj(src, dst, length=1024 * 1024)
                    if digest(output) != expected:
                        raise ValueError(f'Model checksum mismatch: {name}')
                    os.chmod(output, 0o644)
                    os.replace(output, target / name)
                    print('Verified', name, expected, flush=True)
                finally:
                    output.unlink(missing_ok=True)
        finally:
            if archive:
                archive.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--release', required=True)
    args = parser.parse_args()
    install(args.manifest, args.source, args.target, args.release)
