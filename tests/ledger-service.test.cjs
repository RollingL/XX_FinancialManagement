// The ledger as the program uses it: one 钱来 folder with 数据 and 备份, daily automatic
// backups, manual backups, restore and import, and clearing. All data is synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { openLedgerService } = require('../src/main/ledger-service.cjs');
const schema = require('../src/main/ledger-schema.cjs');
const { funds, seedVariedLedger } = require('./ledger-fixture.cjs');

// A clock the tests move forward by whole days.
function clock(day = 20) {
  let current = new Date(2026, 10, day, 10, 0, 0);
  return {
    now: () => new Date(current),
    nextDay(days = 1) {
      current = new Date(current.getTime() + days * 86400000);
    },
    later(seconds = 1) {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
}
function home(t, prefix = 'qianlai-home-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function serviceFixture(t, { dir = home(t), time = clock(), keepAutomaticBackups } = {}) {
  let service = openLedgerService(dir, { now: time.now, keepAutomaticBackups });
  t.after(() => service.close());
  const f = {
    dir,
    time,
    layout: schema.homeLayout(dir),
    get service() {
      return service;
    },
    command: (input) => service.command(input),
    read: () => service.command({ kind: 'read' }),
    info: () => service.command({ kind: 'maintenance-info' }),
    generation: async () => (await f.read()).generation,
    // A save as the screens send it: a new request number and the current generation.
    async send(input) {
      return service.command({
        requestId: randomUUID(),
        generation: await f.generation(),
        ...input,
      });
    },
    seed: (options) => seedVariedLedger((input) => f.send(input), options),
    rows() {
      const db = service.ledger.database;
      return Object.fromEntries(
        schema.TABLE_NAMES.map((name) => [
          name,
          db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
        ]),
      );
    },
    screenshots: () => fs.readdirSync(path.join(f.layout.dataDir, '截图')).sort(),
    backupFolders: () =>
      fs
        .readdirSync(f.layout.backupDir)
        .filter((name) => name !== '截图库')
        .sort(),
    async reopen() {
      await service.close();
      service = openLedgerService(dir, { now: time.now, keepAutomaticBackups });
    },
    async close() {
      await service.close();
    },
  };
  return f;
}
const expense = (amount = 100, extra = {}) => ({
  kind: 'expense',
  expense: { category: '办公', date: '2026-11-01', merchant: '合成商户', note: '', amount },
  ...extra,
});
const withoutGeneration = ({ generation, ...state }) => state;
const hashTree = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      return fs.statSync(file).isFile()
        ? [name, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]
        : [name];
    });
async function restore(f, source) {
  const generation = await f.generation(),
    preview = await f.command({ kind: 'prepare-restore', generation, ...source }),
    input = {
      kind: 'restore-backup',
      requestId: randomUUID(),
      generation,
      token: preview.token,
      confirmation: '恢复备份',
    };
  return { preview, input, result: await f.command(input) };
}

test('a new 钱来 folder holds only 数据 and 备份, and an empty ledger is not backed up', async (t) => {
  const f = serviceFixture(t);
  assert.deepEqual(fs.readdirSync(f.dir).sort(), ['备份', '数据']);
  const info = await f.info();
  assert.deepEqual(
    { ...info, generation: typeof info.generation },
    {
      generation: 'string',
      home: f.dir,
      dataDir: path.join(f.dir, '数据'),
      backupDir: path.join(f.dir, '备份'),
      empty: true,
      keepAutomaticBackups: 30,
      automaticBackupError: null,
      backups: [],
    },
  );
  await f.reopen();
  assert.deepEqual(f.backupFolders(), []);
  // Clearing an empty ledger needs no safety backup either.
  const cleared = await f.command({
    kind: 'reset-ledger',
    requestId: randomUUID(),
    generation: await f.generation(),
    confirmation: '清空当前账本',
  });
  assert.equal(cleared.backup, null);
  assert.deepEqual(f.backupFolders(), []);
  await f.close();
  // Once closed, only the database file and the screenshot folder are left in 数据.
  assert.deepEqual(fs.readdirSync(f.layout.dataDir).sort(), ['qianlai.sqlite', '截图']);
  assert.throws(() => openLedgerService('relative/folder'), /绝对路径/);
});

