import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  allocate,
  balance,
  cents,
  decimal,
  money,
  remaining,
  rowCents,
  sum,
  validateAllocation,
} from './model.ts';
import type { Category, Expense } from './model.ts';
import './style.css';
import './expense-export.css';
import { expenseFilterError, expenseStatus, filterExpenses, expenseCsv } from './expense-export.ts';
import type { ExpenseFilters } from './expense-export.ts';
import { downloadExpenseCsv } from './expense-download.ts';
import { ledgerCommand, imagePayload, onLedgerReloaded } from './ledger.ts';
import AdvanceEditor from './AdvanceEditor.tsx';
import type { LedgerState } from './ledger.ts';
import { localDate as today, localDateLabel } from './local-date.ts';
import Icon from './Icon.tsx';
import Sidebar from './Sidebar.tsx';
import SummaryCards from './SummaryCards.tsx';
import AdvanceList from './AdvanceList.tsx';
import ExpenseList, { PendingTasks } from './ExpenseList.tsx';
import AdvanceForm from './AdvanceForm.tsx';
import ExpenseForm from './ExpenseForm.tsx';
import ReimburseForm from './ReimburseForm.tsx';
import ExpenseDetail from './ExpenseDetail.tsx';
import { reimbursementRows } from './reimbursement-draft.ts';
import { expenseSummary } from './expense-summary.ts';
import { usePagination } from './Pagination.tsx';
import { matchesExpense } from './records.ts';
import ReimbursementRecords, { BatchDetail } from './ReimbursementRecords.tsx';
import BackupPage from './BackupPage.tsx';
import ExpenseCorrection from './ExpenseCorrection.tsx';
import {
  correctionBalance,
  correctionDraft,
  correctionRequest,
  correctionRestriction,
  correctionSession,
  expenseRevision,
} from './expense-correction.ts';
import type {
  CorrectionCommand,
  CorrectionDraft,
  CorrectionSession,
} from './expense-correction.ts';

