const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { createManagedLedger } = require('../spike/managed-ledger.cjs');
const { createLedger } = require('../spike/trial-ledger.cjs');
const {
  createBackup,
  inspectDatabase,
  verifyBackup,
  restoreBackup,
} = require('../spike/ledger-backup.cjs');
// Generated 1 x 1 PNG, containing no receipt or user data.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOYVnECAAN+AdcpgjGUAAAAAElFTkSuQmCC',
  'base64',
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const service = { recognize: async () => ({ validated: true }) };
const editable = (e) => ({
  category: e.category,
  date: e.date,
  merchant: e.merchant,
  amount: e.amount,
  note: e.note,
});
function mutate(file, fn) {
  const db = new Database(file, { fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
function snapshot(root) {
  const db = new Database(path.join(root, 'trial.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const raw = db.prepare('SELECT json FROM trial_state WHERE id=1').get().json,
      state = JSON.parse(raw);
    return {
      raw,
      state,
      operations: db.prepare('SELECT * FROM operations ORDER BY id').all(),
      attachments: db.prepare('SELECT * FROM attachments ORDER BY id').all(),
      files: fs
        .readdirSync(path.join(root, 'attachments'))
        .sort()
        .map((name) => ({
          name,
          hex: fs.readFileSync(path.join(root, 'attachments', name)).toString('hex'),
        })),
      cash: {
        advances: state.advances,
        advanceDetails: state.advanceDetails,
        expenses: state.expenses,
        flows: [
          ...state.advances.map((amount, index) => ({
            kind: 'advance',
            index,
            amount,
            ...state.advanceDetails?.[index],
          })),
          ...state.expenses.map((e) => ({ kind: 'expense', ...e, amount: -e.amount })),
        ],
        balance:
          state.advances.reduce((sum, n) => sum + BigInt(n), 0n) -
          state.expenses.reduce((sum, e) => sum + BigInt(e.amount), 0n),
      },
    };
  } finally {
    db.close();
  }
}
function fixture(t) {
  const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-correction-backup-')),
    ),
    source = path.join(root, 'source'),
    destination = path.join(root, 'backups');
  fs.mkdirSync(destination);
  const opened = new Set();
  let ledger;
  const open = (directory = source) => {
    const value = createManagedLedger(directory, service);
    opened.add(value);
    return value;
  };
  ledger = open();
  t.after(async () => {
    for (const item of opened) await item.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    source,
    destination,
    open,
    get ledger() {
      return ledger;
    },
    async reopen() {
      await ledger.close();
      ledger = open();
      return ledger;
    },
    async command(input) {
      const state = await ledger.command({ kind: 'read' });
      return ledger.command({ ...input, requestId: randomUUID(), generation: state.generation });
    },
    async correct(id, changes) {
      const state = await ledger.command({ kind: 'read' }),
        expected = state.expenses.find((e) => e.id === id);
      return this.command({
        kind: 'correct-expense',
        id,
        expectedRevision: (state.expenseEvents || []).filter((e) => e.expenseId === id).length,
        expected,
        expense: { ...editable(expected), ...changes },
      });
    },
  };
}
async function corrected(f, { legacyMetadata = false } = {}) {
  await f.command({
    kind: 'advance',
    advance: { amount: 5000, date: '2026-10-12', note: '合成预支' },
  });
  await f.command({
    kind: 'expense',
    expense: {
      amount: 1000,
      date: '2026-10-10',
      category: '接待',
      merchant: '合成原摘要',
      note: '',
    },
    image: { base64: png.toString('base64') },
  });
  await f.command({
    kind: 'expense',
    expense: {
      amount: 1001,
      date: '2026-10-11',
      category: '办公',
      merchant: '合成另一费用',
      note: '',
    },
  });
  if (legacyMetadata) {
    await f.ledger.close();
    mutate(path.join(f.source, 'trial.sqlite'), (db) => {
      const state = JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);
      state.expenses[0].legacy = { label: 'synthetic', values: [1, { preserved: true }] };
      db.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(state));
    });
    await f.reopen();
  }
  await f.correct(1, {
    amount: 300,
    date: '2026-10-09',
    category: '办公',
    merchant: '合成第一次纠错',
    note: '第一次',
  });
  await f.correct(1, {
    amount: 9000,
    date: '2026-10-12',
    merchant: '合成第二次纠错',
    note: '第二次',
  });
  return snapshot(f.source);
}
function resealDatabase(directory, change) {
  const file = path.join(directory, 'database.sqlite');
  mutate(file, (db) => {
    const state = JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);
    change(state);
    db.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(state));
  });
  const manifestFile = path.join(directory, 'manifest.json'),
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')),
    bytes = fs.readFileSync(file);
  manifest.database = { path: 'database.sqlite', size: bytes.length, sha256: hash(bytes) };
  const serialized = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(manifestFile, serialized);
  fs.writeFileSync(
    path.join(directory, 'COMPLETE'),
    JSON.stringify({ backupId: manifest.backupId, manifestSha256: hash(serialized) }),
  );
}

