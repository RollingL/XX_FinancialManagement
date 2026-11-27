const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { createLedger } = require('../spike/trial-ledger.cjs');
const { createBackup, verifyBackup, restoreBackup } = require('../spike/ledger-backup.cjs');
// Generated 1 x 1 PNG, containing no receipt or user data.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOYVnECAAN+AdcpgjGUAAAAAElFTkSuQmCC',
  'base64',
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-backup-test-'))),
    source = path.join(root, 'source'),
    destination = path.join(root, 'backups');
  fs.mkdirSync(destination);
  const ledger = createLedger(source, { recognize: async () => ({ validated: true }) });
  const db = new Database(path.join(source, 'trial.sqlite'), {
      readonly: true,
      fileMustExist: true,
    }),
    ledgerId = randomUUID();
  t.after(() => {
    db.close();
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const command = (input) => ledger.command({ ...input, requestId: randomUUID() });
  return {
    root,
    source,
    destination,
    ledger,
    db,
    ledgerId,
    command,
    backup: () =>
      createBackup({
        db,
        dataDir: source,
        destinationParent: destination,
        ledgerId,
        sourceKind: 'isolated-test',
      }),
    mutate(fn) {
      const writer = new Database(path.join(source, 'trial.sqlite'), { fileMustExist: true });
      try {
        return fn(writer);
      } finally {
        writer.close();
      }
    },
  };
}
function facts(directory) {
  const db = new Database(path.join(directory, 'trial.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const state = db.prepare('SELECT * FROM trial_state').all(),
      parsed = JSON.parse(state[0].json);
    return {
      state,
      operations: db.prepare('SELECT * FROM operations ORDER BY id').all(),
      attachments: db.prepare('SELECT * FROM attachments ORDER BY id').all(),
      files: fs
        .readdirSync(path.join(directory, 'attachments'))
        .sort()
        .map((name) => ({
          name,
          hex: fs.readFileSync(path.join(directory, 'attachments', name)).toString('hex'),
        })),
      cash: {
        advances: parsed.advances,
        advanceDetails: parsed.advanceDetails,
        expenses: parsed.expenses,
        flows: [
          ...parsed.advances.map((amount, index) => ({
            kind: 'advance',
            index,
            amount,
            ...parsed.advanceDetails?.[index],
          })),
          ...parsed.expenses.map((e) => ({ kind: 'expense', ...e, amount: -e.amount })),
        ],
        balance:
          parsed.advances.reduce((sum, n) => sum + BigInt(n), 0n) -
          parsed.expenses.reduce((sum, e) => sum + BigInt(e.amount), 0n),
      },
    };
  } finally {
    db.close();
  }
}
async function populated(f) {
  await f.command({
    kind: 'advance',
    advance: { amount: 10000, date: '2026-10-12', note: '合成到账' },
    image: { base64: png.toString('base64') },
  });
  await f.command({
    kind: 'expense',
    expense: {
      amount: 1,
      date: '2026-10-12',
      category: '接待',
      merchant: '合成一分费用',
      note: '',
    },
    image: { base64: png.toString('base64') },
  });
  await f.command({
    kind: 'expense',
    expense: {
      amount: 50000,
      date: '2026-10-11',
      category: '办公',
      merchant: '合成办公费用',
      note: '',
    },
  });
  await f.command({
    kind: 'batch',
    date: '2026-10-12',
    allocations: [{ expenseId: 2, amount: 10000 }],
  });
  await f.command({ kind: 'cancel', id: 1 });
  await f.command({
    kind: 'batch',
    date: '2026-10-12',
    allocations: [
      { expenseId: 1, amount: 1 },
      { expenseId: 2, amount: 20000 },
    ],
  });
  await f.command({ kind: 'delete-batch', id: 2 });
  await f.command({
    kind: 'batch',
    date: '2026-10-12',
    allocations: [{ expenseId: 1, amount: 1 }],
  });
  return facts(f.source);
}
function reseal(directory, change = () => {}) {
  const file = path.join(directory, 'manifest.json'),
    manifest = readJson(file);
  change(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(
    path.join(directory, 'COMPLETE'),
    JSON.stringify({ backupId: manifest.backupId, manifestSha256: digest(bytes) }),
  );
}
function mutateBackup(directory, fn) {
  const file = path.join(directory, 'database.sqlite'),
    db = new Database(file, { fileMustExist: true });
  try {
    fn(db);
  } finally {
    db.close();
  }
  reseal(directory, (manifest) => {
    const bytes = fs.readFileSync(file);
    manifest.database = { path: 'database.sqlite', size: bytes.length, sha256: digest(bytes) };
  });
}

test('empty ledger exports and restores twice to new independent identities without creating money', async (t) => {
  const f = fixture(t),
    before = facts(f.source),
    saved = await f.backup();
  assert.equal(saved.summary.balanceCents, '0');
  assert.equal(saved.summary.expenseCount, 0);
  assert.equal(saved.ledgerId, f.ledgerId);
  assert.deepEqual(verifyBackup(saved.directory).summary, saved.summary);
  const first = restoreBackup({
      backupDir: saved.directory,
      targetDir: path.join(f.root, '新 目录一'),
    }),
    second = restoreBackup({
      backupDir: saved.directory,
      targetDir: path.join(f.root, '新 目录二'),
    });
  assert.deepEqual(facts(first.directory), before);
  assert.deepEqual(facts(second.directory), before);
  assert.notEqual(first.ledgerId, second.ledgerId);
  assert.notEqual(first.ledgerId, f.ledgerId);
  assert.deepEqual(readJson(path.join(first.directory, 'managed-ledger.json')), {
    formatVersion: 1,
    ledgerId: first.ledgerId,
    sourceKind: 'isolated-test',
  });
  assert.deepEqual(fs.readdirSync(first.directory).sort(), [
    'attachments',
    'managed-ledger.json',
    'trial.sqlite',
  ]);
  assert.deepEqual(facts(f.source), before);
});

test('WAL snapshot preserves cents, negative balance, cancellations, full deletion audit, requests and managed attachments', async (t) => {
  const f = fixture(t),
    before = await populated(f);
  assert.ok(fs.statSync(path.join(f.source, 'trial.sqlite-wal')).size > 0);
  const saved = await f.backup();
  assert.deepEqual(
    {
      balance: saved.summary.balanceCents,
      personal: saved.summary.personalFundingCents,
      paid: saved.summary.reimbursedCents,
      pending: saved.summary.pendingCents,
      deleted: saved.summary.deletedBatchCount,
    },
    { balance: '-40001', personal: '40001', paid: '1', pending: '50000', deleted: 1 },
  );
  const restored = restoreBackup({
    backupDir: saved.directory,
    targetDir: path.join(f.root, 'restored'),
  });
  assert.deepEqual(facts(restored.directory), before);
  assert.deepEqual(facts(f.source), before);
  assert.equal(fs.existsSync(path.join(saved.directory, 'database.sqlite-wal')), false);
  assert.equal(fs.existsSync(path.join(saved.directory, 'database.sqlite-shm')), false);
  const db = new Database(path.join(saved.directory, 'database.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.equal(db.pragma('journal_mode', { simple: true }), 'delete');
    assert.equal(
      JSON.parse(db.prepare('SELECT json FROM trial_state').get().json).batchEvents[0].after,
      null,
    );
  } finally {
    db.close();
  }
});

test('legacy amount-only advances and unknown harmless metadata retain exact original JSON with no invented dates or events', async (t) => {
  const f = fixture(t),
    raw = '{"expenses": [], "batches": [], "advances": [300000,1], "legacyMarker":"synthetic"}';
  f.mutate((db) => db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(raw));
  const before = facts(f.source),
    saved = await f.backup(),
    restored = restoreBackup({
      backupDir: saved.directory,
      targetDir: path.join(f.root, 'legacy'),
    });
  assert.deepEqual(facts(restored.directory), before);
  assert.equal(facts(restored.directory).state[0].json, raw);
  assert.equal(saved.summary.totalAdvanceCents, '300001');
});

test('legal orphan attachments are preserved and marked without becoming ledger records', async (t) => {
  const f = fixture(t);
  await populated(f);
  const name = randomUUID() + '.png';
  fs.writeFileSync(path.join(f.source, 'attachments', name), png);
  const before = facts(f.source),
    saved = await f.backup(),
    orphan = saved.manifest.attachments.find((item) => item.path.endsWith(name));
  assert.equal(orphan.registered, false);
  assert.equal(orphan.referenced, false);
  assert.equal(saved.summary.attachmentFileCount, 3);
  assert.equal(saved.summary.attachmentCount, 2);
  const restored = restoreBackup({
    backupDir: saved.directory,
    targetDir: path.join(f.root, 'orphan'),
  });
  assert.deepEqual(facts(restored.directory), before);
});

test('missing or corrupt registered attachment rejects export and removes only its own partial output', async (t) => {
  const f = fixture(t);
  await populated(f);
  const saved = await f.backup(),
    old = fs.readFileSync(path.join(saved.directory, 'manifest.json'));
  const file = path.join(
    f.source,
    'attachments',
    fs.readdirSync(path.join(f.source, 'attachments'))[0],
  );
  fs.unlinkSync(file);
  await assert.rejects(f.backup(), /缺失/);
  assert.deepEqual(fs.readdirSync(f.destination), [path.basename(saved.directory)]);
  const changed = Buffer.from(png);
  changed[changed.length - 1] ^= 1;
  fs.writeFileSync(file, changed);
  await assert.rejects(f.backup(), /校验值/);
  assert.deepEqual(fs.readFileSync(path.join(saved.directory, 'manifest.json')), old);
  verifyBackup(saved.directory);
});

test('unknown attachment layouts, symlinks, hardlinks and a target inside source are rejected', async (t) => {
  const f = fixture(t),
    external = path.join(f.root, 'synthetic.png');
  fs.writeFileSync(external, png);
  let name = path.join(f.source, 'attachments', randomUUID() + '.png');
  fs.symlinkSync(external, name);
  await assert.rejects(f.backup(), /链接/);
  fs.unlinkSync(name);
  fs.linkSync(external, name);
  await assert.rejects(f.backup(), /链接/);
  fs.unlinkSync(name);
  name = path.join(f.source, 'attachments', 'unknown.txt');
  fs.writeFileSync(name, 'synthetic');
  await assert.rejects(f.backup(), /文件名/);
  fs.unlinkSync(name);
  await assert.rejects(
    createBackup({
      db: f.db,
      dataDir: f.source,
      destinationParent: f.source,
      ledgerId: f.ledgerId,
      sourceKind: 'isolated-test',
    }),
    /账本目录内/,
  );
  assert.deepEqual(fs.readFileSync(external), png);
});

test('integrity_check does not replace JSON, allocation, integer and deletion audit validation', async (t) => {
  const f = fixture(t);
  await populated(f);
  const baseline = facts(f.source).state[0].json;
  const cases = [
    (s) => {
      s.expenses[0].amount = Number.MAX_SAFE_INTEGER + 1;
    },
    (s) => {
      s.expenses[0].invoice = -1;
    },
    (s) => {
      s.expenses[0].date = '2026-02-30';
    },
    (s) => {
      s.expenses.push({ ...s.expenses[0] });
    },
    (s) => {
      s.advances = [Number.MAX_SAFE_INTEGER, 1];
    },
    (s) => {
      s.batches[1].allocations = [{ expenseId: 999, amount: 1 }];
    },
    (s) => {
      s.batches[1].allocations = [
        { expenseId: 1, amount: 1 },
        { expenseId: 1, amount: 1 },
      ];
    },
    (s) => {
      s.batches.push({ ...s.batches[1], id: 4 });
    },
    (s) => {
      s.batchEvents[0].requestId = randomUUID();
    },
    (s) => {
      s.batchEvents[0].before.id = 99;
    },
    (s) => {
      s.batchEvents = [];
    },
    (s) => {
      s.batchEvents = null;
    },
    (s) => {
      s.batches[0].deleted = true;
    },
    (s) => {
      s.advanceDetails['9'] = s.advanceDetails['0'];
    },
    (s) => {
      s.expenses[0].attachmentId = randomUUID();
    },
  ];
  for (const change of cases) {
    const state = JSON.parse(baseline);
    change(state);
    f.mutate((db) =>
      db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(state)),
    );
    await assert.rejects(f.backup());
    assert.deepEqual(fs.readdirSync(f.destination), []);
  }
  f.mutate((db) => db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(baseline));
  await f.backup();
});

test('unknown database triggers and unsafe metadata paths reject export before reading external files', async (t) => {
  const f = fixture(t);
  await populated(f);
  f.mutate((db) =>
    db.exec('CREATE TRIGGER synthetic_extra AFTER INSERT ON operations BEGIN SELECT 1; END'),
  );
  await assert.rejects(f.backup(), /触发器/);
  f.mutate((db) => {
    db.exec('DROP TRIGGER synthetic_extra');
    db.prepare('UPDATE attachments SET file=? WHERE id=(SELECT id FROM attachments LIMIT 1)').run(
      '../synthetic.png',
    );
  });
  await assert.rejects(f.backup(), /受管单层/);
  assert.deepEqual(fs.readdirSync(f.destination), []);
});

test('manifest/complete mismatch, unknown versions, traversal and false summaries cannot restore', async (t) => {
  const f = fixture(t);
  await populated(f);
  for (const alter of [
    (d) => fs.writeFileSync(path.join(d, 'COMPLETE'), '{}'),
    (d) =>
      reseal(d, (m) => {
        m.formatVersion = 99;
      }),
    (d) =>
      reseal(d, (m) => {
        m.database.path = '../source/trial.sqlite';
      }),
    (d) =>
      reseal(d, (m) => {
        m.attachments[0].path = '../../outside.png';
      }),
    (d) =>
      reseal(d, (m) => {
        m.summary.balanceCents = '123';
      }),
    (d) => fs.writeFileSync(path.join(d, 'unknown.txt'), 'synthetic'),
  ]) {
    const saved = await f.backup(),
      target = path.join(f.root, randomUUID());
    alter(saved.directory);
    assert.throws(() => restoreBackup({ backupDir: saved.directory, targetDir: target }));
    assert.equal(fs.existsSync(target), false);
  }
});

test('resealed database with invalid business facts is rejected, not accepted solely by hashes', async (t) => {
  const f = fixture(t);
  await populated(f);
  const saved = await f.backup();
  mutateBackup(saved.directory, (db) => {
    const state = JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);
    state.batches[1].allocations[0].amount = 2;
    db.prepare('UPDATE trial_state SET json=?').run(JSON.stringify(state));
  });
  assert.throws(() => verifyBackup(saved.directory), /分配/);
});

test('backup attachment missing, changed, or symlinked is rejected without touching source', async (t) => {
  const f = fixture(t),
    before = await populated(f);
  for (const operation of ['remove', 'change', 'symlink']) {
    const saved = await f.backup(),
      file = path.join(saved.directory, saved.manifest.attachments[0].path);
    fs.unlinkSync(file);
    if (operation === 'change') {
      const bytes = Buffer.from(png);
      bytes[bytes.length - 1] ^= 1;
      fs.writeFileSync(file, bytes);
    }
    if (operation === 'symlink')
      fs.symlinkSync(path.join(f.source, 'attachments', path.basename(file)), file);
    assert.throws(() => verifyBackup(saved.directory));
    assert.deepEqual(facts(f.source), before);
  }
});

test('existing target, dangling symlink and incomplete published-looking directory are never overwritten', async (t) => {
  const f = fixture(t),
    saved = await f.backup(),
    existing = path.join(f.root, 'existing');
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, 'keep'), 'synthetic keep');
  assert.throws(() => restoreBackup({ backupDir: saved.directory, targetDir: existing }), /新目录/);
  assert.equal(fs.readFileSync(path.join(existing, 'keep'), 'utf8'), 'synthetic keep');
  const link = path.join(f.root, 'dangling');
  fs.symlinkSync(path.join(f.root, 'absent'), link);
  assert.throws(() => restoreBackup({ backupDir: saved.directory, targetDir: link }), /新目录/);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  const partial = path.join(f.destination, '.partial-backup-test');
  fs.cpSync(saved.directory, partial, { recursive: true });
  assert.throws(() => verifyBackup(partial), /暂存/);
});

