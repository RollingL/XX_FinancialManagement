// Backups: complete checked copies, screenshots shared in one store, tidy-up rules, and
// reading a ledger back from a backup or another 钱来 folder. All data is synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const backups = require('../src/main/ledger-backup.cjs');
const schema = require('../src/main/ledger-schema.cjs');
const { openLedger } = require('../src/main/ledger.cjs');
const { ledgerFixture, seedVariedLedger } = require('./ledger-fixture.cjs');
const { syntheticPng } = require('./synthetic-image.cjs');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const at = (day, hour = 9, minute = 30, second = 12) =>
  new Date(2026, 10, day, hour, minute, second);
function setup(t) {
  const f = ledgerFixture(t, 'qianlai-backup-'),
    backupDir = path.join(f.dir, '..', path.basename(f.dir) + '-备份');
  t.after(() => fs.rmSync(backupDir, { recursive: true, force: true }));
  const backup = (kind = 'manual', when = at(27)) =>
    backups.createBackup({
      db: f.db,
      attachmentsDir: f.attachmentsDir,
      backupDir,
      kind,
      now: () => when,
    });
  return { f, backupDir, backup, send: (input) => f.ledger.command(input) };
}
function rowsOf(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return Object.fromEntries(
      schema.TABLE_NAMES.map((name) => [
        name,
        db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}
const storeFiles = (backupDir) => fs.readdirSync(path.join(backupDir, backups.STORE)).sort();
function stage(t, folder) {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-stage-'));
  t.after(() => fs.rmSync(stagingDir, { recursive: true, force: true }));
  return backups.stageSource(backups.locateSource(folder), stagingDir);
}

test('a backup is a complete, checked copy with its screenshots and a plain-language note', async (t) => {
  const { f, backupDir, backup, send } = setup(t);
  await seedVariedLedger(send);
  const { name, directory, manifest } = backup('manual');
  assert.equal(name, '2026-11-27_09-30-12_手动备份');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['backup.json', 'qianlai.sqlite', '说明.txt']);
  assert.deepEqual(fs.readdirSync(backupDir).sort(), [name, '截图库']);
  const bytes = fs.readFileSync(path.join(directory, 'qianlai.sqlite'));
  assert.deepEqual(manifest.database, {
    file: 'qianlai.sqlite',
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(manifest.format, 'qianlai-backup');
  assert.equal(manifest.schemaVersion, schema.SCHEMA_VERSION);
  assert.equal(manifest.kind, 'manual');
  assert.equal(manifest.createdAt, at(27).toISOString());
  assert.equal(manifest.ledgerId, f.rows().meta.find((row) => row.key === 'ledger_id').value);
  assert.deepEqual(manifest.summary, schema.summarize(f.db));
  assert.deepEqual(manifest.missingAttachments, []);
  assert.deepEqual(
    manifest.attachments,
    f
      .rows()
      .attachments.map(({ file, size, sha256: hash }) => ({ file, size, sha256: hash }))
      .sort((a, b) => a.file.localeCompare(b.file)),
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'backup.json'))), manifest);
  // Every stored row, including the audit trail and the request log, is in the copy.
  assert.deepEqual(rowsOf(path.join(directory, 'qianlai.sqlite')), f.rows());
  for (const row of f.rows().attachments)
    assert.equal(
      sha256(fs.readFileSync(path.join(backupDir, '截图库', row.sha256 + '.png'))),
      row.sha256,
    );
  const note = fs.readFileSync(path.join(directory, '说明.txt'), 'utf8');
  assert.match(note, /类型：手动备份/);
  assert.match(note, /费用 2 笔，预支 2 笔，报销批次 2 批，截图 2 张/);
  assert.match(note, /用这份恢复/);
});

test('backups share each screenshot once, and two backups in the same second get their own folders', async (t) => {
  const { backupDir, backup, send } = setup(t);
  await seedVariedLedger(send);
  const first = backup('auto'),
    second = backup('auto');
  assert.equal(second.name, first.name.replace('自动备份', '自动备份_2'));
  assert.deepEqual(first.manifest.attachments, second.manifest.attachments);
  assert.equal(storeFiles(backupDir).length, 2);
});

test('a screenshot that is missing or changed when backing up is named in the backup, not hidden', async (t) => {
  const { f, backup, send } = setup(t);
  await seedVariedLedger(send);
  const [lost, changed] = f.rows().attachments;
  fs.rmSync(path.join(f.attachmentsDir, lost.file));
  fs.appendFileSync(path.join(f.attachmentsDir, changed.file), 'x');
  const { directory, manifest } = backup();
  assert.deepEqual(manifest.attachments, []);
  assert.deepEqual(manifest.missingAttachments, [lost.file, changed.file].sort());
  assert.match(fs.readFileSync(path.join(directory, '说明.txt'), 'utf8'), /有 2 张截图/);
});

test('a failed backup leaves nothing behind that looks like a backup', async (t) => {
  const { f, backupDir, backup, send } = setup(t);
  await seedVariedLedger(send);
  f.ledger.close();
  assert.throws(() => backup());
  assert.deepEqual(fs.readdirSync(backupDir), ['截图库']);
  assert.deepEqual(backups.listBackups(backupDir), []);
});

test('the list shows complete backups newest first and ignores unfinished or unrelated folders', async (t) => {
  const { backupDir, backup, send } = setup(t);
  await seedVariedLedger(send);
  const older = backup('auto', at(20)),
    newer = backup('restore', at(26)),
    middle = backup('manual', at(25));
  fs.mkdirSync(path.join(backupDir, '我自己的文件夹'));
  fs.mkdirSync(path.join(backupDir, '.tmp-unfinished'));
  const broken = path.join(backupDir, '2026-11-01_00-00-00_手动备份');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'backup.json'), '{ 不完整');
  assert.deepEqual(
    backups.listBackups(backupDir).map((item) => item.name),
    [newer.name, middle.name, older.name],
  );
  backups.removeStaleTemporary(backupDir);
  assert.equal(fs.existsSync(path.join(backupDir, '.tmp-unfinished')), false);
  assert.equal(fs.existsSync(path.join(backupDir, '我自己的文件夹')), true);
});