test('managed two corrections then reimbursement preserve raw facts, audit, attachments and money through backup, restore and reopen', async (t) => {
  const f = fixture(t),
    correctedFacts = await corrected(f, { legacyMetadata: true });
  const events = correctedFacts.state.expenseEvents;
  assert.deepEqual(
    events.map((e) => e.revision),
    [1, 2],
  );
  assert.deepEqual(events[0].after, events[1].before);
  assert.deepEqual(events[1].after, correctedFacts.state.expenses[0]);
  assert.deepEqual(events[0].before.legacy, events[1].after.legacy);
  assert.equal(events[0].before.attachmentId, events[1].after.attachmentId);
  // This allocation exceeds both historical amounts; it must use the corrected amount.
  await f.command({
    kind: 'batch',
    date: '2026-10-12',
    allocations: [{ expenseId: 1, amount: 6000 }],
  });
  const before = snapshot(f.source),
    sourceGeneration = (await f.ledger.command({ kind: 'read' })).generation;
  assert.deepEqual(before.cash, correctedFacts.cash);
  assert.equal(before.cash.balance, -5001n);
  const saved = await f.ledger.backup(f.destination);
  assert.deepEqual(verifyBackup(saved.directory).summary, saved.summary);
  assert.deepEqual(
    {
      expense: saved.summary.totalExpenseCents,
      advance: saved.summary.totalAdvanceCents,
      balance: saved.summary.balanceCents,
      personal: saved.summary.personalFundingCents,
      paid: saved.summary.reimbursedCents,
      pending: saved.summary.pendingCents,
    },
    {
      expense: '10001',
      advance: '5000',
      balance: '-5001',
      personal: '5001',
      paid: '6000',
      pending: '4001',
    },
  );
  for (const name of ['restored-a', 'restored-b']) {
    const restored = restoreBackup({
      backupDir: saved.directory,
      targetDir: path.join(f.root, name),
    });
    assert.notEqual(restored.ledgerId, f.ledger.ledgerId);
    assert.deepEqual(
      fs.readFileSync(path.join(restored.directory, 'trial.sqlite')),
      fs.readFileSync(path.join(saved.directory, 'database.sqlite')),
    );
    assert.deepEqual(snapshot(restored.directory), before);
    const ledger = f.open(restored.directory),
      state = await ledger.command({ kind: 'read' });
    assert.deepEqual({ ...state, generation: before.state.generation }, before.state);
    assert.notEqual(state.generation, sourceGeneration);
    assert.equal(state.generation, `${restored.ledgerId}:${before.state.generation}`);
    const attachment = await ledger.command({
      kind: 'attachment',
      id: state.expenses[0].attachmentId,
      generation: state.generation,
    });
    assert.deepEqual(Buffer.from(attachment.base64, 'base64'), png);
    await ledger.close();
    assert.deepEqual(snapshot(restored.directory), before);
  }
  await f.reopen();
  assert.deepEqual(snapshot(f.source), before);
  assert.equal((await f.ledger.command({ kind: 'read' })).generation, sourceGeneration);
});

