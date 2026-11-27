"""UTF-8 pipe contract only: subprocess OCR functions are stubs; no models or ledger IO."""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SPIKE = Path(__file__).resolve().parents[1] / 'spike'
sys.path.insert(0, str(SPIKE))
import ocr_probe


WORKER = r'''
import sys
sys.path.insert(0, sys.argv.pop(1))
import ocr_probe

calls = 0
def create_engine():
    global calls
    calls += 1
    return object(), {}
def recognize(engine, image_path):
    print('synthetic diagnostic: 合成中文', file=sys.stderr)
    return {'texts': ['合成中文', '￥12.34'], 'image_path': image_path, 'engine_calls': calls}
def run(image_path):
    print('synthetic diagnostic: 合成中文', file=sys.stderr)
    return {'status': 'passed', 'texts': ['合成中文'], 'image_path': image_path}

ocr_probe.create_engine = create_engine
ocr_probe.recognize = recognize
ocr_probe.run = run
try:
    ocr_probe.main()
finally:
    assert 'rapidocr' not in sys.modules
    assert 'onnxruntime' not in sys.modules
    assert 'PIL' not in sys.modules
'''


class StdioTests(unittest.TestCase):
    def worker(self, encoding, arguments, text=''):
        env = {**os.environ, 'PYTHONIOENCODING': encoding, 'PYTHONUTF8': '0', 'PYTHONDONTWRITEBYTECODE': '1'}
        return subprocess.run([sys.executable, '-B', '-c', WORKER, str(SPIKE), *arguments],
                              input=text.encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env=env, timeout=10, check=False)

    def test_serve_uses_utf8_for_chinese_paths_and_replies_under_legacy_pipe_encodings(self):
        paths = [r'C:\Users\合成用户\有 空格\截图.png', r'C:\临时目录\𠀀中文\第二张.jpg']
        requests = ''.join(json.dumps({'id': str(index), 'image_path': path}, ensure_ascii=False) + '\n'
                           for index, path in enumerate(paths))
        for encoding in ('ascii', 'gbk', 'cp1252'):
            with self.subTest(encoding=encoding):
                result = self.worker(encoding, ['--serve'], requests)
                self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
                replies = [json.loads(line) for line in result.stdout.decode('utf-8').splitlines()]
                self.assertEqual(len(replies), 2)
                for index, reply in enumerate(replies):
                    self.assertEqual(reply, {'id': str(index), 'ok': True,
                                             'result': {'texts': ['合成中文', '￥12.34'],
                                                        'image_path': paths[index], 'engine_calls': 1}})
                self.assertEqual(result.stderr.decode('utf-8').splitlines(), ['synthetic diagnostic: 合成中文'] * 2)

    def test_single_image_entry_also_writes_utf8_without_ocr_imports(self):
        path = r'C:\合成用户\有 空格\截图.png'
        for encoding in ('ascii', 'gbk'):
            with self.subTest(encoding=encoding):
                result = self.worker(encoding, [path])
                self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
                self.assertEqual(json.loads(result.stdout.decode('utf-8')),
                                 {'status': 'passed', 'texts': ['合成中文'], 'image_path': path})
                self.assertEqual(result.stderr.decode('utf-8').strip(), 'synthetic diagnostic: 合成中文')

    def test_configuration_accepts_absent_or_replaced_streams(self):
        output = io.StringIO()
        with patch.object(sys, 'stdin', None), patch.object(sys, 'stdout', output), patch.object(sys, 'stderr', None):
            ocr_probe.configure_stdio()
        self.assertEqual(output.getvalue(), '')

    def test_stderr_escapes_unencodable_diagnostics_without_losing_utf8(self):
        buffers = [io.BytesIO(), io.BytesIO(), io.BytesIO()]
        streams = [io.TextIOWrapper(buffer, encoding='ascii') for buffer in buffers]
        with patch.object(sys, 'stdin', streams[0]), patch.object(sys, 'stdout', streams[1]), patch.object(sys, 'stderr', streams[2]):
            ocr_probe.configure_stdio()
            self.assertEqual([stream.encoding for stream in streams], ['utf-8'] * 3)
            self.assertEqual([stream.errors for stream in streams], ['strict', 'strict', 'backslashreplace'])
            sys.stderr.write('合成\ud800')
            sys.stderr.flush()
        self.assertEqual(buffers[2].getvalue().decode('utf-8'), '合成\\ud800')
        for stream in streams:
            stream.detach()


if __name__ == '__main__':
    unittest.main()
