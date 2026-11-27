import test from 'node:test';
import assert from 'node:assert/strict';
import { balance, decimal, paid } from '../src/renderer/model.ts';
import type { Batch, Expense } from '../src/renderer/model.ts';
import type { ExpenseEvent, LedgerState } from '../src/renderer/ledger.ts';
import {
  correctionBalance,
  correctionDraft,
  correctionFields,
  correctionRequest,
  correctionRestriction,
  correctionSession,
  expenseCorrections,
  expenseRevision,
} from '../src/renderer/expense-correction.ts';
import { paginate } from '../src/renderer/records.ts';

// Entirely synthetic fixtures. No files, ledger instances, screenshots or services.
const expense = (extra: Partial<Expense> = {}): Expense => ({
  id: 11,
  date: '2026-10-12',
  category: '接待',
  merchant: '合成餐厅',
  amount: 12345,
  invoice: 0,
  note: '合成测试',
  attachmentId: 'synthetic-attachment',
  ...extra,
});
const ledger = (extra: Partial<LedgerState> = {}): LedgerState => ({
  expenses: [expense()],
  batches: [],
  advances: [5000, 20000],
  advanceDetails: {
    0: { date: '2026-10-10', note: '合成预支', createdAt: '2026-10-10T01:00:00.000Z' },
  },
  ...extra,
});
const batch = (active: boolean, id = 1): Batch => ({
  id,
  date: '2026-10-12',
  active,
  allocations: [{ expenseId: 11, amount: 100 }],
});
const event = (revision: number, expenseId = 11): ExpenseEvent => ({
  requestId: `synthetic-${expenseId}-${revision}`,
  action: 'correct-expense',
  at: `2026-10-12T01:00:${String(revision).padStart(2, '0')}.000Z`,
  expenseId,
  revision,
  before: expense({ id: expenseId, amount: 12345 + revision - 1 }),
  after: expense({ id: expenseId, amount: 12345 + revision }),
});

test('legacy expense without audit metadata is eligible at revision zero and snapshot is independent', () => {
  const state = ledger(),
    original = state.expenses[0];
  assert.equal(correctionRestriction(original, state), null);
  assert.equal(expenseRevision(state, original.id), 0);
  const session = correctionSession(state, original);
  assert.deepEqual(session, { expected: original, expectedRevision: 0 });
  assert.notEqual(session.expected, original);
  original.note = 'changed after opening';
  assert.equal(session.expected.note, '合成测试');
});

test('invoice and inactive or active reimbursement history allow opening editor', () => {
  for (const active of [true, false]) {
    const state = ledger({ batches: [batch(active)], expenses: [expense({ invoice: 1 })] });
    assert.equal(correctionRestriction(state.expenses[0], state), null);
    assert.deepEqual(correctionSession(state, state.expenses[0]).expected, state.expenses[0]);
  }
});

test('expected revision counts this expense events rather than all events or their maximum revision', () => {
  const state = ledger({ expenseEvents: [event(1), event(2, 12), event(7)] });
  assert.equal(expenseRevision(state, 11), 2);
  assert.equal(expenseRevision(state, 12), 1);
  assert.equal(expenseRevision(state, 13), 0);
});

test('request preserves complete old snapshot including attachment and unknown legacy metadata, with only five editable fields', () => {
  const original = { ...expense(), legacyLabel: { source: 'synthetic' } };
  const state = ledger({
    expenses: [original, expense({ id: 12, amount: 100 })],
    expenseEvents: [event(1)],
  });
  const before = structuredClone(state),
    session = correctionSession(state, original),
    draft = {
      ...correctionDraft(original),
      category: '办公' as const,
      merchant: '  合成采购  ',
      date: '2026-09-30',
      amount: '120.01',
      note: '  纠正摘要  ',
    };
  const request = correctionRequest(session, draft, [], () => 'synthetic-request');
  assert.deepEqual(Object.keys(request).sort(), [
    'expected',
    'expectedRevision',
    'expense',
    'id',
    'kind',
    'requestId',
  ]);
  assert.deepEqual(Object.keys(request.expense).sort(), [
    'amount',
    'category',
    'date',
    'merchant',
    'note',
  ]);
  assert.deepEqual(request.expected, original);
  assert.equal(request.expectedRevision, 1);
  assert.deepEqual(request.expense, {
    category: '办公',
    date: '2026-09-30',
    merchant: '合成采购',
    amount: 12001,
    note: '纠正摘要',
  });
  assert.deepEqual(state, before);
  original.legacyLabel.source = 'mutated after preparing';
  assert.equal((request.expected as typeof original).legacyLabel.source, 'synthetic');
});

test('unchanged and trim-only drafts are rejected before submission', () => {
  const state = ledger(),
    session = correctionSession(state, state.expenses[0]),
    draft = correctionDraft(session.expected);
  assert.throws(() => correctionRequest(session, draft, []), /没有变化/);
  assert.throws(
    () =>
      correctionRequest(
        session,
        { ...draft, merchant: ` ${draft.merchant} `, note: ` ${draft.note} `, amount: '0123.450' },
        [],
      ),
    /最多保留两位小数/,
  );
  assert.throws(
    () =>
      correctionRequest(
        session,
        { ...draft, merchant: ` ${draft.merchant} `, note: ` ${draft.note} `, amount: '0123.45' },
        [],
      ),
    /没有变化/,
  );
});

