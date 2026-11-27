// Deleting a reimbursement batch: its allocations stop counting, the audit trail keeps a
// full copy, money never changes and batch numbers are never reused.
const test = require('node:test'),
  assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ledgerFixture, read } = require('./ledger-fixture.cjs');

const fixture = (t) => ledgerFixture(t, 'qianlai-batch-delete-');
const action = (kind, id = 1, requestId = randomUUID()) => ({ kind, requestId, id });
const newBatch = (allocations = [{ expenseId: 2, amount: 1 }]) => ({
  kind: 'batch',
  requestId: randomUUID(),
  date: '2026-10-06',
  allocations,
});
const remaining = (state) =>
  state.expenses.map(
    (expense) =>
      expense.amount -
      state.batches
        .filter((batch) => batch.active)
        .flatMap((batch) => batch.allocations.filter((row) => row.expenseId === expense.id))
        .reduce((sum, row) => sum + row.amount, 0),
  );
const funds = (state) => ({
  expenses: state.expenses,
  advances: state.advances,
  advanceDetails: state.advanceDetails,
  flows: [
    ...state.advances.map((amount, index) => ({
      kind: 'advance',
      index,
      amount,
      ...state.advanceDetails?.[index],
    })),
    ...state.expenses.map((expense) => ({ kind: 'expense', ...expense, amount: -expense.amount })),
  ],
  balance:
    state.advances.reduce((sum, amount) => sum + amount, 0) -
    state.expenses.reduce((sum, expense) => sum + expense.amount, 0),
});
// The whole ledger: the screen state, every stored row except the request log, and the log.
async function snapshot(f) {
  const { operations, ...rows } = f.rows();
  return { state: await read(f), rows, operations: f.operations() };
}
async function seed(f) {
  // Explicit synthetic facts in a new temporary ledger, never an existing ledger.
  for (const [amount, note] of [
    [25000, '合成预支'],
    [1, '合成一分补款'],
  ])
    await f.ledger.command({
      kind: 'advance',
      requestId: randomUUID(),
      advance: { amount, note, date: '2026-10-01' },
    });
  for (const [category, amount, merchant] of [
    ['接待', 30000, '合成接待甲'],
    ['办公', 20000, '合成办公乙'],
    ['办公', 10000, '合成办公丙'],
  ])
    await f.ledger.command({
      kind: 'expense',
      requestId: randomUUID(),
      expense: { category, amount, merchant, note: '合成测试备注', date: '2026-10-02' },
    });
  for (const [date, allocations] of [
    [
      '2026-10-03',
      [
        { expenseId: 1, amount: 12000 },
        { expenseId: 2, amount: 7000 },
      ],
    ],
    [
      '2026-10-04',
      [
        { expenseId: 1, amount: 3000 },
        { expenseId: 3, amount: 2000 },
      ],
    ],
    ['2026-10-05', [{ expenseId: 2, amount: 5000 }]],
  ])
    await f.ledger.command({ kind: 'batch', requestId: randomUUID(), date, allocations });
  await f.ledger.command(action('cancel', 3));
  return read(f);
}
function assertEvent(f, event, input, before) {
  assert.deepEqual(Object.keys(event).sort(), [
    'action',
    'after',
    'at',
    'batchId',
    'before',
    'requestId',
  ]);
  assert.deepEqual(event, {
    requestId: input.requestId,
    action: 'delete-batch',
    at: event.at,
    batchId: input.id,
    before,
    after: null,
  });
  assert.ok(Number.isFinite(Date.parse(event.at)));
  const operation = f.db
    .prepare('SELECT * FROM operations WHERE request_id = ?')
    .get(input.requestId);
  assert.equal(operation.kind, 'delete-batch');
  assert.equal(operation.created_at, event.at);
}

