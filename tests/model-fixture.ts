import type { Expense, Batch } from '../prototype/src/model.ts';
export function demo() {
  const expenses: Expense[] = [
    {
      id: 1001,
      date: '2026-10-03',
      category: '接待',
      merchant: '青禾餐厅',
      amount: 500000,
      invoice: 500000,
      note: '客户项目交流 · 合成演示数据',
    },
    {
      id: 1002,
      date: '2026-10-06',
      category: '办公',
      merchant: '办公耗材采购',
      amount: 80000,
      invoice: 30000,
      note: '打印纸及墨盒 · 合成演示数据',
    },
    {
      id: 1003,
      date: '2026-10-08',
      category: '接待',
      merchant: '南山茶室',
      amount: 120000,
      invoice: 0,
      note: '项目沟通 · 合成演示数据',
    },
    {
      id: 1004,
      date: '2026-09-28',
      category: '办公',
      merchant: '会议用转接器',
      amount: 26000,
      invoice: 26000,
      note: '合成演示数据',
    },
  ];
  const batches: Batch[] = [
    { id: 1, date: '2026-10-05', active: true, allocations: [{ expenseId: 1001, amount: 100000 }] },
    {
      id: 2,
      date: '2026-10-07',
      active: true,
      allocations: [
        { expenseId: 1001, amount: 200000 },
        { expenseId: 1004, amount: 26000 },
      ],
    },
  ];
  return { expenses, batches, advances: [300000] };
}
