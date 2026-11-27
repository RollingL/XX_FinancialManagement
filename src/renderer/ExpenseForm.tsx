// The drawer form for a new expense (记一笔费用).
import ScreenshotPicker from './Screenshot.tsx';
import { money } from './model.ts';
import type { Category } from './model.ts';

export default function ExpenseForm({
  saveExpense,
  setAttachment,
  setImageBusy,
  saving,
  imageBusy,
  newCategory,
  setNewCategory,
  amount,
  setAmount,
  date,
  setDate,
  merchant,
  setMerchant,
  note,
  setNote,
  after,
  error,
  close,
}: {
  saveExpense: (event: React.FormEvent) => void;
  setAttachment: (file: File | null) => void;
  setImageBusy: (busy: boolean) => void;
  saving: boolean;
  imageBusy: boolean;
  newCategory: Category;
  setNewCategory: (category: Category) => void;
  amount: string;
  setAmount: (value: string) => void;
  date: string;
  setDate: (value: string) => void;
  merchant: string;
  setMerchant: (value: string) => void;
  note: string;
  setNote: (value: string) => void;
  after: number | null;
  error: string;
  close: () => void;
}) {
  return (
    <form onSubmit={saveExpense}>
      <div className="drawer-body">
        <ScreenshotPicker onFile={setAttachment} onBusy={setImageBusy} disabled={saving} />
        <fieldset className="expense-fields" disabled={saving || imageBusy}>
          <div className="segmented" role="group" aria-label="费用类别">
            {(['接待', '办公'] as const).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={newCategory === c}
                className={newCategory === c ? 'active' : ''}
                onClick={() => setNewCategory(c)}
              >
                {c}费用
              </button>
            ))}
          </div>
          <label className="field">
            实际支出金额（元）
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              className="amount-input"
            />
          </label>
          <label className="field">
            实际支出日期
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            {newCategory === '接待' ? '商户' : '采购摘要'}
            <input
              required
              maxLength={100}
              placeholder={newCategory === '接待' ? '例如：青禾餐厅' : '例如：打印纸及墨盒'}
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
            />
          </label>
          <details>
            <summary>补充备注</summary>
            <label className="field">
              <span className="sr-only">备注</span>
              <textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </label>
          </details>
          {newCategory === '办公' && (
            <p className="help">每笔采购填写摘要与实际付款总额；物品名称可补充在备注中。</p>
          )}
          <div className="calculation">
            <span>保存后资金余额</span>
            <strong>{after === null ? '填写金额后计算' : `${money(after)} 元`}</strong>
            {after !== null && after < 0 && (
              <small>本人垫付 {money(-after)} 元，允许继续登记。</small>
            )}
          </div>
        </fieldset>
        <p className="help">请确认金额、日期和商户。截图仅作为支付凭证；取消不会保存。</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <footer className="drawer-footer">
        <button type="button" onClick={close}>
          取消
        </button>
        <button className="primary" disabled={saving || imageBusy} type="submit">
          {saving ? '保存中…' : '确认并保存费用'}
        </button>
      </footer>
    </form>
  );
}