test('backup API failure and simulated ENOSPC preserve source and prior complete backup', async (t) => {
  const f = fixture(t),
    before = await populated(f),
    saved = await f.backup(),
    existing = fs.readdirSync(f.destination);
  const failingDb = {
    open: true,
    name: f.db.name,
    async backup(file) {
      fs.writeFileSync(file, 'synthetic partial');
      throw Error('synthetic backup failure');
    },
  };
  await assert.rejects(
    createBackup({
      db: failingDb,
      dataDir: f.source,
      destinationParent: f.destination,
      ledgerId: f.ledgerId,
      sourceKind: 'isolated-test',
    }),
    /synthetic backup failure/,
  );
  assert.deepEqual(fs.readdirSync(f.destination), existing);
  const original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, bytes, ...rest) {
    if (Buffer.isBuffer(bytes) && bytes.equals(png))
      throw Object.assign(Error('synthetic ENOSPC'), { code: 'ENOSPC' });
    return original.call(this, file, bytes, ...rest);
  });
  await assert.rejects(f.backup(), /ENOSPC/);
  assert.deepEqual(fs.readdirSync(f.destination), existing);
  assert.deepEqual(facts(f.source), before);
  verifyBackup(saved.directory);
});

test('restore write failure cleans only its new partial directory and leaves completed backup/source unchanged', async (t) => {
  const f = fixture(t),
    before = await populated(f),
    saved = await f.backup(),
    target = path.join(f.root, 'failed-restore'),
    existing = fs.readdirSync(f.root).sort();
  const original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, bytes, ...rest) {
    if (typeof bytes === 'string' && bytes.includes('"formatVersion"'))
      throw Error('synthetic marker failure');
    return original.call(this, file, bytes, ...rest);
  });
  assert.throws(
    () => restoreBackup({ backupDir: saved.directory, targetDir: target }),
    /marker failure/,
  );
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(f.root).sort(), existing);
  assert.deepEqual(facts(f.source), before);
  verifyBackup(saved.directory);
});

