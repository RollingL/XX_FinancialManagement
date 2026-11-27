// The 预支 page: every advance that arrived, newest first.
import Icon from './Icon.tsx';
import Pagination from './Pagination.tsx';
import type { Pager } from './Pagination.tsx';
import { money, sum } from './model.ts';
import type { LedgerState } from './ledger.ts';

export default function AdvanceList({
  state,
  advancePages,
  loaded,
  openAdvance,
  openAdvanceDetail,
}: {
  state: LedgerState;
  advancePages: Pager<{ value: number; index: number }>;
  loaded: boolean;
  openAdvance: () => void;
  openAdvanceDetail: (index: number) => void;
}) {
  const { advances } = state;
  return (
    <section className="workspace advance-workspace" aria-label="预支到账记录">
      <div className="workspace-heading">
        <h2>到账记录</h2>
        <span>
          {advances.filter((_, index) => !state.advanceDetails?.[index]?.deleted).length} 笔
        </span>
      </div>
      <p className="advance-help">
        只登记公司已经实际拨入的款项；每笔到账增加同一资金余额，不自动核销费用。
      </p>
      <div className="table-scroll">
        <table className="advance-table">
          <thead>
            <tr>
              <th>编号 / 到账日期</th>
              <th className="num">到账金额</th>
              <th>备注</th>
              <th>记录时间</th>
              <th>到账截图</th>
            </tr>
          </thead>
          <tbody>
            {advancePages.items.map(({ value, index }) => {
              const info = state.advanceDetails?.[index];
              return (
                <tr key={index}>
                  <td>
                    <button
                      className="expense-name"
                      aria-label={`查看预支 ${index + 1} 详情`}
                      onClick={() => openAdvanceDetail(index)}
                    >
                      YZ-{String(index + 1).padStart(3, '0')}
                    </button>
                    <small className="subline">{info?.date ?? '日期未记录'}</small>
                  </td>
                  <td className="num">+¥{money(value)}</td>
                  <td className="advance-note">
                    {info ? info.note || '—' : '旧记录，仅保留原金额'}
                  </td>
                  <td className="muted">
                    {info?.createdAt
                      ? new Date(info.createdAt).toLocaleString('zh-CN', { hour12: false })
                      : '未记录'}
                  </td>
                  <td>
                    {info?.attachmentId ? (
                      <button
                        className="link"
                        aria-label={`查看预支 ${index + 1} 到账截图`}
                        onClick={() => openAdvanceDetail(index)}
                      >
                        查看截图
                      </button>
                    ) : (
                      <span className="muted">未附截图</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!advances.length && (
          <div className="empty">
            <span className="icon-disc">
              <Icon name="wallet" />
            </span>
            <h2>还没有预支到账</h2>
            <p>公司实际拨款后，再登记金额和到账日期。</p>
            <button disabled={!loaded} onClick={openAdvance}>
              登记预支到账
            </button>
          </div>
        )}
      </div>
      <Pagination pager={advancePages} label="预支到账" />
      <footer className="table-footer">
        <span>
          累计预支 <b>¥{money(sum(advances))}</b>
        </span>
        <span>人民币元</span>
      </footer>
      <p className="advance-help">
        到账记录可编辑，误填记录可删除，修改记录与截图会保留。实际退还预支暂不支持，请勿通过修改或删除到账记录代替。
      </p>
    </section>
  );
}
