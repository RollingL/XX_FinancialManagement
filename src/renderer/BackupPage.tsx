import React, { useEffect, useRef, useState } from 'react';
import { ledgerCommand } from './ledger.ts';
import './backup.css';

type MaintenanceInfo = {
  supported: boolean;
  backupConfigured: boolean;
  canReset: boolean;
  canRestore?: boolean;
  generation?: string;
  pendingReset?: { requestId: string; fromGeneration: string } | null;
};
type Request = { requestId: string; generation: string };
type BackupResult = {
  directory: string;
  summary?: {
    expenseCount?: number;
    advanceCount?: number;
    batchCount?: number;
    attachmentFileCount?: number;
  };
};
type Activity = 'info' | 'backup' | 'reset' | 'restore' | null;
type RestorePlan = {
  token: string;
  generation: string;
  directory: string;
  createdAt: string;
  summary: NonNullable<BackupResult['summary']>;
};
const CONFIRMATION = '清空当前账本';
const message = (error: unknown) =>
  error instanceof Error ? error.message : '本地操作失败，请检查状态后重试。';

export default function BackupPage({
  onResetComplete,
}: {
  onResetComplete: (warning?: string) => void;
}) {
  const [info, setInfo] = useState<MaintenanceInfo | null>(null),
    [busy, setBusy] = useState<Activity>('info'),
    [error, setError] = useState('');
  const [backup, setBackup] = useState<BackupResult | null>(null),
    [confirming, setConfirming] = useState(false),
    [confirmation, setConfirmation] = useState('');
  const [restorePlan, setRestorePlan] = useState<RestorePlan | null>(null),
    [restoreText, setRestoreText] = useState(''),
    [restorePath, setRestorePath] = useState('');
  const restoreRequest = useRef<string | null>(null);
  const lock = useRef(false),
    mounted = useRef(true),
    backupRequest = useRef<Request | null>(null),
    resetRequest = useRef<Request | null>(null);
  const confirmationInput = useRef<HTMLInputElement>(null),
    resetComplete = useRef(onResetComplete);
  resetComplete.current = onResetComplete;
  const pending = info?.pendingReset;
  const canBackup = !!(info?.supported && info.backupConfigured && info.generation && !pending);
  const canReset = !!(info?.supported && (pending || (info.canReset && info.generation)));

  function begin(activity: Activity) {
    if (lock.current) return false;
    lock.current = true;
    if (mounted.current) setBusy(activity);
    return true;
  }
  function finish() {
    lock.current = false;
    if (mounted.current) setBusy(null);
  }
  async function readInfo() {
    const next = await ledgerCommand<MaintenanceInfo>({ kind: 'maintenance-info' });
    if (
      !next ||
      typeof next.supported !== 'boolean' ||
      typeof next.backupConfigured !== 'boolean' ||
      typeof next.canReset !== 'boolean' ||
      (next.pendingReset &&
        (typeof next.pendingReset.requestId !== 'string' ||
          typeof next.pendingReset.fromGeneration !== 'string'))
    )
      throw Error('本地维护状态无效，请检查服务后重新读取。');
    if (mounted.current) {
      setInfo(next);
      if (backupRequest.current && backupRequest.current.generation !== next.generation)
        backupRequest.current = null;
      if (next.pendingReset) {
        const request = {
          requestId: next.pendingReset.requestId,
          generation: next.pendingReset.fromGeneration,
        };
        if (
          resetRequest.current?.requestId !== request.requestId ||
          resetRequest.current?.generation !== request.generation
        )
          setConfirmation('');
        resetRequest.current = request;
        setConfirming(true);
      }
    }
    return next;
  }
  async function refresh() {
    if (!begin('info')) return;
    if (mounted.current) setError('');
    try {
      await readInfo();
    } catch (e) {
      if (mounted.current) {
        setInfo(null);
        setError(message(e));
      }
    } finally {
      finish();
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (confirming && !busy) {
      confirmationInput.current?.focus();
      confirmationInput.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [confirming, busy]);

  async function exportBackup() {
    if (!canBackup || !info?.generation || !begin('backup')) return;
    setError('');
    const request = backupRequest.current ?? {
      requestId: crypto.randomUUID(),
      generation: info.generation,
    };
    backupRequest.current = request;
    try {
      const result = await ledgerCommand<BackupResult>({ kind: 'create-backup', ...request });
      if (!result || typeof result.directory !== 'string' || !result.directory)
        throw Error('未收到完整备份的保存位置，请检查状态后重试。');
      backupRequest.current = null;
      if (mounted.current) setBackup(result);
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      finish();
    }
  }
  async function chooseRestore() {
    if (!info?.generation || !info.canRestore || !begin('restore')) return;
    setError('');
    setRestorePlan(null);
    restoreRequest.current = null;
    setRestoreText('');
    try {
      const value = await ledgerCommand<RestorePlan | null>(
        window.localLedger
          ? { kind: 'choose-restore', generation: info.generation }
          : { kind: 'prepare-restore', generation: info.generation, backup: restorePath },
      );
      if (value && mounted.current) setRestorePlan(value);
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      finish();
    }
  }
  async function confirmRestore(event: React.FormEvent) {
    event.preventDefault();
    if (!restorePlan || restoreText !== '恢复备份' || !begin('restore')) return;
    setError('');
    const requestId = restoreRequest.current ?? crypto.randomUUID();
    restoreRequest.current = requestId;
    try {
      const value = await ledgerCommand<{
        restored: boolean;
        completed: boolean;
        backupDirectory: string;
        warning?: string;
      }>({
        kind: 'restore-backup',
        requestId,
        token: restorePlan.token,
        generation: restorePlan.generation,
        confirmation: restoreText,
      });
      if (!value?.restored || !value.completed) throw Error('恢复结果未确认，请保留备份并重试');
      setBackup({ directory: value.backupDirectory });
      setRestorePlan(null);
      setRestoreText('');
      restoreRequest.current = null;
      if (value.warning) setError(value.warning);
      resetComplete.current(value.warning);
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      finish();
    }
  }
  function openConfirmation() {
    if (lock.current || !canReset) return;
    resetRequest.current = pending
      ? { requestId: pending.requestId, generation: pending.fromGeneration }
      : (resetRequest.current ?? { requestId: crypto.randomUUID(), generation: info!.generation! });
    setConfirmation('');
    setConfirming(true);
    setError('');
  }
  function cancelConfirmation() {
    if (lock.current) return;
    setConfirmation('');
    setConfirming(false);
    setError('');
    if (!pending) resetRequest.current = null;
  }
  async function reset(event: React.FormEvent) {
    event.preventDefault();
    if (confirmation !== CONFIRMATION || !canReset || !resetRequest.current || !begin('reset'))
      return;
    const request = resetRequest.current;
    setError('');
    try {
      const result = await ledgerCommand<{
        reset: boolean;
        completed: boolean;
        generation: string;
      }>({ kind: 'reset-ledger', ...request, confirmation });
      if (result?.reset !== true || result?.completed !== true)
        throw Error('本地服务尚未确认清空完成，请检查状态后重试。');
      resetRequest.current = null;
      backupRequest.current = null;
      if (mounted.current) {
        setConfirmation('');
        setConfirming(false);
        setInfo(null);
      }
      resetComplete.current();
    } catch (e) {
      const original = message(e);
      try {
        await readInfo();
        if (mounted.current) setError(`清空尚未确认完成：${original}`);
      } catch {
        if (mounted.current) {
          setInfo(null);
          setError(`清空结果未能确认：${original} 请刷新状态后重试。`);
        }
      }
    } finally {
      finish();
    }
  }

  return (
    <div className="backup-page" aria-busy={!!busy}>
      <div className="backup-status-row">
        <p>备份保存在本机。恢复或清空前，请先核对当前账本和备份内容。</p>
        <button type="button" disabled={!!busy} onClick={() => void refresh()}>
          {busy === 'info' ? '正在读取…' : '刷新状态'}
        </button>
      </div>
      {!info && !error && (
        <p className="backup-message" role="status">
          正在读取备份与数据管理状态…
        </p>
      )}
      {info && !info.supported && (
        <p className="backup-message" role="status">
          当前账本暂无法使用备份与数据管理，请保留原有文件并联系维护人员。原账本不会被改写。
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {pending && (
        <div className="backup-pending" role="alert">
          <h2>清空尚未完成</h2>
          <p>上次清空尚未确认完成，仍需后续清理与核对。记账及备份已锁定，请继续完成清空。</p>
          <p>重新输入确认文字后，将继续同一次操作。</p>
        </div>
      )}

      <section className="backup-card" aria-labelledby="backup-export-title">
        <div className="backup-card-heading">
          <h2 id="backup-export-title">完整备份</h2>
          <span className="backup-badge">本机保存</span>
        </div>
        <p>保存全部账目、开票标记和附件。升级或清空前，请先导出一份完整备份。</p>
        <div className="backup-actions">
          <button
            type="button"
            className="primary"
            disabled={!!busy || !canBackup}
            onClick={() => void exportBackup()}
          >
            {busy === 'backup' ? '正在导出…' : '导出完整备份'}
          </button>
        </div>
        {info?.supported && !info.backupConfigured && (
          <p className="backup-help">尚未设置备份保存位置，请联系维护人员检查。</p>
        )}
        {backup && (
          <div className="backup-result" role="status">
            <h3>最近保存的完整备份</h3>
            <p className="backup-location">{backup.directory}</p>
            {backup.summary && (
              <p className="backup-help">
                {[
                  ['费用', backup.summary.expenseCount, '笔'],
                  ['预支', backup.summary.advanceCount, '笔'],
                  ['报销批次', backup.summary.batchCount, '批'],
                  ['附件', backup.summary.attachmentFileCount, '个'],
                ]
                  .filter(
                    ([, value]) =>
                      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
                  )
                  .map(([label, value, unit]) => `${label} ${value} ${unit}`)
                  .join(' · ')}
              </p>
            )}
          </div>
        )}
      </section>

      <section className="backup-card" aria-labelledby="backup-restore-title">
        <div className="backup-card-heading">
          <h2 id="backup-restore-title">恢复备份</h2>
          <span className="backup-badge">先校验与预览</span>
        </div>
        <p>选择完整备份目录。恢复后切换到备份中的账本；当前账本会先自动完整备份并保留在原目录。</p>
        {!window.localLedger && (
          <label className="field">
            本机完整备份目录
            <input
              value={restorePath}
              onChange={(e) => setRestorePath(e.target.value)}
              disabled={!!busy}
              placeholder="输入完整备份文件夹的路径"
            />
          </label>
        )}
        <div className="backup-actions">
          <button
            type="button"
            disabled={
              !!busy ||
              !info?.canRestore ||
              !!pending ||
              (!window.localLedger && !restorePath.trim())
            }
            onClick={() => void chooseRestore()}
          >
            {busy === 'restore' ? '正在校验…' : '选择并校验备份'}
          </button>
        </div>
        {restorePlan && (
          <form className="backup-confirmation" onSubmit={(e) => void confirmRestore(e)}>
            <p className="backup-location">{restorePlan.directory}</p>
            <p>
              备份时间：{new Date(restorePlan.createdAt).toLocaleString()} · 费用{' '}
              {restorePlan.summary.expenseCount} 笔 · 预支 {restorePlan.summary.advanceCount} 笔 ·
              报销 {restorePlan.summary.batchCount} 批 · 附件{' '}
              {restorePlan.summary.attachmentFileCount} 个
            </p>
            <p id="restore-help">
              确认后将使用备份中的账本，当前账本另行保留。输入 <strong>恢复备份</strong>{' '}
              继续；尚未保存的内容不会保留。
            </p>
            <label className="field">
              确认文字
              <input
                value={restoreText}
                onChange={(e) => setRestoreText(e.target.value)}
                disabled={!!busy}
                autoComplete="off"
                aria-describedby="restore-help"
                placeholder="恢复备份"
              />
            </label>
            <div className="backup-actions">
              <button
                type="button"
                disabled={!!busy}
                onClick={() => {
                  setRestorePlan(null);
                  setRestoreText('');
                  restoreRequest.current = null;
                }}
              >
                取消
              </button>
              <button
                className="primary"
                type="submit"
                disabled={!!busy || restoreText !== '恢复备份'}
              >
                {busy === 'restore' ? '正在恢复…' : '备份当前账本并恢复'}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="backup-card backup-danger" aria-labelledby="backup-reset-title">
        <div className="backup-card-heading">
          <h2 id="backup-reset-title">清空所有数据</h2>
          <span className="backup-badge backup-danger-badge">不可撤销</span>
        </div>
        <p>
          清空当前账本的全部费用、预支、报销、开票标记、已保存附件和其他业务数据，资金余额归零。
        </p>
        <p className="backup-help">
          外部原图、另存备份、其他账本和软件保留。操作无法在软件内撤销。
        </p>
        {!confirming ? (
          <div className="backup-actions">
            <button
              type="button"
              disabled={!!busy || !canBackup}
              onClick={() => void exportBackup()}
            >
              先导出完整备份
            </button>
            <button
              type="button"
              className="backup-danger-button"
              disabled={!!busy || !canReset}
              onClick={openConfirmation}
            >
              {pending ? '继续完成清空' : '清空所有数据'}
            </button>
          </div>
        ) : (
          <form className="backup-confirmation" onSubmit={(event) => void reset(event)}>
            <p id="reset-confirm-help">
              {pending ? '继续完成已开始的清空操作。' : '确认后将永久清空当前账本。'}请准确输入{' '}
              <strong>{CONFIRMATION}</strong>。
            </p>
            <label className="field" htmlFor="reset-confirmation">
              确认文字
              <input
                id="reset-confirmation"
                ref={confirmationInput}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={!!busy}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="reset-confirm-help"
                placeholder={CONFIRMATION}
              />
            </label>
            <div className="backup-actions">
              <button type="button" disabled={!!busy} onClick={cancelConfirmation}>
                {pending ? '稍后处理' : '取消'}
              </button>
              <button
                type="submit"
                className="backup-danger-button"
                disabled={!!busy || !canReset || confirmation !== CONFIRMATION}
              >
                {busy === 'reset' ? '正在清空…' : pending ? '继续完成清空' : '永久清空当前账本'}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
