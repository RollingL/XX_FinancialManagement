import Icon from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import BackupStatus from './BackupStatus.tsx';
import type { LedgerState } from './ledger.ts';

// The left side bar: the pages, the 备份 entry and when the ledger was last backed up.
// `page` uses the screens' own names (全部费用 is 总览).
const PAGES: { page: string; title: string; icon: IconName }[] = [
  { page: '全部费用', title: '总览', icon: 'home' },
  { page: '接待', title: '接待费用', icon: 'meal' },
  { page: '办公', title: '办公费用', icon: 'work' },
  { page: '报销记录', title: '报销记录', icon: 'receipt' },
  { page: '预支', title: '预支', icon: 'wallet' },
];

export default function Sidebar({
  page,
  onOpen,
  ledger,
  day,
}: {
  page: string;
  onOpen: (page: string) => void;
  ledger: LedgerState;
  day: string;
}) {
  const entry = (target: string, title: string, icon: IconName) => (
    <button
      key={target}
      aria-current={page === target ? 'page' : undefined}
      className={page === target ? 'active' : ''}
      onClick={() => onOpen(target)}
    >
      <Icon name={icon} />
      <span>{title}</span>
    </button>
  );
  return (
    <aside className="sidebar">
      <div className="brand">
        钱来<small>财务管理系统</small>
      </div>
      <nav aria-label="主导航">{PAGES.map((item) => entry(item.page, item.title, item.icon))}</nav>
      <div className="sidebar-bottom">
        {entry('备份', '备份', 'backup')}
        <BackupStatus ledger={ledger} page={page} day={day} />
      </div>
    </aside>
  );
}