test('revision chains are per expense even when corrections are interleaved', async (t) => {
  const f = fixture(t);
  await corrected(f);
  await f.correct(2, { amount: 2 });
  await f.correct(1, { amount: 1 });
  await f.correct(2, { amount: 3 });
  const state = snapshot(f.source).state;
  assert.deepEqual(
    state.expenseEvents.map((e) => [e.expenseId, e.revision]),
    [
      [1, 1],
      [1, 2],
      [2, 1],
      [1, 3],
      [2, 2],
    ],
  );
  const saved = await f.ledger.backup(f.destination);
  assert.equal(saved.summary.totalExpenseCents, '4');
  await f.reopen();
  assert.deepEqual(snapshot(f.source).state, state);
});

test('later cancelled and deleted reimbursements do not invalidate earlier legal correction history', async (t) => {
  const f = fixture(t);
  await corrected(f);
  const cash = snapshot(f.source).cash;
  await f.command({
    kind: 'batch',
    date: '2026-10-12',
    allocations: [{ expenseId: 1, amount: 7000 }],
  });
  await f.command({ kind: 'cancel', id: 1 });
  await f.command({
    kind: 'batch',
    date: '2026-10-12',
    allocations: [{ expenseId: 1, amount: 8000 }],
  });
  await f.command({ kind: 'delete-batch', id: 2 });
  const before = snapshot(f.source),
    saved = await f.ledger.backup(f.destination);
  assert.deepEqual(before.cash, cash);
  assert.equal(saved.summary.cancelledBatchCount, 1);
  assert.equal(saved.summary.deletedBatchCount, 1);
  assert.equal(saved.summary.reimbursedCents, '0');
  const restored = restoreBackup({
    backupDir: saved.directory,
    targetDir: path.join(f.root, 'deleted'),
  });
  const ledger = f.open(restored.directory);
  await ledger.close();
  assert.deepEqual(snapshot(restored.directory), before);
});

