// The short backup note at the bottom of the side bar.
export type BackupStatusInput = {
  automaticBackupError: string | null;
  backups: { createdAt: string }[];
};
export type BackupStatus = { tone: 'ok' | 'warn'; title: string; detail: string };

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

// “今天 09:30”, “昨天 09:30”, “11月20日 09:30”, or with the year when it differs.
export function backupMoment(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(date) === dayKey(now)) return `今天 ${time}`;
  if (dayKey(date) === dayKey(yesterday)) return `昨天 ${time}`;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${time}`
    : `${date.getFullYear()}年${day}`;
}

export function backupStatus(info: BackupStatusInput, now = new Date()): BackupStatus {
  if (info.automaticBackupError)
    return { tone: 'warn', title: '自动备份没有完成', detail: '请打开“备份”页查看' };
  const latest = info.backups
    .map((item) => item.createdAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort()
    .at(-1);
  if (!latest) return { tone: 'ok', title: '还没有备份', detail: '记第一笔账后会自动备份' };
  return { tone: 'ok', title: '上次备份', detail: backupMoment(latest, now) };
}
