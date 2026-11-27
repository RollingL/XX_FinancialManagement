const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { createLedger } = require('../spike/trial-ledger.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xx-batch-cancel-'));
  let ledger = createLedger(root);
  t.after(() => {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    get ledger() {
      return ledger;
    },
    reopen() {
      ledger.close();
      ledger = createLedger(root);
    },
    db(fn) {
      const db = new Database(path.join(root, 'trial.sqlite'));
      try {
        return fn(db);
      } finally {
        db.close();
      }
    },
  };
}
const read = (f) => f.ledger.command({ kind: 'read' });
const cancel = (id, requestId = randomUUID()) => ({ kind: 'cancel', requestId, id });
async function snapshot(f) {
  return {
    state: await read(f),
    ...f.db((db) => ({
      raw: db.prepare('SELECT json FROM trial_state WHERE id=1').get().json,
      operations: db.prepare('SELECT * FROM operations ORDER BY id').all(),
      attachments: db.prepare('SELECT * FROM attachments ORDER BY id').all(),
    })),
  };
}
function funds(state, balance) {
  return {
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
      ...state.expenses.map((expense) => ({
        kind: 'expense',
        ...expense,
        amount: -expense.amount,
      })),
    ],
    balance: balance(state.expenses, state.advances),
  };
}
async function seed(f) {
  // All dates, descriptions and cents below are synthetic; no existing ledger is opened.
  for (const [amount, date, note] of [
    [150000, '2026-09-30', '合成预支一'],
    [5000, '2026-10-03', '合成补充款'],
  ])
    await f.ledger.command({
      kind: 'advance',
      requestId: randomUUID(),
      advance: { amount, date, note },
    });
  for (const [category, amount, merchant, note] of [
    ['接待', 120000, '合成接待甲', '跨批次分配'],
    ['办公', 80000, '合成办公乙', '跨类别分配'],
    ['接待', 30000, '合成接待丙', '撤销前全部报账'],
    ['办公', 15000, '合成办公丁', '不属于目标批次'],
  ])
    await f.ledger.command({
      kind: 'expense',
      requestId: randomUUID(),
      expense: { category, amount, merchant, note, date: '2026-10-04' },
    });
  const batches = [
    {
      date: '2026-10-05',
      allocations: [
        { expenseId: 1, amount: 3000 },
        { expenseId: 2, amount: 4000 },
      ],
    },
    {
      date: '2026-10-06',
      allocations: [
        { expenseId: 1, amount: 10000 },
        { expenseId: 2, amount: 15000 },
        { expenseId: 4, amount: 5000 },
      ],
    },
    {
      date: '2026-10-07',
      allocations: [
        { expenseId: 1, amount: 60000 },
        { expenseId: 2, amount: 25000 },
        { expenseId: 3, amount: 20000 },
      ],
    },
    {
      date: '2026-10-08',
      allocations: [
        { expenseId: 1, amount: 5000 },
        { expenseId: 3, amount: 10000 },
      ],
    },
  ];
  for (const batch of batches)
    await f.ledger.command({ kind: 'batch', requestId: randomUUID(), ...batch });
  await f.ledger.command(cancel(1));
  return { targetId: 3, otherActiveId: 2 };
}

test('cancelling a cross-category batch changes only its active flag and restores only its allocations', async (t) => {
  const f = fixture(t),
    { targetId } = await seed(f),
    { remaining, balance } = await import('../prototype/src/model.ts'),
    before = await read(f),
    target = before.batches.find((batch) => batch.id === targetId);
  const remainingBefore = before.expenses.map((expense) => remaining(expense, before.batches));
  assert.deepEqual(remainingBefore, [45000, 40000, 0, 10000]);
  assert.equal(funds(before, balance).balance, -90000);
  assert.ok(before.batches.some((batch) => !batch.active));
  assert.ok(before.batches.filter((batch) => batch.active && batch.id !== targetId).length > 1);
  assert.deepEqual(
    [
      ...new Set(
        target.allocations.map(
          (row) => before.expenses.find((expense) => expense.id === row.expenseId).category,
        ),
      ),
    ].sort(),
    ['办公', '接待'],
  );
  const after = await f.ledger.command(cancel(targetId)),
    expected = structuredClone(before);
  expected.batches.find((batch) => batch.id === targetId).active = false;
  assert.deepEqual(after, expected);
  assert.deepEqual(funds(after, balance), funds(before, balance));
  assert.deepEqual(
    after.batches.map(({ id, date, allocations }) => ({ id, date, allocations })),
    before.batches.map(({ id, date, allocations }) => ({ id, date, allocations })),
  );
  assert.deepEqual(
    after.expenses.map((expense) => remaining(expense, after.batches)),
    [105000, 65000, 20000, 10000],
  );
  for (const [index, expense] of after.expenses.entries())
    assert.equal(
      remaining(expense, after.batches) - remainingBefore[index],
      target.allocations.find((row) => row.expenseId === expense.id)?.amount ?? 0,
    );
  f.reopen();
  assert.deepEqual(await read(f), after);
});

