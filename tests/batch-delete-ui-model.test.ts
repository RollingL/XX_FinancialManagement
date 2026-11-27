import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocate,
  balance,
  paid,
  remaining,
  sum,
  validateAllocation,
} from '../prototype/src/model.ts';
import type { Batch, Expense } from '../prototype/src/model.ts';
import { batchRecords, batchRecordsSummary, batchTotal } from '../prototype/src/batch-records.ts';
import { paginate } from '../prototype/src/records.ts';

// Entirely synthetic model states; no ledger, browser, filesystem data or API is opened.
const expenses: Expense[] = Array.from({ length: 8 }, (_, index) => ({
  id: 101 + index,
  date: '2026-10-01',
  category: index % 2 ? '办公' : '接待',
  merchant: index === 7 ? '合成 Office Beta 采购' : '合成接待商户',
  amount: 10000,
  invoice: 0,
  note: index === 6 ? '合成 ALPHA 第七项' : '合成普通备注',
}));
const batches: Batch[] = [
  {
    id: 1,
    date: '2026-10-01',
    active: true,
    allocations: [
      { expenseId: 101, amount: 1001 },
      { expenseId: 108, amount: 201 },
    ],
  },
  { id: 2, date: '2026-10-02', active: true, allocations: [{ expenseId: 101, amount: 301 }] },
  {
    id: 3,
    date: '2026-10-03',
    active: false,
    allocations: [
      { expenseId: 101, amount: 333 },
      { expenseId: 108, amount: 55 },
    ],
  },
  {
    id: 4,
    date: '2026-09-30',
    active: true,
    allocations: expenses.map((expense) => ({ expenseId: expense.id, amount: 1 })),
  },
];
const all = { query: '', status: '全部' as const, month: '' };
const ids = (items: Batch[]) => items.map((batch) => batch.id);
const makeState = () => ({
  expenses: structuredClone(expenses),
  batches: structuredClone(batches),
  advances: [123, 1],
  advanceDetails: {
    0: { date: '2026-09-01', note: '合成到账记录', createdAt: '2026-09-01T00:00:00Z' },
  },
});
const funds = (state: ReturnType<typeof makeState>) => ({
  expenses: structuredClone(state.expenses),
  advances: [...state.advances],
  advanceDetails: structuredClone(state.advanceDetails),
  entries: [
    ...state.advances.map((amount, index) => ({ kind: 'advance', index, amount })),
    ...state.expenses.map((expense) => ({
      kind: 'expense',
      id: expense.id,
      date: expense.date,
      amount: -expense.amount,
    })),
  ],
  balance: balance(state.expenses, state.advances),
});

test('直接移除批次及其全部分配，默认列表、编号搜索和月份筛选不再出现', () => {
  const after = batches.filter((batch) => batch.id !== 1);
  assert.deepEqual(ids(batchRecords(after, expenses, all)), [3, 2, 4]);
  assert.deepEqual(batchRecords(after, expenses, { ...all, query: ' bx-001 ' }), []);
  assert.deepEqual(
    ids(batchRecords(after, expenses, { ...all, status: '有效', month: '2026-10' })),
    [2],
  );
  assert.equal(
    after.flatMap((batch) => batch.allocations).length,
    batches.flatMap((batch) => batch.allocations).length - 2,
  );
  assert.deepEqual(batchRecordsSummary(after), {
    count: 3,
    activeCount: 2,
    cancelledCount: 1,
    activeTotal: 309,
  });
  assert.deepEqual(after, batches.slice(1));
});

test('删除跨类别有效批次仅释放其分配额度，其他批次与完整资金事实不变', () => {
  const state = makeState(),
    beforeFunds = funds(state),
    beforeBatches = structuredClone(state.batches);
  const beforeOutstanding = sum(state.expenses.map((expense) => remaining(expense, state.batches)));
  const target = state.batches.find((batch) => batch.id === 1)!;
  const after = { ...state, batches: state.batches.filter((batch) => batch.id !== target.id) };
  assert.equal(paid(101, state.batches), 1303);
  assert.equal(paid(101, after.batches), 302);
  assert.equal(paid(108, after.batches), 1);
  assert.equal(remaining(expenses[0], after.batches), 9698);
  assert.equal(remaining(expenses[7], after.batches), 9999);
  assert.equal(
    sum(after.expenses.map((expense) => remaining(expense, after.batches))) - beforeOutstanding,
    batchTotal(target),
  );
  assert.deepEqual(
    after.batches,
    beforeBatches.filter((batch) => batch.id !== 1),
  );
  assert.deepEqual(funds(after), beforeFunds);
  assert.ok(beforeFunds.balance < 0);
  assert.deepEqual(state.batches, beforeBatches);
});

