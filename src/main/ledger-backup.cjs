'use strict';
// Complete backups, and reading a ledger from somewhere else for restore or import.
//
//   备份/
//     截图库/<sha256>.png|.jpg            each screenshot stored once, shared by all backups
//     2026-11-27_09-30-12_自动备份/
//       qianlai.sqlite                    consistent copy of the database
//       backup.json                       what is inside, with checksums
//       说明.txt                          plain-language note for the user
//
// Sharing screenshots keeps 30 daily backups small, so copying the whole 钱来 folder to
// another computer stays quick. A backup is written in a hidden .tmp- folder and only
// renamed into place when complete, so an interrupted backup never looks finished.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const schema = require('./ledger-schema.cjs');
const APPLICATION_VERSION = require('../../package.json').version;

const FORMAT = 'qianlai-backup';
const FORMAT_VERSION = 1;
const MANIFEST = 'backup.json';
const README = '说明.txt';
const STORE = '截图库';
const TEMP_PREFIX = '.tmp-';
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const KINDS = {
  auto: '自动备份',
  manual: '手动备份',
  restore: '恢复前备份',
  reset: '清空前备份',
  upgrade: '升级前备份',
};
const ATTACHMENT_FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg)$/;
const STORE_FILE = /^[a-f0-9]{64}\.(png|jpg)$/;