test('the first save of each day makes one automatic backup, and only the newest are kept', async (t) => {
  const f = serviceFixture(t, { keepAutomaticBackups: 3 });
  await f.send(expense(1));
  await f.send(expense(2));
  let info = await f.info();
  assert.equal(info.backups.length, 1);
  assert.equal(info.backups[0].kind, 'auto');
  assert.equal(info.backups[0].kindLabel, '自动备份');
  assert.equal(info.backups[0].summary.expenseCount, 1);
  assert.equal(info.backups[0].name, '2026-11-20_10-00-00_自动备份');
  for (let day = 0; day < 4; day++) {
    f.time.nextDay();
    await f.send(expense(3 + day));
  }
  info = await f.info();
  assert.deepEqual(
    info.backups.map((item) => item.name),
    [
      '2026-11-24_10-00-00_自动备份',
      '2026-11-23_10-00-00_自动备份',
      '2026-11-22_10-00-00_自动备份',
    ],
  );
  // Opening the program on a new day backs up the existing ledger straight away.
  await f.close();
  f.time.nextDay();
  await f.reopen();
  assert.equal((await f.info()).backups[0].name, '2026-11-25_10-00-00_自动备份');
  assert.equal((await f.info()).backups[0].summary.expenseCount, 6);
});

test('a failed automatic backup never blocks saving; it is reported and tried again', async (t) => {
  const f = serviceFixture(t);
  fs.writeFileSync(path.join(f.layout.backupDir, '截图库'), '合成的占位文件');
  const state = await f.send(expense(5));
  assert.equal(state.expenses.length, 1);
  assert.match((await f.info()).automaticBackupError, /自动备份没有完成/);
  fs.rmSync(path.join(f.layout.backupDir, '截图库'));
  await f.send(expense(6));
  const info = await f.info();
  assert.equal(info.automaticBackupError, null);
  assert.equal(info.backups.length, 1);
});

test('a manual backup is made once per request and refused for a screen that is out of date', async (t) => {
  const f = serviceFixture(t);
  await f.seed();
  const before = f.backupFolders();
  const input = {
    kind: 'create-backup',
    requestId: randomUUID(),
    generation: await f.generation(),
  };
  const made = await f.command(input);
  assert.equal(made.kind, 'manual');
  assert.equal(made.kindLabel, '手动备份');
  assert.equal(made.summary.expenseCount, 2);
  assert.deepEqual(await f.command(input), made);
  assert.deepEqual(f.backupFolders(), [...before, made.name].sort());
  for (const [change, message] of [
    [{ generation: randomUUID() }, /账本已经换过/],
    [{ requestId: 'not-a-request' }, /请求编号无效/],
    [{ extra: true }, /备份请求无效/],
  ])
    await assert.rejects(f.command({ ...input, requestId: randomUUID(), ...change }), message);
  assert.deepEqual(f.backupFolders(), [...before, made.name].sort());
});

