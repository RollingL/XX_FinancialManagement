// Core bookkeeping rules checked directly against the ledger backend.
// Every ledger is a new temporary folder with obviously synthetic records.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { ledgerFixture, read, funds } = require('./ledger-fixture.cjs');

const fixture = (t) => ledgerFixture(t, 'qianlai-core-');

const expense = (fields = {}) => ({
  kind: 'expense',
  requestId: randomUUID(),
  expense: {
    category: '接待',
    date: '2026-11-01',
    merchant: '合成商户',
    note: '',
    amount: 10000,
    ...fields,
  },
});

const advance = (amount, date = '2026-11-01') => ({
  kind: 'advance',
  requestId: randomUUID(),
  advance: { amount, date, note: '' },
});

const batch = (allocations, date = '2026-11-15') => ({
  kind: 'batch',
  requestId: randomUUID(),
  date,
  allocations,
});

const balance = (state) => funds(state).balance;

const reimbursed = (state, expenseId) =>
  state.batches
    .filter((item) => item.active)
    .flatMap((item) => item.allocations)
    .filter((item) => item.expenseId === expenseId)
    .reduce((sum, item) => sum + item.amount, 0);

test('a new expense is stored in whole cents with trimmed text and a new number', async (t) => {
  const f = fixture(t);
  await f.ledger.command(expense({ merchant: '  合成商户甲  ', note: '  合成备注  ' }));
  const state = await f.ledger.command(
    expense({ category: '办公', merchant: '合成采购', amount: 1 }),
  );
  assert.deepEqual(
    state.expenses.map(({ id, category, date, merchant, note, amount }) => ({
      id,
      category,
      date,
      merchant,
      note,
      amount,
    })),
    [
      {
        id: 1,
        category: '接待',
        date: '2026-11-01',
        merchant: '合成商户甲',
        note: '合成备注',
        amount: 10000,
      },
      { id: 2, category: '办公', date: '2026-11-01', merchant: '合成采购', note: '', amount: 1 },
    ],
  );
  assert.equal(balance(state), -10001);
  f.reopen();
  assert.deepEqual(await read(f), state);
});

test('invalid expense input is refused and changes nothing', async (t) => {
  const f = fixture(t);
  await f.ledger.command(expense());
  const before = await read(f),
    operations = f.operations();
  for (const fields of [
    { amount: 0 },
    { amount: -100 },
    { amount: 12.5 },
    { amount: '100' },
    { amount: Number.MAX_SAFE_INTEGER + 1 },
    { date: '2026-02-30' },
    { date: '2026/11/01' },
    { merchant: '' },
    { merchant: '   ' },
    { merchant: '合'.repeat(101) },
    { note: '合'.repeat(501) },
    { category: '其他' },
  ]) {
    await assert.rejects(f.ledger.command(expense(fields)), undefined, JSON.stringify(fields));
    assert.deepEqual(await read(f), before);
    assert.deepEqual(f.operations(), operations);
  }
  const longest = await f.ledger.command(
    expense({ merchant: '合'.repeat(100), note: '合'.repeat(500) }),
  );
  assert.equal(longest.expenses.length, 2);
});

test('the total of all expenses may not pass the safe whole-cent limit', async (t) => {
  const f = fixture(t);
  await f.ledger.command(expense({ amount: Number.MAX_SAFE_INTEGER - 1 }));
  await f.ledger.command(expense({ amount: 1 }));
  const before = await read(f);
  await assert.rejects(f.ledger.command(expense({ amount: 1 })), /合计超出安全范围/);
  assert.deepEqual(await read(f), before);
});

test('balance is all advances minus all expenses, may go negative, and ignores reimbursement', async (t) => {
  const f = fixture(t);
  let state = await f.ledger.command(advance(50000));
  assert.equal(balance(state), 50000);
  await f.ledger.command(expense({ amount: 30000 }));
  state = await f.ledger.command(expense({ category: '办公', amount: 45000 }));
  assert.equal(balance(state), -25000);
  const reimbursedState = await f.ledger.command(
    batch([
      { expenseId: 1, amount: 30000 },
      { expenseId: 2, amount: 45000 },
    ]),
  );
  assert.equal(balance(reimbursedState), -25000);
  assert.deepEqual(funds(reimbursedState), funds(state));
  state = await f.ledger.command(advance(25000));
  assert.equal(balance(state), 0);
});

test('a batch may cover several expenses and one expense may be reimbursed in parts', async (t) => {
  const f = fixture(t);
  await f.ledger.command(expense({ amount: 10000 }));
  await f.ledger.command(expense({ category: '办公', amount: 5000 }));
  const before = await read(f);
  let state = await f.ledger.command(
    batch([
      { expenseId: 1, amount: 4000 },
      { expenseId: 2, amount: 5000 },
    ]),
  );
  assert.deepEqual(funds(state), funds(before));
  assert.deepEqual(state.batches, [
    {
      id: 1,
      date: '2026-11-15',
      active: true,
      allocations: [
        { expenseId: 1, amount: 4000 },
        { expenseId: 2, amount: 5000 },
      ],
    },
  ]);
  assert.equal(reimbursed(state, 1), 4000);
  assert.equal(reimbursed(state, 2), 5000);
  state = await f.ledger.command(batch([{ expenseId: 1, amount: 6000 }], '2026-11-20'));
  assert.equal(reimbursed(state, 1), 10000);
  assert.deepEqual(funds(state), funds(before));
  f.reopen();
  assert.deepEqual(await read(f), state);
});