test('释放后的额度可重新分配，超出剩余额一分仍被拒绝', () => {
  const after = batches.filter((batch) => batch.id !== 1);
  const selected = [expenses[0], expenses[7]];
  const rows = allocate(19697, selected, after);
  assert.deepEqual(rows, [
    { expenseId: 101, amount: 9698 },
    { expenseId: 108, amount: 9999 },
  ]);
  assert.equal(validateAllocation(rows, selected, after), 19697);
  assert.throws(() => allocate(19698, selected, after), /超过所选费用/);
  assert.throws(
    () => validateAllocation([{ expenseId: 101, amount: 9699 }], selected, after),
    /超过待报销额/,
  );
});

test('删除已撤销批次不再次释放额度，有效金额和完整资金内容保持不变', () => {
  const state = makeState(),
    beforeFunds = funds(state);
  const beforeProgress = state.expenses.map((expense) => ({
    id: expense.id,
    paid: paid(expense.id, state.batches),
    remaining: remaining(expense, state.batches),
  }));
  const after = { ...state, batches: state.batches.filter((batch) => batch.id !== 3) };
  assert.deepEqual(
    after.expenses.map((expense) => ({
      id: expense.id,
      paid: paid(expense.id, after.batches),
      remaining: remaining(expense, after.batches),
    })),
    beforeProgress,
  );
  assert.deepEqual(batchRecords(after.batches, after.expenses, { ...all, status: '已撤销' }), []);
  assert.deepEqual(batchRecordsSummary(after.batches), {
    count: 3,
    activeCount: 3,
    cancelledCount: 0,
    activeTotal: 1511,
  });
  assert.deepEqual(funds(after), beforeFunds);
  assert.deepEqual(
    after.batches,
    state.batches.filter((batch) => batch.id !== 3),
  );
});

test('关联备注搜索不再命中已删除批次，其他跨类别关联仍可查询', () => {
  assert.deepEqual(ids(batchRecords(batches, expenses, { ...all, query: ' alpha ' })), [4]);
  const after = batches.filter((batch) => batch.id !== 4);
  assert.deepEqual(batchRecords(after, expenses, { ...all, query: 'ALPHA' }), []);
  assert.deepEqual(
    ids(batchRecords(after, expenses, { ...all, query: ' OFFICE beta ', month: '2026-10' })),
    [3, 1],
  );
  assert.deepEqual(
    ids(batchRecords(after, expenses, { ...all, query: 'OFFICE beta', status: '有效' })),
    [1],
  );
  assert.deepEqual(batchRecords(after, expenses, { ...all, month: '2026-09' }), []);
});

test('删空最后一页后夹紧页码，汇总覆盖全部剩余记录，删空列表显示零', () => {
  const source: Batch[] = Array.from({ length: 13 }, (_, index) => ({
    id: index + 1,
    date: '2026-10-01',
    active: index % 2 === 0,
    allocations: [{ expenseId: 101, amount: index + 1 }],
  }));
  const before = batchRecords(source, expenses, all);
  assert.deepEqual(ids(paginate(before, 3).items), [1]);
  assert.deepEqual(batchRecordsSummary(before), {
    count: 13,
    activeCount: 7,
    cancelledCount: 6,
    activeTotal: 49,
  });
  assert.notEqual(batchRecordsSummary(paginate(before, 1).items).activeTotal, 49);
  const removed = source.filter((batch) => batch.id !== 1),
    visible = batchRecords(removed, expenses, all),
    clamped = paginate(visible, 3);
  assert.equal(clamped.page, 2);
  assert.equal(clamped.pages, 2);
  assert.deepEqual(ids(clamped.items), [7, 6, 5, 4, 3, 2]);
  assert.deepEqual(batchRecordsSummary(visible), {
    count: 12,
    activeCount: 6,
    cancelledCount: 6,
    activeTotal: 48,
  });
  const firstPageOnly = removed.filter((batch) => batch.id > 7);
  assert.equal(paginate(batchRecords(firstPageOnly, expenses, all), 2).page, 1);
  const empty = firstPageOnly.filter((batch) => batch.id < 0);
  assert.deepEqual(paginate(batchRecords(empty, expenses, all), 3), {
    items: [],
    page: 1,
    pages: 1,
    count: 0,
  });
  assert.deepEqual(batchRecordsSummary(empty), {
    count: 0,
    activeCount: 0,
    cancelledCount: 0,
    activeTotal: 0,
  });
});

test('筛选、汇总与额度读取不改写剩余旧记录或原始输入', () => {
  const input = structuredClone(batches),
    inputExpenses = structuredClone(expenses),
    before = structuredClone({ input, inputExpenses });
  for (const batch of input) {
    batch.allocations.forEach(Object.freeze);
    Object.freeze(batch.allocations);
    Object.freeze(batch);
  }
  inputExpenses.forEach(Object.freeze);
  Object.freeze(input);
  Object.freeze(inputExpenses);
  const after = input.filter((batch) => batch.id !== 1);
  for (const status of ['全部', '有效', '已撤销'] as const) {
    batchRecordsSummary(batchRecords(after, inputExpenses, { ...all, status }));
  }
  after.forEach(batchTotal);
  paid(101, after);
  remaining(inputExpenses[0], after);
  assert.deepEqual({ input, inputExpenses }, before);
  assert.deepEqual(after, before.input.slice(1));
});