test('draft validates real calendar dates, fields and positive safe cent amounts without rounding', () => {
  const draft = correctionDraft(expense());
  for (const amount of ['0', '-1', '1.001', '1e3', '90071992547409.92'])
    assert.throws(() => correctionFields({ ...draft, amount }));
  for (const date of ['', '2026-02-29', '2026-04-31', '2026-2-01'])
    assert.throws(() => correctionFields({ ...draft, date }), /日期/);
  assert.equal(correctionFields({ ...draft, date: '2024-02-29' }).date, '2024-02-29');
  assert.throws(() => correctionFields({ ...draft, merchant: ' ' }), /摘要/);
  assert.throws(() => correctionFields({ ...draft, merchant: 'x'.repeat(101) }), /摘要/);
  assert.throws(() => correctionFields({ ...draft, note: 'x'.repeat(501) }), /备注/);
  assert.throws(
    () => correctionFields({ ...draft, category: '其他' as Expense['category'] }),
    /类别/,
  );
  assert.equal(
    correctionFields({ ...draft, amount: decimal(Number.MAX_SAFE_INTEGER) }).amount,
    Number.MAX_SAFE_INTEGER,
  );
});

test('preview replaces the original cash expense and supports negative balance, while metadata changes leave funds intact', () => {
  const state = ledger({
      expenses: [expense({ amount: 8000 }), expense({ id: 12, amount: 9000 })],
      advances: [5000, 3000],
    }),
    before = structuredClone(state);
  const current = balance(state.expenses, state.advances);
  assert.equal(current, -9000);
  assert.equal(correctionBalance(current, 8000, 10000), -11000);
  assert.equal(correctionBalance(current, 8000, 100), -1100);
  const metadata = correctionFields({
    ...correctionDraft(state.expenses[0]),
    category: '办公',
    date: '2026-10-01',
    merchant: '合成新摘要',
    note: '合成新备注',
  });
  assert.equal(correctionBalance(current, 8000, metadata.amount), current);
  assert.deepEqual(state, before);
});

test('preview sums exact integer cents even when a temporary arithmetic subtotal would exceed safe integers', () => {
  assert.equal(correctionBalance(Number.MAX_SAFE_INTEGER, 100, 101), Number.MAX_SAFE_INTEGER - 1);
  assert.equal(correctionBalance(-Number.MAX_SAFE_INTEGER, 101, 100), -Number.MAX_SAFE_INTEGER + 1);
  assert.throws(() => correctionBalance(Number.MAX_SAFE_INTEGER, 101, 100), /安全范围/);
  assert.throws(() => correctionBalance(-Number.MAX_SAFE_INTEGER, 100, 101), /安全范围/);
  assert.equal(correctionBalance(20, 10, 29), 1);
});

test('unchanged retries reuse the exact request after a lost response; edited drafts get a new id without overwriting previous payloads', () => {
  const state = ledger(),
    session = correctionSession(state, state.expenses[0]),
    draft = { ...correctionDraft(session.expected), amount: '150.00' };
  let count = 0;
  const createId = () => `synthetic-attempt-${++count}`;
  const first = correctionRequest(session, draft, [], createId),
    firstSnapshot = structuredClone(first),
    attempts = [first];
  assert.equal(correctionRequest(session, draft, attempts, createId), first);
  assert.equal(
    correctionRequest(
      session,
      { ...draft, amount: '150', merchant: ` ${draft.merchant} ` },
      attempts,
      createId,
    ),
    first,
  );
  const changed = correctionRequest(
    session,
    { ...draft, note: '不同合成草稿' },
    attempts,
    createId,
  );
  attempts.push(changed);
  assert.notEqual(changed.requestId, first.requestId);
  assert.deepEqual(changed.expected, first.expected);
  assert.equal(changed.expectedRevision, first.expectedRevision);
  assert.equal(correctionRequest(session, draft, attempts, createId), first);
  assert.deepEqual(first, firstSnapshot);
  assert.equal(count, 2);
});

test('an updated source revision never reuses an old attempted request even if its editable values match', () => {
  const state = ledger(),
    session = correctionSession(state, state.expenses[0]),
    draft = { ...correctionDraft(session.expected), amount: '125.00' };
  const first = correctionRequest(session, draft, [], () => 'synthetic-old');
  const newer = { ...session, expectedRevision: 1 };
  const next = correctionRequest(newer, draft, [first], () => 'synthetic-new');
  assert.equal(next.requestId, 'synthetic-new');
  assert.equal(next.expectedRevision, 1);
});

test('correction history retains all before/after values, newest first with six-row pagination and no source mutation', () => {
  const state = ledger({
      expenseEvents: [
        event(4),
        event(8),
        event(1),
        event(1, 12),
        event(6),
        event(3),
        event(7),
        event(2),
        event(5),
      ],
    }),
    before = structuredClone(state);
  const records = expenseCorrections(state, 11),
    first = paginate(records, 1),
    second = paginate(records, 2);
  assert.deepEqual(
    first.items.map((item) => item.revision),
    [8, 7, 6, 5, 4, 3],
  );
  assert.deepEqual(
    second.items.map((item) => item.revision),
    [2, 1],
  );
  assert.equal(first.count, 8);
  assert.equal(first.pages, 2);
  assert.deepEqual(records[0].before, event(8).before);
  assert.deepEqual(records[0].after, event(8).after);
  assert.equal(paginate(records, 99).page, 2);
  assert.deepEqual(expenseCorrections(ledger(), 11), []);
  assert.deepEqual(state, before);
});
