const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto'),
  Database = require('better-sqlite3');
const { createManagedLedger } = require('../spike/managed-ledger.cjs');
const { seedLegacyInvoices } = require('./legacy-invoice-fixture.cjs');
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-reminder-'))),
    root = path.join(parent, 'ledger');
  let ledger = createManagedLedger(root, { backupDestination: parent });
  t.after(async () => {
    await ledger.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return {
    root,
    parent,
    get ledger() {
      return ledger;
    },
    async send(input) {
      const state = await ledger.command({ kind: 'read' });
      return ledger.command({ requestId: randomUUID(), generation: state.generation, ...input });
    },
    async reopen() {
      await ledger.close();
      ledger = createManagedLedger(root, { backupDestination: parent });
    },
    db(fn) {
      const db = new Database(path.join(root, 'trial.sqlite'));
      try {
        return fn(db);
      } finally {
        db.close();
      }
    },
  };
}
const read = (f) => f.ledger.command({ kind: 'read' });
const reminder = (state, id, value) => ({
  kind: 'set-invoice-issued',
  requestId: randomUUID(),
  id,
  expected: structuredClone(state.expenses.find((e) => e.id === id)),
  expectedRevision: (state.expenseEvents ?? []).filter((e) => e.expenseId === id).length,
  invoiceIssued: value,
});
const cash = (s) => ({
  advances: s.advances,
  advanceDetails: s.advanceDetails,
  expenseFlows: s.expenses.map(({ invoiceIssued, ...e }) => e),
  balance: s.advances.reduce((a, b) => a + b, 0) - s.expenses.reduce((a, e) => a + e.amount, 0),
  batches: s.batches,
});
async function snapshot(f) {
  return {
    state: await read(f),
    ops: f.db((db) => db.prepare('SELECT * FROM operations ORDER BY id').all()),
    files: fs
      .readdirSync(path.join(f.root, 'attachments'))
      .map((file) => [
        file,
        fs.readFileSync(path.join(f.root, 'attachments', file)).toString('base64'),
      ]),
  };
}
async function setup(t) {
  const f = fixture(t);
  await f.send({ kind: 'advance', advance: { amount: 100, date: '2026-10-16', note: '合成预支' } });
  for (const category of ['接待', '办公'])
    await f.send({
      kind: 'expense',
      expense: { category, date: '2026-10-16', merchant: '合成' + category, amount: 200, note: '' },
    });
  await f.send({
    kind: 'batch',
    date: '2026-10-16',
    allocations: [
      { expenseId: 1, amount: 200 },
      { expenseId: 2, amount: 50 },
    ],
  });
  return f;
}

test('both categories toggle on/off, persist after reopen, and preserve full cash and reimbursement facts with negative balance', async (t) => {
  const f = await setup(t),
    before = await read(f);
  assert.equal(cash(before).balance, -300);
  assert.equal(before.expenses[0].invoiceIssued, undefined);
  for (const id of [1, 2])
    for (const flag of [true, false]) {
      const current = await read(f),
        request = reminder(current, id, flag),
        after = await f.send(request);
      assert.equal(after.expenses.find((e) => e.id === id).invoiceIssued, flag);
      assert.deepEqual(cash(after), cash(before));
      assert.deepEqual(await f.send(request), after);
      await f.reopen();
      assert.deepEqual(await read(f), after);
    }
  const after = await read(f);
  assert.equal(after.expenseEvents.length, 4);
  assert.deepEqual(
    after.expenseEvents.map((e) => e.revision),
    [1, 2, 1, 2],
  );
});

test('legacy invoice links/amounts never default the reminder to true and are unchanged by toggles', async (t) => {
  const f = await setup(t);
  seedLegacyInvoices(f.root, 1);
  const before = await snapshot(f);
  assert.equal(before.state.expenses[0].invoiceIssued, undefined);
  for (const value of [true, false]) {
    const s = await read(f),
      after = await f.send(reminder(s, 1, value));
    assert.deepEqual(after.invoices, before.state.invoices);
    assert.deepEqual(after.invoiceEvents, before.state.invoiceEvents);
    assert.deepEqual(cash(after), cash(before.state));
    assert.deepEqual((await snapshot(f)).files, before.files);
  }
});

test('all retired invoice writes, batch link payloads and malformed reminder fields fail without mutations', async (t) => {
  const f = await setup(t),
    before = await snapshot(f),
    request = reminder(before.state, 1, true);
  for (const kind of [
    'invoice',
    'invoice-identity',
    'invoice-attachment',
    'invoice-allocate',
    'invoice-link',
    'invoice-edit',
    'invoice-delete',
  ])
    await assert.rejects(f.send({ kind, image: { base64: 'bad' } }), /请求无效/);
  await assert.rejects(
    f.send({
      kind: 'batch',
      date: '2026-10-16',
      allocations: [{ expenseId: 2, amount: 1 }],
      invoiceLinks: [],
    }),
    /停用/,
  );
  for (const change of [
    { invoiceIssued: 1 },
    { invoiceIssued: 'true' },
    { invoiceIssued: null },
    { id: 0 },
    { id: 999 },
    { expectedRevision: 1 },
    { expectedRevision: -1 },
    { amount: 1 },
    { image: {} },
    { expected: { ...request.expected, note: 'changed' } },
  ])
    await assert.rejects(f.send({ ...request, ...change }));
  assert.deepEqual(await snapshot(f), before);
});

test('stale revisions, reused IDs, deleted expense and correction preserve concurrency boundaries', async (t) => {
  const f = await setup(t),
    before = await read(f),
    request = reminder(before, 2, true);
  let state = await f.send(request);
  await assert.rejects(f.send({ ...request, requestId: randomUUID() }), /已变化/);
  await assert.rejects(f.send({ ...request, invoiceIssued: false }), /重复请求/);
  const correct = {
    kind: 'correct-expense',
    id: 2,
    expected: state.expenses[1],
    expectedRevision: 1,
    expense: { category: '办公', date: '2026-10-16', merchant: '合成更正', amount: 201, note: '' },
  };
  state = await f.send(correct);
  assert.equal(state.expenses[1].invoiceIssued, true);
  await assert.rejects(f.send(reminder({ ...state, expenseEvents: [] }, 2, false)), /已变化/);
  state = await f.send(reminder(state, 2, false));
  assert.equal(state.expenseEvents.at(-1).revision, 3);
  state = await f.send({ kind: 'cancel', id: 1 });
  const pending = reminder(state, 2, true);
  state = await f.send({
    kind: 'delete-expense',
    id: 2,
    expected: state.expenses[1],
    expectedRevision: 3,
  });
  await assert.rejects(f.send(pending), /不存在/);
});

test('transaction failure rolls back marker/audit/receipt and the same request succeeds once on retry', async (t) => {
  const f = await setup(t),
    before = await snapshot(f),
    request = reminder(before.state, 1, true);
  f.db((db) =>
    db.exec(
      "CREATE TRIGGER synthetic_fail BEFORE INSERT ON operations WHEN NEW.kind='set-invoice-issued' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
    ),
  );
  await assert.rejects(f.send(request), /synthetic rollback/);
  assert.deepEqual(await snapshot(f), before);
  f.db((db) => db.exec('DROP TRIGGER synthetic_fail'));
  const saved = await f.send(request);
  assert.equal(saved.expenseEvents.length, 1);
  assert.deepEqual(await f.send(request), saved);
});
