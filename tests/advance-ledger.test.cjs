const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { createLedger } = require('../src/main/ledger.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xx-advance-test-'));
  let ledger = createLedger(root);
  t.after(() => {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    get ledger() {
      return ledger;
    },
    reopen() {
      ledger.close();
      ledger = createLedger(root);
    },
    db() {
      return new Database(path.join(root, 'trial.sqlite'));
    },
  };
}
const advance = (amount = 1, extra = {}) => ({
  kind: 'advance',
  requestId: randomUUID(),
  advance: { amount, date: '2026-10-12', ...extra },
});
const read = (f) => f.ledger.command({ kind: 'read' });
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
test('advance stores integer cents, optional note, separate dates and idempotent operation; persists on reopen', async (t) => {
  const f = fixture(t),
    input = advance(1);
  const state = await f.ledger.command(input);
  assert.deepEqual(state.advances, [1]);
  assert.equal(state.advanceDetails[0].date, '2026-10-12');
  assert.equal(state.advanceDetails[0].note, '');
  assert.ok(Number.isFinite(Date.parse(state.advanceDetails[0].createdAt)));
  assert.deepEqual(await f.ledger.command(input), state);
  await assert.rejects(
    f.ledger.command({ ...input, advance: { ...input.advance, amount: 2 } }),
    /重复请求内容不一致/,
  );
  f.reopen();
  assert.deepEqual(await read(f), state);
  assert.deepEqual(await f.ledger.command(input), state);
  const db = f.db();
  try {
    assert.deepEqual(db.prepare('SELECT kind,created_at FROM operations').all(), [
      { kind: 'advance', created_at: state.advanceDetails[0].createdAt },
    ]);
  } finally {
    db.close();
  }
});
test('advance backend rejects invalid cents, date and note without any state or operation', async (t) => {
  const f = fixture(t),
    before = await read(f);
  for (const value of [0, -1, 1.1, '1', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
    await assert.rejects(f.ledger.command(advance(value)));
  for (const extra of [
    { date: '2026-02-30' },
    { date: '' },
    { date: 7 },
    { note: 12 },
    { note: 'x'.repeat(501) },
  ])
    await assert.rejects(f.ledger.command(advance(1, extra)));
  assert.deepEqual(await read(f), before);
  const db = f.db();
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n, 0);
  } finally {
    db.close();
  }
});
test('advance cumulative limit accepts last safe cent and rejects overflow atomically', async (t) => {
  const f = fixture(t);
  await f.ledger.command(advance(Number.MAX_SAFE_INTEGER));
  const before = await read(f);
  await assert.rejects(f.ledger.command(advance(1)), /合计超出安全范围/);
  assert.deepEqual(await read(f), before);
});
test('legacy amount-only entries read without rewriting; append preserves all history without invented dates', async (t) => {
  const f = fixture(t),
    legacy = { expenses: [], batches: [], advances: [300000, 1], legacyMarker: 'synthetic' };
  const raw = JSON.stringify(legacy);
  let db = f.db();
  db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(raw);
  db.close();
  f.reopen();
  assert.deepEqual(await read(f), legacy);
  db = f.db();
  assert.equal(db.prepare('SELECT json FROM trial_state').get().json, raw);
  db.close();
  const state = await f.ledger.command(advance(20000, { note: ' 合成补充款 ' }));
  assert.deepEqual(state.advances, [300000, 1, 20000]);
  assert.equal(state.legacyMarker, 'synthetic');
  assert.equal(state.advanceDetails[0], undefined);
  assert.equal(state.advanceDetails[1], undefined);
  assert.equal(state.advanceDetails[2].note, '合成补充款');
  assert.equal(cash(state).balance, 320001);
  f.reopen();
  assert.deepEqual(await read(f), state);
});
test('failure after state update rolls back amount, metadata and operation; same request can retry', async (t) => {
  const f = fixture(t),
    before = await read(f),
    input = advance(10000);
  let db = f.db();
  db.exec(
    "CREATE TRIGGER fail_advance BEFORE INSERT ON operations WHEN NEW.kind='advance' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  db.close();
  await assert.rejects(f.ledger.command(input), /synthetic failure/);
  assert.deepEqual(await read(f), before);
  db = f.db();
  assert.equal(db.prepare('SELECT count(*) n FROM operations').get().n, 0);
  db.exec('DROP TRIGGER fail_advance');
  db.close();
  const after = await f.ledger.command(input);
  assert.deepEqual(after.advances, [10000]);
  assert.deepEqual(await f.ledger.command(input), after);
});
test('shared funds go negative then positive; reimbursement and cancellation preserve complete cash contents', async (t) => {
  const f = fixture(t);
  const { balance, remaining } = await import('../src/renderer/model.ts');
  await f.ledger.command(advance(300000));
  await f.ledger.command({
    kind: 'expense',
    requestId: randomUUID(),
    expense: {
      date: '2026-10-12',
      category: '接待',
      amount: 400000,
      merchant: '合成接待',
      note: '',
    },
  });
  await f.ledger.command({
    kind: 'expense',
    requestId: randomUUID(),
    expense: {
      date: '2026-10-12',
      category: '办公',
      amount: 100000,
      merchant: '合成办公',
      note: '',
    },
  });
  const before = await read(f);
  assert.equal(balance(before.expenses, before.advances), -200000);
  const batch = await f.ledger.command({
    kind: 'batch',
    requestId: randomUUID(),
    date: '2026-10-12',
    allocations: [
      { expenseId: 1, amount: 400000 },
      { expenseId: 2, amount: 100000 },
    ],
  });
  assert.deepEqual(cash(batch), cash(before));
  assert.equal(remaining(batch.expenses[0], batch.batches), 0);
  const topup = await f.ledger.command(advance(400000));
  assert.deepEqual(topup.expenses, batch.expenses);
  assert.deepEqual(topup.batches, batch.batches);
  assert.equal(balance(topup.expenses, topup.advances), 200000);
  const cancelled = await f.ledger.command({ kind: 'cancel', requestId: randomUUID(), id: 1 });
  assert.deepEqual(cash(cancelled), cash(topup));
  assert.equal(remaining(cancelled.expenses[0], cancelled.batches), 400000);
  f.reopen();
  assert.deepEqual(await read(f), cancelled);
});
