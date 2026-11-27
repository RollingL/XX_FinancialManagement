// The expense pages (总览, 接待费用, 办公费用): filters, the list, and the 待处理 panel.
import Icon from './Icon.tsx';
import Pagination from './Pagination.tsx';
import type { Pager } from './Pagination.tsx';
import { money, paid, remaining, sum } from './model.ts';
import type { Batch, Expense } from './model.ts';
import { selectScope } from './records.ts';

export default function ExpenseList({
  category,
  isOverview,
  visible,
  expenses,
  batches,
  loaded,
  filterError,
  query,
  setQuery,
  startDate,
  setStartDate,
  endDate,
  setEndDate,
  status,
  setStatus,
  expensePages,
  pagePending,
  selected,
  setSelected,
  toggle,
  openDetail,
  openNew,
  openReimburse,
  exportExpenses,
  listChosenRemaining,
  label,
}: {
  category: string;
  isOverview: boolean;
  visible: Expense[];
  expenses: Expense[];
  batches: Batch[];
  loaded: boolean;
  filterError: string;
  query: string;
  setQuery: (value: string) => void;
  startDate: string;
  setStartDate: (value: string) => void;
  endDate: string;
  setEndDate: (value: string) => void;
  status: string;
  setStatus: (value: string) => void;
  expensePages: Pager<Expense>;
  pagePending: number[];
  selected: number[];
  setSelected: (ids: number[]) => void;
  toggle: (id: number) => void;
  openDetail: (id: number) => void;
  openNew: () => void;
  openReimburse: (ids?: number[]) => void;
  exportExpenses: () => void;
  listChosenRemaining: number;
  label: (expense: Expense) => string;
}) {
  return (
    <section className="workspace expense-workspace" aria-label="费用列表">
      <div className="workspace-heading">
        <div className="expense-heading-title">
          <h2>{category === '全部费用' ? '费用记录' : `${category}记录`}</h2>
          <span>{visible.length} 笔</span>
        </div>
        <button
          className="expense-export-button"
          disabled={!loaded || !!filterError || !visible.length}
          aria-describedby="expense-export-scope"
          onClick={exportExpenses}
        >
          导出当前筛选 CSV
        </button>
      </div>
      <div className="filters expense-filters">
        <label className="search">
          <Icon name="search" />
          <span className="sr-only">搜索商户、摘要、备注或编号</span>
          <input
            placeholder="搜索商户、摘要、备注或编号"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="expense-date-filter">
          支出开始日期
          <input
            aria-label="支出开始日期"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
        <label className="expense-date-filter">
          支出结束日期
          <input
            aria-label="支出结束日期"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </label>
        <select
          aria-label="报销状态筛选"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {['全部状态', '未报销', '部分报销', '已报销'].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
        {(query || startDate || endDate || status !== '全部状态') && (
          <button
            className="link"
            onClick={() => {
              setQuery('');
              setStartDate('');
              setEndDate('');
              setStatus('全部状态');
            }}
          >
            清除筛选
          </button>
        )}
      </div>
      {filterError && (
        <p className="error expense-filter-error" role="alert">
          {filterError}
        </p>
      )}
      <p className="expense-export-scope" id="expense-export-scope">
        导出当前类别及筛选后的全部 {visible.length} 笔，包含所有页，与勾选无关。CSV
        仅含费用明细，不含附件，也不是完整备份。
      </p>
      <div className="table-scroll">
        <table className={`expense-table ${isOverview ? 'overview-table' : ''}`}>
          <thead>
            <tr>
              {!isOverview && (
                <th className="check-cell">
                  <input
                    type="checkbox"
                    aria-label="选择本页待报销费用"
                    checked={
                      pagePending.length > 0 && pagePending.every((id) => selected.includes(id))
                    }
                    disabled={!pagePending.length}
                    onChange={(ev) =>
                      setSelected(selectScope(selected, pagePending, ev.target.checked))
                    }
                  />
                </th>
              )}
              <th>费用</th>
              <th className="num">支出金额</th>
              <th>报销进度</th>
              <th>
                <span className="sr-only">详情</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {expensePages.items.map((e) => (
              <tr
                key={e.id}
                className={!isOverview && selected.includes(e.id) ? 'selected' : ''}
                onClick={(event) => {
                  if (
                    isOverview &&
                    !(event.target as Element).closest('button,input,label,a,select,textarea')
                  )
                    openDetail(e.id);
                }}
              >
                {!isOverview && (
                  <td>
                    <input
                      aria-label={`选择费用 ${e.id}`}
                      type="checkbox"
                      checked={selected.includes(e.id)}
                      disabled={remaining(e, batches) === 0}
                      onChange={() => toggle(e.id)}
                    />
                  </td>
                )}
                <td>
                  <div className="expense-info">
                    <span className={`icon-disc ${e.category === '办公' ? 'blue' : ''}`}>
                      <Icon name={e.category === '办公' ? 'work' : 'meal'} />
                    </span>
                    <div>
                      <button className="expense-name" onClick={() => openDetail(e.id)}>
                        {e.merchant}
                      </button>
                      <small className="subline">
                        {e.date} · {e.category} · #{e.id}
                      </small>
                    </div>
                  </div>
                </td>
                <td className="num amount">¥{money(e.amount)}</td>
                <td>
                  <span
                    className={`status ${label(e) === '已报销' ? 'done' : label(e) === '部分报销' ? 'partial' : ''}`}
                  >
                    {label(e)}
                  </span>
                  <small className="subline">
                    待 ¥{money(remaining(e, batches))} · 已 ¥{money(paid(e.id, batches))}
                  </small>
                </td>
                <td>
                  <button
                    className="row-detail"
                    aria-label={`查看费用 ${e.id} 详情`}
                    onClick={() => openDetail(e.id)}
                  >
                    <Icon name="chevron" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length && (
          <div className="empty">
            <span className="icon-disc">
              <Icon name="receipt" />
            </span>
            <h2>{expenses.length ? '没有符合条件的费用' : '从第一笔费用开始'}</h2>
            <p>
              {expenses.length
                ? '调整筛选条件，或记录一笔新费用。'
                : '填写金额、日期和商户，可附上支付截图作为凭证。以前用过钱来？到“备份”页从旧文件夹导入账本。'}
            </p>
            <button disabled={!loaded} onClick={() => openNew()}>
              新增费用
            </button>
          </div>
        )}
      </div>
      <Pagination pager={expensePages} label="费用列表" />
      <footer className="table-footer">
        <span>
          筛选结果 {visible.length} 笔 · 支出合计 <b>¥{money(sum(visible.map((e) => e.amount)))}</b>
        </span>
        <span>人民币元</span>
      </footer>
      {!isOverview && (
        <div className="selection-bar">
          <span>
            {selected.length ? (
              <>
                已选 <b>{selected.length}</b> 笔 · 待报销 <b>¥{money(listChosenRemaining)}</b>
              </>
            ) : (
              '勾选费用，可合并登记报销'
            )}
          </span>
          <div>
            {selected.length > 0 && <button onClick={() => setSelected([])}>取消选择</button>}
            <button
              className="primary"
              disabled={!selected.length || listChosenRemaining === 0}
              onClick={() => openReimburse(selected)}
            >
              登记报销
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function PendingTasks({
  pending,
  batches,
  openReimburse,
}: {
  pending: Expense[];
  batches: Batch[];
  openReimburse: () => void;
}) {
  return (
    <aside className="tasks" aria-label="待处理">
      <h2>待处理</h2>
      <div className="task-item">
        <span className="icon-disc">
          <Icon name="receipt" />
        </span>
        <div>
          <h3>{pending.length} 笔费用待报销</h3>
          <p>其中 {pending.filter((e) => paid(e.id, batches) > 0).length} 笔部分报销</p>
          <button
            className="soft-button"
            disabled={!pending.length}
            onClick={() => openReimburse()}
          >
            选择费用并登记 <span aria-hidden="true">→</span>
          </button>
          <small>在报销面板中选择费用及金额</small>
        </div>
      </div>
      <div className="rule">
        <Icon name="bulb" />
        <div>
          <h3>资金与报销分开记录</h3>
          <p>公司到账统一记预支，报销只更新报账进度，不增加余额。</p>
        </div>
      </div>
    </aside>
  );
}