test('restoring a backup brings back exactly what it holds, after a safety backup of the current ledger', async (t) => {
  const f = serviceFixture(t);
  await f.seed();
  const saved = await f.read(),
    savedRows = f.rows(),
    backup = await f.command({
      kind: 'create-backup',
      requestId: randomUUID(),
      generation: saved.generation,
    });
  // Work done after the backup, including a new screenshot, which the restore replaces.
  const { syntheticPng } = require('./synthetic-image.cjs');
  f.time.later();
  await f.send(expense(4321, { image: { base64: syntheticPng({ seed: 99 }).toString('base64') } }));
  const current = await f.read(),
    currentRows = f.rows(),
    currentScreenshots = f.screenshots();
  assert.equal(currentScreenshots.length, 3);

  const generation = current.generation,
    preview = await f.command({ kind: 'prepare-restore', generation, backup: backup.name });
  assert.equal(preview.sourceType, 'backup');
  assert.equal(preview.kindLabel, '手动备份');
  assert.equal(preview.createdAt, backup.createdAt);
  assert.deepEqual(preview.summary, backup.summary);
  assert.equal(preview.missingAttachmentCount, 0);
  assert.deepEqual(f.rows(), currentRows, 'a preview changes nothing');

  f.time.later();
  const input = {
    kind: 'restore-backup',
    requestId: randomUUID(),
    generation,
    token: preview.token,
    confirmation: '恢复备份',
  };
  const result = await f.command(input);
  assert.equal(result.restored, true);
  assert.equal(result.missingAttachmentCount, 0);
  assert.match(result.backup, /_恢复前备份$/);
  assert.notEqual(result.generation, generation);
  const restored = await f.read();
  assert.equal(restored.generation, result.generation);
  assert.deepEqual(withoutGeneration(restored), withoutGeneration(saved));
  assert.deepEqual(funds(restored), funds(saved));
  for (const table of ['expenses', 'advances', 'batches', 'allocations', 'events', 'attachments'])
    assert.deepEqual(f.rows()[table], savedRows[table], table);
  assert.deepEqual(f.screenshots(), savedRows.attachments.map((row) => row.file).sort());
  for (const row of savedRows.attachments)
    assert.equal((await f.command({ kind: 'attachment', id: row.id })).base64.length > 0, true);
  // The safety backup holds the ledger exactly as it was before the restore.
  const safety = (await f.info()).backups.find((item) => item.name === result.backup);
  assert.equal(safety.kind, 'restore');
  const safetyDb = new Database(path.join(safety.directory, 'qianlai.sqlite'), { readonly: true });
  t.after(() => safetyDb.close());
  assert.deepEqual(
    safetyDb.prepare('SELECT * FROM expenses ORDER BY id').all(),
    currentRows.expenses,
  );
  // Repeating the same confirmation returns the same result without a second restore.
  const folders = f.backupFolders();
  assert.deepEqual(await f.command(input), result);
  assert.deepEqual(f.backupFolders(), folders);
  // Screens still showing the old ledger cannot save into the restored one.
  await assert.rejects(
    f.command({ ...expense(1), requestId: randomUUID(), generation }),
    /账本已经换过/,
  );
  await assert.rejects(
    f.command({ ...input, requestId: randomUUID(), generation: result.generation }),
    /恢复预览已失效/,
  );
  await f.reopen();
  assert.deepEqual(await f.read(), restored);
});

test('restoring an earlier backup of the same ledger repairs a damaged screenshot', async (t) => {
  const f = serviceFixture(t);
  const state = await f.seed();
  const backup = await f.command({
    kind: 'create-backup',
    requestId: randomUUID(),
    generation: state.generation,
  });
  const id = state.expenses[0].attachmentId,
    good = await f.command({ kind: 'attachment', id }),
    file = f.rows().attachments.find((row) => row.id === id).file;
  fs.writeFileSync(path.join(f.layout.dataDir, '截图', file), '合成的损坏内容');
  await assert.rejects(f.command({ kind: 'attachment', id }), /附件损坏/);
  const { result } = await restore(f, { backup: backup.name });
  assert.equal(result.missingAttachmentCount, 0);
  assert.deepEqual(await f.command({ kind: 'attachment', id }), good);
  assert.equal(
    f.screenshots().some((name) => name.startsWith('.tmp-')),
    false,
  );
});

test('a wrong confirmation, an out-of-date screen or a bad backup name changes nothing', async (t) => {
  const f = serviceFixture(t);
  await f.seed();
  const generation = await f.generation(),
    backup = await f.command({ kind: 'create-backup', requestId: randomUUID(), generation }),
    preview = await f.command({ kind: 'prepare-restore', generation, backup: backup.name }),
    input = {
      kind: 'restore-backup',
      requestId: randomUUID(),
      generation,
      token: preview.token,
      confirmation: '恢复备份',
    },
    rows = f.rows(),
    folders = f.backupFolders();
  for (const [change, message] of [
    [{ confirmation: '恢复' }, /请输入完整确认文字“恢复备份”/],
    [{ generation: randomUUID() }, /账本已经换过/],
    [{ token: randomUUID() }, /恢复预览已失效/],
    [{ requestId: 'x' }, /请求编号无效/],
    [{ extra: 1 }, /恢复确认请求无效/],
  ]) {
    await assert.rejects(f.command({ ...input, requestId: randomUUID(), ...change }), message);
    assert.deepEqual(f.rows(), rows);
    assert.deepEqual(f.backupFolders(), folders);
  }
  for (const [request, message] of [
    [{ backup: '../数据' }, /备份名称无效/],
    [{ backup: '截图库' }, /备份名称无效/],
    [{ backup: '.tmp-x' }, /备份名称无效/],
    [{ backup: '不存在的备份' }, /请选择一个文件夹/],
    [{ source: 'relative' }, /请选择一个文件夹/],
    [{ source: f.layout.dataDir }, /正在用的账本/],
    [{ source: f.dir }, /正在用的账本/],
    [{ backup: backup.name, source: f.dir }, /恢复预览请求无效/],
  ]) {
    await assert.rejects(
      f.command({ kind: 'prepare-restore', generation, ...request }),
      message,
      JSON.stringify(request),
    );
    assert.deepEqual(f.rows(), rows);
  }
});

