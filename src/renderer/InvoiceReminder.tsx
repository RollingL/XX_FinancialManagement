import React, { useRef, useState } from 'react';
import { ledgerCommand } from './ledger.ts';
import type { LedgerState } from './ledger.ts';
import type { Expense } from './model.ts';
import { expenseRevision } from './expense-correction.ts';
import './invoice-reminder.css';

type ReminderCommand = {
  kind: 'set-invoice-issued';
  requestId: string;
  id: number;
  expected: Expense;
  expectedRevision: number;
  invoiceIssued: boolean;
};
export default function InvoiceReminder({
  state,
  expense,
  onState,
  onBusy,
  disabled,
}: {
  state: LedgerState;
  expense: Expense;
  onState: (state: LedgerState) => void;
  onBusy: (busy: boolean) => void;
  disabled: boolean;
}) {
  const [pending, setPending] = useState<ReminderCommand | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function save(request: ReminderCommand) {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setPending(request);
    setError('');
    try {
      onState(await ledgerCommand(request));
      setPending(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <section className="invoice-reminder" aria-label="开票提醒" aria-busy={busy}>
      <label>
        <input
          type="checkbox"
          checked={expense.invoiceIssued === true}
          disabled={disabled || busy || !!pending}
          onChange={(event) =>
            void save({
              kind: 'set-invoice-issued',
              requestId: crypto.randomUUID(),
              id: expense.id,
              expected: structuredClone(expense),
              expectedRevision: expenseRevision(state, expense.id),
              invoiceIssued: event.target.checked,
            })
          }
        />
        <span>是否已开票</span>
      </label>
      <p className="help">仅作提醒，勾选或取消后自动保存。</p>
      <p className="reminder-status" role="status">
        {busy
          ? '正在保存…'
          : error
            ? '尚未确认保存'
            : expense.invoiceIssued === true
              ? '已标记开票'
              : '未标记已开票'}
      </p>
      {error && (
        <div>
          <p role="alert" className="error">
            {error}
          </p>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => pending && void save(pending)}
          >
            重试保存
          </button>
          <p className="help">若提示费用已变化，请刷新页面后重新核对。</p>
        </div>
      )}
    </section>
  );
}
