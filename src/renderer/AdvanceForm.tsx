// The drawer form for a new advance (登记预支到账).
import ScreenshotPicker from './Screenshot.tsx';
import { money } from './model.ts';

export default function AdvanceForm({
  saveAdvance,
  setAttachment,
  setImageBusy,
  saving,
  imageBusy,
  amount,
  setAmount,
  date,
  setDate,
  note,
  setNote,
  setError,
  afterAdvance,
  error,
  close,
}: {
  saveAdvance: (event: React.FormEvent) => void;
  setAttachment: (file: File | null) => void;
  setImageBusy: (busy: boolean) => void;
  saving: boolean;
  imageBusy: boolean;
  amount: string;
  setAmount: (value: string) => void;
  date: string;
  setDate: (value: string) => void;
  note: string;
  setNote: (value: string) => void;
  setError: (value: string) => void;
  afterAdvance: number | null;
  error: string;
  close: () => void;
}) {
  return (
    <form onSubmit={saveAdvance}>
      <div className="drawer-body">
        <ScreenshotPicker
          kind="advance"
          onFile={setAttachment}
          onBusy={setImageBusy}
          disabled={saving}
        />
        <fieldset className="expense-fields" disabled={saving || imageBusy}>
          <label className="field">
            实际到账金额（元）
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setError('');
              }}
              required
              className="amount-input"
            />
          </label>
          <label className="field">
            实际到账日期
            <input
              type="date"
              required
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setError('');
              }}
            />
          </label>
          <label className="field">
            备注（选填）
            <textarea
              value={note}
              maxLength={500}
              placeholder="例如：公司补充业务资金"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="calculation">
            <span>登记后资金余额</span>
            <strong>
              {afterAdvance === null ? '填写有效金额后计算' : `${money(afterAdvance)} 元`}
            </strong>
            {afterAdvance !== null && afterAdvance < 0 && (
              <small>本人垫付 {money(-afterAdvance)} 元</small>
            )}
          </div>
        </fieldset>
        <p className="help">
          请核对实际到账金额与日期。登记只保存本地记录，不发起转账，也不会自动报销费用。
        </p>
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
        <button type="submit" className="primary" disabled={saving || imageBusy}>
          {saving ? '保存中…' : '确认登记到账'}
        </button>
      </footer>
    </form>
  );
}
