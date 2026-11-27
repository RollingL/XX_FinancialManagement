const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto'),
  Database = require('better-sqlite3');
const { createLedger } = require('../src/main/ledger.cjs');
const png = fs.readFileSync(path.join(__dirname, 'fixtures/synthetic-payment.png'));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xx-crud-'));
  let ledger = createLedger(root);
  t.after(() => {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    get ledger() {
      return ledger;
    },
    reopen() {
      ledger.close();
      ledger = createLedger(root);
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
const read = (f) => f.ledger.command({ kind: 'read' }),
  cash = (s) => ({
    advances: s.advances,
    expenseFlows: s.expenses.map((e) => ({ id: e.id, date: e.date, amount: -e.amount })),
    balance: s.advances.reduce((a, b) => a + b, 0) - s.expenses.reduce((a, e) => a + e.amount, 0),
  });
async function setup(t) {
  const f = fixture(t);
  await f.ledger.command({
    kind: 'advance',
    requestId: randomUUID(),
    advance: { amount: 1000, date: '2026-10-13', note: '合成预支' },
    image: { base64: png.toString('base64') },
  });
  await f.ledger.command({
    kind: 'expense',
    requestId: randomUUID(),
    expense: {
      amount: 2000,
      date: '2026-10-13',
      note: '合成',
      category: '办公',
      merchant: '合成商户',
    },
    image: { base64: png.toString('base64') },
  });
  return f;
}
const advanceRequest = (
  s,
  id,
  kind = 'correct-advance',
  advance = { amount: 999, date: '2026-10-12', note: '合成纠错' },
) => ({
  kind,
  requestId: randomUUID(),
  id,
  expectedAmount: s.advances[id],
  expected: structuredClone(s.advanceDetails?.[id] ?? null),
  expectedRevision: (s.advanceEvents ?? []).filter((e) => e.advanceId === id).length,
  ...(kind === 'correct-advance' ? { advance } : {}),
});
const expenseDelete = (s) => ({
  kind: 'delete-expense',
  requestId: randomUUID(),
  id: 1,
  expected: structuredClone(s.expenses[0]),
  expectedRevision: (s.expenseEvents ?? []).filter((e) => e.expenseId === 1).length,
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
test('advance edit/delete preserves stable IDs, attachment metadata and audit; replay, stale snapshot and reopen', async (t) => {
  const f = await setup(t),
    before = await snapshot(f),
    first = advanceRequest(before.state, 0),
    edited = await f.ledger.command(first);
  assert.equal(edited.advances[0], 999);
  assert.equal(cash(edited).balance, cash(before.state).balance - 1);
  assert.deepEqual(edited.expenses, before.state.expenses);
  assert.equal(edited.advanceDetails[0].createdAt, before.state.advanceDetails[0].createdAt);
  assert.equal(edited.advanceDetails[0].attachmentId, before.state.advanceDetails[0].attachmentId);
  assert.deepEqual(edited.advanceEvents[0].before, {
    amount: 1000,
    details: before.state.advanceDetails[0],
  });
  await assert.rejects(f.ledger.command({ ...first, requestId: randomUUID() }), /已变化/);
  const remove = advanceRequest(edited, 0, 'delete-advance'),
    deleted = await f.ledger.command(remove);
  assert.deepEqual(deleted.advances, [0]);
  assert.equal(deleted.advanceDetails[0].deleted, true);
  assert.equal(deleted.advanceEvents[1].after, null);
  assert.equal(cash(deleted).balance, -2000);
  const saved = await snapshot(f);
  assert.deepEqual(saved.files, before.files);
  assert.deepEqual(await f.ledger.command(remove), deleted);
  assert.deepEqual(await f.ledger.command(first), deleted);
  f.reopen();
  assert.deepEqual(await snapshot(f), saved);
  const added = await f.ledger.command({
    kind: 'advance',
    requestId: randomUUID(),
    advance: { amount: 1, date: '2026-10-13', note: '' },
  });
  assert.deepEqual(added.advances, [0, 1]);
  assert.equal(added.advanceDetails[1].date, '2026-10-13');
});
test('legacy advance deletion does not invent dates; invalid/stale fields and transaction failure rollback', async (t) => {
  const f = fixture(t);
  f.db((db) =>
    db
      .prepare('UPDATE trial_state SET json=?')
      .run(JSON.stringify({ expenses: [], batches: [], advances: [123] })),
  );
  const initial = await snapshot(f),
    input = advanceRequest(initial.state, 0, 'delete-advance');
  for (const change of [
    { id: -1 },
    { expectedAmount: 124 },
    { expectedRevision: 1 },
    { expected: {} },
    { image: { base64: 'abc' } },
  ]) {
    await assert.rejects(f.ledger.command({ ...input, ...change }));
    assert.deepEqual(await snapshot(f), initial);
  }
  f.db((db) =>
    db.exec(
      "CREATE TRIGGER fail_delete BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
    ),
  );
  await assert.rejects(f.ledger.command(input), /synthetic rollback/);
  assert.deepEqual(await snapshot(f), initial);
  f.db((db) => db.exec('DROP TRIGGER fail_delete'));
  const after = await f.ledger.command(input);
  assert.deepEqual(after.advanceDetails[0], { deleted: true });
  assert.deepEqual(after.advanceEvents[0].before, { amount: 123, details: null });
});
test('expense deletion rejects active allocation, permits canceled historical references, preserves attachments and reserves ID', async (t) => {
  const f = await setup(t),
    state = await f.ledger.command({
      kind: 'batch',
      requestId: randomUUID(),
      date: '2026-10-13',
      allocations: [{ expenseId: 1, amount: 100 }],
    }),
    before = await snapshot(f);
  await assert.rejects(f.ledger.command(expenseDelete(state)), /有效报销分配/);
  assert.deepEqual(await snapshot(f), before);
  const canceled = await f.ledger.command({ kind: 'cancel', requestId: randomUUID(), id: 1 }),
    input = expenseDelete(canceled),
    deleted = await f.ledger.command(input);
  assert.deepEqual(deleted.expenses, []);
  assert.deepEqual(deleted.batches, canceled.batches);
  assert.equal(deleted.expenseEvents[0].after, null);
  assert.deepEqual(deleted.expenseEvents[0].before, canceled.expenses[0]);
  assert.equal(cash(deleted).balance, 1000);
  assert.deepEqual((await snapshot(f)).files, before.files);
  assert.deepEqual(await f.ledger.command(input), deleted);
  f.reopen();
  assert.deepEqual(await read(f), deleted);
  const added = await f.ledger.command({
    kind: 'expense',
    requestId: randomUUID(),
    expense: { amount: 1, date: '2026-10-13', category: '办公', merchant: '新合成', note: '' },
  });
  assert.equal(added.expenses[0].id, 2);
});
test('expense deletion operation failure rolls back state/audit and retries exactly once', async (t) => {
  const f = await setup(t),
    before = await snapshot(f),
    input = expenseDelete(before.state);
  f.db((db) =>
    db.exec(
      "CREATE TRIGGER fail_delete BEFORE INSERT ON operations WHEN NEW.kind='delete-expense' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
    ),
  );
  await assert.rejects(f.ledger.command(input), /synthetic rollback/);
  assert.deepEqual(await snapshot(f), before);
  f.db((db) => db.exec('DROP TRIGGER fail_delete'));
  const result = await f.ledger.command(input);
  assert.equal(result.expenseEvents.length, 1);
  assert.deepEqual(await f.ledger.command(input), result);
});
test('retired batch invoice payload is rejected and expense deletion preserves historical invoice fields', async (t) => {
  const f = await setup(t),
    state = await read(f),
    invoice = { id: 1, expenseIds: [1], allocations: [{ expenseId: 1, amount: 1 }] };
  state.invoices = [invoice];
  state.invoiceEvents = [];
  f.db((db) => db.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(state)));
  const before = await snapshot(f);
  await assert.rejects(
    f.ledger.command({
      kind: 'batch',
      requestId: randomUUID(),
      date: '2026-10-13',
      allocations: [{ expenseId: 1, amount: 100 }],
      invoiceLinks: [],
    }),
    /发票管理已停用/,
  );
  assert.deepEqual(await snapshot(f), before);
  const deleted = await f.ledger.command(expenseDelete(state));
  assert.deepEqual(deleted.invoices, state.invoices);
  assert.deepEqual(deleted.invoiceEvents, state.invoiceEvents);
  assert.deepEqual((await snapshot(f)).files, before.files);
});
