// Shared helpers for ledger tests. Every ledger is a new temporary folder with obviously
// synthetic records; no real ledger is ever opened.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openLedger } = require('../src/main/ledger.cjs');
const { TABLE_NAMES } = require('../src/main/ledger-schema.cjs');
const { syntheticPng } = require('./synthetic-image.cjs');
const { cleanup, temporaryFolder } = require('./test-cleanup.cjs');

// The ledger keeps its database locked, so tests read and change it through the
// ledger's own connection (ledger.database).
function ledgerFixture(t, prefix = 'qianlai-ledger-') {
  const dir = temporaryFolder(t, prefix);
  let ledger = openLedger(dir);
  cleanup(t, () => {
    if (ledger.database.open) ledger.close();
  });
  return {
    dir,
    attachmentsDir: ledger.files.attachments,
    get ledger() {
      return ledger;
    },
    get db() {
      return ledger.database;
    },
    reopen() {
      ledger.close();
      ledger = openLedger(dir);
    },
    sql(statement) {
      ledger.database.exec(statement);
    },
    // Every row of every table: a change anywhere shows up in a comparison.
    rows() {
      return Object.fromEntries(
        TABLE_NAMES.map((name) => [
          name,
          ledger.database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
        ]),
      );
    },
    operations() {
      return ledger.database
        .prepare('SELECT request_id AS id, kind, created_at FROM operations ORDER BY rowid')
        .all();
    },
    files() {
      return fs
        .readdirSync(ledger.files.attachments)
        .sort()
        .map((name) => [
          name,
          fs.readFileSync(path.join(ledger.files.attachments, name)).toString('base64'),
        ]);
    },
  };
}
const read = (f) => f.ledger.command({ kind: 'read' });
// The complete stored ledger plus the screenshot files.
async function snapshot(f) {
  return { state: await read(f), rows: f.rows(), files: f.files() };
}
// Everything that is money. Reimbursement must never change any of it.
function funds(state) {
  return {
    advances: state.advances,
    advanceDetails: state.advanceDetails,
    expenses: state.expenses,
    balance:
      state.advances.reduce((sum, value) => sum + value, 0) -
      state.expenses.reduce((sum, item) => sum + item.amount, 0),
  };
}
// Fills a ledger with one of everything: advances with and without a screenshot, a
// deleted advance, corrected, flagged and deleted expenses, active, cancelled and deleted
// batches. `send` saves one request (with any extra fields the caller needs, such as
// generation). Returns the final state.
async function seedVariedLedger(send, { seed = 1 } = {}) {
  const image = (n) => ({ base64: syntheticPng({ seed: seed * 10 + n }).toString('base64') });
  const save = (input) => send({ requestId: randomUUID(), ...input });
  const newExpense = (category, amount, merchant, extra = {}) =>
    save({
      kind: 'expense',
      expense: { category, date: '2026-10-02', merchant, amount, note: '合成备注' },
      ...extra,
    });
  await save({
    kind: 'advance',
    advance: { amount: 50000, date: '2026-10-01', note: '合成预支' },
    image: image(1),
  });
  await save({ kind: 'advance', advance: { amount: 1, date: '2026-10-01', note: '' } });
  let state = await save({ kind: 'advance', advance: { amount: 7, date: '2026-10-01', note: '' } });
  state = await save({
    kind: 'delete-advance',
    id: 2,
    expectedAmount: 7,
    expected: state.advanceDetails[2],
    expectedRevision: 0,
  });
  await newExpense('接待', 30000, '合成接待甲', { image: image(2) });
  await newExpense('办公', 20000, '合成办公乙');
  state = await newExpense('办公', 999, '合成待删除');
  state = await save({
    kind: 'correct-expense',
    id: 2,
    expected: state.expenses[1],
    expectedRevision: 0,
    expense: {
      category: '办公',
      date: '2026-10-03',
      merchant: '合成办公乙（更正）',
      amount: 21000,
      note: '',
    },
  });
  state = await save({
    kind: 'set-invoice-issued',
    id: 1,
    invoiceIssued: true,
    expected: state.expenses[0],
    expectedRevision: 0,
  });
  state = await save({
    kind: 'delete-expense',
    id: 3,
    expected: state.expenses[2],
    expectedRevision: 0,
  });
  for (const allocations of [
    [
      { expenseId: 1, amount: 10000 },
      { expenseId: 2, amount: 5000 },
    ],
    [{ expenseId: 1, amount: 2000 }],
    [{ expenseId: 2, amount: 3000 }],
  ])
    await save({ kind: 'batch', date: '2026-10-05', allocations });
  await save({ kind: 'cancel', id: 2 });
  return save({ kind: 'delete-batch', id: 3 });
}

module.exports = { ledgerFixture, read, snapshot, funds, seedVariedLedger };