test('restore publishes with exclusive mkdir and cannot replace a competing empty target created at publication', async (t) => {
  const f = fixture(t),
    saved = await f.backup(),
    target = path.join(f.root, 'raced-restore'),
    original = fs.mkdirSync;
  let competitor;
  t.mock.method(fs, 'mkdirSync', function (dir, ...args) {
    if (dir === target && !competitor) {
      original.call(this, dir, ...args);
      competitor = fs.lstatSync(dir);
    }
    return original.call(this, dir, ...args);
  });
  assert.throws(() => restoreBackup({ backupDir: saved.directory, targetDir: target }), {
    code: 'EEXIST',
  });
  assert.equal(fs.lstatSync(target).ino, competitor.ino);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(
    fs.readdirSync(f.root).some((name) => name.startsWith('.partial-restore-')),
    false,
  );
  verifyBackup(saved.directory);
});

test('backup publication cannot replace a competing empty backup directory', async (t) => {
  const f = fixture(t),
    original = fs.mkdirSync;
  let competitor, target;
  t.mock.method(fs, 'mkdirSync', function (dir, ...args) {
    if (
      path.dirname(dir) === f.destination &&
      path.basename(dir).startsWith('backup-') &&
      !competitor
    ) {
      target = dir;
      original.call(this, dir, ...args);
      competitor = fs.lstatSync(dir);
    }
    return original.call(this, dir, ...args);
  });
  await assert.rejects(f.backup(), { code: 'EEXIST' });
  assert.equal(fs.lstatSync(target).ino, competitor.ino);
  assert.deepEqual(fs.readdirSync(target), []);
  assert.deepEqual(fs.readdirSync(f.destination), [path.basename(target)]);
});