test('invalid event shape, values, stable fields and revision chains are rejected without repairing state', async (t) => {
  const f = fixture(t),
    before = await corrected(f, { legacyMetadata: true });
  await f.ledger.close();
  const file = path.join(f.source, 'trial.sqlite');
  const cases = [
    [
      'null history',
      (s) => {
        s.expenseEvents = null;
      },
    ],
    [
      'object history',
      (s) => {
        s.expenseEvents = {};
      },
    ],
    [
      'unknown action',
      (s) => {
        s.expenseEvents[0].action = 'expense';
      },
    ],
    [
      'unknown event field',
      (s) => {
        s.expenseEvents[0].extra = true;
      },
    ],
    [
      'missing snapshot',
      (s) => {
        delete s.expenseEvents[0].before;
      },
    ],
    [
      'invalid request id',
      (s) => {
        s.expenseEvents[0].requestId = 'a'.repeat(36);
      },
    ],
    [
      'duplicate request',
      (s) => {
        s.expenseEvents[1].requestId = s.expenseEvents[0].requestId;
      },
    ],
    [
      'invalid timestamp',
      (s) => {
        s.expenseEvents[0].at = '2026-10-12';
      },
    ],
    [
      'missing expense',
      (s) => {
        s.expenseEvents[0].expenseId = 99;
      },
    ],
    [
      'snapshot id changed',
      (s) => {
        s.expenseEvents[0].before.id = 2;
      },
    ],
    [
      'unsafe amount',
      (s) => {
        s.expenseEvents[0].before.amount = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      'negative amount',
      (s) => {
        s.expenseEvents[0].before.amount = -1;
      },
    ],
    [
      'zero amount',
      (s) => {
        s.expenseEvents[0].before.amount = 0;
      },
    ],
    [
      'fractional amount',
      (s) => {
        s.expenseEvents[0].after.amount = 0.5;
      },
    ],
    [
      'invalid date',
      (s) => {
        s.expenseEvents[0].before.date = '2026-02-30';
      },
    ],
    [
      'unknown category',
      (s) => {
        s.expenseEvents[0].before.category = '其他';
      },
    ],
    [
      'blank merchant',
      (s) => {
        s.expenseEvents[0].before.merchant = ' ';
      },
    ],
    [
      'long note',
      (s) => {
        s.expenseEvents[0].before.note = 'x'.repeat(501);
      },
    ],
    [
      'invalid attachment',
      (s) => {
        s.expenseEvents[0].before.attachmentId = '../x';
      },
    ],
    [
      'changed attachment',
      (s) => {
        s.expenseEvents[0].before.attachmentId = randomUUID();
      },
    ],
    [
      'removed attachment',
      (s) => {
        delete s.expenseEvents[0].before.attachmentId;
      },
    ],
    [
      'changed invoice',
      (s) => {
        s.expenseEvents[0].before.invoice = 1;
      },
    ],
    [
      'unknown field changed',
      (s) => {
        s.expenseEvents[0].before.legacy.values[1].preserved = false;
      },
    ],
    [
      'unknown field removed',
      (s) => {
        delete s.expenseEvents[0].before.legacy;
      },
    ],
    [
      'zero revision',
      (s) => {
        s.expenseEvents[0].revision = 0;
      },
    ],
    [
      'fractional revision',
      (s) => {
        s.expenseEvents[0].revision = 1.5;
      },
    ],
    [
      'first revision skipped',
      (s) => {
        s.expenseEvents[0].revision = 2;
      },
    ],
    [
      'revision duplicate',
      (s) => {
        s.expenseEvents[1].revision = 1;
      },
    ],
    [
      'revision gap',
      (s) => {
        s.expenseEvents[1].revision = 3;
      },
    ],
    [
      'reordered history',
      (s) => {
        s.expenseEvents.reverse();
      },
    ],
    [
      'broken before after chain',
      (s) => {
        s.expenseEvents[1].before.note = 'not the first after';
      },
    ],
    [
      'last after differs',
      (s) => {
        s.expenseEvents[1].after.merchant = 'not current';
      },
    ],
    [
      'no change',
      (s) => {
        s.expenseEvents[0].after = structuredClone(s.expenseEvents[0].before);
      },
    ],
  ];
  for (const [label, change] of cases) {
    const state = JSON.parse(before.raw);
    change(state);
    const raw = JSON.stringify(state);
    mutate(file, (db) => db.prepare('UPDATE trial_state SET json=?').run(raw));
    assert.throws(() => inspectDatabase(file), undefined, label);
    assert.equal(snapshot(f.source).raw, raw, label);
  }
  mutate(file, (db) => db.prepare('UPDATE trial_state SET json=?').run(before.raw));
  inspectDatabase(file);
  await f.reopen();
  assert.deepEqual(snapshot(f.source), before);
});

test('correction operations and audit events must correspond in both directions and share the timestamp', async (t) => {
  const f = fixture(t),
    before = await corrected(f);
  await f.ledger.close();
  const file = path.join(f.source, 'trial.sqlite'),
    event = before.state.expenseEvents[0];
  const reset = (db) => {
    db.prepare('UPDATE trial_state SET json=?').run(before.raw);
    db.exec('DELETE FROM operations');
    const insert = db.prepare('INSERT INTO operations VALUES(@id,@digest,@kind,@created_at)');
    for (const row of before.operations) insert.run(row);
  };
  const cases = [
    [
      'audit absent',
      (db) => {
        const state = JSON.parse(before.raw);
        delete state.expenseEvents;
        db.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(state));
      },
    ],
    [
      'operation absent',
      (db) => db.prepare('DELETE FROM operations WHERE id=?').run(event.requestId),
    ],
    [
      'operation kind mismatch',
      (db) => db.prepare('UPDATE operations SET kind=? WHERE id=?').run('expense', event.requestId),
    ],
    [
      'operation time mismatch',
      (db) =>
        db
          .prepare('UPDATE operations SET created_at=? WHERE id=?')
          .run('2026-01-01T00:00:00.000Z', event.requestId),
    ],
    [
      'extra correction operation',
      (db) =>
        db
          .prepare('INSERT INTO operations VALUES(?,?,?,?)')
          .run(randomUUID(), 'a'.repeat(64), 'correct-expense', event.at),
    ],
  ];
  for (const [label, change] of cases) {
    mutate(file, (db) => {
      reset(db);
      change(db);
    });
    assert.throws(() => inspectDatabase(file), undefined, label);
  }
  mutate(file, reset);
  await f.reopen();
  assert.deepEqual(snapshot(f.source), before);
});

