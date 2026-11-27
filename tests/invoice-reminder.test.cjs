// The “已开票” reminder: a plain yes/no flag on an expense. It never touches money or
// reimbursement, is kept in the audit trail, and is checked against stale screens.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  { randomUUID } = require('node:crypto');
const { ledgerFixture, read, snapshot } = require('./ledger-fixture.cjs');
function fixture(t) {
  const f = ledgerFixture(t, 'qianlai-reminder-');
  return Object.assign(f, {
    send: (input) => f.ledger.command({ requestId: randomUUID(), ...input }),
  });
}
const reminder = (state, id, value) => ({
  kind: 'set-invoice-issued',
  requestId: randomUUID(),
  id,
  expected: structuredClone(state.expenses.find((e) => e.id === id)),
  expectedRevision: (state.expenseEvents ?? []).filter((e) => e.expenseId === id).length,
  invoiceIssued: value,
});
const cash = (s) => ({
  advances: s.advances,
  advanceDetails: s.advanceDetails,
  expenseFlows: s.expenses.map(({ invoiceIssued, ...e }) => e),
  balance: s.advances.reduce((a, b) => a + b, 0) - s.expenses.reduce((a, e) => a + e.amount, 0),
  batches: s.batches,
});
async function setup(t) {
  const f = fixture(t);
  await f.send({ kind: 'advance', advance: { amount: 100, date: '2026-10-16', note: '合成预支' } });
  for (const category of ['接待', '办公'])
    await f.send({
      kind: 'expense',
      expense: { category, date: '2026-10-16', merchant: '合成' + category, amount: 200, note: '' },
    });
  await f.send({
    kind: 'batch',
    date: '2026-10-16',
    allocations: [
      { expenseId: 1, amount: 200 },
      { expenseId: 2, amount: 50 },
    ],
  });
  return f;
}

test('both categories toggle on/off, persist after reopen, and preserve full cash and reimbursement facts with negative balance', async (t) => {
  const f = await setup(t),
    before = await read(f);
  assert.equal(cash(before).balance, -300);
  assert.equal(before.expenses[0].invoiceIssued, false);
  for (const id of [1, 2])
    for (const flag of [true, false]) {
      const current = await read(f),
        request = reminder(current, id, flag),
        after = await f.send(request);
      assert.equal(after.expenses.find((e) => e.id === id).invoiceIssued, flag);
      assert.deepEqual(cash(after), cash(before));
      assert.deepEqual(await f.send(request), after);
      f.reopen();
      assert.deepEqual(await read(f), after);
    }
  const after = await read(f);
  assert.equal(after.expenseEvents.length, 4);
  assert.deepEqual(
    after.expenseEvents.map((e) => e.revision),
    [1, 2, 1, 2],
  );
});

test('all retired invoice writes, batch link payloads and malformed reminder fields fail without mutations', async (t) => {
  const f = await setup(t),
    before = await snapshot(f),
    request = reminder(before.state, 1, true);
  for (const kind of [
    'invoice',
    'invoice-identity',
    'invoice-attachment',
    'invoice-allocate',
    'invoice-link',
    'invoice-edit',
    'invoice-delete',
  ])
    await assert.rejects(f.send({ kind, image: { base64: 'bad' } }), /请求无效/);
  await assert.rejects(
    f.send({
      kind: 'batch',
      date: '2026-10-16',
      allocations: [{ expenseId: 2, amount: 1 }],
      invoiceLinks: [],
    }),
    /停用/,
  );
  for (const change of [
    { invoiceIssued: 1 },
    { invoiceIssued: 'true' },
    { invoiceIssued: null },
    { id: 0 },
    { id: 999 },
    { expectedRevision: 1 },
    { expectedRevision: -1 },
    { amount: 1 },
    { image: {} },
    { expected: { ...request.expected, note: 'changed' } },
  ])
    await assert.rejects(f.send({ ...request, ...change }));
  assert.deepEqual(await snapshot(f), before);
});

test('stale revisions, reused IDs, deleted expense and correction preserve concurrency boundaries', async (t) => {
  const f = await setup(t),
    before = await read(f),
    request = reminder(before, 2, true);
  let state = await f.send(request);
  await assert.rejects(f.send({ ...request, requestId: randomUUID() }), /已变化/);
  await assert.rejects(f.send({ ...request, invoiceIssued: false }), /重复请求/);
  const correct = {
    kind: 'correct-expense',
    id: 2,
    expected: state.expenses[1],
    expectedRevision: 1,
    expense: { category: '办公', date: '2026-10-16', merchant: '合成更正', amount: 201, note: '' },
  };
  state = await f.send(correct);
  assert.equal(state.expenses[1].invoiceIssued, true);
  await assert.rejects(f.send(reminder({ ...state, expenseEvents: [] }, 2, false)), /已变化/);
  state = await f.send(reminder(state, 2, false));
  assert.equal(state.expenseEvents.at(-1).revision, 3);
  state = await f.send({ kind: 'cancel', id: 1 });
  const pending = reminder(state, 2, true);
  state = await f.send({
    kind: 'delete-expense',
    id: 2,
    expected: state.expenses[1],
    expectedRevision: 3,
  });
  await assert.rejects(f.send(pending), /不存在/);
});

test('transaction failure rolls back marker/audit/receipt and the same request succeeds once on retry', async (t) => {
  const f = await setup(t),
    before = await snapshot(f),
    request = reminder(before.state, 1, true);
  f.sql(
    "CREATE TRIGGER synthetic_fail BEFORE INSERT ON operations WHEN NEW.kind='set-invoice-issued' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
  );
  await assert.rejects(f.send(request), /synthetic rollback/);
  assert.deepEqual(await snapshot(f), before);
  f.sql('DROP TRIGGER synthetic_fail');
  const saved = await f.send(request);
  assert.equal(saved.expenseEvents.length, 1);
  assert.deepEqual(await f.send(request), saved);
});
