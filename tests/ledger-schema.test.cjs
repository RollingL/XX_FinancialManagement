// The ledger file format: creation, the lock, refusing foreign or newer files, upgrades,
// table rules and the consistency check. Every ledger is a new temporary folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { openLedger } = require('../src/main/ledger.cjs');
const schema = require('../src/main/ledger-schema.cjs');
const { ledgerFixture } = require('./ledger-fixture.cjs');
const { cleanup, temporaryFolder } = require('./test-cleanup.cjs');

const folder = (t) => temporaryFolder(t, 'qianlai-schema-');
const hashOf = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const expense = (amount = 100) => ({
  kind: 'expense',
  requestId: randomUUID(),
  expense: { category: '办公', date: '2026-11-01', merchant: '合成商户', note: '', amount },
});
const meta = (db) =>
  Object.fromEntries(
    db
      .prepare('SELECT key, value FROM meta')
      .all()
      .map((row) => [row.key, row.value]),
  );

test('a new ledger is created with its marker, version and identity, and keeps them on reopen', (t) => {
  const dir = path.join(folder(t), '数据');
  let ledger = openLedger(dir);
  assert.equal(ledger.created, true);
  assert.ok(fs.statSync(path.join(dir, 'qianlai.sqlite')).isFile());
  assert.ok(fs.statSync(path.join(dir, '截图')).isDirectory());
  const db = ledger.database;
  assert.equal(db.pragma('application_id', { simple: true }), schema.APPLICATION_ID);
  assert.equal(db.pragma('user_version', { simple: true }), schema.SCHEMA_VERSION);
  assert.equal(db.pragma('journal_mode', { simple: true }), 'delete');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  const identity = meta(db);
  assert.deepEqual(Object.keys(identity).sort(), ['created_at', 'generation', 'ledger_id']);
  assert.equal(ledger.generation(), identity.generation);
  ledger.close();
  ledger = openLedger(dir);
  cleanup(t, () => ledger.close());
  assert.equal(ledger.created, false);
  assert.equal(ledger.upgradedFrom, null);
  assert.deepEqual(meta(ledger.database), identity);
});

test('a ledger in use cannot be opened a second time; closing releases it', async (t) => {
  const f = ledgerFixture(t);
  await f.ledger.command(expense());
  assert.throws(() => openLedger(f.dir), { code: 'LEDGER_IN_USE', message: /另一个钱来窗口/ });
  const outside = new Database(path.join(f.dir, 'qianlai.sqlite'), { timeout: 100 });
  cleanup(t, () => outside.close());
  assert.throws(() => outside.prepare('SELECT COUNT(*) FROM expenses').get(), {
    code: 'SQLITE_BUSY',
  });
  f.reopen();
  assert.equal((await f.ledger.command({ kind: 'read' })).expenses.length, 1);
});

