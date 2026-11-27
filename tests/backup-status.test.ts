// The backup note in the side bar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backupMoment, backupStatus } from '../src/renderer/backup-status.ts';

const now = new Date(2026, 10, 27, 20, 15);
const at = (...parts: number[]) =>
  new Date(...(parts as [number, number, number, number, number])).toISOString();

test('backup times read as today, yesterday, a date this year, or a date with the year', () => {
  assert.equal(backupMoment(at(2026, 10, 27, 9, 5), now), '今天 09:05');
  assert.equal(backupMoment(at(2026, 10, 26, 23, 59), now), '昨天 23:59');
  assert.equal(backupMoment(at(2026, 0, 3, 8, 0), now), '1月3日 08:00');
  assert.equal(backupMoment(at(2025, 11, 31, 8, 0), now), '2025年12月31日');
  assert.equal(backupMoment('不是时间', now), '时间未知');
  // Yesterday across a month boundary.
  assert.equal(backupMoment(at(2026, 10, 30, 18, 0), new Date(2026, 11, 1, 9, 0)), '昨天 18:00');
});

test('the side bar shows the newest backup, a missing backup, or a failed automatic backup', () => {
  const backups = [
    { createdAt: at(2026, 10, 20, 9, 30) },
    { createdAt: at(2026, 10, 27, 8, 45) },
    { createdAt: 'damaged' },
  ];
  assert.deepEqual(backupStatus({ automaticBackupError: null, backups }, now), {
    tone: 'ok',
    title: '上次备份',
    detail: '今天 08:45',
  });
  assert.deepEqual(backupStatus({ automaticBackupError: null, backups: [] }, now), {
    tone: 'ok',
    title: '还没有备份',
    detail: '记第一笔账后会自动备份',
  });
  assert.deepEqual(
    backupStatus({ automaticBackupError: '自动备份没有完成：磁盘已满', backups }, now),
    { tone: 'warn', title: '自动备份没有完成', detail: '请打开“备份”页查看' },
  );
});