test('resealed invalid audit cannot bypass backup verification, restore or managed reopening', async (t) => {
  const f = fixture(t);
  await corrected(f);
  const saved = await f.ledger.backup(f.destination),
    target = path.join(f.root, 'must-not-exist');
  resealDatabase(saved.directory, (s) => {
    s.expenseEvents[1].before.amount = 301;
  });
  assert.throws(() => verifyBackup(saved.directory), /链不连续/);
  assert.throws(() => restoreBackup({ backupDir: saved.directory, targetDir: target }), /链不连续/);
  assert.equal(fs.existsSync(target), false);
  await f.ledger.close();
  mutate(path.join(f.source, 'trial.sqlite'), (db) => {
    const state = JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);
    state.expenseEvents[1].before.amount = 301;
    db.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(state));
  });
  const before = snapshot(f.source);
  assert.throws(() => createManagedLedger(f.source, service), /链不连续/);
  assert.equal(fs.existsSync(path.join(f.source, '.writer-lock')), false);
  assert.deepEqual(snapshot(f.source), before);
});

test('legacy JSON without operations or correction history keeps original bytes and manifest summary format', async (t) => {
  const f = fixture(t),
    source = path.join(f.root, 'legacy'),
    ledger = createLedger(source, service);
  ledger.close();
  const raw =
    '{"expenses": [{"id":1,"category":"接待","date":"2026-10-12","merchant":"合成旧费用","amount":1,"note":"","invoice":0}], "advances": [1], "batches": []}';
  mutate(path.join(source, 'trial.sqlite'), (db) =>
    db.prepare('UPDATE trial_state SET json=?').run(raw),
  );
  const db = new Database(path.join(source, 'trial.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  let saved;
  try {
    saved = await createBackup({
      db,
      dataDir: source,
      destinationParent: f.destination,
      ledgerId: randomUUID(),
      sourceKind: 'isolated-test',
    });
  } finally {
    db.close();
  }
  assert.deepEqual(
    Object.keys(saved.summary).sort(),
    [
      'expenseCount',
      'advanceCount',
      'batchCount',
      'activeBatchCount',
      'cancelledBatchCount',
      'deletedBatchCount',
      'allocationCount',
      'deletedAllocationCount',
      'operationCount',
      'attachmentCount',
      'totalExpenseCents',
      'totalAdvanceCents',
      'balanceCents',
      'personalFundingCents',
      'reimbursedCents',
      'pendingCents',
      'attachmentFileCount',
    ].sort(),
  );
  const restored = restoreBackup({
    backupDir: saved.directory,
    targetDir: path.join(f.root, 'legacy-restored'),
  });
  assert.equal(snapshot(restored.directory).raw, raw);
  const reopened = f.open(restored.directory);
  assert.equal((await reopened.command({ kind: 'read' })).expenseEvents, undefined);
  await reopened.close();
  assert.equal(snapshot(restored.directory).raw, raw);
  assert.equal(snapshot(source).raw, raw);
  assert.equal(saved.summary.operationCount, 0);
});
