import { decimal, remaining } from './model.ts';
import type { Batch, Expense } from './model.ts';

// Changing selection preserves other edited amounts; fully registered expenses are never selectable.
export function reimbursementRows(
  expenses: Expense[],
  batches: Batch[],
  ids: number[],
  previous: Record<number, string> = {},
): Record<number, string> {
  const selected = new Set(ids);
  return Object.fromEntries(
    expenses
      .filter((e) => selected.has(e.id) && remaining(e, batches) > 0)
      .map((e) => [e.id, previous[e.id] ?? decimal(remaining(e, batches))]),
  );
}
