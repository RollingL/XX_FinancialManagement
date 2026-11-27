import React, { useEffect, useRef, useState } from 'react';
import { ledgerCommand } from './ledger.ts';
import './backup.css';

type Summary = {
  expenseCount: number;
  advanceCount: number;
  batchCount: number;
  attachmentCount: number;
};
export type BackupItem = {
  name: string;
  directory: string;
  kind: string;
  kindLabel: string;
  createdAt: string;
  summary: Summary | null;
  missingAttachmentCount: number;
  olderFormat: boolean;
};
export type MaintenanceInfo = {
  generation: string;
  version?: string;
  home: string;
  dataDir: string;
  backupDir: string;
  empty: boolean;
  keepAutomaticBackups: number;
  automaticBackupError: string | null;
  backups: BackupItem[];
};
type RestorePlan = {
  token: string;
  generation: string;
  sourceType: 'backup' | 'data';
  location: string;
  createdAt: string | null;
  kindLabel: string | null;
  summary: Summary;
  missingAttachmentCount: number;
  upgradedFrom: number | null;
};
type Activity = 'info' | 'backup' | 'external' | 'reset' | 'restore' | 'folder' | null;
type ExternalBackup = BackupItem & { external: true; sameDisk: boolean };
const RESET_CONFIRMATION = '清空当前账本';
const RESTORE_CONFIRMATION = '恢复备份';
const SHOWN_BACKUPS = 8;
const message = (error: unknown) =>
  error instanceof Error ? error.message : '本地操作失败，请检查后重试。';

