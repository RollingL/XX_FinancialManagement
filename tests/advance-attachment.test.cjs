// Screenshots attached to advances: checked, stored once, read back intact, and removed
// again when the save fails.
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
const { ledgerFixture, read } = require('./ledger-fixture.cjs');
const { MAX_IMAGE_BYTES } = require('../src/main/image-check.cjs');
const { pngHeaderOnly } = require('./synthetic-image.cjs');

// Generated 1 × 1 PNG; no payment screenshot, receipt text or user data.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOYVnECAAN+AdcpgjGUAAAAAElFTkSuQmCC',
  'base64',
);
const advance = (amount = 12345, extra = {}) => ({
  kind: 'advance',
  requestId: randomUUID(),
  advance: { amount, date: '2026-10-12', note: '合成到账附件' },
  image: { base64: png.toString('base64') },
  ...extra,
});
const fixture = (t) => ledgerFixture(t, 'qianlai-advance-attachment-');
async function snapshot(f) {
  return {
    state: await read(f),
    rows: f.rows(),
    attachments: f.rows().attachments,
    operations: f.operations(),
    files: f.files().map(([file, base64]) => ({ file, base64 })),
  };
}
const cash = (s) => ({
  advances: s.advances,
  advanceDetails: s.advanceDetails,
  expenses: s.expenses,
  flows: [
    ...s.advances.map((amount, index) => ({
      kind: 'advance',
      index,
      amount,
      ...s.advanceDetails?.[index],
    })),
    ...s.expenses.map((e) => ({ kind: 'expense', ...e, amount: -e.amount })),
  ],
  balance: s.advances.reduce((a, b) => a + b, 0) - s.expenses.reduce((a, e) => a + e.amount, 0),
});

test('advance attachment persists and reopens; idempotent retry creates no duplicate file', async (t) => {
  const f = fixture(t),
    input = advance(),
    state = await f.ledger.command(input),
    id = state.advanceDetails[0].attachmentId;
  assert.equal(typeof id, 'string');
  assert.deepEqual(state.advances, [12345]);
  assert.deepEqual(state.expenses, []);
  assert.deepEqual(state.batches, []);
  assert.deepEqual(await f.ledger.command({ kind: 'attachment', id }), {
    mime: 'image/png',
    base64: png.toString('base64'),
  });
  const saved = await snapshot(f);
  assert.equal(saved.attachments.length, 1);
  assert.equal(saved.operations.length, 1);
  assert.equal(saved.files.length, 1);
  assert.equal(saved.operations[0].created_at, state.advanceDetails[0].createdAt);
  f.reopen();
  assert.deepEqual(await read(f), state);
  assert.deepEqual(await f.ledger.command({ kind: 'attachment', id }), {
    mime: 'image/png',
    base64: png.toString('base64'),
  });
  assert.deepEqual(await f.ledger.command(input), state);
  assert.deepEqual(await snapshot(f), saved);
  await assert.rejects(
    f.ledger.command({ ...input, image: { base64: 'changed' } }),
    /重复请求内容不一致/,
  );
  assert.deepEqual(await snapshot(f), saved);
});

test('an attachment is optional', async (t) => {
  const f = fixture(t);
  await f.ledger.command(advance(300000));
  const state = await f.ledger.command(advance(2, { image: undefined }));
  assert.deepEqual(state.advances, [300000, 2]);
  assert.equal(typeof state.advanceDetails[0].attachmentId, 'string');
  assert.equal(state.advanceDetails[1].attachmentId, undefined);
  assert.equal(f.rows().advances[1].attachment_id, null);
  const saved = await snapshot(f);
  assert.equal(saved.attachments.length, 1);
  assert.equal(saved.files.length, 1);
  f.reopen();
  assert.deepEqual(await read(f), state);
});

test('an advance without any screenshot stores no file', async (t) => {
  const f = fixture(t);
  const state = await f.ledger.command(advance(2, { image: undefined }));
  assert.equal(state.advanceDetails[0].attachmentId, undefined);
  const saved = await snapshot(f);
  assert.deepEqual(saved.attachments, []);
  assert.deepEqual(saved.files, []);
  f.reopen();
  assert.deepEqual(await read(f), state);
});

test('advance image rejects invalid base64, unsupported signatures and byte overflow', async (t) => {
  const f = fixture(t),
    before = await snapshot(f);
  const tooLarge = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  png.copy(tooLarge);
  for (const base64 of [
    '',
    3,
    'not base64!',
    Buffer.from('<svg/>').toString('base64'),
    tooLarge.toString('base64'),
  ]) {
    await assert.rejects(f.ledger.command(advance(1, { image: { base64 } })));
    assert.deepEqual(await snapshot(f), before);
  }
});

