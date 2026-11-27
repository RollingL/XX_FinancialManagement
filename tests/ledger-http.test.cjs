const test = require('node:test'),
  assert = require('node:assert/strict'),
  { Readable } = require('node:stream');
const { ledgerMiddleware } = require('../spike/trial-ledger.cjs');
test('trial ledger API rejects foreign origin, wrong Host, missing header, and corrupt JSON', async () => {
  let calls = 0;
  const middleware = ledgerMiddleware(
    {
      command: async () => {
        calls++;
        return { expenses: [] };
      },
    },
    'http://127.0.0.1:5173',
  );
  async function request(headers = {}, body = '{"kind":"read"}') {
    const req = Readable.from([Buffer.from(body)]);
    Object.assign(req, {
      method: 'POST',
      url: '/api/ledger',
      headers: {
        host: '127.0.0.1:5173',
        origin: 'http://127.0.0.1:5173',
        'x-ledger-request': '1',
        'content-type': 'application/json',
        ...headers,
      },
    });
    const res = {
      writeHead(code) {
        this.status = code;
      },
      end(body) {
        this.body = body;
      },
    };
    await middleware(req, res, () => assert.fail('unexpected next'));
    return res.status;
  }
  assert.equal(await request({ origin: 'https://example.com' }), 403);
  assert.equal(await request({ host: 'other.invalid:5173' }), 403);
  assert.equal(await request({ 'x-ledger-request': undefined }), 403);
  assert.equal(await request({}, '{bad'), 500);
  assert.equal(calls, 0);
  assert.equal(await request(), 200);
  assert.equal(calls, 1);
});