test('delete removes the active batch and all its allocations while retaining a complete audit snapshot and funds', async (t) => {
  const f = fixture(t);
  const before = await seed(f),
    input = action('delete-batch'),
    after = await f.ledger.command(input),
    expected = structuredClone(before);
  expected.batches = expected.batches.filter((batch) => batch.id !== 1);
  expected.batchEvents = after.batchEvents;
  assert.deepEqual(after, expected);
  assert.equal(
    after.batches.some((batch) => batch.id === 1),
    false,
  );
  assert.deepEqual(funds(after), funds(before));
  assert.equal(funds(after).balance, -34999);
  assert.deepEqual(remaining(before), [15000, 13000, 8000]);
  assert.deepEqual(remaining(after), [27000, 20000, 8000]);
  assert.equal(after.batchEvents.length, 1);
  assertEvent(f, after.batchEvents[0], input, before.batches[0]);
  assert.ok(after.batches.every((batch) => !Object.hasOwn(batch, 'deleted')));
  f.reopen();
  assert.deepEqual(await read(f), after);
});

test('deleting a cancelled batch removes its allocation history from batches without releasing another quota', async (t) => {
  const f = fixture(t),
    before = await seed(f),
    input = action('delete-batch', 3),
    after = await f.ledger.command(input),
    expected = structuredClone(before);
  expected.batches = expected.batches.filter((batch) => batch.id !== 3);
  expected.batchEvents = after.batchEvents;
  assert.deepEqual(after, expected);
  assert.deepEqual(remaining(after), remaining(before));
  assert.deepEqual(funds(after), funds(before));
  assertEvent(f, after.batchEvents[0], input, before.batches[2]);
});

test('freed quota can be reused but there is no restore command to recreate the deleted batch or allocations', async (t) => {
  const f = fixture(t),
    initial = await seed(f);
  await f.ledger.command(action('delete-batch'));
  const fullyAllocated = await f.ledger.command(
    newBatch([
      { expenseId: 1, amount: 27000 },
      { expenseId: 2, amount: 20000 },
      { expenseId: 3, amount: 8000 },
    ]),
  );
  assert.deepEqual(remaining(fullyAllocated), [0, 0, 0]);
  assert.deepEqual(funds(fullyAllocated), funds(initial));
  const before = await snapshot(f);
  await assert.rejects(f.ledger.command(action('restore-batch')), /保存请求无效/);
  assert.deepEqual(await snapshot(f), before);
  await assert.rejects(
    f.ledger.command(newBatch([{ expenseId: 1, amount: 1 }])),
    /超过当前待报销额/,
  );
  assert.deepEqual(await snapshot(f), before);
  f.reopen();
  assert.deepEqual(await read(f), fullyAllocated);
});

test('same deletion request is idempotent across reopen and different content cannot reuse its request ID', async (t) => {
  const f = fixture(t);
  await seed(f);
  const input = action('delete-batch'),
    before = await snapshot(f),
    state = await f.ledger.command(input),
    saved = await snapshot(f);
  assert.equal(saved.operations.length, before.operations.length + 1);
  assert.equal(state.batchEvents.length, 1);
  assert.deepEqual(await f.ledger.command(input), state);
  assert.deepEqual(await snapshot(f), saved);
  f.reopen();
  assert.deepEqual(await f.ledger.command(input), state);
  assert.deepEqual(await snapshot(f), saved);
  await assert.rejects(f.ledger.command({ ...input, id: 2 }), /重复请求内容不一致/);
  assert.deepEqual(await snapshot(f), saved);
  await assert.rejects(f.ledger.command({ ...input, kind: 'cancel' }), /重复请求内容不一致/);
  assert.deepEqual(await snapshot(f), saved);
});

test('another delete request or cancellation for an already removed batch rejects without another event or operation', async (t) => {
  const f = fixture(t);
  await seed(f);
  await f.ledger.command(action('delete-batch'));
  const before = await snapshot(f);
  for (const kind of ['delete-batch', 'cancel']) {
    await assert.rejects(f.ledger.command(action(kind)), /批次不存在/);
    assert.deepEqual(await snapshot(f), before);
  }
});

test('illegal IDs, missing batches and restore commands reject without creating state, history or operations', async (t) => {
  const f = fixture(t);
  await seed(f);
  const before = await snapshot(f);
  for (const id of [undefined, null, '1', 0, -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.ledger.command({ ...action('delete-batch'), id }), /批次编号无效/);
    assert.deepEqual(await snapshot(f), before);
  }
  await assert.rejects(f.ledger.command(action('delete-batch', 999999)), /批次不存在/);
  assert.deepEqual(await snapshot(f), before);
  await assert.rejects(f.ledger.command(action('restore-batch')), /保存请求无效/);
  assert.deepEqual(await snapshot(f), before);
});

