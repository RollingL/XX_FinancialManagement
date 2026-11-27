import { sum } from './model.ts';
import type { Expense } from './model.ts';

// Summary cards always use the complete ledger, independently of list dates and filters.
export function expenseSummary(expenses: Expense[]) {
  return {
    total: sum(expenses.map((e) => e.amount)),
    byCategory: {
      接待: sum(expenses.filter((e) => e.category === '接待').map((e) => e.amount)),
      办公: sum(expenses.filter((e) => e.category === '办公').map((e) => e.amount)),
    },
  };
}
