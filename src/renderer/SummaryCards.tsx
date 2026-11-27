// The three totals at the top of each page: balance, spending and what is left to reimburse.
import Icon from './Icon.tsx';
import { money } from './model.ts';
import type { Category } from './model.ts';
import type { expenseSummary } from './expense-summary.ts';

export default function SummaryCards({
  bal,
  spendingCategory,
  spending,
  outstanding,
}: {
  bal: number;
  spendingCategory: Category | null;
  spending: ReturnType<typeof expenseSummary>;
  outstanding: number;
}) {
  return (
    <section className="summary" aria-label="资金与费用统计">
      <div className="summary-card balance-card">
        <div className="metric">
          <span className="icon-disc">
            <Icon name="wallet" />
          </span>
          <div>
            <h2>
              预支资金余额 <small>全账本</small>
            </h2>
            <strong>
              {bal < 0 ? '−' : ''}
              <span className="currency">¥</span>
              {money(Math.abs(bal))}
            </strong>
            {bal < 0 && <p>本人垫付 ¥{money(-bal)}</p>}
          </div>
        </div>
      </div>
      <div className="summary-card">
        <div className="metric">
          <span className="icon-disc mint">
            <Icon name="chart" />
          </span>
          <div>
            <h2>
              {spendingCategory ? `${spendingCategory}费用支出` : '总费用支出'}{' '}
              <small>全部时间</small>
            </h2>
            <strong>
              <span className="currency">¥</span>
              {money(spendingCategory ? spending.byCategory[spendingCategory] : spending.total)}
            </strong>
          </div>
        </div>
      </div>
      <div className="summary-card">
        <div className="metric">
          <span className="icon-disc peach">
            <Icon name="clock" />
          </span>
          <div>
            <h2>
              待报销 <small>报账进度</small>
            </h2>
            <strong>
              <span className="currency">¥</span>
              {money(outstanding)}
            </strong>
          </div>
        </div>
      </div>
    </section>
  );
}
