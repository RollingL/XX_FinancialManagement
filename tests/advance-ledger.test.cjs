// Recording company advances: whole cents, separate business date and save time,
// one record per request, and nothing half-saved.
const test = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ledgerFixture, read } = require('./ledger-fixture.cjs');
const fixture = (t) => ledgerFixture(t, 'qianlai-advance-');
const advance = (amount = 1, extra = {}) => ({
  kind: 'advance',
  requestId: randomUUID(),
  advance: { amount, date: '2026-10-12', ...extra },
});
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
  assert.deepEqual(f.db.prepare('SELECT kind, created_at FROM operations').all(), [
    { kind: 'advance', created_at: state.advanceDetails[0].createdAt },
  ]);
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
  assert.deepEqual(f.operations(), []);
});
test('advance cumulative limit accepts last safe cent and rejects overflow atomically', async (t) => {
  const f = fixture(t);
  await f.ledger.command(advance(Number.MAX_SAFE_INTEGER));
  const before = await read(f);
  await assert.rejects(f.ledger.command(advance(1)), /合计超出安全范围/);
  assert.deepEqual(await read(f), before);
});
test('failure after state update rolls back amount, metadata and operation; same request can retry', async (t) => {
  const f = fixture(t),
    before = await read(f),
    input = advance(10000);
  f.sql(
    "CREATE TRIGGER fail_advance BEFORE INSERT ON operations WHEN NEW.kind='advance' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  await assert.rejects(f.ledger.command(input), /synthetic failure/);
  assert.deepEqual(await read(f), before);
  assert.deepEqual(f.operations(), []);
  f.sql('DROP TRIGGER fail_advance');
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