test('batch allocations are refused when they are empty, zero, repeated, unknown or too large', async (t) => {
  const f = fixture(t);
  await f.ledger.command(expense({ amount: 10000 }));
  await f.ledger.command(expense({ amount: 2000 }));
  await f.ledger.command(batch([{ expenseId: 1, amount: 7000 }]));
  const before = await read(f),
    operations = f.operations();
  for (const [allocations, message] of [
    [[], /分配无效/],
    ['not a list', /分配无效/],
    [[{ expenseId: 1, amount: 0 }], /金额/],
    [[{ expenseId: 1, amount: -1 }], /金额/],
    [[{ expenseId: 1, amount: 0.5 }], /金额/],
    [[{ expenseId: 99, amount: 1 }], /费用不存在/],
    [
      [
        { expenseId: 2, amount: 1000 },
        { expenseId: 2, amount: 1000 },
      ],
      /重复分配/,
    ],
    [[{ expenseId: 1, amount: 3001 }], /超过当前待报销额/],
    [
      [
        { expenseId: 1, amount: 3000 },
        { expenseId: 2, amount: 2001 },
      ],
      /超过当前待报销额/,
    ],
  ]) {
    await assert.rejects(
      f.ledger.command(batch(allocations)),
      message,
      JSON.stringify(allocations),
    );
    assert.deepEqual(await read(f), before);
    assert.deepEqual(f.operations(), operations);
  }
  await assert.rejects(
    f.ledger.command(batch([{ expenseId: 1, amount: 1 }], '2026-13-01')),
    /日期无效/,
  );
  const exact = await f.ledger.command(
    batch([
      { expenseId: 1, amount: 3000 },
      { expenseId: 2, amount: 2000 },
    ]),
  );
  assert.equal(reimbursed(exact, 1), 10000);
  assert.equal(reimbursed(exact, 2), 2000);
  await assert.rejects(f.ledger.command(batch([{ expenseId: 1, amount: 1 }])), /超过当前待报销额/);
});

test('a cancelled batch frees its amounts again without touching any money', async (t) => {
  const f = fixture(t);
  await f.ledger.command(advance(1000));
  await f.ledger.command(expense({ amount: 10000 }));
  await f.ledger.command(batch([{ expenseId: 1, amount: 10000 }]));
  const before = await read(f);
  const cancelled = await f.ledger.command({ kind: 'cancel', requestId: randomUUID(), id: 1 });
  assert.equal(cancelled.batches[0].active, false);
  assert.deepEqual(cancelled.batches[0].allocations, before.batches[0].allocations);
  assert.equal(reimbursed(cancelled, 1), 0);
  assert.deepEqual(funds(cancelled), funds(before));
  const again = await f.ledger.command(batch([{ expenseId: 1, amount: 10000 }]));
  assert.equal(reimbursed(again, 1), 10000);
  assert.deepEqual(funds(again), funds(before));
});

test('sending the same save twice records it once; reusing the request number for other content is refused', async (t) => {
  const f = fixture(t),
    input = expense({ amount: 2500 });
  const [first, second] = await Promise.all([f.ledger.command(input), f.ledger.command(input)]);
  assert.deepEqual(second, first);
  assert.equal(first.expenses.length, 1);
  f.reopen();
  assert.deepEqual(await f.ledger.command(input), first);
  await assert.rejects(
    f.ledger.command({ ...input, expense: { ...input.expense, amount: 2600 } }),
    /重复请求内容不一致/,
  );
  assert.deepEqual(await read(f), first);
  assert.equal(f.operations().length, 1);
  const save = batch([{ expenseId: 1, amount: 2500 }]);
  const saved = await f.ledger.command(save);
  assert.deepEqual(await f.ledger.command(save), saved);
  assert.equal(saved.batches.length, 1);
});

test('a failure while saving leaves no partial expense or batch, and the same request can retry', async (t) => {
  const f = fixture(t);
  await f.ledger.command(expense());
  const before = await read(f);
  f.sql(
    "CREATE TRIGGER synthetic_failure BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT, 'synthetic save failure'); END",
  );
  const newExpense = expense({ amount: 300 }),
    newBatch = batch([{ expenseId: 1, amount: 100 }]);
  for (const input of [newExpense, newBatch]) {
    await assert.rejects(f.ledger.command(input), /synthetic save failure/);
    assert.deepEqual(await read(f), before);
  }
  f.sql('DROP TRIGGER synthetic_failure');
  f.reopen();
  assert.equal((await f.ledger.command(newExpense)).expenses.length, 2);
  assert.equal(reimbursed(await f.ledger.command(newBatch), 1), 100);
});