export function backupTime(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
export function summaryLine(summary: Summary | null) {
  if (!summary) return '较早版本的格式，恢复时会自动升级';
  return (
    `费用 ${summary.expenseCount} 笔 · 预支 ${summary.advanceCount} 笔 · ` +
    `报销 ${summary.batchCount} 批 · 截图 ${summary.attachmentCount} 张`
  );
}
function validInfo(value: unknown): value is MaintenanceInfo {
  const info = value as MaintenanceInfo;
  return (
    !!info &&
    typeof info.generation === 'string' &&
    typeof info.home === 'string' &&
    typeof info.backupDir === 'string' &&
    Array.isArray(info.backups)
  );
}

export default function BackupPage({
  onLedgerReplaced,
}: {
  onLedgerReplaced: (notice: string) => void;
}) {
  const desktop = !!window.localLedger;
  const [info, setInfo] = useState<MaintenanceInfo | null>(null),
    [busy, setBusy] = useState<Activity>('info'),
    [error, setError] = useState(''),
    [done, setDone] = useState(''),
    [external, setExternal] = useState<ExternalBackup | null>(null);
  const [showAll, setShowAll] = useState(false),
    [sourcePath, setSourcePath] = useState('');
  const [plan, setPlan] = useState<RestorePlan | null>(null),
    [restoreText, setRestoreText] = useState('');
  const [confirmingReset, setConfirmingReset] = useState(false),
    [resetText, setResetText] = useState('');
  const lock = useRef(false),
    mounted = useRef(true),
    backupRequest = useRef<string | null>(null),
    externalRequest = useRef<string | null>(null),
    restoreRequest = useRef<string | null>(null),
    resetRequest = useRef<string | null>(null),
    planRef = useRef<HTMLFormElement>(null),
    resetInput = useRef<HTMLInputElement>(null),
    replaced = useRef(onLedgerReplaced);
  replaced.current = onLedgerReplaced;

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
    if (!validInfo(next)) throw Error('没有读到备份信息，请稍后重试。');
    if (mounted.current) setInfo(next);
    return next;
  }
  async function refresh() {
    if (!begin('info')) return;
    setError('');
    try {
      await readInfo();
    } catch (e) {
      if (mounted.current) setError(message(e));
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
    if (plan) planRef.current?.scrollIntoView({ block: 'nearest' });
  }, [plan]);
  useEffect(() => {
    if (confirmingReset && !busy) resetInput.current?.focus();
  }, [confirmingReset, busy]);

  async function backupNow() {
    if (!info || !begin('backup')) return;
    setError('');
    setDone('');
    const requestId = (backupRequest.current ??= crypto.randomUUID());
    try {
      const result = await ledgerCommand<BackupItem>({
        kind: 'create-backup',
        requestId,
        generation: info.generation,
      });
      if (!result || typeof result.name !== 'string') throw Error('没有收到备份结果，请重试。');
      backupRequest.current = null;
      if (mounted.current) {
        setDone(
          `已备份：${result.name}` +
            (result.missingAttachmentCount
              ? `（有 ${result.missingAttachmentCount} 张截图找不到或已损坏，没能备份）`
              : ''),
        );
        await readInfo();
      }
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      finish();
    }
  }
  // The main process asks where (a USB drive, for example) with the system's folder chooser.
  async function backupElsewhere() {
    if (!info || !begin('external')) return;
    setError('');
    setExternal(null);
    const requestId = (externalRequest.current ??= crypto.randomUUID());
    try {
      const result = await ledgerCommand<ExternalBackup | null>({
        kind: 'backup-elsewhere',
        requestId,
        generation: info.generation,
      });
      if (result === null) return;
      if (!result || typeof result.directory !== 'string')
        throw Error('没有收到备份结果，请重试。');
      externalRequest.current = null;
      if (mounted.current) setExternal(result);
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      finish();
    }
  }
  async function showFolder(which: 'backups' | 'home') {
    if (!begin('folder')) return;
    setError('');
    try {
      await ledgerCommand({ kind: 'show-folder', which });
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      finish();
    }
  }
  async function preview(request: Record<string, unknown> | null) {
    if (!info || !request || !begin('restore')) return;
    setError('');
    setDone('');
    setPlan(null);
    setRestoreText('');
    restoreRequest.current = null;
    try {
      const value = await ledgerCommand<RestorePlan | null>({
        ...request,
        generation: info.generation,
      });
      if (value && mounted.current) setPlan(value);
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      finish();
    }
  }
  function previewOther() {
    if (desktop) return preview({ kind: 'choose-restore' });
    const source = sourcePath.trim();
    return preview(source ? { kind: 'prepare-restore', source } : null);
  }
  async function confirmRestore(event: React.FormEvent) {
    event.preventDefault();
    if (!plan || restoreText !== RESTORE_CONFIRMATION || !begin('restore')) return;
    setError('');
    const requestId = (restoreRequest.current ??= crypto.randomUUID());
    try {
      const value = await ledgerCommand<{
        restored: boolean;
        completed: boolean;
        backup: string | null;
        missingAttachmentCount: number;
      }>({
        kind: 'restore-backup',
        requestId,
        token: plan.token,
        generation: plan.generation,
        confirmation: restoreText,
      });
      if (!value?.restored || !value.completed) throw Error('恢复结果没有确认，请重试。');
      replaced.current(
        '已用选中的内容恢复账本。' +
          (value.backup ? `恢复前的账本已保存为备份“${value.backup}”。` : '') +
          (value.missingAttachmentCount
            ? `有 ${value.missingAttachmentCount} 张截图找不到，恢复后会显示为缺失。`
            : ''),
      );
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      finish();
    }
  }
  function cancelRestore() {
    setPlan(null);
    setRestoreText('');
    restoreRequest.current = null;
  }
  async function reset(event: React.FormEvent) {
    event.preventDefault();
    if (!info || resetText !== RESET_CONFIRMATION || !begin('reset')) return;
    setError('');
    const requestId = (resetRequest.current ??= crypto.randomUUID());
    try {
      const value = await ledgerCommand<{
        reset: boolean;
        completed: boolean;
        backup: string | null;
      }>({ kind: 'reset-ledger', requestId, generation: info.generation, confirmation: resetText });
      if (value?.reset !== true || value.completed !== true)
        throw Error('清空结果没有确认，请重试。');
      replaced.current(
        '账本已清空。' + (value.backup ? `清空前的账本已保存为备份“${value.backup}”。` : ''),
      );
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      finish();
    }
  }

  const backups = info?.backups ?? [],
    visible = showAll ? backups : backups.slice(0, SHOWN_BACKUPS);
  return (
    <div className="backup-page" aria-busy={!!busy}>
      {!info && !error && (
        <p className="backup-message" role="status">
          正在读取备份信息…
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="backup-card" aria-labelledby="backup-where-title">
        <div className="backup-card-heading">
          <h2 id="backup-where-title">自动备份</h2>
          <span className="backup-badge">每天一次</span>
        </div>
        <p>
          每天打开钱来或第一次记账时自动备份一次，保留最近 {info?.keepAutomaticBackups ?? 30}{' '}
          份自动备份。恢复、清空或升级之前，也会先自动备份当前账本。
        </p>
        {info?.automaticBackupError && (
          <p className="error" role="alert">
            {info.automaticBackupError}
          </p>
        )}
        <div className="backup-actions">
          <button
            type="button"
            className="primary"
            disabled={!!busy || !info}
            onClick={() => void backupNow()}
          >
            {busy === 'backup' ? '正在备份…' : '立即备份'}
          </button>
          {desktop && (
            <button type="button" disabled={!!busy} onClick={() => void showFolder('backups')}>
              打开备份文件夹
            </button>
          )}
        </div>
        {done && (
          <p className="backup-result" role="status">
            {done}
          </p>
        )}
        {info && (
          <div className="backup-help backup-where">
            <p>账本、截图和备份都保存在钱来自己的文件夹里：</p>
            <p className="backup-location">{info.home}</p>
            <p>要换电脑：先关闭钱来，再把整个文件夹复制到新电脑，从里面打开钱来即可。</p>
            {desktop && (
              <button
                type="button"
                className="link-button"
                disabled={!!busy}
                onClick={() => void showFolder('home')}
              >
                打开钱来文件夹
              </button>
            )}
          </div>
        )}
      </section>

      {desktop && (
        <section className="backup-card" aria-labelledby="backup-usb-title">
          <div className="backup-card-heading">
            <h2 id="backup-usb-title">备份到 U 盘</h2>
            <span className="backup-badge">防止硬盘损坏</span>
          </div>
          <p>
            账本和上面的自动备份都在这台电脑的同一块硬盘上，硬盘坏了或电脑丢了会一起丢失。建议每周插上
            U 盘备份一次。
          </p>
          <div className="backup-actions">
            <button type="button" disabled={!!busy || !info} onClick={() => void backupElsewhere()}>
              {busy === 'external' ? '正在备份…' : '备份到 U 盘…'}
            </button>
          </div>
          {external && (
            <div className="backup-help backup-where" role="status">
              <p className="backup-result">已备份到：</p>
              <p className="backup-location">{external.directory}</p>
              {external.missingAttachmentCount > 0 && (
                <p>有 {external.missingAttachmentCount} 张截图找不到或已损坏，没能备份。</p>
              )}
              <p>以后要用它恢复：在本页点“从其他文件夹恢复或导入…”，选这个文件夹。</p>
              {external.sameDisk && (
                <p className="error">
                  这个位置和钱来在同一块硬盘上，硬盘坏了时这份备份也会一起丢失，建议改用 U 盘。
                </p>
              )}
            </div>
          )}
        </section>
      )}

      <section className="backup-card" aria-labelledby="backup-restore-title">
        <div className="backup-card-heading">
          <h2 id="backup-restore-title">恢复备份或导入旧账本</h2>
          <span className="backup-badge">先预览再确认</span>
        </div>
        {info && !backups.length && (
          <p className="backup-message">还没有备份。记下第一笔账后会自动备份。</p>
        )}
        {!!backups.length && (
          <ul className="backup-list" aria-label="备份列表">
            {visible.map((item) => (
              <li key={item.name}>
                <div>
                  <strong>{backupTime(item.createdAt)}</strong>
                  <span className="backup-kind">{item.kindLabel}</span>
                  <small>
                    {summaryLine(item.summary)}
                    {item.missingAttachmentCount
                      ? ` · 缺 ${item.missingAttachmentCount} 张截图`
                      : ''}
                  </small>
                </div>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => void preview({ kind: 'prepare-restore', backup: item.name })}
                >
                  用这份恢复
                </button>
              </li>
            ))}
          </ul>
        )}
        {backups.length > SHOWN_BACKUPS && (
          <button type="button" className="link-button" onClick={() => setShowAll(!showAll)}>
            {showAll ? '只显示最近几份' : `显示全部 ${backups.length} 份`}
          </button>
        )}
        <p className="backup-help backup-restore-help">
          升级到新版本：在新版里点下面的按钮，选择旧的钱来文件夹，就能把旧账本搬过来，旧文件夹不会被修改。也可以选择
          U 盘等其他位置的备份。
        </p>
        {!desktop && (
          <label className="field">
            文件夹路径
            <input
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              disabled={!!busy}
              placeholder="旧的钱来文件夹、它的“数据”文件夹或某一份备份"
            />
          </label>
        )}
        <div className="backup-actions">
          <button
            type="button"
            disabled={!!busy || !info || (!desktop && !sourcePath.trim())}
            onClick={() => void previewOther()}
          >
            {busy === 'restore' && !plan ? '正在检查…' : '从其他文件夹恢复或导入…'}
          </button>
        </div>
        {plan && (
          <form
            ref={planRef}
            className="backup-confirmation"
            onSubmit={(e) => void confirmRestore(e)}
          >
            <h3>
              {plan.sourceType === 'backup'
                ? `备份：${plan.createdAt ? backupTime(plan.createdAt) : ''} ${plan.kindLabel ?? ''}`
                : '另一个钱来文件夹里的账本'}
            </h3>
            <p className="backup-location">{plan.location}</p>
            <p>{summaryLine(plan.summary)}</p>
            {!!plan.missingAttachmentCount && (
              <p className="error">
                有 {plan.missingAttachmentCount} 张截图找不到或已损坏，恢复后这些截图会显示为缺失。
              </p>
            )}
            {plan.upgradedFrom !== null && (
              <p className="backup-help">这是较早版本的格式，恢复时会自动升级。</p>
            )}
            <p id="restore-help">
              确认后，当前账本会先自动备份，然后换成上面的内容。请输入{' '}
              <strong>{RESTORE_CONFIRMATION}</strong> 继续。
            </p>
            <label className="field">
              确认文字
              <input
                value={restoreText}
                onChange={(e) => setRestoreText(e.target.value)}
                disabled={!!busy}
                autoComplete="off"
                aria-describedby="restore-help"
                placeholder={RESTORE_CONFIRMATION}
              />
            </label>
            <div className="backup-actions">
              <button type="button" disabled={!!busy} onClick={cancelRestore}>
                取消
              </button>
              <button
                className="primary"
                type="submit"
                disabled={!!busy || restoreText !== RESTORE_CONFIRMATION}
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
          <span className="backup-badge backup-danger-badge">谨慎操作</span>
        </div>
        <p>清空全部费用、预支、报销、开票标记和截图，资金余额归零。</p>
        <p className="backup-help">清空之前会自动备份当前账本，需要时可以在上面的列表里恢复。</p>
        {!confirmingReset ? (
          <div className="backup-actions">
            <button
              type="button"
              className="backup-danger-button"
              disabled={!!busy || !info}
              onClick={() => {
                setResetText('');
                setConfirmingReset(true);
                setError('');
              }}
            >
              清空所有数据
            </button>
          </div>
        ) : (
          <form className="backup-confirmation" onSubmit={(event) => void reset(event)}>
            <p id="reset-confirm-help">
              确认后将清空当前账本。请准确输入 <strong>{RESET_CONFIRMATION}</strong>。
            </p>
            <label className="field" htmlFor="reset-confirmation">
              确认文字
              <input
                id="reset-confirmation"
                ref={resetInput}
                value={resetText}
                onChange={(event) => setResetText(event.target.value)}
                disabled={!!busy}
                autoComplete="off"
                spellCheck={false}
                aria-describedby="reset-confirm-help"
                placeholder={RESET_CONFIRMATION}
              />
            </label>
            <div className="backup-actions">
              <button
                type="button"
                disabled={!!busy}
                onClick={() => {
                  setConfirmingReset(false);
                  setResetText('');
                  resetRequest.current = null;
                }}
              >
                取消
              </button>
              <button
                type="submit"
                className="backup-danger-button"
                disabled={!!busy || resetText !== RESET_CONFIRMATION}
              >
                {busy === 'reset' ? '正在清空…' : '备份后清空当前账本'}
              </button>
            </div>
          </form>
        )}
      </section>
      {info?.version && <p className="backup-version">钱来 版本 {info.version}</p>}
    </div>
  );
}