function App() {
  const [state, setState] = useState<LedgerState>({ expenses: [], batches: [], advances: [] }),
    [category, setCategory] = useState('全部费用'),
    [query, setQuery] = useState(''),
    [status, setStatus] = useState('全部状态'),
    [startDate, setStartDate] = useState(''),
    [endDate, setEndDate] = useState('');
  const [selected, setSelected] = useState<number[]>([]),
    [panel, setPanel] = useState<
      | 'new'
      | 'advance'
      | 'advance-detail'
      | 'reimburse'
      | 'detail'
      | 'batch-detail'
      | 'correction'
      | null
    >(null),
    [detail, setDetail] = useState<number>(1001),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const [newCategory, setNewCategory] = useState<Category>('接待'),
    [date, setDate] = useState(today),
    [merchant, setMerchant] = useState(''),
    [amount, setAmount] = useState(''),
    [note, setNote] = useState('');
  const [total, setTotal] = useState(''),
    [rows, setRows] = useState<Record<number, string>>({}),
    [batchDate, setBatchDate] = useState(today),
    [saving, setSaving] = useState(false),
    [cancelId, setCancelId] = useState<number | null>(null);
  const [attachment, setAttachment] = useState<File | null>(null),
    [imageBusy, setImageBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [pickerQuery, setPickerQuery] = useState(''),
    [pickerCategory, setPickerCategory] = useState('全部');
  const [currentDay, setCurrentDay] = useState(today);
  const [batchAction, setBatchAction] = useState<{ id: number; kind: 'delete-batch' } | null>(null);
  const [batchDetailId, setBatchDetailId] = useState<number | null>(null),
    [returnBatchId, setReturnBatchId] = useState<number | null>(null);
  const [correction, setCorrection] = useState<CorrectionSession | null>(null),
    [correctionForm, setCorrectionForm] = useState<CorrectionDraft | null>(null);
  const [expenseDeletion, setExpenseDeletion] = useState<{
    requestId: string;
    id: number;
    expected: Expense;
    expectedRevision: number;
  } | null>(null);
  const correctionAttempts = useRef<CorrectionCommand[]>([]);
  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', preventFileNavigation);
    window.addEventListener('drop', preventFileNavigation);
    return () => {
      window.removeEventListener('dragover', preventFileNavigation);
      window.removeEventListener('drop', preventFileNavigation);
    };
  }, []);
  useEffect(() => {
    const refresh = () => setCurrentDay(today());
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const requestId = useRef(crypto.randomUUID());
  // A save refused as out of date reads the ledger again; show what it read.
  useEffect(() => onLedgerReloaded(setState), []);
  useEffect(() => {
    ledgerCommand({ kind: 'read' })
      .then((value) => {
        setState(value);
        setLoaded(true);
        try {
          const replaced = sessionStorage.getItem('qianlai-ledger-replaced');
          if (replaced) {
            sessionStorage.removeItem('qianlai-ledger-replaced');
            setNotice(replaced);
          }
        } catch {
          /* 提示存储不可用不影响账本加载。 */
        }
      })
      .catch((e) => {
        setCategory('备份');
        setNotice(`账本未加载：${e.message}。当前金额暂不显示。`);
      });
  }, []);
  const dialog = useRef<HTMLDialogElement>(null),
    saveLock = useRef(false);
  const { expenses, batches, advances } = state,
    bal = balance(expenses, advances),
    outstanding = sum(expenses.map((e) => remaining(e, batches)));
  const label = (e: Expense) => expenseStatus(e, batches);
  const filters: ExpenseFilters = {
    category: category === '接待' || category === '办公' ? category : '全部费用',
    query,
    status,
    startDate,
    endDate,
  };
  const filterError = expenseFilterError(filters),
    visible = filterExpenses(state, filters);
  function exportExpenses() {
    if (!loaded || filterError || !visible.length) return;
    try {
      downloadExpenseCsv(expenseCsv(state, visible));
      setNotice(
        `已发起 ${visible.length} 笔费用的 CSV 下载${window.localLedger ? '，请在保存窗口选择位置。' : '，请在浏览器下载记录中确认。'}`,
      );
    } catch (e) {
      setNotice(`CSV 导出未开始：${(e as Error).message}`);
    }
  }
  const isOverview = category === '全部费用',
    isAdvances = category === '预支',
    isBatches = category === '报销记录',
    isBackup = category === '备份';
  const chosen = expenses.filter((e) => Object.hasOwn(rows, e.id)),
    chosenRemaining = sum(chosen.map((e) => remaining(e, batches)));
  const listChosenRemaining = sum(
    expenses.filter((e) => selected.includes(e.id)).map((e) => remaining(e, batches)),
  );
  useEffect(() => {
    if (panel) {
      dialog.current?.showModal();
      if (panel === 'new' || panel === 'advance' || panel === 'correction')
        dialog.current?.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.focus();
      else dialog.current?.querySelector<HTMLHeadingElement>('#panel-title')?.focus();
    } else dialog.current?.close();
  }, [panel]);
  function close() {
    if (saveLock.current) return;
    setImageBusy(false);
    setAttachment(null);
    setPanel(null);
    setError('');
    setCancelId(null);
    setBatchAction(null);
    setExpenseDeletion(null);
    setCorrection(null);
    setCorrectionForm(null);
  }
  // Moving to another page clears the list selection; 备份 also closes any open drawer.
  function openPage(next: string) {
    if (next === '备份') {
      if (saveLock.current) return;
      close();
    }
    setCategory(next);
    setSelected([]);
  }
  function openAdvanceDetail(index: number) {
    setDetail(index);
    setError('');
    setPanel('advance-detail');
  }
  // Child forms that save by themselves hold the same lock as the drawer's own saves.
  function setBusy(busy: boolean) {
    saveLock.current = busy;
    setSaving(busy);
  }
  function toggle(id: number) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }
  function openNew() {
    requestId.current = crypto.randomUUID();
    setAttachment(null);
    setImageBusy(false);
    setNewCategory(category === '办公' ? '办公' : '接待');
    setDate(today());
    setMerchant('');
    setAmount('');
    setNote('');
    setError('');
    setPanel('new');
  }
  function openAdvance() {
    requestId.current = crypto.randomUUID();
    setImageBusy(false);
    setAttachment(null);
    setDate(today());
    setAmount('');
    setNote('');
    setError('');
    setPanel('advance');
  }
  async function saveAdvance(event: React.FormEvent) {
    event.preventDefault();
    if (saveLock.current || imageBusy) return;
    try {
      const value = cents(amount);
      sum([...advances, value]);
      if (!date) throw new Error('请选择实际到账日期');
      saveLock.current = true;
      setSaving(true);
      const next = await ledgerCommand({
        kind: 'advance',
        requestId: requestId.current,
        advance: { date, amount: value, note },
        ...(attachment ? { image: await imagePayload(attachment) } : {}),
      });
      setState(next);
      setNotice(`已登记预支到账 ${money(value)} 元；费用报销进度未改变。`);
      saveLock.current = false;
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  function suggest(value: string, items = chosen) {
    setTotal(value);
    try {
      const result = allocate(cents(value), items, batches);
      setRows(
        Object.fromEntries(
          items.map((e) => [e.id, decimal(result.find((a) => a.expenseId === e.id)?.amount || 0)]),
        ),
      );
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function setBatchSelection(ids: number[], previous = rows) {
    const next = reimbursementRows(expenses, batches, ids, previous);
    setRows(next);
    try {
      setTotal(Object.keys(next).length ? decimal(sum(Object.values(next).map(rowCents))) : '');
      setError('');
    } catch (e) {
      setTotal('');
      setError((e as Error).message);
    }
  }
  function openReimburse(ids: number[] = []) {
    setPickerQuery('');
    setPickerCategory(category === '接待' || category === '办公' ? category : '全部');
    requestId.current = crypto.randomUUID();
    setBatchDate(today());
    setBatchSelection(ids, {});
    setPanel('reimburse');
  }
  function openDetail(id: number, fromBatch: number | null = null) {
    setReturnBatchId(fromBatch);
    setBatchAction(null);
    setCancelId(null);
    setDetail(id);
    setError('');
    setPanel('detail');
  }
  function askExpenseDelete() {
    if (!current || saveLock.current) return;
    setExpenseDeletion({
      requestId: crypto.randomUUID(),
      id: current.id,
      expected: structuredClone(current),
      expectedRevision: expenseRevision(state, current.id),
    });
    setError('');
  }
  async function deleteExpense() {
    if (saveLock.current || !expenseDeletion) return;
    saveLock.current = true;
    setSaving(true);
    try {
      setState(await ledgerCommand({ kind: 'delete-expense', ...expenseDeletion }));
      setNotice('误填费用已删除，支出余额已重新计算；原始图片及审计保留。');
      saveLock.current = false;
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  function openCorrection() {
    if (saveLock.current || !current) return;
    try {
      setCorrection(correctionSession(state, current));
      setCorrectionForm(correctionDraft(current));
      correctionAttempts.current = [];
      setCancelId(null);
      setError('');
      setPanel('correction');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function cancelCorrection() {
    if (saveLock.current) return;
    setCorrection(null);
    setCorrectionForm(null);
    setError('');
    setPanel('detail');
  }
  async function saveCorrection(event: React.FormEvent) {
    event.preventDefault();
    if (saveLock.current || !correction || !correctionForm) return;
    try {
      const existing = expenses.find((expense) => expense.id === correction.expected.id);
      if (!existing) throw new Error('找不到这笔费用，可能已被删除，请返回列表重新打开');
      const restriction = correctionRestriction(existing, state);
      if (restriction) throw new Error(restriction);
      const request = correctionRequest(correction, correctionForm, correctionAttempts.current);
      sum(
        expenses.map((expense) =>
          expense.id === request.id ? request.expense.amount : expense.amount,
        ),
      );
      correctionBalance(bal, correction.expected.amount, request.expense.amount);
      if (!correctionAttempts.current.includes(request)) correctionAttempts.current.push(request);
      saveLock.current = true;
      setSaving(true);
      setError('');
      const next = await ledgerCommand(request);
      setState(next);
      setNotice('费用纠错已保存，原编号和附件保留；可在费用详情查看前后值。');
      setCorrection(null);
      setCorrectionForm(null);
      setPanel('detail');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  function openBatchDetail(id: number) {
    if (saveLock.current) return;
    setBatchDetailId(id);
    setBatchAction(null);
    setCancelId(null);
    setError('');
    setPanel('batch-detail');
  }
  function askCancel(id: number) {
    if (saveLock.current) return;
    requestId.current = crypto.randomUUID();
    setBatchAction(null);
    setError('');
    setCancelId(id);
  }
  function askBatchAction(id: number, kind: 'delete-batch') {
    if (saveLock.current) return;
    requestId.current = crypto.randomUUID();
    setCancelId(null);
    setError('');
    setBatchAction({ id, kind });
  }
  function keepBatchAction() {
    if (saveLock.current) return;
    setBatchAction(null);
    setError('');
  }
  async function runBatchAction() {
    if (saveLock.current || !batchAction) return;
    saveLock.current = true;
    setSaving(true);
    setError('');
    try {
      setState(await ledgerCommand({ ...batchAction, requestId: requestId.current }));
      setNotice('报销批次已删除，相关核销已撤销；资金余额未改变。');
      setBatchAction(null);
      setPanel(null);
      setBatchDetailId(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  function keepBatch() {
    if (saveLock.current) return;
    setCancelId(null);
    setError('');
  }
  function changeRow(id: number, value: string) {
    const next = { ...rows, [id]: value };
    setRows(next);
    try {
      const amounts = chosen.map((e) => rowCents(next[e.id] || ''));
      setTotal(decimal(sum(amounts)));
      setError('');
    } catch (e) {
      setTotal('');
      setError((e as Error).message);
    }
  }
  async function saveExpense(event: React.FormEvent) {
    event.preventDefault();
    if (saveLock.current || imageBusy) return;
    try {
      const value = cents(amount);
      if (!merchant.trim() || !date) throw new Error('请填写商户或采购摘要，并确认日期');
      sum([...expenses.map((e) => e.amount), value]);
      saveLock.current = true;
      setSaving(true);
      const next = await ledgerCommand({
        kind: 'expense',
        requestId: requestId.current,
        expense: { date, category: newCategory, merchant: merchant.trim(), amount: value, note },
        ...(attachment ? { image: await imagePayload(attachment) } : {}),
      });
      setState(next);
      setNotice('费用已保存到本地账本' + (attachment ? '，支付截图已作为附件保留。' : '。'));
      saveLock.current = false;
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  async function saveBatch(event: React.FormEvent) {
    event.preventDefault();
    if (saveLock.current) return;
    try {
      // Revalidate the current form; an earlier request error must not block its retry.
      if (!batchDate) throw new Error('请选择报销日期');
      const allocations = chosen.flatMap((e) =>
        rowCents(rows[e.id] || '') === 0 ? [] : [{ expenseId: e.id, amount: rowCents(rows[e.id]) }],
      );
      const valid = validateAllocation(allocations, chosen, batches);
      if (valid !== cents(total)) throw new Error('总额与逐行分配不一致，请重新核对');
      // Keep this draft's request ID after errors, including a committed response lost in transit.
      saveLock.current = true;
      setSaving(true);
      setError('');
      const next = await ledgerCommand({
        kind: 'batch',
        requestId: requestId.current,
        date: batchDate,
        allocations,
      });
      setState(next);
      setNotice(`已登记报销 ${money(valid)} 元；资金余额未改变。`);
      setSelected([]);
      saveLock.current = false;
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  async function cancelBatch() {
    if (saveLock.current || cancelId === null) return;
    saveLock.current = true;
    setSaving(true);
    setError('');
    try {
      setState(await ledgerCommand({ kind: 'cancel', requestId: requestId.current, id: cancelId }));
      setCancelId(null);
      setNotice('报销批次已撤销，资金余额未改变。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }
  const current = expenses.find((e) => e.id === detail),
    currentBatch = batches.find((b) => b.id === batchDetailId);
  const currentRestriction = current ? correctionRestriction(current, state) : null;
  let after: number | null = null;
  try {
    if (amount) after = sum([bal, -cents(amount)]);
  } catch {}
  let afterAdvance: number | null = null;
  try {
    if (amount)
      afterAdvance = sum([sum([...advances, cents(amount)]), -sum(expenses.map((e) => e.amount))]);
  } catch {}
  const spending = expenseSummary(expenses);
  const pending = expenses.filter((e) => remaining(e, batches) > 0);
  const expensePages = usePagination(visible, JSON.stringify(filters));
  const pagePending = expensePages.items.filter((e) => remaining(e, batches) > 0).map((e) => e.id);
  const advancePages = usePagination(
    advances
      .map((value, index) => ({ value, index }))
      .filter((row) => !state.advanceDetails?.[row.index]?.deleted)
      .reverse(),
    category,
  );
  const pickerFiltered = expenses.filter(
    (e) =>
      (pickerCategory === '全部' || e.category === pickerCategory) &&
      matchesExpense(e, pickerQuery),
  );
  const pickerPending = pickerFiltered.filter((e) => remaining(e, batches) > 0).map((e) => e.id);
  const pickerPages = usePagination(
    pickerFiltered,
    JSON.stringify([panel, pickerQuery, pickerCategory]),
  );
  const allocationPages = usePagination(chosen, String(panel));
  const history = batches.filter((b) => b.allocations.some((a) => a.expenseId === detail));
  const historyPages = usePagination(history, String(detail));
  const spendingCategory = category === '接待' || category === '办公' ? category : null;

  return (
    <div className="app">
      <Sidebar page={category} onOpen={openPage} ledger={state} day={currentDay} />
      <main>
        <header className="page-header">
          <div>
            <h1>
              {isOverview
                ? '你好，小徐同学'
                : isAdvances
                  ? '预支到账'
                  : isBatches
                    ? '报销记录'
                    : isBackup
                      ? '备份与数据管理'
                      : `${category}费用`}
            </h1>
            <p>
              <time dateTime={currentDay}>{localDateLabel(currentDay)}</time>
            </p>
          </div>
          <div className="header-actions">
            {isBackup ? null : isAdvances ? (
              <button className="primary" disabled={!loaded} onClick={openAdvance}>
                <Icon name="plus" />
                登记预支到账
              </button>
            ) : isBatches ? (
              <button className="primary" disabled={!loaded} onClick={() => openReimburse()}>
                <Icon name="receipt" />
                登记报销
              </button>
            ) : (
              <>
                <button className="primary" disabled={!loaded} onClick={() => openNew()}>
                  <Icon name="plus" />
                  新增费用
                </button>
                <button disabled={!loaded} onClick={() => openReimburse()}>
                  <Icon name="receipt" />
                  登记报销
                </button>
              </>
            )}
          </div>
        </header>
        {!isBackup && loaded && (
          <SummaryCards
            bal={bal}
            spendingCategory={spendingCategory}
            spending={spending}
            outstanding={outstanding}
          />
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button aria-label="关闭提示" onClick={() => setNotice('')}>
              关闭
            </button>
          </div>
        )}
        {isBackup ? (
          <BackupPage
            onLedgerReplaced={(message) => {
              try {
                sessionStorage.setItem('qianlai-ledger-replaced', message);
              } catch {
                /* 页面刷新必须继续。 */
              }
              window.location.reload();
            }}
          />
        ) : isBatches ? (
          <ReimbursementRecords batches={batches} expenses={expenses} onOpen={openBatchDetail} />
        ) : isAdvances ? (
          <AdvanceList
            state={state}
            advancePages={advancePages}
            loaded={loaded}
            openAdvance={openAdvance}
            openAdvanceDetail={openAdvanceDetail}
          />
        ) : (
          <div className="content-grid">
            <ExpenseList
              category={category}
              isOverview={isOverview}
              visible={visible}
              expenses={expenses}
              batches={batches}
              loaded={loaded}
              filterError={filterError}
              query={query}
              setQuery={setQuery}
              startDate={startDate}
              setStartDate={setStartDate}
              endDate={endDate}
              setEndDate={setEndDate}
              status={status}
              setStatus={setStatus}
              expensePages={expensePages}
              pagePending={pagePending}
              selected={selected}
              setSelected={setSelected}
              toggle={toggle}
              openDetail={openDetail}
              openNew={openNew}
              openReimburse={openReimburse}
              exportExpenses={exportExpenses}
              listChosenRemaining={listChosenRemaining}
              label={label}
            />
            <PendingTasks
              pending={pending}
              batches={batches}
              openReimburse={() => openReimburse()}
            />
          </div>
        )}
        <p className="footer-note">
          账本、截图和备份都在钱来文件夹里，每天自动备份。实际退款和退还预支暂不支持，请勿用修改或删除原记录代替。
        </p>
      </main>
      <dialog
        ref={dialog}
        className={`drawer ${panel === 'reimburse' || panel === 'batch-detail' ? 'wide' : ''}`}
        onCancel={(e) => {
          if (saveLock.current) e.preventDefault();
          else close();
        }}
        onClose={() => {
          if (!dialog.current?.open) setPanel(null);
        }}
        aria-labelledby="panel-title"
      >
        <header className="drawer-header">
          <div>
            <h2 id="panel-title" tabIndex={-1}>
              {panel === 'new'
                ? '记一笔费用'
                : panel === 'advance'
                  ? '登记预支到账'
                  : panel === 'reimburse'
                    ? '登记报销'
                    : panel === 'advance-detail'
                      ? '预支到账详情'
                      : panel === 'batch-detail'
                        ? '报销批次详情'
                        : panel === 'correction'
                          ? '纠正费用录入'
                          : '费用详情'}
            </h2>
            <p>
              {panel === 'new'
                ? '只记录已经实际支付的费用'
                : panel === 'advance'
                  ? '记录公司实际拨款，不自动核销费用'
                  : panel === 'reimburse'
                    ? '仅登记报账进度，不产生收付款'
                    : panel === 'advance-detail'
                      ? '查看实际拨款及其凭证'
                      : panel === 'batch-detail'
                        ? '仅登记报账进度，不产生收付款'
                        : panel === 'correction'
                          ? '核对实际支出，保留每次纠错记录'
                          : '查看支出事实与独立的报销记录'}
            </p>
          </div>
          <button aria-label="关闭面板" disabled={saving} onClick={close}>
            关闭
          </button>
        </header>
        {panel === 'correction' && correction && correctionForm && (
          <ExpenseCorrection
            expense={correction.expected}
            draft={correctionForm}
            balance={bal}
            saving={saving}
            error={error}
            onChange={(draft) => {
              if (saveLock.current) return;
              setCorrectionForm(draft);
              setError('');
            }}
            onSave={saveCorrection}
            onCancel={cancelCorrection}
          />
        )}
        {panel === 'advance' && (
          <AdvanceForm
            saveAdvance={saveAdvance}
            setAttachment={setAttachment}
            setImageBusy={setImageBusy}
            saving={saving}
            imageBusy={imageBusy}
            amount={amount}
            setAmount={setAmount}
            date={date}
            setDate={setDate}
            note={note}
            setNote={setNote}
            setError={setError}
            afterAdvance={afterAdvance}
            error={error}
            close={close}
          />
        )}
        {panel === 'new' && (
          <ExpenseForm
            saveExpense={saveExpense}
            setAttachment={setAttachment}
            setImageBusy={setImageBusy}
            saving={saving}
            imageBusy={imageBusy}
            newCategory={newCategory}
            setNewCategory={setNewCategory}
            amount={amount}
            setAmount={setAmount}
            date={date}
            setDate={setDate}
            merchant={merchant}
            setMerchant={setMerchant}
            note={note}
            setNote={setNote}
            after={after}
            error={error}
            close={close}
          />
        )}
        {panel === 'reimburse' && (
          <ReimburseForm
            saveBatch={saveBatch}
            saving={saving}
            pickerQuery={pickerQuery}
            setPickerQuery={setPickerQuery}
            pickerCategory={pickerCategory}
            setPickerCategory={setPickerCategory}
            chosen={chosen}
            chosenRemaining={chosenRemaining}
            pickerPending={pickerPending}
            setBatchSelection={setBatchSelection}
            pickerPages={pickerPages}
            batches={batches}
            rows={rows}
            pickerFiltered={pickerFiltered}
            expenses={expenses}
            pending={pending}
            batchDate={batchDate}
            setBatchDate={setBatchDate}
            total={total}
            suggest={suggest}
            allocationPages={allocationPages}
            changeRow={changeRow}
            error={error}
            close={close}
          />
        )}
        {panel === 'advance-detail' && (
          <AdvanceEditor
            key={detail}
            state={state}
            id={detail}
            onState={setState}
            onClose={close}
            onBusy={setBusy}
          />
        )}
        {panel === 'batch-detail' && currentBatch && (
          <BatchDetail
            batch={currentBatch}
            batches={batches}
            expenses={expenses}
            onExpense={(id) => openDetail(id, currentBatch.id)}
            onAskCancel={() => askCancel(currentBatch.id)}
            onClose={close}
            cancelId={cancelId}
            onKeep={keepBatch}
            onConfirm={() => void cancelBatch()}
            saving={saving}
            error={error}
            deleting={batchAction?.id === currentBatch.id}
            onAskDelete={() => askBatchAction(currentBatch.id, 'delete-batch')}
            onKeepDelete={keepBatchAction}
            onConfirmDelete={() => void runBatchAction()}
          />
        )}
        {panel === 'detail' && current && (
          <ExpenseDetail
            current={current}
            batches={batches}
            state={state}
            setState={setState}
            setBusy={setBusy}
            saving={saving}
            currentRestriction={currentRestriction}
            openCorrection={openCorrection}
            askExpenseDelete={askExpenseDelete}
            expenseDeletion={expenseDeletion}
            setExpenseDeletion={setExpenseDeletion}
            bal={bal}
            deleteExpense={deleteExpense}
            historyPages={historyPages}
            history={history}
            askCancel={askCancel}
            cancelId={cancelId}
            keepBatch={keepBatch}
            cancelBatch={cancelBatch}
            error={error}
            returnBatchId={returnBatchId}
            openBatchDetail={openBatchDetail}
            close={close}
          />
        )}
      </dialog>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
