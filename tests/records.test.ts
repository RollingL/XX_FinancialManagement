import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_SIZE, paginate, matchesExpense, selectScope } from '../src/renderer/records.ts';
import { reimbursementRows } from '../src/renderer/reimbursement-draft.ts';
import {
  allocate,
  balance,
  remaining,
  rowCents,
  sum,
  validateAllocation,
} from '../src/renderer/model.ts';
import type { Expense, Batch, Allocation } from '../src/renderer/model.ts';

const expenses: Expense[] = Array.from({ length: 13 }, (_, index) => ({
  id: index + 1,
  date: `2026-10-${String(index + 1).padStart(2, '0')}`,
  category: index % 2 ? '办公' : '接待',
  merchant: `合成商户 ${index + 1}`,
  amount: 10000,
  invoice: 0,
  note: index === 6 ? '项目 ALPHA：接待备注' : '合成采购摘要',
}));
const batches: Batch[] = [
  {
    id: 1,
    date: '2026-10-13',
    active: true,
    allocations: [
      { expenseId: 1, amount: 3000 },
      { expenseId: 13, amount: 10000 },
    ],
  },
];
const ids = (items: Expense[]) => items.map((item) => item.id);
const positiveAllocations = (rows: Record<number, string>): Allocation[] =>
  Object.entries(rows)
    .map(([id, value]) => ({ expenseId: Number(id), amount: rowCents(value) }))
    .filter((row) => row.amount > 0);

test('每页六条；空列表、整页及最后不足一页有一致的页数与边界', () => {
  assert.equal(PAGE_SIZE, 6);
  assert.deepEqual(paginate([], 1), { items: [], page: 1, pages: 1, count: 0 });
  for (const count of [1, 6, 7, 12, 13]) {
    const items = expenses.slice(0, count),
      pages = Math.ceil(count / 6);
    const last = paginate(items, pages);
    assert.equal(last.count, count);
    assert.equal(last.pages, pages);
    assert.equal(last.items.length, count - (pages - 1) * 6);
    assert.deepEqual(last.items, items.slice((pages - 1) * 6));
  }
});

test('非法页码回第一页；记录减少后页码收敛，翻页不修改原列表', () => {
  const original = structuredClone(expenses);
  for (const requested of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(paginate(expenses, requested).page, 1);
  }
  assert.deepEqual(ids(paginate(expenses, 2).items), [7, 8, 9, 10, 11, 12]);
  assert.deepEqual(paginate(expenses.slice(0, 7), 3), {
    items: expenses.slice(6, 7),
    page: 2,
    pages: 2,
    count: 7,
  });
  assert.equal(paginate(expenses, 999).page, 3);
  assert.deepEqual(expenses, original);
});

test('搜索匹配商户/采购摘要、备注及编号，忽略首尾空白和字母大小写', () => {
  const summary: Expense = {
    ...expenses[0],
    merchant: '合成墨盒采购摘要',
    note: '会议用 · Office ALPHA',
  };
  for (const query of ['墨盒', '采购摘要', '会议用', ' alpha ', 'OFFICE', '1', '  ']) {
    assert.equal(matchesExpense(summary, query), true, query);
  }
  assert.equal(matchesExpense(summary, '不存在的商户'), false);
  assert.equal(matchesExpense(summary, '2026-10'), false);
  assert.deepEqual(ids(expenses.filter((e) => matchesExpense(e, 'alpha'))), [7]);
});

test('本页全选/取消只改变本页范围，保留其他页并避免重复编号', () => {
  const selected = [1, 7],
    scope = [1, 2, 3, 4, 5, 6];
  const added = selectScope(selected, scope, true);
  assert.deepEqual(added, [1, 7, 2, 3, 4, 5, 6]);
  assert.deepEqual(selectScope(added, scope, false), [7]);
  assert.deepEqual(selectScope(added, scope, true), added);
  assert.deepEqual(selectScope(added, [], false), added);
  assert.deepEqual(selected, [1, 7]);
  assert.deepEqual(scope, [1, 2, 3, 4, 5, 6]);
});