test('damaged, truncated and over-sized images leave no ledger change or file; a valid retry saves', async (t) => {
  const f = fixture(t),
    before = await snapshot(f),
    input = advance();
  const damaged = Buffer.from(png);
  damaged[damaged.length - 20] ^= 1;
  for (const [bytes, message] of [
    [damaged, /损坏或不完整/],
    [png.subarray(0, png.length - 12), /损坏或不完整/],
    [pngHeaderOnly(5000, 4001), /2000 万像素/],
  ]) {
    await assert.rejects(
      f.ledger.command({ ...input, image: { base64: bytes.toString('base64') } }),
      message,
    );
    assert.deepEqual(await snapshot(f), before);
  }
  const state = await f.ledger.command(advance());
  assert.deepEqual(state.advances, [12345]);
  assert.equal((await snapshot(f)).files.length, 1);
});

test('invalid advance fields are rejected before any filesystem write', async (t) => {
  const f = fixture(t),
    before = await snapshot(f);
  for (const invalid of [
    null,
    {},
    { amount: 0, date: '2026-10-12' },
    { amount: 1, date: '2026-02-30' },
    { amount: 1, date: '2026-10-12', note: 'x'.repeat(501) },
  ]) {
    await assert.rejects(f.ledger.command(advance(1, { advance: invalid })));
    assert.deepEqual(await snapshot(f), before);
  }
});

test('failure after attachment and state writes rolls back all tables and removes the new file; same request can retry', async (t) => {
  const f = fixture(t),
    before = await snapshot(f),
    input = advance();
  f.sql(
    "CREATE TRIGGER fail_attachment_save BEFORE INSERT ON operations WHEN NEW.kind='advance' BEGIN SELECT RAISE(ABORT,'synthetic operation failure'); END",
  );
  await assert.rejects(f.ledger.command(input), /synthetic operation failure/);
  assert.deepEqual(await snapshot(f), before);
  f.reopen();
  assert.deepEqual(await snapshot(f), before);
  f.sql('DROP TRIGGER fail_attachment_save');
  const state = await f.ledger.command(input);
  assert.deepEqual(state.advances, [12345]);
  assert.equal((await snapshot(f)).attachments.length, 1);
  assert.equal((await snapshot(f)).files.length, 1);
});

test('transaction rechecks cumulative cents and cleans only the failed request file', async (t) => {
  const f = fixture(t);
  await f.ledger.command(advance(Number.MAX_SAFE_INTEGER));
  const before = await snapshot(f);
  await assert.rejects(f.ledger.command(advance(1)), /合计超出安全范围/);
  assert.deepEqual(await snapshot(f), before);
  f.reopen();
  assert.deepEqual(await snapshot(f), before);
});

test('integrity reads reject a modified screenshot without mutating ledger or metadata', async (t) => {
  const f = fixture(t),
    state = await f.ledger.command(advance()),
    id = state.advanceDetails[0].attachmentId,
    before = await snapshot(f),
    record = before.attachments[0];
  const altered = Buffer.from(png);
  altered[altered.length - 1] ^= 1;
  fs.writeFileSync(path.join(f.attachmentsDir, record.file), altered);
  await assert.rejects(f.ledger.command({ kind: 'attachment', id }), /附件损坏/);
  const after = await snapshot(f);
  assert.deepEqual(after.state, before.state);
  assert.deepEqual(after.attachments, before.attachments);
  assert.deepEqual(after.operations, before.operations);
});

test('expense and advance attachments coexist; reimbursement save and cancel preserve complete funds and attachments', async (t) => {
  const f = fixture(t);
  await f.ledger.command({
    kind: 'expense',
    requestId: randomUUID(),
    expense: {
      date: '2026-10-12',
      category: '接待',
      amount: 20000,
      merchant: '合成费用',
      note: '',
    },
    image: { base64: png.toString('base64') },
  });
  await f.ledger.command(advance(10000));
  const before = await snapshot(f);
  assert.equal(cash(before.state).balance, -10000);
  assert.equal(before.attachments.length, 2);
  const batch = await f.ledger.command({
    kind: 'batch',
    requestId: randomUUID(),
    date: '2026-10-12',
    allocations: [{ expenseId: 1, amount: 20000 }],
  });
  assert.deepEqual(cash(batch), cash(before.state));
  const cancelled = await f.ledger.command({ kind: 'cancel', requestId: randomUUID(), id: 1 });
  assert.deepEqual(cash(cancelled), cash(before.state));
  const after = await snapshot(f);
  assert.deepEqual(after.attachments, before.attachments);
  assert.deepEqual(after.files, before.files);
  for (const id of [cancelled.expenses[0].attachmentId, cancelled.advanceDetails[0].attachmentId])
    assert.deepEqual(await f.ledger.command({ kind: 'attachment', id }), {
      mime: 'image/png',
      base64: png.toString('base64'),
    });
});

test('the same request sent twice at once saves one record and one file', async (t) => {
  const f = fixture(t),
    input = advance();
  const [first, second] = await Promise.all([f.ledger.command(input), f.ledger.command(input)]);
  assert.deepEqual(second, first);
  assert.deepEqual(first.advances, [12345]);
  const saved = await snapshot(f);
  assert.equal(saved.files.length, 1);
  assert.equal(saved.attachments.length, 1);
  assert.equal(saved.operations.length, 1);
});
