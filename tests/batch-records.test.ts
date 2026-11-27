import test from 'node:test';
import assert from 'node:assert/strict';
import {
  batchCode,
  batchTotal,
  batchRecords,
  batchRecordsSummary,
} from '../prototype/src/batch-records.ts';
import { paginate } from '../prototype/src/records.ts';
import type { Batch, Expense } from '../prototype/src/model.ts';

// All amounts, dates, merchants and notes here are synthetic test data.
const expenses: Expense[] = Array.from({ length: 8 }, (_, index) => ({
  id: 100 + index,
  date: '2026-10-01',
  category: index % 2 ? '办公' : '接待',
  merchant: index === 7 ? '合成 Office Beta 采购' : '合成接待商户',
  amount: 10000,
  invoice: 0,
  note: index === 6 ? '合成 ALPHA 第七项' : '合成普通备注',
}));
const batches: Batch[] = [
  { id: 1, date: '2026-09-30', active: true, allocations: [{ expenseId: 100, amount: 101 }] },
  { id: 2, date: '2026-10-01', active: false, allocations: [{ expenseId: 107, amount: 202 }] },
  { id: 3, date: '2026-10-01', active: true, allocations: [{ expenseId: 107, amount: 303 }] },
  {
    id: 4,
    date: '2026-10-02',
    active: true,
    allocations: expenses.map((expense) => ({ expenseId: expense.id, amount: 1 })),
  },
  { id: 5, date: '2026-10-03', active: false, allocations: [{ expenseId: 100, amount: 505 }] },
  { id: 6, date: '2026-10-04', active: true, allocations: [{ expenseId: 100, amount: 606 }] },
  { id: 7, date: '2026-10-05', active: true, allocations: [{ expenseId: 100, amount: 707 }] },
  { id: 8, date: '2026-10-06', active: true, allocations: [{ expenseId: 100, amount: 808 }] },
];
const all = { query: '', status: '全部' as const, month: '' };
const ids = (items: Batch[]) => items.map((batch) => batch.id);

test('批次编号至少三位；批次金额汇总全部分配且精确到分', () => {
  assert.equal(batchCode(1), 'BX-001');
  assert.equal(batchCode(123), 'BX-123');
  assert.equal(batchCode(1234), 'BX-1234');
  assert.equal(batchTotal(batches[3]), 8);
  assert.equal(batchTotal({ ...batches[3], allocations: [] }), 0);
});

test('搜索全部关联费用：第七项备注、跨类别摘要和大小写空白', () => {
  assert.equal(expenses[6].category, '接待');
  assert.equal(expenses[7].category, '办公');
  assert.deepEqual(ids(batchRecords(batches, expenses, { ...all, query: ' alpha ' })), [4]);
  assert.deepEqual(
    ids(batchRecords(batches, expenses, { ...all, query: ' OFFICE beta ' })),
    [4, 3, 2],
  );
  assert.deepEqual(ids(batchRecords(batches, expenses, { ...all, query: '107' })), [4, 3, 2]);
  assert.deepEqual(ids(batchRecords(batches, expenses, { ...all, query: '不存在的合成商户' })), []);
});

test('编号、原始编号及日期搜索可见，空白搜索保留所有批次', () => {
  assert.deepEqual(ids(batchRecords(batches, expenses, { ...all, query: ' bx-002 ' })), [2]);
  assert.deepEqual(ids(batchRecords(batches, expenses, { ...all, query: '8' })), [8]);
  assert.deepEqual(ids(batchRecords(batches, expenses, { ...all, query: '2026-09-30' })), [1]);
  assert.equal(batchRecords(batches, expenses, { ...all, query: '  ' }).length, 8);
});

test('搜索、状态与月份取交集；撤销批次保留原分配', () => {
  assert.deepEqual(
    ids(batchRecords(batches, expenses, { query: 'office', status: '已撤销', month: '2026-10' })),
    [2],
  );
  assert.deepEqual(
    ids(batchRecords(batches, expenses, { query: 'office', status: '有效', month: '2026-10' })),
    [4, 3],
  );
  assert.deepEqual(
    ids(batchRecords(batches, expenses, { query: 'office', status: '全部', month: '2026-09' })),
    [],
  );
  assert.deepEqual(ids(batchRecords(batches, expenses, { ...all, month: '2026-09' })), [1]);
  assert.deepEqual(
    batchRecords(batches, expenses, { ...all, status: '已撤销' }).map((batch) => batch.allocations),
    [batches[4].allocations, batches[1].allocations],
  );
});