test('报销跨页和搜索增删选择保留已编辑金额、零额与无效输入', () => {
  const previous = { 1: '12.34', 7: '20.01', 8: '0.00', 9: '1.001' };
  const searched = expenses.filter((e) => matchesExpense(e, 'alpha'));
  const selected = selectScope([1, 8, 9], ids(searched), true);
  const rows = reimbursementRows(expenses, batches, selected, previous);
  assert.deepEqual(rows, { 1: '12.34', 7: '20.01', 8: '0.00', 9: '1.001' });
  const removed = reimbursementRows(
    expenses,
    batches,
    selectScope(selected, ids(searched), false),
    rows,
  );
  assert.deepEqual(removed, { 1: '12.34', 8: '0.00', 9: '1.001' });
  assert.deepEqual(previous, { 1: '12.34', 7: '20.01', 8: '0.00', 9: '1.001' });
});

test('全选筛选结果覆盖所有匹配页，保留筛选外选择，已报完不新增额度', () => {
  const filtered = expenses.filter((e) => matchesExpense(e, '合成采购摘要'));
  assert.equal(paginate(filtered, 1).items.length, 6);
  assert.equal(paginate(filtered, 2).items.length, 6);
  const pending = filtered.filter((e) => remaining(e, batches) > 0);
  const rows = reimbursementRows(expenses, batches, selectScope([7], ids(pending), true), {
    7: '1.23',
  });
  assert.deepEqual(Object.keys(rows).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(rows[7], '1.23');
  assert.equal(rows[1], '70.00');
  assert.equal(Object.hasOwn(rows, 13), false);
  assert.equal(validateAllocation(positiveAllocations(rows), expenses, batches), 107123);
});

test('跨页保存按全部已选分配合计，隐藏页的金额同样校验，零行不保存', () => {
  const selected = ids(expenses.filter((e) => remaining(e, batches) > 0));
  const rows = reimbursementRows(expenses, batches, selected, {
    1: '12.34',
    7: '20.01',
    12: '0.00',
  });
  const chosen = expenses.filter((e) => Object.hasOwn(rows, e.id));
  const allocations = positiveAllocations(rows);
  assert.equal(allocations.length, 11);
  assert.equal(validateAllocation(allocations, chosen, batches), 93235);
  assert.equal(sum(Object.values(rows).map(rowCents)), 93235);
  const pageIds = new Set(ids(paginate(chosen, 1).items));
  assert.notEqual(
    validateAllocation(
      allocations.filter((row) => pageIds.has(row.expenseId)),
      chosen,
      batches,
    ),
    93235,
  );
  assert.equal(allocations.find((row) => row.expenseId === 7)?.amount, 2001);
  assert.throws(
    () => validateAllocation(positiveAllocations({ ...rows, 7: '100.01' }), chosen, batches),
    /费用 #7/,
  );
  assert.throws(() => positiveAllocations({ ...rows, 7: '1.001' }), /最多保留两位小数/);
});

test('改总额的分配跨页延续，校验不改变完整资金事实或负余额', () => {
  const advances = [3000, 1],
    before = { expenses: structuredClone(expenses), advances: [...advances] };
  const beforeBalance = balance(expenses, advances);
  const selected = expenses.filter((e) => remaining(e, batches) > 0);
  const allocations = allocate(67001, selected, batches);
  assert.deepEqual(allocations.slice(-2), [
    { expenseId: 7, amount: 10000 },
    { expenseId: 8, amount: 1 },
  ]);
  assert.equal(validateAllocation(allocations, selected, batches), 67001);
  assert.throws(() => allocate(117001, selected, batches), /超过所选费用/);
  assert.deepEqual({ expenses, advances }, before);
  assert.equal(balance(expenses, advances), beforeBalance);
  assert.ok(beforeBalance < 0);
});