test('fsync failure after a completion marker retains the generated path and rejects success', async (t) => {
  const f = fixture(t),
    before = await populated(f),
    saved = await f.backup(),
    original = fs.fsyncSync,
    target = path.join(f.root, 'durability-uncertain');
  let mode = 'backup',
    fired = false;
  t.mock.method(fs, 'fsyncSync', function (fd) {
    const candidate =
      mode === 'restore'
        ? path.join(target, 'managed-ledger.json')
        : fs
            .readdirSync(f.destination)
            .filter((name) => name.startsWith('backup-') && name !== path.basename(saved.directory))
            .map((name) => path.join(f.destination, name, 'COMPLETE'))
            .find((file) => fs.existsSync(file));
    if (
      !fired &&
      candidate &&
      fs.existsSync(candidate) &&
      fs.fstatSync(fd).ino === fs.statSync(candidate).ino
    ) {
      fired = true;
      throw Error('synthetic completion fsync failure');
    }
    return original.call(this, fd);
  });
  let failure;
  try {
    await f.backup();
    assert.fail('must reject');
  } catch (e) {
    failure = e;
  }
  assert.match(failure.message, /fsync failure/);
  assert.ok(failure.publishedDirectory);
  assert.ok(fs.existsSync(failure.publishedDirectory));
  verifyBackup(failure.publishedDirectory);
  mode = 'restore';
  fired = false;
  assert.throws(
    () => restoreBackup({ backupDir: saved.directory, targetDir: target }),
    (e) => e.publishedDirectory === target && /fsync failure/.test(e.message),
  );
  assert.deepEqual(facts(target), before);
  assert.deepEqual(facts(f.source), before);
  verifyBackup(saved.directory);
});