test('only the oldest automatic backups are removed, with screenshots no backup still uses', async (t) => {
  const { f, backupDir, backup, send } = setup(t);
  const manual = backup('manual', at(1));
  const autos = [];
  for (let day = 2; day <= 6; day++) {
    // Each day adds a different screenshot, so each backup has one more file.
    await send({
      kind: 'expense',
      requestId: randomUUID(),
      expense: {
        category: '办公',
        date: '2026-11-01',
        merchant: '合成商户',
        note: '',
        amount: day,
      },
      image: { base64: syntheticPng({ seed: day }).toString('base64') },
    });
    autos.push(backup('auto', at(day)));
  }
  const safety = backup('reset', at(7));
  assert.equal(storeFiles(backupDir).length, 5);
  // Keep the two newest automatic backups; days 2–4 go. Their screenshots stay because the
  // newer backups (and the safety backup) still contain them.
  backups.pruneAutomaticBackups(backupDir, 2);
  assert.deepEqual(
    backups.listBackups(backupDir).map((item) => item.name),
    [safety.name, autos[4].name, autos[3].name, manual.name],
  );
  assert.equal(storeFiles(backupDir).length, 5);
  // Without the safety backup and the newer ones, unused screenshots are removed too.
  fs.rmSync(safety.directory, { recursive: true });
  fs.rmSync(autos[4].directory, { recursive: true });
  assert.equal(backups.removeUnusedStoreFiles(backupDir), 1);
  assert.equal(storeFiles(backupDir).length, 4);
  // A folder that cannot be read as a backup stops the screenshot clean-up entirely.
  fs.rmSync(autos[3].directory, { recursive: true });
  fs.mkdirSync(path.join(backupDir, '看不懂的备份'));
  assert.equal(backups.removeUnusedStoreFiles(backupDir), 0);
  assert.equal(storeFiles(backupDir).length, 4);
  assert.equal(f.rows().attachments.length, 5);
});