test('same cancellation request is idempotent before and after SQLite reopen with no extra operation', async (t) => {
  const f = fixture(t),
    { targetId } = await seed(f),
    input = cancel(targetId),
    before = await snapshot(f),
    state = await f.ledger.command(input),
    saved = await snapshot(f);
  assert.equal(saved.operations.length, before.operations.length + 1);
  assert.equal(saved.operations.filter((operation) => operation.id === input.requestId).length, 1);
  assert.deepEqual(await f.ledger.command(input), state);
  assert.deepEqual(await snapshot(f), saved);
  f.reopen();
  assert.deepEqual(await f.ledger.command(input), state);
  assert.deepEqual(await snapshot(f), saved);
});

test('a new request cancelling an already cancelled batch leaves state and funds unchanged and records its own operation', async (t) => {
  const f = fixture(t),
    { targetId } = await seed(f),
    { balance } = await import('../prototype/src/model.ts');
  await f.ledger.command(cancel(targetId));
  const before = await snapshot(f),
    input = cancel(targetId),
    state = await f.ledger.command(input),
    after = await snapshot(f);
  assert.deepEqual(state, before.state);
  assert.equal(after.raw, before.raw);
  assert.deepEqual(funds(state, balance), funds(before.state, balance));
  assert.deepEqual(after.attachments, before.attachments);
  const newOperations = after.operations.filter(
    (operation) => !before.operations.some((old) => old.id === operation.id),
  );
  assert.equal(newOperations.length, 1);
  assert.equal(newOperations[0].id, input.requestId);
  assert.equal(newOperations[0].kind, 'cancel');
  assert.deepEqual(
    after.operations.filter((operation) => operation.id !== input.requestId),
    before.operations,
  );
});

test('missing batch and same request with different content reject without state or operation changes', async (t) => {
  const f = fixture(t),
    { targetId, otherActiveId } = await seed(f),
    before = await snapshot(f);
  await assert.rejects(f.ledger.command(cancel(999999)), /批次不存在/);
  assert.deepEqual(await snapshot(f), before);
  const input = cancel(targetId);
  await f.ledger.command(input);
  const saved = await snapshot(f);
  await assert.rejects(f.ledger.command({ ...input, id: otherActiveId }), /重复请求内容不一致/);
  assert.deepEqual(await snapshot(f), saved);
  assert.equal(saved.state.batches.find((batch) => batch.id === otherActiveId).active, true);
});

test('operation insertion failure rolls back cancellation completely and the same request can retry after recovery', async (t) => {
  const f = fixture(t),
    { targetId } = await seed(f),
    { balance } = await import('../prototype/src/model.ts'),
    input = cancel(targetId),
    before = await snapshot(f);
  f.db((db) =>
    db.exec(
      "CREATE TRIGGER fail_cancel BEFORE INSERT ON operations WHEN NEW.kind='cancel' BEGIN SELECT RAISE(ABORT,'synthetic cancellation failure'); END",
    ),
  );
  await assert.rejects(f.ledger.command(input), /synthetic cancellation failure/);
  assert.deepEqual(await snapshot(f), before);
  f.reopen();
  assert.deepEqual(await snapshot(f), before);
  f.db((db) => db.exec('DROP TRIGGER fail_cancel'));
  const state = await f.ledger.command(input),
    expected = structuredClone(before.state);
  expected.batches.find((batch) => batch.id === targetId).active = false;
  assert.deepEqual(state, expected);
  assert.deepEqual(funds(state, balance), funds(before.state, balance));
  const saved = await snapshot(f);
  assert.equal(saved.operations.length, before.operations.length + 1);
  assert.equal(saved.operations.filter((operation) => operation.id === input.requestId).length, 1);
  assert.deepEqual(await f.ledger.command(input), state);
  assert.deepEqual(await snapshot(f), saved);
});