test('optional generation is preserved exactly without manufacturing a reset receipt or business record', async (t) => {
  const f = fixture(t);
  await populated(f);
  const original = facts(f.source),
    state = JSON.parse(original.state[0].json);
  state.generation = randomUUID();
  const raw = JSON.stringify(state, null, 2);
  f.mutate((db) => db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(raw));
  const before = facts(f.source),
    saved = await f.backup(),
    restored = restoreBackup({
      backupDir: saved.directory,
      targetDir: path.join(f.root, 'generation-only'),
    });
  assert.deepEqual(facts(restored.directory), before);
  assert.deepEqual(before.cash, original.cash);
  assert.equal(saved.summary.operationCount, original.operations.length);
  assert.equal(JSON.parse(facts(restored.directory).state[0].json).resetReceipt, undefined);
  assert.notEqual(restored.ledgerId, f.ledgerId);
  assert.deepEqual(
    fs.readFileSync(path.join(restored.directory, 'trial.sqlite')),
    fs.readFileSync(path.join(saved.directory, 'database.sqlite')),
  );
  assert.deepEqual(facts(f.source), before);
});

test('reset receipt needs no operations row and remains technical metadata after new business entries', async (t) => {
  const f = fixture(t),
    generation = randomUUID(),
    receipt = {
      requestId: randomUUID(),
      fromGeneration: randomUUID(),
      at: '2026-10-12T12:00:00.000Z',
    };
  const raw = JSON.stringify(
    { expenses: [], batches: [], advances: [], generation, resetReceipt: receipt },
    null,
    2,
  );
  f.mutate((db) => db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(raw));
  const before = facts(f.source),
    saved = await f.backup(),
    restored = restoreBackup({
      backupDir: saved.directory,
      targetDir: path.join(f.root, 'after-clear'),
    });
  assert.equal(saved.summary.operationCount, 0);
  assert.equal(saved.summary.expenseCount, 0);
  assert.equal(saved.summary.batchCount, 0);
  assert.equal(saved.summary.balanceCents, '0');
  assert.deepEqual(facts(restored.directory), before);
  assert.deepEqual(
    fs.readFileSync(path.join(restored.directory, 'trial.sqlite')),
    fs.readFileSync(path.join(saved.directory, 'database.sqlite')),
  );
  await f.command({
    kind: 'expense',
    expense: {
      amount: 1,
      date: '2026-10-12',
      category: '接待',
      merchant: '合成清空后费用',
      note: '',
    },
  });
  const next = await f.backup();
  assert.equal(next.summary.operationCount, 1);
  assert.equal(next.summary.expenseCount, 1);
  assert.equal(next.summary.balanceCents, '-1');
  const after = JSON.parse(facts(f.source).state[0].json);
  assert.deepEqual(after.resetReceipt, receipt);
  assert.equal(after.generation, generation);
});