test('importing from another 钱来 folder copies its ledger and screenshots and leaves it untouched', async (t) => {
  const old = serviceFixture(t, { dir: home(t, 'qianlai-old-') });
  await old.seed({ seed: 7 });
  const oldState = await old.read();
  await old.close();
  const oldFiles = hashTree(old.dir);
  for (const source of [old.dir, old.layout.dataDir]) {
    const f = serviceFixture(t);
    await f.seed({ seed: 1 });
    const { preview, result } = await restore(f, { source });
    assert.equal(preview.sourceType, 'data');
    assert.equal(preview.location, old.layout.dataDir);
    assert.equal(preview.kindLabel, null);
    assert.equal(preview.summary.expenseCount, 2);
    assert.match(result.backup, /_恢复前备份$/);
    const imported = await f.read();
    assert.deepEqual(withoutGeneration(imported), withoutGeneration(oldState));
    for (const id of [imported.expenses[0].attachmentId, imported.advanceDetails[0].attachmentId])
      assert.equal((await f.command({ kind: 'attachment', id })).mime, 'image/png');
    assert.equal(f.screenshots().length, 2);
  }
  assert.deepEqual(hashTree(old.dir), oldFiles);
});

test('a backup copied somewhere else, for example a USB drive, can be restored with its screenshots', async (t) => {
  const old = serviceFixture(t, { dir: home(t, 'qianlai-old-') });
  await old.seed({ seed: 3 });
  const oldState = await old.read();
  const made = await old.command({
    kind: 'create-backup',
    requestId: randomUUID(),
    generation: oldState.generation,
  });
  await old.close();
  const usb = home(t, 'qianlai-usb-');
  fs.cpSync(old.layout.backupDir, path.join(usb, '备份'), { recursive: true });
  const f = serviceFixture(t);
  const { preview, result } = await restore(f, { source: path.join(usb, '备份', made.name) });
  assert.equal(preview.sourceType, 'backup');
  assert.equal(preview.missingAttachmentCount, 0);
  assert.equal(result.backup, null, 'an empty ledger needs no safety backup');
  assert.deepEqual(withoutGeneration(await f.read()), withoutGeneration(oldState));
  // Without the shared 截图库 the records come back, and the missing screenshots are counted.
  fs.rmSync(path.join(usb, '备份', '截图库'), { recursive: true });
  const again = await restore(f, { source: path.join(usb, '备份', made.name) });
  assert.equal(again.preview.missingAttachmentCount, 0, 'the live 截图 folder still has them');
  const elsewhere = serviceFixture(t);
  const without = await restore(elsewhere, { source: path.join(usb, '备份', made.name) });
  assert.equal(without.preview.missingAttachmentCount, 2);
  assert.equal(without.result.missingAttachmentCount, 2);
  const state = await elsewhere.read();
  assert.equal(state.expenses.length, 2);
  await assert.rejects(
    elsewhere.command({ kind: 'attachment', id: state.expenses[0].attachmentId }),
    /附件文件找不到了/,
  );
});

test('a source open in another window, from a newer version, damaged, or old test data is refused', async (t) => {
  const other = serviceFixture(t, { dir: home(t, 'qianlai-other-') });
  await other.seed();
  const f = serviceFixture(t);
  await f.send(expense());
  const generation = await f.generation(),
    rows = f.rows(),
    prepare = (source) => f.command({ kind: 'prepare-restore', generation, source });
  await assert.rejects(prepare(other.dir), { code: 'SOURCE_IN_USE', message: /另一个钱来窗口/ });
  await other.close();
  const file = path.join(other.layout.dataDir, 'qianlai.sqlite');
  const db = new Database(file);
  db.pragma(`user_version = ${schema.SCHEMA_VERSION + 1}`);
  db.close();
  await assert.rejects(prepare(other.dir), { code: 'LEDGER_NEWER' });
  fs.writeFileSync(file, '合成的损坏文件');
  await assert.rejects(prepare(other.dir), { code: 'LEDGER_DAMAGED' });
  const trial = home(t, 'qianlai-trial-');
  fs.mkdirSync(path.join(trial, 'trial-data'));
  await assert.rejects(prepare(trial), /早期测试版的数据，新版不能读取/);
  const damagedBackup = await f.command({
    kind: 'create-backup',
    requestId: randomUUID(),
    generation,
  });
  fs.appendFileSync(path.join(damagedBackup.directory, 'qianlai.sqlite'), 'x');
  await assert.rejects(
    f.command({ kind: 'prepare-restore', generation, backup: damagedBackup.name }),
    /已损坏或不完整/,
  );
  assert.deepEqual(f.rows(), rows);
});

