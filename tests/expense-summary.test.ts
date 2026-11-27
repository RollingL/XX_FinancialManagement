import test from 'node:test';
import assert from 'node:assert/strict';
import { expenseSummary } from '../src/renderer/expense-summary.ts';
import type { Expense } from '../src/renderer/model.ts';

test('费用支出涵盖跨年、跨月和当日全部费用，分类之和与总额精确到分一致', () => {
  const expenses: Expense[] = [
    {
      id: 1,
      date: '2025-12-31',
      category: '接待',
      amount: 10001,
      merchant: '合成历史接待',
      note: '',
    },
    {
      id: 2,
      date: '2026-09-30',
      category: '办公',
      amount: 20002,
      merchant: '合成上月办公',
      note: '',
    },
    {
      id: 3,
      date: '2026-10-12',
      category: '接待',
      amount: 30003,
      merchant: '合成当月接待',
      note: '',
    },
    {
      id: 4,
      date: '2026-10-12',
      category: '办公',
      amount: 1,
      merchant: '合成当月办公',
      note: '',
    },
  ];
  const original = structuredClone(expenses),
    result = expenseSummary(expenses);
  assert.deepEqual(result, { total: 60007, byCategory: { 接待: 40004, 办公: 20003 } });
  assert.equal(result.total, result.byCategory['接待'] + result.byCategory['办公']);
  assert.deepEqual(expenses, original);
  assert.deepEqual(expenseSummary([]), { total: 0, byCategory: { 接待: 0, 办公: 0 } });
});