test('invalid generation and malformed or contradictory reset receipts reject backup', async (t) => {
  const f = fixture(t),
    base = {
      expenses: [],
      batches: [],
      advances: [],
      generation: randomUUID(),
      resetReceipt: {
        requestId: randomUUID(),
        fromGeneration: randomUUID(),
        at: '2026-10-12T12:00:00.000Z',
      },
    };
  for (const change of [
    (s) => {
      s.generation = null;
    },
    (s) => {
      s.generation = 7;
    },
    (s) => {
      s.generation = 'invalid';
    },
    (s) => {
      delete s.generation;
    },
    (s) => {
      s.generation = s.resetReceipt.fromGeneration;
    },
    (s) => {
      s.resetReceipt = null;
    },
    (s) => {
      s.resetReceipt = [];
    },
    (s) => {
      delete s.resetReceipt.requestId;
    },
    (s) => {
      s.resetReceipt.requestId = 7;
    },
    (s) => {
      s.resetReceipt.requestId = 'invalid';
    },
    (s) => {
      delete s.resetReceipt.fromGeneration;
    },
    (s) => {
      s.resetReceipt.fromGeneration = null;
    },
    (s) => {
      s.resetReceipt.fromGeneration = 'invalid';
    },
    (s) => {
      delete s.resetReceipt.at;
    },
    (s) => {
      s.resetReceipt.at = '2026-02-30';
    },
    (s) => {
      s.resetReceipt.at = 123;
    },
    (s) => {
      s.resetReceipt.extra = 'unsupported';
    },
  ]) {
    const state = structuredClone(base);
    change(state);
    f.mutate((db) =>
      db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(state)),
    );
    await assert.rejects(f.backup(), /generation|清空回执/);
    assert.deepEqual(fs.readdirSync(f.destination), []);
  }
});

