import { decimal, paid, remaining } from './model.ts';
import type { Batch, Expense } from './model.ts';
import type { LedgerState } from './ledger.ts';
import { matchesExpense } from './records.ts';

export type ExpenseFilters = {
  category: '全部费用' | '接待' | '办公';
  query: string;
  status: string;
  startDate: string;
  endDate: string;
};

function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function expenseFilterError(filters: ExpenseFilters): string {
  if (filters.startDate && !validDate(filters.startDate)) return '请输入有效的开始日期';
  if (filters.endDate && !validDate(filters.endDate)) return '请输入有效的结束日期';
  if (filters.startDate && filters.endDate && filters.startDate > filters.endDate)
    return '开始日期不能晚于结束日期';
  return '';
}
export function expenseStatus(expense: Expense, batches: Batch[]) {
  return paid(expense.id, batches) === 0
    ? '未报销'
    : remaining(expense, batches) === 0
      ? '已报销'
      : '部分报销';
}
export function filterExpenses(state: LedgerState, filters: ExpenseFilters): Expense[] {
  if (expenseFilterError(filters)) return [];
  return state.expenses.filter(
    (expense) =>
      (filters.category === '全部费用' || expense.category === filters.category) &&
      matchesExpense(expense, filters.query) &&
      (!filters.startDate || expense.date >= filters.startDate) &&
      (!filters.endDate || expense.date <= filters.endDate) &&
      (filters.status === '全部状态' || expenseStatus(expense, state.batches) === filters.status),
  );
}

const headers = [
  '费用编号',
  '实际支出日期',
  '费用类别',
  '商户/采购摘要',
  '备注',
  '支出金额（元）',
  '已报销金额（元）',
  '待报销金额（元）',
  '报销状态',
];
function textCell(value: string) {
  // Normalize only for detection: exported business text otherwise keeps its original bytes.
  const unsafe = /^[=+\-@\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(
    value.normalize('NFKC'),
  );
  return `"${(unsafe ? "'" + value : value).replaceAll('"', '""')}"`;
}
export function expenseCsv(state: LedgerState, expenses: Expense[]): string {
  const rows = [headers.map(textCell).join(',')];
  for (const expense of expenses) {
    if (!Number.isSafeInteger(expense.id)) throw new Error('费用编号超出安全范围');
    rows.push(
      [
        String(expense.id),
        textCell(expense.date),
        textCell(expense.category),
        textCell(expense.merchant),
        textCell(expense.note),
        decimal(expense.amount),
        decimal(paid(expense.id, state.batches)),
        decimal(remaining(expense, state.batches)),
        textCell(expenseStatus(expense, state.batches)),
      ].join(','),
    );
  }
  return '\uFEFF' + rows.join('\r\n') + '\r\n';
}
