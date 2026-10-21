import hashlib
import importlib.util
import json
import tempfile
import io
import zipfile
from unittest.mock import patch
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('install_models', Path(__file__).with_name('install-models.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Models(unittest.TestCase):
    def test_only_locked_models_are_installed_and_tampering_fails(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source = root / 'source'
            source.mkdir()
            (source / 'model.onnx').write_bytes(b'locked model')
            (source / 'unlocked.bin').write_bytes(b'never installed')
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({'files': {'model.onnx': hashlib.sha256(b'locked model').hexdigest()}}))
            target = root / 'target'
            module.install(manifest, source, target, root / 'unused-release.json')
            self.assertEqual([p.name for p in target.iterdir()], ['model.onnx'])
            self.assertEqual((target / 'model.onnx').read_bytes(), b'locked model')
            (source / 'model.onnx').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                module.install(manifest, source, target, root / 'unused-release.json')
            self.assertEqual((target / 'model.onnx').read_bytes(), b'locked model')

    def test_missing_models_use_verified_archive_and_bad_archive_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            content = io.BytesIO()
            with zipfile.ZipFile(content, 'w') as archive:
                archive.writestr('package/models/model.onnx', b'locked model')
                archive.writestr('package/python/private-runtime', b'never copy platform runtime')
            payload = content.getvalue()
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({'files': {'model.onnx': hashlib.sha256(b'locked model').hexdigest()}}))
            asset = root / 'release.json'
            asset.write_text(json.dumps({'urls': ['https://example.invalid/pinned.zip'], 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest()}))
            class Response(io.BytesIO):
                def geturl(self):
                    return 'https://example.invalid/pinned.zip'
            with patch.object(module.urllib.request, 'urlopen', return_value=Response(payload)):
                module.install(manifest, root / 'missing', root / 'models', asset)
            self.assertEqual([p.name for p in (root / 'models').iterdir()], ['model.onnx'])
            asset.write_text(json.dumps({'urls': ['https://example.invalid/pinned.zip'], 'bytes': len(payload), 'sha256': '0' * 64}))
            with patch.object(module.urllib.request, 'urlopen', return_value=Response(payload)):
                with self.assertRaisesRegex(ValueError, 'archive checksum mismatch'):
                    module.install(manifest, root / 'missing', root / 'bad', asset)
            self.assertFalse((root / 'bad' / 'model.onnx').exists())

    def test_manifest_cannot_escape_the_models_directory(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps({'files': {'../outside.onnx': '0' * 64}}))
            with self.assertRaisesRegex(ValueError, 'Invalid model manifest'):
                module.install(manifest, root, root / 'out', root / 'unused')
            self.assertFalse((root / 'outside.onnx').exists())

if __name__ == '__main__':
    unittest.main()
