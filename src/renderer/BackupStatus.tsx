import { useEffect, useState } from 'react';
import { ledgerCommand } from './ledger.ts';
import { backupStatus } from './backup-status.ts';
import type { BackupStatus as Status, BackupStatusInput } from './backup-status.ts';

// Shows when the ledger was last backed up. It reads the backup list again whenever the
// ledger changes (after loading and after each save, because the first save of the day
// makes the automatic backup), whenever the page changes (for example after 立即备份)
// and when the day changes, so “今天” stays right.
export default function BackupStatus({
  ledger,
  page,
  day,
}: {
  ledger: unknown;
  page: string;
  day: string;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let current = true;
    ledgerCommand<BackupStatusInput>({ kind: 'maintenance-info' }).then(
      (info) => current && setStatus(backupStatus(info)),
      () => current && setStatus(null),
    );
    return () => {
      current = false;
    };
  }, [ledger, page, day]);
  if (!status)
    return (
      <p className="backup-status">
        <span className="dot" />
        本地账本<small>账本和备份都在钱来文件夹里</small>
      </p>
    );
  return (
    <p
      className={`backup-status ${status.tone}`}
      role={status.tone === 'warn' ? 'alert' : undefined}
    >
      <span className="dot" />
      {status.title}
      <small>{status.detail}</small>
    </p>
  );
}
