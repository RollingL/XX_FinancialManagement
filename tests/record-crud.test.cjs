// Correcting and deleting advances and expenses: numbers stay, screenshots stay,
// before/after copies are kept, and a failed save changes nothing.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
const { ledgerFixture, read, snapshot } = require('./ledger-fixture.cjs');
const png = fs.readFileSync(path.join(__dirname, 'fixtures/synthetic-payment.png'));
const fixture = (t) => ledgerFixture(t, 'qianlai-crud-');
const cash = (s) => ({
  advances: s.advances,
  expenseFlows: s.expenses.map((e) => ({ id: e.id, date: e.date, amount: -e.amount })),
  balance: s.advances.reduce((a, b) => a + b, 0) - s.expenses.reduce((a, e) => a + e.amount, 0),
});
async function setup(t) {
  const f = fixture(t);
  await f.ledger.command({
    kind: 'advance',
    requestId: randomUUID(),
    advance: { amount: 1000, date: '2026-10-13', note: '合成预支' },
    image: { base64: png.toString('base64') },
  });
  await f.ledger.command({
    kind: 'expense',
    requestId: randomUUID(),
    expense: {
      amount: 2000,
      date: '2026-10-13',
      note: '合成',
      category: '办公',
      merchant: '合成商户',
    },
    image: { base64: png.toString('base64') },
  });
  return f;
}
const advanceRequest = (
  s,
  id,
  kind = 'correct-advance',
  advance = { amount: 999, date: '2026-10-12', note: '合成纠错' },
) => ({
  kind,
  requestId: randomUUID(),
  id,
  expectedAmount: s.advances[id],
  expected: structuredClone(s.advanceDetails?.[id] ?? null),
  expectedRevision: (s.advanceEvents ?? []).filter((e) => e.advanceId === id).length,
  ...(kind === 'correct-advance' ? { advance } : {}),
});
const expenseDelete = (s) => ({
  kind: 'delete-expense',
  requestId: randomUUID(),
  id: 1,
  expected: structuredClone(s.expenses[0]),
  expectedRevision: (s.expenseEvents ?? []).filter((e) => e.expenseId === 1).length,
});
test('advance edit/delete preserves stable IDs, attachment metadata and audit; replay, stale snapshot and reopen', async (t) => {
  const f = await setup(t),
    before = await snapshot(f),
    first = advanceRequest(before.state, 0),
    edited = await f.ledger.command(first);
  assert.equal(edited.advances[0], 999);
  assert.equal(cash(edited).balance, cash(before.state).balance - 1);
  assert.deepEqual(edited.expenses, before.state.expenses);
  assert.equal(edited.advanceDetails[0].createdAt, before.state.advanceDetails[0].createdAt);
  assert.equal(edited.advanceDetails[0].attachmentId, before.state.advanceDetails[0].attachmentId);
  assert.deepEqual(edited.advanceEvents[0].before, {
    amount: 1000,
    details: before.state.advanceDetails[0],
  });
  await assert.rejects(f.ledger.command({ ...first, requestId: randomUUID() }), /已变化/);
  const remove = advanceRequest(edited, 0, 'delete-advance'),
    deleted = await f.ledger.command(remove);
  assert.deepEqual(deleted.advances, [0]);
  assert.equal(deleted.advanceDetails[0].deleted, true);
  assert.equal(deleted.advanceEvents[1].after, null);
  assert.equal(cash(deleted).balance, -2000);
  const saved = await snapshot(f);
  assert.deepEqual(saved.files, before.files);
  assert.deepEqual(await f.ledger.command(remove), deleted);
  assert.deepEqual(await f.ledger.command(first), deleted);
  f.reopen();
  assert.deepEqual(await snapshot(f), saved);
  const added = await f.ledger.command({
    kind: 'advance',
    requestId: randomUUID(),
    advance: { amount: 1, date: '2026-10-13', note: '' },
  });
  assert.deepEqual(added.advances, [0, 1]);
  assert.equal(added.advanceDetails[1].date, '2026-10-13');
});
test('advance deletion refuses invalid or stale fields and rolls back a failed save', async (t) => {
  const f = fixture(t);
  await f.ledger.command({
    kind: 'advance',
    requestId: randomUUID(),
    advance: { amount: 123, date: '2026-10-13', note: '合成预支' },
  });
  const initial = await snapshot(f),
    input = advanceRequest(initial.state, 0, 'delete-advance');
  for (const change of [
    { id: -1 },
    { id: 1 },
    { expectedAmount: 124 },
    { expectedRevision: 1 },
    { expected: {} },
    { image: { base64: 'abc' } },
  ]) {
    await assert.rejects(
      f.ledger.command({ ...input, ...change }),
      undefined,
      JSON.stringify(change),
    );
    assert.deepEqual(await snapshot(f), initial);
  }
  f.sql(
    "CREATE TRIGGER fail_delete BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
  );
  await assert.rejects(f.ledger.command(input), /synthetic rollback/);
  assert.deepEqual(await snapshot(f), initial);
  f.sql('DROP TRIGGER fail_delete');
  const after = await f.ledger.command(input);
  assert.deepEqual(after.advances, [0]);
  assert.deepEqual(after.advanceDetails[0], { ...initial.state.advanceDetails[0], deleted: true });
  assert.deepEqual(after.advanceEvents[0].before, {
    amount: 123,
    details: initial.state.advanceDetails[0],
  });
  await assert.rejects(
    f.ledger.command(advanceRequest(after, 0, 'delete-advance')),
    /不存在或已删除/,
  );
});
test('expense deletion rejects active allocation, permits canceled historical references, preserves attachments and reserves ID', async (t) => {
  const f = await setup(t),
    state = await f.ledger.command({
      kind: 'batch',
      requestId: randomUUID(),
      date: '2026-10-13',
      allocations: [{ expenseId: 1, amount: 100 }],
    }),
    before = await snapshot(f);
  await assert.rejects(f.ledger.command(expenseDelete(state)), /有效报销分配/);
  assert.deepEqual(await snapshot(f), before);
  const canceled = await f.ledger.command({ kind: 'cancel', requestId: randomUUID(), id: 1 }),
    input = expenseDelete(canceled),
    deleted = await f.ledger.command(input);
  assert.deepEqual(deleted.expenses, []);
  assert.deepEqual(deleted.batches, canceled.batches);
  assert.equal(deleted.expenseEvents[0].after, null);
  assert.deepEqual(deleted.expenseEvents[0].before, canceled.expenses[0]);
  assert.equal(cash(deleted).balance, 1000);
  assert.deepEqual((await snapshot(f)).files, before.files);
  assert.deepEqual(await f.ledger.command(input), deleted);
  f.reopen();
  assert.deepEqual(await read(f), deleted);
  const added = await f.ledger.command({
    kind: 'expense',
    requestId: randomUUID(),
    expense: { amount: 1, date: '2026-10-13', category: '办公', merchant: '新合成', note: '' },
  });
  assert.equal(added.expenses[0].id, 2);
});
test('expense deletion operation failure rolls back state/audit and retries exactly once', async (t) => {
  const f = await setup(t),
    before = await snapshot(f),
    input = expenseDelete(before.state);
  f.sql(
    "CREATE TRIGGER fail_delete BEFORE INSERT ON operations WHEN NEW.kind='delete-expense' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
  );
  await assert.rejects(f.ledger.command(input), /synthetic rollback/);
  assert.deepEqual(await snapshot(f), before);
  f.sql('DROP TRIGGER fail_delete');
  const result = await f.ledger.command(input);
  assert.equal(result.expenseEvents.length, 1);
  assert.deepEqual(await f.ledger.command(input), result);
});
test('the retired invoice payload on a batch is refused and changes nothing', async (t) => {
  const f = await setup(t),
    before = await snapshot(f);
  await assert.rejects(
    f.ledger.command({
      kind: 'batch',
      requestId: randomUUID(),
      date: '2026-10-13',
      allocations: [{ expenseId: 1, amount: 100 }],
      invoiceLinks: [],
    }),
    /发票管理已停用/,
  );
  assert.deepEqual(await snapshot(f), before);
});