test('when the program is killed, the operating system releases the lock and saved money is intact', async (t) => {
  const dir = folder(t);
  const script = `
    const { openLedger } = require(${JSON.stringify(require.resolve('../src/main/ledger.cjs'))});
    const ledger = openLedger(process.argv[1]);
    ledger.command({ kind: 'advance', requestId: process.argv[2],
      advance: { amount: 12345, date: '2026-11-01', note: '合成预支' } })
      .then(() => process.stdout.write('ready\\n'));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script, dir, randomUUID()], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  cleanup(t, () => child.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => String(chunk).includes('ready') && resolve());
    child.on('exit', (code) => reject(Error(`child exited early with ${code}`)));
  });
  assert.throws(() => openLedger(dir), { code: 'LEDGER_IN_USE' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  const ledger = openLedger(dir);
  cleanup(t, () => ledger.close());
  assert.deepEqual((await ledger.command({ kind: 'read' })).advances, [12345]);
});

test('files that are not a 钱来 ledger, or come from a newer version, are refused and left unchanged', (t) => {
  const root = folder(t);
  const cases = [
    ['其他程序的数据库', (db) => db.exec('CREATE TABLE notes (text TEXT)'), 'LEDGER_FOREIGN'],
    ['其他程序的标记', (db) => db.pragma('application_id = 42'), 'LEDGER_FOREIGN'],
    [
      '更新版本',
      (db) => {
        db.pragma(`application_id = ${schema.APPLICATION_ID}`);
        db.pragma(`user_version = ${schema.SCHEMA_VERSION + 1}`);
        db.exec('CREATE TABLE future (value TEXT)');
      },
      'LEDGER_NEWER',
    ],
  ];
  for (const [name, make, code] of cases) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const file = path.join(dir, 'qianlai.sqlite'),
      db = new Database(file);
    make(db);
    db.close();
    const before = hashOf(file);
    assert.throws(() => openLedger(dir), { code }, name);
    assert.equal(hashOf(file), before, name);
  }
  const damaged = path.join(root, '损坏');
  fs.mkdirSync(damaged);
  fs.writeFileSync(path.join(damaged, 'qianlai.sqlite'), '合成的损坏文件，不是数据库');
  assert.throws(() => openLedger(damaged), { code: 'LEDGER_DAMAGED', message: /已损坏/ });
  assert.equal(
    fs.readFileSync(path.join(damaged, 'qianlai.sqlite'), 'utf8'),
    '合成的损坏文件，不是数据库',
  );
});

test('the data folder and the screenshot folder must be plain folders, not shortcuts', (t) => {
  const root = folder(t),
    real = path.join(root, 'real');
  fs.mkdirSync(real);
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(real, path.join(root, 'link'), kind);
  assert.throws(() => openLedger(path.join(root, 'link')), /必须是普通文件夹/);
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir);
  fs.symlinkSync(real, path.join(dir, '截图'), kind);
  assert.throws(() => openLedger(dir), /必须是普通文件夹/);
});

// Upgrades are exercised with a pretend next version: the steps run in order inside one
// transaction, after the safety callback, and a failure leaves the file as it was.
function versionOneDatabase(t) {
  const file = path.join(folder(t), 'qianlai.sqlite'),
    db = new Database(file);
  cleanup(t, () => db.open && db.close());
  schema.prepareDatabase(db, {
    create: true,
    identity: () => ({
      ledgerId: randomUUID(),
      generation: randomUUID(),
      createdAt: new Date().toISOString(),
    }),
  });
  return db;
}
const columns = (db, table) => db.pragma(`table_info(${table})`).map((row) => row.name);

test('an older ledger is backed up first, then upgraded step by step in one transaction', (t) => {
  const db = versionOneDatabase(t),
    calls = [];
  const result = schema.prepareDatabase(db, {
    target: 3,
    beforeUpgrade: (from) =>
      calls.push(['backup', from, db.pragma('user_version', { simple: true })]),
    migrations: {
      1: (d) => {
        calls.push(['step', 1]);
        d.exec("ALTER TABLE expenses ADD COLUMN synthetic_one TEXT NOT NULL DEFAULT ''");
      },
      2: (d) => {
        calls.push(['step', 2]);
        d.exec("ALTER TABLE expenses ADD COLUMN synthetic_two TEXT NOT NULL DEFAULT ''");
      },
    },
  });
  assert.deepEqual(result, { created: false, upgradedFrom: 1 });
  assert.deepEqual(calls, [
    ['backup', 1, 1],
    ['step', 1],
    ['step', 2],
  ]);
  assert.equal(db.pragma('user_version', { simple: true }), 3);
  assert.ok(columns(db, 'expenses').includes('synthetic_two'));
  assert.deepEqual(schema.prepareDatabase(db, { target: 3 }), {
    created: false,
    upgradedFrom: null,
  });
});

test('a failed or incomplete upgrade, or a failed safety backup, changes nothing', (t) => {
  const db = versionOneDatabase(t),
    before = columns(db, 'expenses');
  const addColumn = (d) =>
    d.exec("ALTER TABLE expenses ADD COLUMN synthetic TEXT NOT NULL DEFAULT ''");
  const attempts = [
    [
      {
        target: 3,
        migrations: {
          1: addColumn,
          2: () => {
            throw Error('合成的升级失败');
          },
        },
      },
      /合成的升级失败/,
    ],
    [{ target: 3, migrations: { 1: addColumn } }, /缺少从第 2 版升级的步骤/],
    [
      {
        target: 2,
        migrations: { 1: addColumn },
        beforeUpgrade: () => {
          throw Error('合成的备份失败');
        },
      },
      /合成的备份失败/,
    ],
  ];
  for (const [options, message] of attempts) {
    assert.throws(() => schema.prepareDatabase(db, options), message);
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    assert.deepEqual(columns(db, 'expenses'), before);
  }
});

test('the tables refuse rows that break single-record rules', async (t) => {
  const f = ledgerFixture(t);
  await f.ledger.command(expense());
  const now = "'2026-11-01T00:00:00.000Z'";
  const before = f.rows();
  for (const statement of [
    `INSERT INTO expenses (id, category, date, merchant, amount, note, created_at)
      VALUES (2, '办公', '2026-11-01', '合成', 0, '', ${now})`,
    `INSERT INTO expenses (id, category, date, merchant, amount, note, created_at)
      VALUES (2, '办公', '2026-11-01', '合成', 1.5, '', ${now})`,
    `INSERT INTO expenses (id, category, date, merchant, amount, note, created_at)
      VALUES (2, '办公', '2026-11-01', '合成', '一百', '', ${now})`,
    `INSERT INTO expenses (id, category, date, merchant, amount, note, created_at)
      VALUES (2, '办公', '2026-02-30', '合成', 1, '', ${now})`,
    `INSERT INTO expenses (id, category, date, merchant, amount, note, created_at)
      VALUES (2, '其他', '2026-11-01', '合成', 1, '', ${now})`,
    `INSERT INTO expenses (id, category, date, merchant, amount, note, created_at)
      VALUES (2, '办公', '2026-11-01', '', 1, '', ${now})`,
    `INSERT INTO expenses (id, category, date, merchant, amount, note, created_at)
      VALUES (2, '办公', '2026-11-01', '合成', 1, '', '昨天')`,
    `INSERT INTO expenses (id, category, date, merchant, amount, note, attachment_id, created_at)
      VALUES (2, '办公', '2026-11-01', '合成', 1, '', '${randomUUID()}', ${now})`,
    `INSERT INTO advances (id, amount, date, note, created_at) VALUES (0, 0, '2026-11-01', '', ${now})`,
    `INSERT INTO advances (id, amount, date, note, created_at, deleted_at)
      VALUES (0, 5, '2026-11-01', '', ${now}, ${now})`,
    `INSERT INTO batches (id, date, created_at) VALUES (1, '2026-11-01', ${now});
     INSERT INTO allocations (batch_id, position, expense_id, amount) VALUES (1, 0, 99, 1)`,
    `INSERT INTO attachments (id, file, mime, size, sha256, created_at)
      VALUES ('${randomUUID()}', 'x.gif', 'image/gif', 1, '${'0'.repeat(64)}', ${now})`,
    `INSERT INTO events (request_id, action, record_type, record_id, revision, at, before)
      VALUES ('${randomUUID()}', 'refund', 'expense', 1, 1, ${now}, '{}')`,
  ]) {
    assert.throws(
      () => f.db.transaction(() => f.sql(statement))(),
      /constraint failed|cannot store|FOREIGN KEY/,
      statement,
    );
    assert.deepEqual(f.rows(), before, statement);
  }
});

test('the consistency check finds broken rules that span records, and the ledger then refuses to open', async (t) => {
  const now = "'2026-11-01T00:00:00.000Z'";
  const breaks = [
    [
      'over-allocated',
      `INSERT INTO batches (id, date, created_at) VALUES (1, '2026-11-01', ${now});
       INSERT INTO allocations VALUES (1, 0, 1, 101)`,
      /有效报销超过费用金额/,
    ],
    [
      'deleted expense still allocated',
      `INSERT INTO batches (id, date, created_at) VALUES (1, '2026-11-01', ${now});
       INSERT INTO allocations VALUES (1, 0, 1, 50);
       UPDATE expenses SET deleted_at = ${now} WHERE id = 1`,
      /有效报销超过费用金额/,
    ],
    [
      'empty batch',
      `INSERT INTO batches (id, date, created_at) VALUES (1, '2026-11-01', ${now})`,
      /没有分配/,
    ],
    [
      'advance numbers with a gap',
      `INSERT INTO advances (id, amount, date, note, created_at) VALUES (1, 5, '2026-11-01', '', ${now})`,
      /预支编号不连续/,
    ],
    ['missing identity', "DELETE FROM meta WHERE key = 'ledger_id'", /标识信息不完整/],
    ['extra table', 'CREATE TABLE synthetic_extra (value TEXT)', /数据表和本程序不一致/],
    ['missing table', 'DROP TABLE operations', /数据表和本程序不一致/],
  ];
  for (const [name, statement, message] of breaks) {
    await t.test(name, async (t) => {
      const f = ledgerFixture(t);
      await f.ledger.command(expense());
      f.sql(statement);
      assert.throws(() => schema.checkLedger(f.db), message);
      f.ledger.close();
      assert.throws(() => openLedger(f.dir), message);
    });
  }
});

test('the summary counts money the same way as the screens', async (t) => {
  const f = ledgerFixture(t);
  const send = (input) => f.ledger.command({ requestId: randomUUID(), ...input });
  await send({ kind: 'advance', advance: { amount: 10000, date: '2026-11-01', note: '' } });
  await send({ kind: 'advance', advance: { amount: 500, date: '2026-11-01', note: '' } });
  await send(expense(8000));
  await send(expense(7000));
  await send({ kind: 'batch', date: '2026-11-02', allocations: [{ expenseId: 1, amount: 8000 }] });
  await send({ kind: 'batch', date: '2026-11-02', allocations: [{ expenseId: 2, amount: 1000 }] });
  await send({ kind: 'cancel', id: 2 });
  const state = await send({
    kind: 'delete-advance',
    id: 1,
    expectedAmount: 500,
    expected: (await f.ledger.command({ kind: 'read' })).advanceDetails[1],
    expectedRevision: 0,
  });
  assert.deepEqual(schema.summarize(f.db), {
    expenseCount: 2,
    advanceCount: 1,
    batchCount: 2,
    activeBatchCount: 1,
    attachmentCount: 0,
    totalExpenseCents: 15000,
    totalAdvanceCents: 10000,
    balanceCents: -5000,
    personalFundingCents: 5000,
    reimbursedCents: 8000,
    pendingCents: 7000,
  });
  assert.equal(
    state.advances.reduce((a, b) => a + b, 0) - state.expenses.reduce((a, e) => a + e.amount, 0),
    -5000,
  );
  assert.equal(schema.isEmpty(f.db), false);
});