test('按日期降序，同日按编号降序；返回新数组且不改输入', () => {
  const input = structuredClone(batches),
    original = structuredClone(input),
    originalExpenses = structuredClone(expenses);
  for (const batch of input) {
    batch.allocations.forEach(Object.freeze);
    Object.freeze(batch.allocations);
    Object.freeze(batch);
  }
  Object.freeze(input);
  const result = batchRecords(input, expenses, all);
  assert.deepEqual(ids(result), [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.notEqual(result, input);
  batchRecordsSummary(result);
  assert.deepEqual(input, original);
  assert.deepEqual(expenses, originalExpenses);
});

test('缺失关联费用仍可按批次编号和日期查到，不凭空补关联', () => {
  const missing: Batch = {
    id: 91,
    date: '2025-12-31',
    active: false,
    allocations: [{ expenseId: 999, amount: 19 }],
  };
  for (const query of ['', 'BX-091', '91', '2025-12-31']) {
    assert.deepEqual(batchRecords([missing], expenses, { ...all, query }), [missing]);
  }
  assert.deepEqual(batchRecords([missing], expenses, { ...all, query: 'office' }), []);
  assert.equal(batchTotal(missing), 19);
});

test('六条分页前汇总全部筛选记录，有效金额不含已撤销批次', () => {
  const filtered = batchRecords(batches, expenses, all);
  const page = paginate(filtered, 1);
  assert.equal(page.items.length, 6);
  assert.equal(page.pages, 2);
  assert.deepEqual(batchRecordsSummary(filtered), {
    count: 8,
    activeCount: 6,
    cancelledCount: 2,
    activeTotal: 2533,
  });
  assert.notEqual(
    batchRecordsSummary(page.items).activeTotal,
    batchRecordsSummary(filtered).activeTotal,
  );
  const october = batchRecords(batches, expenses, { ...all, month: '2026-10' });
  assert.deepEqual(batchRecordsSummary(october), {
    count: 7,
    activeCount: 5,
    cancelledCount: 2,
    activeTotal: 2432,
  });
  assert.deepEqual(
    batchRecordsSummary(batchRecords(batches, expenses, { ...all, status: '已撤销' })),
    { count: 2, activeCount: 0, cancelledCount: 2, activeTotal: 0 },
  );
});

test('空集合和无匹配记录的汇总为零', () => {
  assert.deepEqual(batchRecords([], expenses, all), []);
  assert.deepEqual(batchRecordsSummary([]), {
    count: 0,
    activeCount: 0,
    cancelledCount: 0,
    activeTotal: 0,
  });
  assert.deepEqual(
    batchRecordsSummary(batchRecords(batches, expenses, { ...all, month: '1999-01' })),
    { count: 0, activeCount: 0, cancelledCount: 0, activeTotal: 0 },
  );
});

test('安全整数边界精确合计，单批和有效总额超界拒绝', () => {
  const largest: Batch = {
    id: 100,
    date: '2026-10-12',
    active: true,
    allocations: [
      { expenseId: 100, amount: Number.MAX_SAFE_INTEGER - 1 },
      { expenseId: 101, amount: 1 },
    ],
  };
  assert.equal(batchTotal(largest), Number.MAX_SAFE_INTEGER);
  assert.equal(batchRecordsSummary([largest]).activeTotal, Number.MAX_SAFE_INTEGER);
  assert.throws(
    () =>
      batchTotal({
        ...largest,
        allocations: [...largest.allocations, { expenseId: 102, amount: 1 }],
      }),
    /安全范围/,
  );
  assert.throws(
    () =>
      batchRecordsSummary([
        largest,
        { ...largest, id: 101, allocations: [{ expenseId: 102, amount: 1 }] },
      ]),
    /安全范围/,
  );
  assert.throws(
    () => batchTotal({ ...largest, allocations: [{ expenseId: 100, amount: 1.5 }] }),
    RangeError,
  );
});

test('撤销历史可累计超过安全整数，但不参与有效金额求和', () => {
  const cancelled: Batch = {
    id: 100,
    date: '2026-10-12',
    active: false,
    allocations: [{ expenseId: 100, amount: Number.MAX_SAFE_INTEGER }],
  };
  const history = [cancelled, { ...cancelled, id: 101 }];
  assert.equal(batchTotal(history[0]), Number.MAX_SAFE_INTEGER);
  assert.deepEqual(batchRecordsSummary(history), {
    count: 2,
    activeCount: 0,
    cancelledCount: 2,
    activeTotal: 0,
  });
  assert.deepEqual(
    batchRecordsSummary([
      ...history,
      { ...cancelled, id: 102, active: true, allocations: [{ expenseId: 100, amount: 1 }] },
    ]),
    { count: 3, activeCount: 1, cancelledCount: 2, activeTotal: 1 },
  );
});