test('operation insertion failure rolls back batch removal and audit together; the same request can retry safely', async (t) => {
  const f = fixture(t);
  await seed(f);
  const before = await snapshot(f),
    input = action('delete-batch');
  f.sql(
    "CREATE TRIGGER fail_batch_event BEFORE INSERT ON operations WHEN NEW.kind='delete-batch' BEGIN SELECT RAISE(ABORT,'synthetic audit transaction failure'); END",
  );
  await assert.rejects(f.ledger.command(input), /synthetic audit transaction failure/);
  assert.deepEqual(await snapshot(f), before);
  f.reopen();
  assert.deepEqual(await snapshot(f), before);
  f.sql('DROP TRIGGER fail_batch_event');
  const state = await f.ledger.command(input),
    saved = await snapshot(f),
    expected = structuredClone(before.state);
  expected.batches = expected.batches.filter((batch) => batch.id !== 1);
  expected.batchEvents = state.batchEvents;
  assert.deepEqual(state, expected);
  assert.equal(state.batchEvents.length, 1);
  assert.equal(saved.operations.length, before.operations.length + 1);
  assert.deepEqual(funds(state), funds(before.state));
  assertEvent(f, state.batchEvents[0], input, before.state.batches[0]);
  assert.deepEqual(await f.ledger.command(input), state);
  assert.deepEqual(await snapshot(f), saved);
});

test('deleted highest IDs are never reused and an old delete request cannot target a newer batch', async (t) => {
  const f = fixture(t);
  await seed(f);
  const input = action('delete-batch', 3);
  await f.ledger.command(input);
  f.reopen();
  const afterNew = await f.ledger.command(newBatch());
  assert.equal(afterNew.batches.at(-1).id, 4);
  const saved = await snapshot(f);
  assert.deepEqual(await f.ledger.command(input), afterNew);
  assert.deepEqual(await snapshot(f), saved);
  await assert.rejects(f.ledger.command(action('delete-batch', 3)), /批次不存在/);
  assert.deepEqual(await snapshot(f), saved);
  for (const id of [1, 2, 4]) await f.ledger.command(action('delete-batch', id));
  const empty = await read(f);
  assert.deepEqual(empty.batches, []);
  f.reopen();
  const created = await f.ledger.command(newBatch());
  assert.equal(created.batches[0].id, 5);
  assert.deepEqual(created.batchEvents, empty.batchEvents);
});

test('batch IDs reject overflow both from current records and deleted-history high water mark', async (t) => {
  const f = fixture(t);
  await seed(f);
  // A synthetic batch with the largest safe number, inserted directly.
  f.sql(`INSERT INTO batches (id, date, created_at)
    VALUES (${Number.MAX_SAFE_INTEGER}, '2026-10-06', '2026-10-06T00:00:00.000Z');
    INSERT INTO allocations (batch_id, position, expense_id, amount)
    VALUES (${Number.MAX_SAFE_INTEGER}, 0, 3, 1)`);
  const before = await snapshot(f);
  await assert.rejects(f.ledger.command(newBatch()), /批次编号超出安全范围/);
  assert.deepEqual(await snapshot(f), before);
  await f.ledger.command(action('delete-batch', Number.MAX_SAFE_INTEGER));
  const removed = await snapshot(f);
  f.reopen();
  await assert.rejects(f.ledger.command(newBatch()), /批次编号超出安全范围/);
  assert.deepEqual(await snapshot(f), removed);
});

test('audit snapshots stay unchanged when later batches are deleted', async (t) => {
  const f = fixture(t),
    initial = await seed(f);
  let earlier = [];
  for (const id of [1, 2, 3]) {
    const before = await read(f),
      input = action('delete-batch', id),
      after = await f.ledger.command(input);
    assert.deepEqual(after.batchEvents.slice(0, -1), earlier);
    assertEvent(
      f,
      after.batchEvents.at(-1),
      input,
      before.batches.find((batch) => batch.id === id),
    );
    earlier = structuredClone(after.batchEvents);
    assert.deepEqual(funds(after), funds(initial));
  }
  f.reopen();
  assert.deepEqual((await read(f)).batchEvents, earlier);
});