test('clearing makes a safety backup, empties records and screenshots, and a repeat clears nothing twice', async (t) => {
  const f = serviceFixture(t);
  const seeded = await f.seed();
  const rows = f.rows(),
    generation = seeded.generation,
    input = {
      kind: 'reset-ledger',
      requestId: randomUUID(),
      generation,
      confirmation: '清空当前账本',
    };
  for (const [change, message] of [
    [{ confirmation: '清空' }, /请输入完整确认文字“清空当前账本”/],
    [{ generation: randomUUID() }, /账本已经换过/],
    [{ extra: 1 }, /清空请求无效/],
  ]) {
    await assert.rejects(f.command({ ...input, requestId: randomUUID(), ...change }), message);
    assert.deepEqual(f.rows(), rows);
  }
  const result = await f.command(input);
  assert.equal(result.reset, true);
  assert.match(result.backup, /_清空前备份$/);
  assert.notEqual(result.generation, generation);
  const empty = await f.read();
  assert.deepEqual(withoutGeneration(empty), {
    expenses: [],
    batches: [],
    advances: [],
    advanceDetails: {},
    expenseEvents: [],
    advanceEvents: [],
    batchEvents: [],
  });
  assert.deepEqual(f.screenshots(), []);
  assert.equal((await f.info()).empty, true);
  const safety = (await f.info()).backups.find((item) => item.name === result.backup);
  assert.deepEqual(safety.summary, schema.summarize(openReadonly(t, safety.directory)));
  assert.equal(safety.summary.expenseCount, 2);
  // The same request again returns the same answer; the new records stay.
  await f.send(expense(77));
  assert.deepEqual(await f.command(input), result);
  assert.equal((await f.read()).expenses.length, 1);
  // Old screens cannot correct a record that now has a reused number.
  const fresh = await f.read();
  assert.equal(fresh.expenses[0].id, 1);
  await assert.rejects(
    f.command({
      kind: 'correct-expense',
      requestId: randomUUID(),
      generation,
      id: 1,
      expected: fresh.expenses[0],
      expectedRevision: 0,
      expense: { ...expense(200).expense },
    }),
    /账本已经换过/,
  );
  await assert.rejects(
    f.command({
      kind: 'correct-expense',
      requestId: randomUUID(),
      generation: fresh.generation,
      id: 1,
      expected: seeded.expenses[0],
      expectedRevision: 0,
      expense: { ...expense(200).expense },
    }),
    /费用已变化/,
  );
});
function openReadonly(t, directory) {
  const db = new Database(path.join(directory, 'qianlai.sqlite'), { readonly: true });
  t.after(() => db.close());
  return db;
}

test('requests run one at a time in the order they arrive, and closing waits for them', async (t) => {
  const f = serviceFixture(t);
  const generation = await f.generation();
  const results = await Promise.all([
    f.command({ ...expense(1), requestId: randomUUID(), generation }),
    f.command({ kind: 'create-backup', requestId: randomUUID(), generation }),
    f.command({ ...expense(2), requestId: randomUUID(), generation }),
    f.command({ kind: 'read' }),
  ]);
  assert.equal(results[0].expenses.length, 1);
  assert.equal(results[1].summary.expenseCount, 1);
  assert.equal(results[3].expenses.length, 2);
  const pending = f.command({ ...expense(3), requestId: randomUUID(), generation });
  const closing = f.close();
  await assert.rejects(f.command({ kind: 'read' }), /账本正在关闭/);
  assert.equal((await pending).expenses.length, 3);
  await closing;
  await f.reopen();
  assert.equal((await f.read()).expenses.length, 3);
});

test('a second program window cannot open the same 钱来 folder', async (t) => {
  const f = serviceFixture(t);
  assert.throws(() => openLedgerService(f.dir), { code: 'LEDGER_IN_USE' });
  await f.send(expense());
  assert.equal((await f.read()).expenses.length, 1);
});
