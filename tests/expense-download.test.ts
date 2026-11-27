import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadExpenseCsv } from '../prototype/src/expense-download.ts';

function fixture(t: any, fail = false) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const events: string[] = [],
    revoked: string[] = [],
    timers: { fn: () => void; delay: number }[] = [];
  let blob: Blob | undefined;
  const link = {
    href: '',
    download: '',
    click() {
      events.push('click');
      if (fail) throw Error('synthetic download failure');
    },
    remove() {
      events.push('remove');
    },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tag: string) => {
        assert.equal(tag, 'a');
        return link;
      },
      body: {
        append: (node: unknown) => {
          assert.equal(node, link);
          events.push('append');
        },
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else delete (globalThis as any).document;
  });
  t.mock.method(URL, 'createObjectURL', (value: Blob) => {
    blob = value;
    return 'blob:synthetic-local-only';
  });
  t.mock.method(URL, 'revokeObjectURL', (url: string) => revoked.push(url));
  t.mock.method(globalThis, 'setTimeout', (fn: () => void, delay: number) => {
    timers.push({ fn, delay });
    return 1;
  });
  return {
    link,
    events,
    revoked,
    timers,
    get blob() {
      return blob;
    },
  };
}
test('local CSV download preserves UTF-8 bytes, uses a fixed safe name and frees its blob after launch', async (t) => {
  const f = fixture(t),
    content = '\ufeff"商户","备注"\r\n"合成","一,二"\r\n';
  downloadExpenseCsv(content);
  assert.deepEqual(f.events, ['append', 'click', 'remove']);
  assert.match(f.link.download, /^钱来-费用明细-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.equal(f.link.href, 'blob:synthetic-local-only');
  assert.equal(f.blob?.type, 'text/csv;charset=utf-8');
  assert.deepEqual(Buffer.from(await f.blob!.arrayBuffer()), Buffer.from(content));
  assert.deepEqual(f.revoked, []);
  assert.equal(f.timers[0].delay, 60000);
  f.timers[0].fn();
  assert.deepEqual(f.revoked, ['blob:synthetic-local-only']);
});
test('failed launch reports failure and releases both anchor and local blob', (t) => {
  const f = fixture(t, true);
  assert.throws(() => downloadExpenseCsv('synthetic'), /未能发起 CSV 下载/);
  assert.deepEqual(f.events, ['append', 'click', 'remove']);
  assert.deepEqual(f.revoked, ['blob:synthetic-local-only']);
  assert.equal(f.timers.length, 0);
});
