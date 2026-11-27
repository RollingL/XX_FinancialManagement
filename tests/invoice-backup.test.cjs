const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto'),
  Database = require('better-sqlite3');
const { createManagedLedger } = require('../spike/managed-ledger.cjs');
const { inspectDatabase, verifyBackup, restoreBackup } = require('../spike/ledger-backup.cjs');
const { seedLegacyInvoices } = require('./legacy-invoice-fixture.cjs');
const service = { recognize: async () => ({}) };
async function fixture(t) {
  const parent = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-legacy-reminder-backup-')),
    ),
    root = path.join(parent, 'ledger'),
    ledger = createManagedLedger(root, service, { backupDestination: parent });
  t.after(async () => {
    await ledger.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const send = async (body) =>
    ledger.command({
      generation: (await ledger.command({ kind: 'read' })).generation,
      requestId: randomUUID(),
      ...body,
    });
  await send({
    kind: 'expense',
    expense: { category: '办公', date: '2026-10-16', merchant: '合成', amount: 200, note: '' },
  });
  seedLegacyInvoices(root, 1);
  return { parent, root, ledger, send };
}
const toggle = (s, value) => ({
  kind: 'set-invoice-issued',
  id: 1,
  expected: s.expenses[0],
  expectedRevision: s.expenseEvents?.length ?? 0,
  invoiceIssued: value,
});
function mutate(file, fn) {
  const db = new Database(file);
  try {
    const s = JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);
    fn(s);
    db.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(s));
  } finally {
    db.close();
  }
}
for (const flag of [undefined, true, false])
  test(`legacy invoice history/attachments and reminder ${flag} survive complete backup, new-directory restore and reopening`, async (t) => {
    const f = await fixture(t);
    let state = await f.ledger.command({ kind: 'read' });
    if (flag !== undefined) {
      state = await f.send(toggle(state, true));
      if (flag === false) state = await f.send(toggle(state, false));
    }
    const saved = await f.ledger.backup(f.parent);
    verifyBackup(saved.directory);
    assert.equal(saved.summary.balanceCents, '-200');
    const restored = restoreBackup({
        backupDir: saved.directory,
        targetDir: path.join(f.parent, 'restored'),
      }),
      reopened = createManagedLedger(restored.directory, service, { backupDestination: f.parent });
    try {
      const after = await reopened.command({ kind: 'read' });
      assert.deepEqual({ ...after, generation: state.generation }, state);
      for (const file of fs.readdirSync(path.join(f.root, 'attachments')))
        assert.deepEqual(
          fs.readFileSync(path.join(restored.directory, 'attachments', file)),
          fs.readFileSync(path.join(f.root, 'attachments', file)),
        );
    } finally {
      await reopened.close();
    }
  });
test('deleting an expense keeps legacy invoice links and historical audits backup-compatible', async (t) => {
  const f = await fixture(t),
    before = await f.ledger.command({ kind: 'read' });
  let state = await f.send(toggle(before, true));
  state = await f.send({
    kind: 'correct-expense',
    id: 1,
    expected: state.expenses[0],
    expectedRevision: 1,
    expense: { category: '办公', date: '2026-10-16', merchant: '合成', amount: 1, note: '' },
  });
  inspectDatabase(path.join(f.root, 'trial.sqlite'));
  state = await f.send({
    kind: 'delete-expense',
    id: 1,
    expected: state.expenses[0],
    expectedRevision: 2,
  });
  assert.deepEqual(state.invoices, before.invoices);
  assert.deepEqual(state.invoiceEvents, before.invoiceEvents);
  assert.equal(state.expenses.length, 0);
  const backup = await f.ledger.backup(f.parent);
  verifyBackup(backup.directory);
  restoreBackup({ backupDir: backup.directory, targetDir: path.join(f.parent, 'restored') });
});
test('backup rejects corrupted reminder types and a reminder audit that changes a financial fact', async (t) => {
  const f = await fixture(t),
    s = await f.send(toggle(await f.ledger.command({ kind: 'read' }), true)),
    file = path.join(f.root, 'trial.sqlite');
  await f.ledger.close();
  for (const corrupt of [
    (state) => {
      state.expenses[0].invoiceIssued = 'true';
    },
    (state) => {
      state.expenses[0].amount++;
      state.expenseEvents[0].after.amount++;
    },
    (state) => {
      state.expenseEvents[0].before.invoiceIssued = true;
    },
  ]) {
    mutate(file, (state) => {
      Object.keys(state).forEach((k) => delete state[k]);
      Object.assign(state, structuredClone(s), { generation: s.generation.split(':').at(-1) });
      corrupt(state);
    });
    assert.throws(() => inspectDatabase(file), /开票提醒/);
  }
});