test('a ledger can be found in a backup, a 数据 folder or a whole 钱来 folder', async (t) => {
  const { f, backup, send } = setup(t);
  await seedVariedLedger(send);
  const { directory } = backup();
  assert.equal(backups.locateSource(directory).type, 'backup');
  assert.equal(backups.locateSource(f.dir).type, 'data');
  // A whole 钱来 folder: <home>/数据/qianlai.sqlite
  const whole = fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-home-'));
  t.after(() => fs.rmSync(whole, { recursive: true, force: true }));
  fs.mkdirSync(path.join(whole, '数据'));
  fs.copyFileSync(
    path.join(directory, 'qianlai.sqlite'),
    path.join(whole, '数据', 'qianlai.sqlite'),
  );
  const found = backups.locateSource(whole);
  assert.equal(found.type, 'data');
  assert.equal(found.folder, path.join(whole, '数据'));
  for (const [make, message] of [
    [() => {}, /没有找到钱来账本或备份/],
    [(dir) => fs.mkdirSync(path.join(dir, 'trial-data')), /早期测试版的数据/],
    [(dir) => fs.writeFileSync(path.join(dir, 'trial.sqlite'), ''), /早期测试版的数据/],
    [(dir) => fs.writeFileSync(path.join(dir, 'backup.json'), '{}'), /说明文件已损坏/],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-source-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    make(dir);
    assert.throws(() => backups.locateSource(dir), message);
  }
  assert.throws(() => backups.locateSource('relative/path'), /请选择一个文件夹/);
});

test('reading a backup checks it completely and never changes the source', async (t) => {
  const { f, backup, send } = setup(t);
  await seedVariedLedger(send);
  const { directory } = backup();
  const file = path.join(directory, 'qianlai.sqlite'),
    before = sha256(fs.readFileSync(file));
  const staged = stage(t, directory);
  assert.deepEqual(staged.summary, schema.summarize(f.db));
  assert.equal(staged.files.length, 2);
  assert.deepEqual(staged.missing, []);
  assert.equal(staged.upgradedFrom, null);
  assert.deepEqual(rowsOf(staged.database), f.rows());
  assert.equal(sha256(fs.readFileSync(file)), before);
  // A screenshot missing from the store is reported, not fatal.
  fs.rmSync(staged.files[0].source);
  assert.deepEqual(stage(t, directory).missing, [staged.files[0].file]);
  // A database changed after the backup was written is refused.
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  assert.throws(() => stage(t, directory), /备份里的账本文件已损坏或不完整/);
});

test('a ledger folder that is open in another window, damaged or not a 钱来 ledger is refused', async (t) => {
  const { f, send } = setup(t);
  await seedVariedLedger(send);
  assert.throws(() => stage(t, f.dir), { code: 'SOURCE_IN_USE' });
  f.ledger.close();
  assert.equal(stage(t, f.dir).summary.expenseCount, 2);
  const file = path.join(f.dir, 'qianlai.sqlite');
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, 100), Buffer.alloc(bytes.length - 100)]));
  assert.throws(() => stage(t, f.dir), { code: 'LEDGER_DAMAGED' });
  const foreign = new Database(file + '.other');
  foreign.exec('CREATE TABLE notes (text TEXT)');
  foreign.close();
  fs.renameSync(file + '.other', file);
  assert.throws(() => stage(t, f.dir), { code: 'LEDGER_FOREIGN' });
});

test('replacing the contents is all or nothing', async (t) => {
  const source = setup(t);
  await seedVariedLedger(source.send);
  const { directory } = source.backup();
  const target = ledgerFixture(t, 'qianlai-target-');
  await seedVariedLedger((input) => target.ledger.command(input), { seed: 2 });
  const before = target.rows(),
    staged = stage(t, directory);
  assert.throws(
    () =>
      backups.replaceContents(target.db, staged.database, () => {
        throw Error('合成的中途失败');
      }),
    /合成的中途失败/,
  );
  assert.deepEqual(target.rows(), before);
  backups.replaceContents(target.db, staged.database, () => {});
  assert.deepEqual(target.rows(), source.f.rows());
  // The live database is still the target's own file, locked and usable.
  target.reopen();
  assert.equal((await target.ledger.command({ kind: 'read' })).expenses.length, 2);
});

test('screenshot clean-up removes only screenshot files the ledger no longer uses', async (t) => {
  const { f, send } = setup(t);
  await seedVariedLedger(send);
  const used = f.rows().attachments.map((row) => row.file);
  const unused = '00000000-0000-4000-8000-000000000000.png';
  fs.writeFileSync(path.join(f.attachmentsDir, unused), 'x');
  fs.writeFileSync(path.join(f.attachmentsDir, '我的笔记.txt'), '合成');
  assert.equal(backups.removeUnusedScreenshots(f.db, f.attachmentsDir), 1);
  assert.deepEqual(fs.readdirSync(f.attachmentsDir).sort(), [...used, '我的笔记.txt'].sort());
});

test('a backup of a ledger opened again by the program is identical to the live rows', async (t) => {
  const { f, backup, send } = setup(t);
  await seedVariedLedger(send);
  const { directory } = backup();
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-copy-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.copyFileSync(path.join(directory, 'qianlai.sqlite'), path.join(copy, 'qianlai.sqlite'));
  const reopened = openLedger(copy);
  t.after(() => reopened.close());
  assert.deepEqual(
    await reopened.command({ kind: 'read' }),
    await f.ledger.command({ kind: 'read' }),
  );
});
