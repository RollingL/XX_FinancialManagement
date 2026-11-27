"""Local CPU OCR dependency probe. Amount candidates only; no ledger writes."""
import hashlib
import json
from pathlib import Path
import socket
import sys
import time
from contextlib import redirect_stdout
from ocr_fields import extract_fields
from receipt_fields import expense_fields

# This probe rejects Python socket networking; Windows clean offline install remains a separate gate.
def deny_network(*args, **kwargs):
    raise RuntimeError("Network is disabled in this OCR probe")
socket.socket.connect = deny_network
socket.create_connection = deny_network
socket.getaddrinfo = deny_network


def configure_stdio():
    # Node sends UTF-8 JSON through pipes; Windows pipes otherwise use the ANSI code page.
    # Configure inside the program so this also applies to the frozen executable.
    for name in ('stdin', 'stdout', 'stderr'):
        stream = getattr(sys, name, None)
        if stream is not None and callable(getattr(stream, 'reconfigure', None)):
            stream.reconfigure(encoding='utf-8', errors='backslashreplace' if name == 'stderr' else 'strict')


def create_engine():
    from rapidocr import RapidOCR
    import onnxruntime
    onnxruntime.disable_telemetry_events()
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    models = base / "models"
    names = {"Det": "PP-OCRv6_det_small.onnx", "Cls": "ch_ppocr_mobile_v2.0_cls_mobile.onnx", "Rec": "PP-OCRv6_rec_small.onnx"}
    paths = {key: models / name for key, name in names.items()}
    for path in paths.values():
        if not path.is_file():
            raise FileNotFoundError(f"Required bundled model is missing: {path}")
    params = {f"{key}.model_path": str(path) for key, path in paths.items()}
    params.update({"Global.log_level": "error", "EngineConfig.onnxruntime.intra_op_num_threads": 2, "EngineConfig.onnxruntime.inter_op_num_threads": 1})
    return RapidOCR(params=params), paths


def validate_image(image_path):
    image_path = Path(image_path).resolve(strict=True)
    if image_path.suffix.lower() not in {".png", ".jpg", ".jpeg"} or image_path.stat().st_size > 20 * 1024 * 1024:
        raise ValueError("Probe accepts a local PNG/JPEG up to 20 MiB")
    from PIL import Image
    with Image.open(image_path) as image:
        if image.format not in {"PNG", "JPEG"}:
            raise ValueError("Only PNG/JPEG decoding is supported")
        if image.width * image.height > 20_000_000:
            raise ValueError("Probe image exceeds 20 megapixels")
        image.verify()
    return image_path


def recognize(engine, image_path):
    image_path = validate_image(image_path)
    started = time.perf_counter()
    result = engine(str(image_path))
    item = {"elapsed_ms": round((time.perf_counter() - started) * 1000), "texts": list(result.txts or []), "boxes": result.boxes.tolist() if result.boxes is not None else [], "scores": [float(x) for x in result.scores] if result.scores is not None else []}
    item["extraction"] = extract_fields(item["texts"], item["boxes"], item["scores"])
    item["expense_fields"] = expense_fields(item["texts"], item["boxes"], item["scores"], item["extraction"])
    return item


def run(image_path):
    import onnxruntime
    started = time.perf_counter()
    engine, paths = create_engine()
    init_ms = round((time.perf_counter() - started) * 1000)
    runs = []
    for _ in range(2):
        runs.append(recognize(engine, image_path))
    if not runs[0]["texts"]:
        raise AssertionError("OCR returned no text for probe fixture")
    if Path(image_path).name == 'ocr-sample.png':
        joined = ''.join(runs[0]['texts'])
        assert '1,280.50' in joined or '1280.50' in joined, joined
        assert '青禾' in joined, joined
    return {"status": "passed", "scope": "two inferences with conservative amount candidates; not real-screenshot or Windows acceptance", "network": "Python socket connect/DNS blocked; explicit model paths", "python": sys.version, "onnxruntime": onnxruntime.__version__, "model_sha256": {key: hashlib.sha256(path.read_bytes()).hexdigest() for key, path in paths.items()}, "dictionary": "recognition ONNX character metadata (embedded)", "init_ms": init_ms, "runs": runs}

def serve():
    # One sequential worker reuses local models; only the host supplies temporary image paths.
    engine = None
    for line in sys.stdin:
        request_id = None
        try:
            if len(line) > 8192:
                raise ValueError('Request too large')
            request = json.loads(line)
            request_id = request.get('id')
            if not isinstance(request_id, str) or len(request_id) > 64 or not isinstance(request.get('image_path'), str):
                raise ValueError('Invalid request')
            with redirect_stdout(sys.stderr):
                if request.get('validate_only') is True:
                    validate_image(request['image_path'])
                    result = {'validated': True}
                else:
                    if engine is None:
                        engine, _ = create_engine()
                    result = recognize(engine, request['image_path'])
            response = {'id': request_id, 'ok': True, 'result': result}
        except Exception:
            response = {'id': request_id, 'ok': False}
        print(json.dumps(response, ensure_ascii=False), flush=True)


def main():
    configure_stdio()
    if sys.argv[1:] == ['--serve']:
        serve()
    else:
        try:
            if len(sys.argv) != 2:
                raise ValueError('Usage: ocr_probe.py LOCAL_IMAGE | --serve')
            print(json.dumps(run(sys.argv[1]), ensure_ascii=False))
        except Exception as error:
            print(json.dumps({'status': 'failed', 'error': str(error)}, ensure_ascii=False))
            sys.exit(1)


if __name__ == '__main__':
    main()
