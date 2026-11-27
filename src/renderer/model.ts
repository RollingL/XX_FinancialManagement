export type Category = '接待' | '办公';
export type Expense = {
  id: number;
  date: string;
  category: Category;
  merchant: string;
  amount: number;
  invoice: number;
  invoiceIssued?: boolean;
  note: string;
  attachmentId?: string;
};
export type Allocation = { expenseId: number; amount: number };
export type Batch = {
  id: number;
  date: string;
  allocations: Allocation[];
  active: boolean;
  invoiceLinks?: { invoiceId: number; expenseIds: number[] }[];
};
export function decimal(value: number) {
  if (!Number.isSafeInteger(value)) throw new Error('金额超出安全范围');
  const absolute = BigInt(value) < 0n ? -BigInt(value) : BigInt(value);
  return `${value < 0 ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
export function money(value: number) {
  const [whole, fraction] = decimal(value).split('.');
  const grouped = BigInt(whole.replace('-', '')).toLocaleString('zh-CN');
  return `${value < 0 ? '-' : ''}${grouped}.${fraction}`;
}
export function cents(text: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(text.trim())) throw new Error('请输入金额，最多保留两位小数');
  const [yuan, decimal = ''] = text.trim().split('.');
  const value = Number(BigInt(yuan) * 100n + BigInt(decimal.padEnd(2, '0')));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('金额须大于 0 且在安全范围内');
  return value;
}
export const rowCents = (value: string) =>
  value.trim() === '' || /^0(\.0{1,2})?$/.test(value.trim()) ? 0 : cents(value);
export function sum(values: number[]) {
  const total = values.reduce((a, b) => a + BigInt(b), 0n);
  const n = Number(total);
  if (!Number.isSafeInteger(n)) throw new Error('金额合计超出安全范围');
  return n;
}
export const paid = (id: number, batches: Batch[], exclude?: number) =>
  sum(
    batches
      .filter((b) => b.active && b.id !== exclude)
      .flatMap((b) => b.allocations.filter((a) => a.expenseId === id).map((a) => a.amount)),
  );
export const remaining = (expense: Expense, batches: Batch[], exclude?: number) =>
  expense.amount - paid(expense.id, batches, exclude);
export const balance = (expenses: Expense[], advances: number[]) =>
  sum([...advances, ...expenses.map((e) => -e.amount)]);
export function allocate(total: number, expenses: Expense[], batches: Batch[]): Allocation[] {
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('本次登记金额须大于 0');
  if (total > sum(expenses.map((e) => remaining(e, batches))))
    throw new Error('本次登记金额超过所选费用的待报销合计');
  let rest = total;
  return [...expenses]
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
    .flatMap((e) => {
      const amount = Math.min(rest, remaining(e, batches));
      rest -= amount;
      return amount > 0 ? [{ expenseId: e.id, amount }] : [];
    });
}
export function validateAllocation(rows: Allocation[], expenses: Expense[], batches: Batch[]) {
  if (!rows.length) throw new Error('请至少填写一笔分配');
  const seen = new Set<number>();
  for (const row of rows) {
    const e = expenses.find((e) => e.id === row.expenseId);
    if (!e || seen.has(row.expenseId)) throw new Error('费用不存在或重复分配');
    seen.add(row.expenseId);
    if (!Number.isSafeInteger(row.amount) || row.amount <= 0 || row.amount > remaining(e, batches))
      throw new Error(`费用 #${row.expenseId} 的分配超过待报销额或金额无效`);
  }
  return sum(rows.map((a) => a.amount));
}
