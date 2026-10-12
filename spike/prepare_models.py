"""Copy and verify the three models already bundled in the pinned RapidOCR wheel."""
from importlib.util import find_spec
import hashlib
from pathlib import Path
import shutil

root = Path(__file__).parent
source = Path(find_spec('rapidocr').origin).parent / 'models'
expected = {
    'PP-OCRv6_det_small.onnx': '090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f',
    'ch_ppocr_mobile_v2.0_cls_mobile.onnx': 'e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c',
    'PP-OCRv6_rec_small.onnx': '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884',
}
(root / 'models').mkdir(exist_ok=True)
for name, digest in expected.items():
    data = (source / name).read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError(f'Model checksum mismatch: {name}')
    shutil.copy2(source / name, root / 'models' / name)
print('Verified and copied 3 bundled models. No runtime download is required.')