test('a resealed backup with an invalid reset receipt cannot pass verification or restore', async (t) => {
  const f = fixture(t),
    saved = await f.backup(),
    target = path.join(f.root, 'invalid-receipt');
  mutateBackup(saved.directory, (db) => {
    const generation = randomUUID(),
      state = JSON.parse(db.prepare('SELECT json FROM trial_state').get().json);
    state.generation = generation;
    state.resetReceipt = {
      requestId: randomUUID(),
      fromGeneration: generation,
      at: '2026-10-12T12:00:00.000Z',
    };
    db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(state));
  });
  assert.throws(() => verifyBackup(saved.directory), /清空回执/);
  assert.throws(() => restoreBackup({ backupDir: saved.directory, targetDir: target }), /清空回执/);
  assert.equal(fs.existsSync(target), false);
});

test('any reset journal entry blocks backup before reading business data, including dangling symlinks', async (t) => {
  const f = fixture(t),
    journal = path.join(f.source, 'reset-journal.json'),
    outside = path.join(f.root, 'synthetic-journal-target');
  fs.writeFileSync(outside, 'synthetic');
  const before = facts(f.source),
    originalRead = fs.readFileSync;
  let sourceReads = 0,
    backupCalls = 0;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    if (file === path.join(f.source, 'trial.sqlite')) sourceReads++;
    return originalRead.call(this, file, ...args);
  });
  const guardedDb = {
    get open() {
      backupCalls++;
      throw Error('business DB must not be inspected');
    },
  };
  for (const createJournal of [
    () => fs.writeFileSync(journal, '{}'),
    () => fs.writeFileSync(journal, ''),
    () => fs.mkdirSync(journal),
    () => fs.symlinkSync(outside, journal),
    () => fs.symlinkSync(path.join(f.root, 'missing-journal-target'), journal),
  ]) {
    createJournal();
    const stat = fs.lstatSync(journal);
    await assert.rejects(
      createBackup({
        db: guardedDb,
        dataDir: f.source,
        destinationParent: f.destination,
        ledgerId: f.ledgerId,
        sourceKind: 'isolated-test',
      }),
      /清空尚未完成/,
    );
    assert.equal(fs.lstatSync(journal).ino, stat.ino);
    assert.deepEqual(fs.readdirSync(f.destination), []);
    fs.rmSync(journal, { recursive: true });
  }
  assert.equal(sourceReads, 0);
  assert.equal(backupCalls, 0);
  assert.deepEqual(facts(f.source), before);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'synthetic');
});

test('backup and restore flush their copies with writable handles required by Windows', async (t) => {
  const f = fixture(t);
  await populated(f);
  const opened = new Map(),
    open = fs.openSync,
    close = fs.closeSync,
    flush = fs.fsyncSync;
  let flushedFiles = 0;
  t.mock.method(fs, 'openSync', function (file, flags, ...args) {
    const fd = open.call(this, file, flags, ...args);
    opened.set(fd, { file, flags });
    return fd;
  });
  t.mock.method(fs, 'closeSync', function (fd) {
    opened.delete(fd);
    return close.call(this, fd);
  });
  t.mock.method(fs, 'fsyncSync', function (fd) {
    if (fs.fstatSync(fd).isFile()) {
      const entry = opened.get(fd);
      assert.ok(entry, 'the application owns the flushing descriptor');
      assert.notEqual(
        entry.file,
        path.join(f.source, 'trial.sqlite'),
        'backup never flushes the live source',
      );
      assert.ok(
        typeof entry.flags === 'string'
          ? /[wa+]/.test(entry.flags)
          : (entry.flags & 3) !== fs.constants.O_RDONLY,
        'Windows requires a writable file descriptor',
      );
      flushedFiles++;
    }
    return flush.call(this, fd);
  });
  const saved = await f.backup(),
    restored = restoreBackup({
      backupDir: saved.directory,
      targetDir: path.join(f.root, 'windows-flush'),
    });
  assert.ok(flushedFiles > 0);
  assert.deepEqual(facts(restored.directory), facts(f.source));
});
