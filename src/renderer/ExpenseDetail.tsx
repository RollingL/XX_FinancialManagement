// The drawer with one expense: amounts, screenshot, invoice reminder, correction, deletion and reimbursement history.
import Pagination from './Pagination.tsx';
import type { Pager } from './Pagination.tsx';
import { SavedScreenshot } from './Screenshot.tsx';
import InvoiceReminder from './InvoiceReminder.tsx';
import { CancelConfirmation } from './ReimbursementRecords.tsx';
import { ExpenseCorrectionHistory } from './ExpenseCorrection.tsx';
import { money, paid, remaining, sum } from './model.ts';
import type { Batch, Expense } from './model.ts';
import type { LedgerState } from './ledger.ts';

export default function ExpenseDetail({
  current,
  batches,
  state,
  setState,
  setBusy,
  saving,
  currentRestriction,
  openCorrection,
  askExpenseDelete,
  expenseDeletion,
  setExpenseDeletion,
  bal,
  deleteExpense,
  historyPages,
  history,
  askCancel,
  cancelId,
  keepBatch,
  cancelBatch,
  error,
  returnBatchId,
  openBatchDetail,
  close,
}: {
  current: Expense;
  batches: Batch[];
  state: LedgerState;
  setState: (state: LedgerState) => void;
  setBusy: (busy: boolean) => void;
  saving: boolean;
  currentRestriction: string | null;
  openCorrection: () => void;
  askExpenseDelete: () => void;
  expenseDeletion: object | null;
  setExpenseDeletion: (value: null) => void;
  bal: number;
  deleteExpense: () => Promise<void>;
  historyPages: Pager<Batch>;
  history: Batch[];
  askCancel: (id: number) => void;
  cancelId: number | null;
  keepBatch: () => void;
  cancelBatch: () => Promise<void>;
  error: string;
  returnBatchId: number | null;
  openBatchDetail: (id: number) => void;
  close: () => void;
}) {
  return (
    <div>
      <div className="drawer-body">
        <span className="muted">
          {current.category}费用 · #{current.id}
        </span>
        <h3 className="detail-merchant">{current.merchant}</h3>
        <div className="detail-amount">
          {money(current.amount)}
          <small> 元</small>
        </div>
        <dl>
          <div>
            <dt>实际付款日期</dt>
            <dd>{current.date}</dd>
          </div>
          <div>
            <dt>已报销</dt>
            <dd>{money(paid(current.id, batches))} 元</dd>
          </div>
          <div>
            <dt>待报销</dt>
            <dd>{money(remaining(current, batches))} 元</dd>
          </div>
        </dl>
        <p className="help">{current.note}</p>
        {current.attachmentId && (
          <SavedScreenshot key={current.attachmentId} id={current.attachmentId} />
        )}
        <InvoiceReminder
          key={current.id}
          state={state}
          expense={current}
          onState={setState}
          onBusy={setBusy}
          disabled={saving}
        />
        <section className="correction-entry" aria-label="费用纠错">
          <button
            disabled={saving || !!currentRestriction}
            aria-describedby="correction-eligibility"
            onClick={openCorrection}
          >
            纠正录入错误
          </button>
          <p className="help" id="correction-eligibility">
            {currentRestriction ||
              '可修正金额、日期、类别、商户或备注，保留原编号和附件；纠错不能代替实际退款。'}
          </p>
          <button
            className="danger-button"
            disabled={saving || paid(current.id, batches) > 0}
            onClick={askExpenseDelete}
          >
            删除费用记录
          </button>
          <p className="help">
            {paid(current.id, batches) > 0
              ? '存在有效报销分配，需先自行撤销相关批次后才可删除。'
              : '删除用于纠正误填，会移除此笔支出并重新计算余额，不代表实际退款。'}
          </p>
          {expenseDeletion && (
            <div className="cancel-confirm" role="alert">
              <p>
                确认删除费用 #{current.id}（¥{money(current.amount)}）？删除后余额为 ¥
                {money(sum([bal, current.amount]))}
                。历史审计和图片保留；不会撤销其他报销批次。
              </p>
              <button disabled={saving} onClick={() => setExpenseDeletion(null)}>
                保留费用
              </button>
              <button disabled={saving} onClick={() => void deleteExpense()}>
                确认删除费用
              </button>
            </div>
          )}
        </section>
        <h3>报销历史</h3>
        {historyPages.items.map((b) => (
          <div className="history" key={b.id}>
            <div>
              <strong>
                BX-{String(b.id).padStart(3, '0')} <small>{b.active ? '有效' : '已撤销'}</small>
              </strong>
              <p>
                {b.date} · 本费用分配{' '}
                {money(b.allocations.find((a) => a.expenseId === current.id)!.amount)} 元
              </p>
            </div>
            {b.active && (
              <button className="link" disabled={saving} onClick={() => askCancel(b.id)}>
                撤销整批
              </button>
            )}
          </div>
        ))}
        <Pagination pager={historyPages} label="报销历史" disabled={saving} />
        {!history.length && <p className="help">暂无报销分配记录。</p>}
        {cancelId !== null && (
          <CancelConfirmation
            id={cancelId}
            saving={saving}
            onKeep={keepBatch}
            onConfirm={() => void cancelBatch()}
          />
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <ExpenseCorrectionHistory state={state} expenseId={current.id} disabled={saving} />
        <p className="help">报销状态根据有效分配自动更新，不改变资金余额。</p>
      </div>
      <footer className="drawer-footer">
        {returnBatchId !== null && (
          <button disabled={saving} onClick={() => openBatchDetail(returnBatchId)}>
            返回报销批次
          </button>
        )}
        <button onClick={close}>返回列表</button>
      </footer>
    </div>
  );
}
