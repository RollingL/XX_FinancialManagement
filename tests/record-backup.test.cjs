const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { randomUUID } = require('node:crypto'),
  Database = require('better-sqlite3');
const { createManagedLedger } = require('../spike/managed-ledger.cjs');
const { verifyBackup, restoreBackup, inspectDatabase } = require('../spike/ledger-backup.cjs');
const { syntheticPng } = require('./synthetic-image.cjs');
const image = (n) => ({ base64: syntheticPng({ seed: n }).toString('base64') });
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-crud-backup-'))),
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
  };
}
test('deleted advances, edited/deleted expenses and expense audits fully back up, restore, reopen', async (t) => {
  const f = fixture(t);
  let state = await f.send({
    kind: 'advance',
    advance: { amount: 100, date: '2026-10-13', note: '' },
    image: image(1),
  });
  state = await f.send({
    kind: 'correct-advance',
    id: 0,
    expectedAmount: 100,
    expected: state.advanceDetails[0],
    expectedRevision: 0,
    advance: { amount: 200, date: '2026-10-12', note: '改' },
  });
  state = await f.send({
    kind: 'delete-advance',
    id: 0,
    expectedAmount: 200,
    expected: state.advanceDetails[0],
    expectedRevision: 1,
  });
  state = await f.send({
    kind: 'expense',
    expense: { category: '办公', date: '2026-10-13', merchant: '合成', amount: 100, note: '' },
    image: image(2),
  });
  state = await f.send({
    kind: 'batch',
    date: '2026-10-13',
    allocations: [{ expenseId: 1, amount: 10 }],
  });
  state = await f.send({ kind: 'cancel', id: 1 });
  state = await f.send({
    kind: 'correct-expense',
    id: 1,
    expected: state.expenses[0],
    expectedRevision: 0,
    expense: { category: '接待', date: '2026-10-13', merchant: '合成改', amount: 2, note: '' },
  });
  state = await f.send({
    kind: 'delete-expense',
    id: 1,
    expected: state.expenses[0],
    expectedRevision: 1,
  });
  const saved = await f.ledger.backup(f.parent);
  assert.equal(saved.summary.balanceCents, '0');
  assert.equal(saved.summary.advanceCount, 0);
  assert.equal(saved.summary.expenseCount, 0);
  verifyBackup(saved.directory);
  const restored = restoreBackup({
    backupDir: saved.directory,
    targetDir: path.join(f.parent, 'restored'),
  });
  inspectDatabase(path.join(restored.directory, 'trial.sqlite'));
  const db = new Database(path.join(restored.directory, 'trial.sqlite'), { readonly: true });
  try {
    const raw = JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);
    assert.deepEqual({ ...raw, generation: state.generation }, state);
  } finally {
    db.close();
  }
  await f.reopen();
  assert.deepEqual(await f.ledger.command({ kind: 'read' }), state);
  const file = path.join(f.root, 'trial.sqlite');
  await f.ledger.close();
  const edit = new Database(file);
  try {
    const raw = JSON.parse(edit.prepare('SELECT json FROM trial_state').get().json);
    raw.advanceEvents[1].before.amount++;
    edit.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(raw));
  } finally {
    edit.close();
  }
  assert.throws(() => inspectDatabase(file), /审计链/);
});

test('editing an amount-only legacy advance records the correction time and remains backup/restore/reopen compatible', async (t) => {
  const f = fixture(t);
  await f.send({
    kind: 'expense',
    expense: {
      category: '办公',
      date: '2026-10-16',
      merchant: '合成旧账本费用',
      amount: 401,
      note: '',
    },
    image: image(3),
  });
  await f.ledger.close();
  const db = new Database(path.join(f.root, 'trial.sqlite'));
  try {
    const state = JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);
    state.advances = [100];
    db.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(state));
  } finally {
    db.close();
  }
  await f.reopen();
  const before = await f.ledger.command({ kind: 'read' }),
    request = {
      kind: 'correct-advance',
      requestId: randomUUID(),
      id: 0,
      expectedAmount: 100,
      expected: null,
      expectedRevision: 0,
      advance: { amount: 201, date: '2026-10-16', note: '合成更正' },
    };
  assert.equal(before.advanceDetails, undefined);
  const after = await f.send(request),
    event = after.advanceEvents[0];
  assert.deepEqual(event.before, { amount: 100, details: null });
  assert.deepEqual(after.expenses, before.expenses);
  assert.deepEqual(after.batches, before.batches);
  assert.equal(after.advances[0] - before.advances[0], 101);
  assert.equal(after.advances[0] - after.expenses[0].amount, -200);
  const saved = await f.ledger.backup(f.parent);
  verifyBackup(saved.directory);
  assert.equal(after.advanceDetails[0].createdAt, event.at);
  assert.equal(event.after.details.createdAt, event.at);
  assert.equal(after.advanceDetails[0].date, '2026-10-16');
  assert.deepEqual(await f.send(request), after);
  const restored = restoreBackup({
      backupDir: saved.directory,
      targetDir: path.join(f.parent, 'legacy-restored'),
    }),
    opened = createManagedLedger(restored.directory, { backupDestination: f.parent });
  try {
    assert.deepEqual(
      { ...(await opened.command({ kind: 'read' })), generation: after.generation },
      after,
    );
    for (const file of fs.readdirSync(path.join(f.root, 'attachments')))
      assert.deepEqual(
        fs.readFileSync(path.join(restored.directory, 'attachments', file)),
        fs.readFileSync(path.join(f.root, 'attachments', file)),
      );
  } finally {
    await opened.close();
  }
  await f.reopen();
  assert.deepEqual(await f.ledger.command({ kind: 'read' }), after);
  inspectDatabase(path.join(f.root, 'trial.sqlite'));
});
