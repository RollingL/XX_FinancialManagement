// The drawer form for a reimbursement (登记报销): choose expenses, then split the amount.
import Icon from './Icon.tsx';
import Pagination from './Pagination.tsx';
import type { Pager } from './Pagination.tsx';
import { money, paid, remaining, rowCents } from './model.ts';
import type { Batch, Expense } from './model.ts';
import { selectScope } from './records.ts';

export default function ReimburseForm({
  saveBatch,
  saving,
  pickerQuery,
  setPickerQuery,
  pickerCategory,
  setPickerCategory,
  chosen,
  chosenRemaining,
  pickerPending,
  setBatchSelection,
  pickerPages,
  batches,
  rows,
  pickerFiltered,
  expenses,
  pending,
  batchDate,
  setBatchDate,
  total,
  suggest,
  allocationPages,
  changeRow,
  error,
  close,
}: {
  saveBatch: (event: React.FormEvent) => void;
  saving: boolean;
  pickerQuery: string;
  setPickerQuery: (value: string) => void;
  pickerCategory: string;
  setPickerCategory: (value: string) => void;
  chosen: Expense[];
  chosenRemaining: number;
  pickerPending: number[];
  setBatchSelection: (ids: number[]) => void;
  pickerPages: Pager<Expense>;
  batches: Batch[];
  rows: Record<number, string>;
  pickerFiltered: Expense[];
  expenses: Expense[];
  pending: Expense[];
  batchDate: string;
  setBatchDate: (value: string) => void;
  total: string;
  suggest: (value: string) => void;
  allocationPages: Pager<Expense>;
  changeRow: (id: number, value: string) => void;
  error: string;
  close: () => void;
}) {
  return (
    <form onSubmit={saveBatch}>
      <div className="drawer-body">
        <fieldset className="expense-picker" disabled={saving}>
          <legend>1. 选择费用</legend>
          <div className="picker-filters">
            <label className="search">
              <Icon name="search" />
              <span className="sr-only">搜索报销费用</span>
              <input
                placeholder="搜索商户、摘要或备注"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
              />
            </label>
            <select
              aria-label="报销费用类别"
              value={pickerCategory}
              onChange={(e) => setPickerCategory(e.target.value)}
            >
              {['全部', '接待', '办公'].map((c) => (
                <option key={c} value={c}>
                  {c === '全部' ? '全部类别' : c}
                </option>
              ))}
            </select>
          </div>
          <div className="picker-heading">
            <span>
              跨页已选 {chosen.length} 笔 · 可登记 ¥{money(chosenRemaining)}
            </span>
            <div>
              <button
                type="button"
                className="link"
                disabled={!pickerPending.length}
                onClick={() =>
                  setBatchSelection(
                    selectScope(
                      chosen.map((e) => e.id),
                      pickerPending,
                      true,
                    ),
                  )
                }
              >
                全选筛选结果（{pickerPending.length} 笔）
              </button>
              <button
                type="button"
                className="link"
                disabled={!chosen.length}
                onClick={() => setBatchSelection([])}
              >
                清空全部选择
              </button>
            </div>
          </div>
          <p className="help">全选包含当前搜索和类别下的所有页；翻页或更改筛选不会清除已选费用。</p>
          <div className="picker-list">
            {pickerPages.items.map((e) => {
              const rest = remaining(e, batches),
                checked = Object.hasOwn(rows, e.id);
              return (
                <label
                  key={e.id}
                  className={`picker-option ${checked ? 'selected' : ''} ${rest === 0 ? 'unavailable' : ''}`}
                >
                  <input
                    type="checkbox"
                    aria-label={`报销选择费用 ${e.id} ${e.merchant}`}
                    checked={checked}
                    disabled={rest === 0}
                    onChange={() =>
                      setBatchSelection(
                        checked
                          ? chosen.filter((x) => x.id !== e.id).map((x) => x.id)
                          : [...chosen.map((x) => x.id), e.id],
                      )
                    }
                  />
                  <span className="picker-name">
                    {e.merchant}
                    <small>
                      {e.date} · {e.category}
                    </small>
                  </span>
                  <span className="picker-remaining">
                    {rest === 0 ? '已全部报销' : `待报销 ¥${money(rest)}`}
                  </span>
                </label>
              );
            })}
            {!pickerFiltered.length && (
              <p className="help">
                {expenses.length
                  ? '没有匹配的费用，请调整搜索或类别。'
                  : '账本中还没有费用，请先记录实际支出。'}
              </p>
            )}
          </div>
          <Pagination pager={pickerPages} label="报销选择" disabled={saving} />
          {!pending.length && expenses.length > 0 && (
            <p className="help">所有费用已全部报销，没有可登记的剩余额度。</p>
          )}
        </fieldset>
        <h3 className="allocation-step">2. 填写分配金额</h3>
        {!chosen.length ? (
          <p className="help selection-help">先在上方选择一笔或多笔待报销费用，再填写本次金额。</p>
        ) : (
          <>
            <div className="form-row">
              <label className="field">
                报销日期
                <input
                  type="date"
                  disabled={saving}
                  value={batchDate}
                  onChange={(e) => setBatchDate(e.target.value)}
                  required
                />
              </label>
              <label className="field">
                本次报销登记金额（元）
                <input
                  inputMode="decimal"
                  disabled={saving}
                  value={total}
                  onChange={(e) => suggest(e.target.value)}
                  required
                />
              </label>
            </div>
            <p className="help">
              新增选择默认填入该费用的剩余额度，其他行已填金额保留。改总额按费用日期从早到晚分配；改逐行金额则同步总额。
            </p>
            <div className="table-scroll">
              <table className="allocation">
                <thead>
                  <tr>
                    <th>费用 / 原额</th>
                    <th className="num">此前已报销</th>
                    <th className="num">当前待报销</th>
                    <th className="num">本次分配</th>
                    <th className="num">登记后剩余</th>
                  </tr>
                </thead>
                <tbody>
                  {allocationPages.items.map((e) => {
                    let n = 0;
                    try {
                      n = rowCents(rows[e.id] || '');
                    } catch {}
                    return (
                      <tr key={e.id}>
                        <td>
                          {e.merchant}
                          <small className="subline">
                            {e.category} · {money(e.amount)} 元
                          </small>
                        </td>
                        <td className="num">{money(paid(e.id, batches))}</td>
                        <td className="num">{money(remaining(e, batches))}</td>
                        <td>
                          <input
                            disabled={saving}
                            aria-label={`${e.merchant}本次分配`}
                            inputMode="decimal"
                            value={rows[e.id] || ''}
                            onChange={(ev) => changeRow(e.id, ev.target.value)}
                          />
                        </td>
                        <td className="num">{money(remaining(e, batches) - n)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination pager={allocationPages} label="报销分配" disabled={saving} />
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      <footer className="drawer-footer">
        <span>
          合计 <b>{total || '—'}</b> 元
        </span>
        <button type="button" onClick={close}>
          取消
        </button>
        <button className="primary" type="submit" disabled={saving || !chosen.length}>
          {saving ? '保存中…' : '确认登记'}
        </button>
      </footer>
    </form>
  );
}