const fail = (message, code = 'BACKUP_INVALID') => {
  throw Object.assign(Error(message), { status: 409, code });
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pad = (n) => String(n).padStart(2, '0');
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;

function localStamp(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}
function localDay(date) {
  return localStamp(date).slice(0, 10);
}
function readableTime(date) {
  return `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function writeDurably(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function syncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
// Windows cannot flush a folder; file contents are flushed individually above.
function syncDirectory(folder) {
  let fd;
  try {
    fd = fs.openSync(folder, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EPERM', 'EINVAL', 'EISDIR', 'EBADF'].includes(error.code)
    )
      throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function isFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return !!stat && stat.isFile() && !stat.isSymbolicLink();
}
function isDirectory(folder) {
  const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
  return !!stat && stat.isDirectory() && !stat.isSymbolicLink();
}
function readFileIfValid(file, size, hash) {
  if (!isFile(file)) return null;
  const bytes = fs.readFileSync(file);
  return bytes.length === size && sha256(bytes) === hash ? bytes : null;
}
const storeName = (row) => `${row.sha256}${path.extname(row.file)}`;

// ---- Writing a backup ----

// Puts one screenshot into the shared store. A file already there with the right name
// is reused; a new one is written under a temporary name and renamed when complete.
function storeScreenshot(store, attachmentsDir, row) {
  const target = path.join(store, storeName(row));
  if (isFile(target) && fs.statSync(target).size === row.size) return true;
  const bytes = readFileIfValid(path.join(attachmentsDir, row.file), row.size, row.sha256);
  if (!bytes) return false;
  const temporary = path.join(store, `${TEMP_PREFIX}${randomUUID()}`);
  writeDurably(temporary, bytes);
  fs.renameSync(temporary, target);
  return true;
}
function uniqueFolder(backupDir, base) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}_${n}`;
    if (!fs.lstatSync(path.join(backupDir, name), { throwIfNoEntry: false })) return name;
  }
}
function summaryText(summary) {
  if (!summary) return '较早版本的账本格式（恢复时会自动升级）。';
  return (
    `费用 ${summary.expenseCount} 笔，预支 ${summary.advanceCount} 笔，` +
    `报销批次 ${summary.batchCount} 批，截图 ${summary.attachmentCount} 张。`
  );
}
function readme(manifest, createdAt) {
  const lines = [
    '这是钱来的完整备份，请不要修改或删除这个文件夹里的文件。',
    '',
    `时间：${readableTime(createdAt)}`,
    `类型：${KINDS[manifest.kind]}`,
    `内容：${summaryText(manifest.summary)}`,
    ...(manifest.missingAttachments.length
      ? [
          `注意：有 ${manifest.missingAttachments.length} 张截图在备份时已经找不到或损坏，备份里也没有。`,
        ]
      : []),
    '',
    '截图统一保存在旁边的“截图库”文件夹里，复制备份时请把整个“备份”文件夹一起复制。',
    '',
    '怎么恢复：打开钱来 → “备份”页 → 在列表里找到这份备份，点“用这份恢复”。',
    '如果它不在列表里（例如在 U 盘上），点“从其他文件夹恢复或导入”，选择这个文件夹。',
  ];
  return Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

// Writes a complete backup of an open ledger database into backupDir.
// kind is one of KINDS. Returns { name, directory, manifest }.
function createBackup({ db, attachmentsDir, backupDir, kind, now = () => new Date() }) {
  if (!Object.hasOwn(KINDS, kind)) throw Error('未知的备份类型');
  schema.plainDirectory(backupDir, true);
  const store = schema.plainDirectory(path.join(backupDir, STORE), true),
    createdAt = now(),
    temporary = path.join(backupDir, `${TEMP_PREFIX}${randomUUID()}`);
  fs.mkdirSync(temporary, { mode: 0o700 });
  try {
    const databaseFile = path.join(temporary, schema.DATABASE_FILE);
    db.exec(`VACUUM INTO ${sqlString(databaseFile)}`);
    syncFile(databaseFile);
    const copy = new Database(databaseFile, { readonly: true, fileMustExist: true });
    let version, summary, ledgerId, rows;
    try {
      version = copy.pragma('user_version', { simple: true });
      summary = version === schema.SCHEMA_VERSION ? schema.checkLedger(copy) : null;
      ledgerId = copy.prepare("SELECT value FROM meta WHERE key = 'ledger_id'").get()?.value;
      rows = copy.prepare('SELECT file, mime, size, sha256 FROM attachments ORDER BY file').all();
    } finally {
      copy.close();
    }
    const attachments = [],
      missingAttachments = [];
    for (const row of rows)
      if (storeScreenshot(store, attachmentsDir, row))
        attachments.push({ file: row.file, size: row.size, sha256: row.sha256 });
      else missingAttachments.push(row.file);
    syncDirectory(store);
    const databaseBytes = fs.readFileSync(databaseFile);
    const manifest = {
      format: FORMAT,
      formatVersion: FORMAT_VERSION,
      applicationVersion: APPLICATION_VERSION,
      schemaVersion: version,
      kind,
      createdAt: createdAt.toISOString(),
      ledgerId: ledgerId ?? null,
      database: {
        file: schema.DATABASE_FILE,
        size: databaseBytes.length,
        sha256: sha256(databaseBytes),
      },
      attachments,
      missingAttachments,
      summary,
    };
    writeDurably(path.join(temporary, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
    writeDurably(path.join(temporary, README), readme(manifest, createdAt));
    syncDirectory(temporary);
    const name = uniqueFolder(backupDir, `${localStamp(createdAt)}_${KINDS[kind]}`),
      directory = path.join(backupDir, name);
    fs.renameSync(temporary, directory);
    syncDirectory(backupDir);
    return { name, directory, manifest };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

// ---- Listing and tidying backups ----

function validManifest(value) {
  return (
    value &&
    typeof value === 'object' &&
    value.format === FORMAT &&
    value.formatVersion === FORMAT_VERSION &&
    Object.hasOwn(KINDS, value.kind) &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    Number.isSafeInteger(value.schemaVersion) &&
    value.database?.file === schema.DATABASE_FILE &&
    Number.isSafeInteger(value.database.size) &&
    /^[a-f0-9]{64}$/.test(value.database.sha256) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(
      (item) =>
        ATTACHMENT_FILE.test(item?.file) &&
        Number.isSafeInteger(item.size) &&
        /^[a-f0-9]{64}$/.test(item.sha256),
    ) &&
    Array.isArray(value.missingAttachments)
  );
}
function readManifest(folder) {
  const file = path.join(folder, MANIFEST);
  if (!isFile(file) || fs.statSync(file).size > MAX_MANIFEST_BYTES) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validManifest(value) ? value : null;
  } catch {
    return null;
  }
}
function backupFolders(backupDir) {
  if (!isDirectory(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter(
      (name) => !name.startsWith('.') && name !== STORE && isDirectory(path.join(backupDir, name)),
    );
}
// Newest first. Folders without a readable backup.json are not listed.
function listBackups(backupDir) {
  return backupFolders(backupDir)
    .flatMap((name) => {
      const directory = path.join(backupDir, name),
        manifest = readManifest(directory);
      return manifest ? [{ name, directory, manifest }] : [];
    })
    .sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}
function removeStaleTemporary(backupDir) {
  if (!isDirectory(backupDir)) return;
  for (const name of fs.readdirSync(backupDir))
    if (name.startsWith(TEMP_PREFIX))
      fs.rmSync(path.join(backupDir, name), { recursive: true, force: true });
  const store = path.join(backupDir, STORE);
  if (isDirectory(store))
    for (const name of fs.readdirSync(store))
      if (name.startsWith(TEMP_PREFIX)) fs.rmSync(path.join(store, name), { force: true });
}
// Removes screenshots that no backup uses any more. Skipped entirely if any folder in
// 备份/ cannot be read as a backup, because its screenshots might still be needed.
function removeUnusedStoreFiles(backupDir) {
  const store = path.join(backupDir, STORE);
  if (!isDirectory(store)) return 0;
  const used = new Set();
  for (const name of backupFolders(backupDir)) {
    const manifest = readManifest(path.join(backupDir, name));
    if (!manifest) return 0;
    for (const item of manifest.attachments) used.add(storeName(item));
  }
  let removed = 0;
  for (const name of fs.readdirSync(store))
    if (STORE_FILE.test(name) && !used.has(name)) {
      fs.rmSync(path.join(store, name), { force: true });
      removed++;
    }
  return removed;
}
// Keeps the newest `keep` automatic backups. Manual and safety backups are never removed.
function pruneAutomaticBackups(backupDir, keep) {
  const automatic = listBackups(backupDir).filter((item) => item.manifest.kind === 'auto');
  for (const item of automatic.slice(keep))
    fs.rmSync(item.directory, { recursive: true, force: true });
  return removeUnusedStoreFiles(backupDir);
}

// ---- Reading a ledger from a backup, a 数据 folder or a whole 钱来 folder ----

function locateSource(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || !isDirectory(folder))
    fail('请选择一个文件夹');
  if (isFile(path.join(folder, MANIFEST))) {
    const manifest = readManifest(folder);
    if (!manifest) fail('这个备份的说明文件已损坏，无法确认里面的内容');
    return {
      type: 'backup',
      folder,
      manifest,
      database: path.join(folder, schema.DATABASE_FILE),
      screenshot: (row) => path.join(path.dirname(folder), STORE, storeName(row)),
    };
  }
  for (const dataDir of [folder, path.join(folder, schema.DATA_FOLDER)]) {
    const files = schema.ledgerFiles(dataDir);
    if (isFile(files.database))
      return {
        type: 'data',
        folder: dataDir,
        manifest: null,
        database: files.database,
        screenshot: (row) => path.join(files.attachments, row.file),
      };
  }
  if (
    ['trial-data', 'trial.sqlite', 'stage0-trial'].some((name) =>
      fs.existsSync(path.join(folder, name)),
    )
  )
    fail('这是早期测试版的数据，新版不能读取');
  fail('这个文件夹里没有找到钱来账本或备份。请选择旧的钱来文件夹、它的“数据”文件夹或某一份备份。');
}

// Another 钱来 window keeps its ledger locked; reading it then would be unreliable.
function assertNotInUse(file) {
  let probe;
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true, timeout: 300 });
    probe.pragma('schema_version');
  } catch (error) {
    if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
      fail('选中的账本正被另一个钱来窗口使用，请先关闭那个窗口再试', 'SOURCE_IN_USE');
    // A ledger that was not closed normally can only be repaired on a copy; continue.
  } finally {
    probe?.close();
  }
}

// Copies the source database into stagingDir (the source is never modified), upgrades
// the copy if it is from an older version, checks it and checks every screenshot.
// A screenshot missing from the source is also looked for in `alsoLookIn` (the live
// 截图 folder), which still has it when an older backup of the same ledger is restored.
function stageSource(source, stagingDir, { alsoLookIn } = {}) {
  if (source.manifest) {
    const expected = source.manifest.database;
    if (!readFileIfValid(source.database, expected.size, expected.sha256))
      fail('备份里的账本文件已损坏或不完整');
  }
  assertNotInUse(source.database);
  const staged = path.join(stagingDir, schema.DATABASE_FILE);
  fs.copyFileSync(source.database, staged, fs.constants.COPYFILE_EXCL);
  if (isFile(source.database + '-journal'))
    fs.copyFileSync(source.database + '-journal', staged + '-journal');
  const db = new Database(staged, { fileMustExist: true });
  try {
    return readStaged(db, source, staged, alsoLookIn);
  } catch (error) {
    throw schema.damagedFileError(error);
  } finally {
    db.close();
  }
}
// Upgrades and checks the staged copy, then finds every screenshot it refers to.
function readStaged(db, source, staged, alsoLookIn) {
  const prepared = schema.prepareDatabase(db, { create: false });
  const summary = schema.checkLedger(db),
    meta = Object.fromEntries(
      db
        .prepare('SELECT key, value FROM meta')
        .all()
        .map((row) => [row.key, row.value]),
    ),
    rows = db.prepare('SELECT id, file, mime, size, sha256 FROM attachments ORDER BY file').all();
  const files = [],
    missing = [];
  for (const row of rows) {
    const file = [source.screenshot(row), alsoLookIn && path.join(alsoLookIn, row.file)].find(
      (candidate) => candidate && readFileIfValid(candidate, row.size, row.sha256),
    );
    if (file) files.push({ ...row, source: file });
    else missing.push(row.file);
  }
  return {
    database: staged,
    summary,
    files,
    missing,
    ledgerId: meta.ledger_id,
    upgradedFrom: prepared.upgradedFrom,
  };
}

// Copies one verified screenshot into the live 截图 folder. A damaged file with the same
// name is replaced (the safety backup made just before has already recorded it).
function copyScreenshot(file, attachmentsDir) {
  const target = path.join(attachmentsDir, file.file);
  if (readFileIfValid(target, file.size, file.sha256)) return;
  const bytes = readFileIfValid(file.source, file.size, file.sha256);
  if (!bytes) fail('备份里的截图在恢复前发生了变化，请重新选择备份');
  const temporary = path.join(attachmentsDir, `${TEMP_PREFIX}${randomUUID()}`);
  writeDurably(temporary, bytes);
  fs.renameSync(temporary, target);
}

// Replaces every row of the live database with the staged copy, in one transaction.
// `finish` runs inside the same transaction (to record the request and new generation).
function replaceContents(db, stagedFile, finish) {
  db.exec(`ATTACH DATABASE ${sqlString(stagedFile)} AS source`);
  try {
    db.transaction(() => {
      for (const table of [...schema.TABLES].reverse()) db.exec(`DELETE FROM main.${table.name}`);
      for (const table of schema.TABLES) {
        const columns = table.columns.join(', ');
        db.exec(
          `INSERT INTO main.${table.name} (${columns}) SELECT ${columns} FROM source.${table.name}`,
        );
      }
      finish();
      schema.checkLedger(db);
    }).immediate();
  } finally {
    db.exec('DETACH DATABASE source');
  }
}
// Deletes screenshots in 截图/ that the ledger no longer uses (after a clear or restore;
// the safety backup made just before keeps them), and unfinished copies. Only files
// named like screenshots are touched.
function removeUnusedScreenshots(db, attachmentsDir) {
  const used = new Set(
    db
      .prepare('SELECT file FROM attachments')
      .all()
      .map((row) => row.file),
  );
  let removed = 0;
  for (const name of fs.readdirSync(attachmentsDir))
    if ((ATTACHMENT_FILE.test(name) && !used.has(name)) || name.startsWith(TEMP_PREFIX)) {
      fs.rmSync(path.join(attachmentsDir, name), { force: true });
      removed++;
    }
  return removed;
}

module.exports = {
  KINDS,
  STORE,
  MANIFEST,
  localDay,
  createBackup,
  listBackups,
  readManifest,
  pruneAutomaticBackups,
  removeStaleTemporary,
  removeUnusedStoreFiles,
  locateSource,
  stageSource,
  copyScreenshot,
  replaceContents,
  removeUnusedScreenshots,
};
