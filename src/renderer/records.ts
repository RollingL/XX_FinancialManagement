import type { Expense } from './model.ts';

export const PAGE_SIZE = 6;
export function paginate<T>(items: T[], requested: number) {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.isSafeInteger(requested) ? requested : 1));
  return {
    items: items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    page,
    pages,
    count: items.length,
  };
}
export function matchesExpense(expense: Expense, query: string) {
  const key = query.trim().toLocaleLowerCase();
  return (
    !key ||
    [expense.merchant, expense.note, String(expense.id)].some((value) =>
      value.toLocaleLowerCase().includes(key),
    )
  );
}
// Select/deselect only the supplied scope; selections on other pages remain intact.
export function selectScope(selected: number[], scope: number[], checked: boolean) {
  const ids = new Set(scope);
  return checked ? [...new Set([...selected, ...scope])] : selected.filter((id) => !ids.has(id));
}
