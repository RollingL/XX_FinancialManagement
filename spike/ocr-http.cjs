const { MAX_BYTES } = require('./ocr-service.cjs');
function ocrMiddleware(service, origin) {
  return async (req, res, next) => {
    if (req.url !== '/api/ocr') {
      next();
      return;
    }
    const send = (status, value) => {
      if (!res.destroyed) {
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify(value));
      }
    };
    if (req.method !== 'POST') {
      send(405, { error: '只接受本机页面发起的识别请求' });
      return;
    }
    if (
      req.headers.host !== new URL(origin).host ||
      req.headers.origin !== origin ||
      req.headers['x-ocr-request'] !== '1' ||
      req.headers['content-type'] !== 'application/octet-stream'
    ) {
      send(403, { error: '只允许当前本机原型页面调用 OCR' });
      return;
    }
    if (Number(req.headers['content-length']) > MAX_BYTES) {
      send(413, { error: '图片不能超过 20 MiB' });
      return;
    }
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', cancel);
    req.once('aborted', cancel);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES)
          throw Object.assign(new Error('图片不能超过 20 MiB'), { status: 413 });
        chunks.push(chunk);
      }
      const result = await service.recognize(Buffer.concat(chunks), { signal: controller.signal });
      send(200, result);
    } catch (e) {
      send(e.status || 500, { error: e.status ? e.message : '本地识别失败，请重试或手动填写' });
    } finally {
      res.off('close', cancel);
      req.off('aborted', cancel);
    }
  };
}
module.exports = { ocrMiddleware };
