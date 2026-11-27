'use strict';
// The ledger's file format: where it lives, its tables, its version number, how older
// versions are upgraded and the consistency check run on every open, backup and restore.
// This is the only place that describes the format; ledger.cjs and ledger-backup.cjs use it.
const fs = require('node:fs');
const path = require('node:path');

const APPLICATION_ID = 0x514c4149; // "QLAI": marks a SQLite file as a 钱来 ledger.
const SCHEMA_VERSION = 1;
const DATABASE_FILE = 'qianlai.sqlite';
const ATTACHMENTS_DIR = '截图';
// Everything lives in one home folder, so copying that folder moves the whole ledger:
//   <home>/数据      the ledger: qianlai.sqlite and 截图/
//   <home>/备份      automatic and manual backups
//   <home>/运行记录  program cache and startup logs, no bookkeeping data
const DATA_FOLDER = '数据';
const BACKUP_FOLDER = '备份';
const RUNTIME_FOLDER = '运行记录';
const MAX_CENTS = Number.MAX_SAFE_INTEGER;
const { MAX_IMAGE_BYTES } = require('./image-check.cjs');

// IS rather than =, so text that is not a date or time fails the check instead of passing as NULL.
const iso = (column) => `${column} IS strftime('%Y-%m-%dT%H:%M:%fZ', ${column})`;
const day = (column) => `date(${column}) IS ${column}`;
const cents = (column, minimum = 1) => `${column} BETWEEN ${minimum} AND ${MAX_CENTS}`;

// Creation order: every table appears after the tables it refers to.
const TABLES = [
  {
    name: 'meta',
    columns: ['key', 'value'],
    sql: `CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT`,
  },
  {
    name: 'attachments',
    columns: ['id', 'file', 'mime', 'size', 'sha256', 'created_at'],
    sql: `CREATE TABLE attachments (
      id TEXT PRIMARY KEY CHECK (length(id) = 36),
      file TEXT NOT NULL UNIQUE,
      mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
      size INTEGER NOT NULL CHECK (size BETWEEN 1 AND ${MAX_IMAGE_BYTES}),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      created_at TEXT NOT NULL CHECK (${iso('created_at')}),
      CHECK (file = id || CASE mime WHEN 'image/png' THEN '.png' ELSE '.jpg' END)
    ) STRICT`,
  },
  {
    name: 'expenses',
    columns: [
      'id',
      'category',
      'date',
      'merchant',
      'amount',
      'note',
      'invoice_issued',
      'attachment_id',
      'created_at',
      'deleted_at',
    ],
    sql: `CREATE TABLE expenses (
      id INTEGER PRIMARY KEY CHECK (id > 0),
      category TEXT NOT NULL CHECK (category IN ('接待', '办公')),
      date TEXT NOT NULL CHECK (${day('date')}),
      merchant TEXT NOT NULL CHECK (length(merchant) BETWEEN 1 AND 100),
      amount INTEGER NOT NULL CHECK (${cents('amount')}),
      note TEXT NOT NULL CHECK (length(note) <= 500),
      invoice_issued INTEGER NOT NULL DEFAULT 0 CHECK (invoice_issued IN (0, 1)),
      attachment_id TEXT REFERENCES attachments(id),
      created_at TEXT NOT NULL CHECK (${iso('created_at')}),
      deleted_at TEXT CHECK (deleted_at IS NULL OR ${iso('deleted_at')})
    ) STRICT`,
  },
  {
    // Advances are numbered 0, 1, 2… in the order they were recorded. A deleted advance
    // keeps its number, date and note with amount 0, so every number stays meaningful.
    name: 'advances',
    columns: ['id', 'amount', 'date', 'note', 'attachment_id', 'created_at', 'deleted_at'],
    sql: `CREATE TABLE advances (
      id INTEGER PRIMARY KEY CHECK (id >= 0),
      amount INTEGER NOT NULL CHECK (${cents('amount', 0)}),
      date TEXT NOT NULL CHECK (${day('date')}),
      note TEXT NOT NULL CHECK (length(note) <= 500),
      attachment_id TEXT REFERENCES attachments(id),
      created_at TEXT NOT NULL CHECK (${iso('created_at')}),
      deleted_at TEXT CHECK (deleted_at IS NULL OR ${iso('deleted_at')}),
      CHECK ((deleted_at IS NULL) = (amount > 0))
    ) STRICT`,
  },
  {
    name: 'batches',
    columns: ['id', 'date', 'created_at', 'cancelled_at', 'deleted_at'],
    sql: `CREATE TABLE batches (
      id INTEGER PRIMARY KEY CHECK (id > 0),
      date TEXT NOT NULL CHECK (${day('date')}),
      created_at TEXT NOT NULL CHECK (${iso('created_at')}),
      cancelled_at TEXT CHECK (cancelled_at IS NULL OR ${iso('cancelled_at')}),
      deleted_at TEXT CHECK (deleted_at IS NULL OR ${iso('deleted_at')})
    ) STRICT`,
  },
  {
    name: 'allocations',
    columns: ['batch_id', 'position', 'expense_id', 'amount'],
    sql: `CREATE TABLE allocations (
      batch_id INTEGER NOT NULL REFERENCES batches(id),
      position INTEGER NOT NULL CHECK (position >= 0),
      expense_id INTEGER NOT NULL REFERENCES expenses(id),
      amount INTEGER NOT NULL CHECK (${cents('amount')}),
      PRIMARY KEY (batch_id, position),
      UNIQUE (batch_id, expense_id)
    ) STRICT`,
  },
  {
    // Before/after copies of every correction, deletion and cancellation (the audit trail).
    name: 'events',
    columns: [
      'seq',
      'request_id',
      'action',
      'record_type',
      'record_id',
      'revision',
      'at',
      'before',
      'after',
    ],
    sql: `CREATE TABLE events (
      seq INTEGER PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      action TEXT NOT NULL CHECK (action IN (
        'correct-expense', 'delete-expense', 'set-invoice-issued',
        'correct-advance', 'delete-advance', 'cancel-batch', 'delete-batch')),
      record_type TEXT NOT NULL CHECK (record_type IN ('expense', 'advance', 'batch')),
      record_id INTEGER NOT NULL CHECK (record_id >= 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      at TEXT NOT NULL CHECK (${iso('at')}),
      before TEXT NOT NULL CHECK (json_valid(before)),
      after TEXT CHECK (after IS NULL OR json_valid(after)),
      UNIQUE (record_type, record_id, revision)
    ) STRICT`,
  },
  {
    // One row per save request, so a repeated click or retry is recorded only once.
    name: 'operations',
    columns: ['request_id', 'digest', 'kind', 'created_at'],
    sql: `CREATE TABLE operations (
      request_id TEXT PRIMARY KEY CHECK (length(request_id) = 36),
      digest TEXT NOT NULL CHECK (length(digest) = 64),
      kind TEXT NOT NULL,
      created_at TEXT NOT NULL CHECK (${iso('created_at')})
    ) STRICT`,
  },
];
const TABLE_NAMES = TABLES.map((table) => table.name);

// MIGRATIONS[n] upgrades a version n ledger to version n + 1 inside one transaction.
// Version 1 is the first format, so there is nothing to upgrade yet. When the format
// changes: raise SCHEMA_VERSION, update TABLES, add MIGRATIONS[old] and its tests.
const MIGRATIONS = {};

function formatError(message, code = 'LEDGER_INVALID') {
  return Object.assign(Error(message), { status: 409, code });
}
function busy(error) {
  return error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';
}
// SQLite's own messages for an unreadable file become one plain message with a code the
// program can act on (it offers to set the damaged folder aside).
function damagedFileError(error) {
  if (error?.code === 'SQLITE_NOTADB' || String(error?.code).startsWith('SQLITE_CORRUPT'))
    return formatError('账本文件已损坏，无法读取', 'LEDGER_DAMAGED');
  return error;
}

// Holds the database file for this process until it is closed. The operating system
// releases the lock if the program crashes, so a stale lock can never block startup.
function lockDatabase(db) {
  db.pragma('locking_mode = EXCLUSIVE');
  try {
    db.exec('BEGIN EXCLUSIVE; COMMIT');
  } catch (error) {
    if (busy(error))
      throw formatError(
        '这个账本正被另一个钱来窗口使用。请先关闭那个窗口，再重新打开。',
        'LEDGER_IN_USE',
      );
    throw error;
  }
}
function configure(db) {
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
}
function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name)
    .sort();
}
function createSchema(db, { ledgerId, generation, createdAt }) {
  db.transaction(() => {
    for (const table of TABLES) db.exec(table.sql);
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('ledger_id', ledgerId);
    meta.run('generation', generation);
    meta.run('created_at', createdAt);
    db.pragma(`application_id = ${APPLICATION_ID}`);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }).immediate();
}
function upgrade(db, from, { target, migrations }) {
  for (let version = from; version < target; version++)
    if (typeof migrations[version] !== 'function')
      throw formatError(`缺少从第 ${version} 版升级的步骤，未修改账本`);
  db.transaction(() => {
    for (let version = from; version < target; version++) {
      migrations[version](db);
      db.pragma(`user_version = ${version + 1}`);
    }
  }).immediate();
}

// Prepares an opened (and, for a live ledger, locked) database: creates a new ledger,
// rejects files that are not a 钱来 ledger or come from a newer version, and upgrades
// older versions after calling beforeUpgrade (which makes the safety backup).
function prepareDatabase(
  db,
  {
    create = false,
    identity,
    beforeUpgrade,
    target = SCHEMA_VERSION,
    migrations = MIGRATIONS,
  } = {},
) {
  configure(db);
  const applicationId = db.pragma('application_id', { simple: true }),
    version = db.pragma('user_version', { simple: true });
  if (applicationId === 0 && version === 0 && tableNames(db).length === 0) {
    if (!create) throw formatError('没有找到钱来账本', 'LEDGER_MISSING');
    createSchema(db, identity());
    return { created: true, upgradedFrom: null };
  }
  if (applicationId !== APPLICATION_ID)
    throw formatError('这个文件不是钱来账本，未修改它', 'LEDGER_FOREIGN');
  if (version > target)
    throw formatError(
      '这个账本是用更新版本的钱来保存的，请用新版本打开。为了安全，没有修改它。',
      'LEDGER_NEWER',
    );
  if (version < 1) throw formatError('账本版本号无效，未修改账本');
  if (version === target) return { created: false, upgradedFrom: null };
  beforeUpgrade?.(version);
  upgrade(db, version, { target, migrations });
  return { created: false, upgradedFrom: version };
}

function sumCents(db, sql) {
  try {
    const value = db.prepare(sql).get().total ?? 0;
    if (!Number.isSafeInteger(value) || value > MAX_CENTS) throw RangeError();
    return value;
  } catch (error) {
    if (error instanceof RangeError || /integer overflow/.test(error.message))
      throw formatError('账本金额合计超出安全范围');
    throw error;
  }
}
function count(db, sql) {
  return db.prepare(sql).get().n;
}
function summarize(db) {
  const totalExpenseCents = sumCents(
      db,
      'SELECT SUM(amount) total FROM expenses WHERE deleted_at IS NULL',
    ),
    totalAdvanceCents = sumCents(db, 'SELECT SUM(amount) total FROM advances'),
    reimbursedCents = sumCents(
      db,
      `SELECT SUM(a.amount) total FROM allocations a JOIN batches b ON b.id = a.batch_id
       WHERE b.cancelled_at IS NULL AND b.deleted_at IS NULL`,
    ),
    balanceCents = totalAdvanceCents - totalExpenseCents;
  return {
    expenseCount: count(db, 'SELECT COUNT(*) n FROM expenses WHERE deleted_at IS NULL'),
    advanceCount: count(db, 'SELECT COUNT(*) n FROM advances WHERE deleted_at IS NULL'),
    batchCount: count(db, 'SELECT COUNT(*) n FROM batches WHERE deleted_at IS NULL'),
    activeBatchCount: count(
      db,
      'SELECT COUNT(*) n FROM batches WHERE deleted_at IS NULL AND cancelled_at IS NULL',
    ),
    attachmentCount: count(db, 'SELECT COUNT(*) n FROM attachments'),
    totalExpenseCents,
    totalAdvanceCents,
    balanceCents,
    personalFundingCents: Math.max(0, -balanceCents),
    reimbursedCents,
    pendingCents: totalExpenseCents - reimbursedCents,
  };
}
function isEmpty(db) {
  return (
    count(
      db,
      `SELECT (SELECT COUNT(*) FROM expenses) + (SELECT COUNT(*) FROM advances)
        + (SELECT COUNT(*) FROM batches) n`,
    ) === 0
  );
}

// Rules that span several rows and so cannot be table constraints. Single-row rules
// (positive whole cents, real dates, text limits, categories) are enforced by the tables.
function checkInvariants(db) {
  const meta = Object.fromEntries(
    db
      .prepare('SELECT key, value FROM meta')
      .all()
      .map((row) => [row.key, row.value]),
  );
  for (const key of ['ledger_id', 'generation', 'created_at'])
    if (typeof meta[key] !== 'string' || !meta[key]) throw formatError('账本标识信息不完整');
  const advances = db.prepare('SELECT COUNT(*) n, COALESCE(MAX(id), -1) last FROM advances').get();
  if (advances.n !== advances.last + 1) throw formatError('预支编号不连续');
  const overAllocated = db
    .prepare(
      `SELECT e.id FROM allocations a
       JOIN batches b ON b.id = a.batch_id AND b.cancelled_at IS NULL AND b.deleted_at IS NULL
       JOIN expenses e ON e.id = a.expense_id
       GROUP BY e.id HAVING SUM(a.amount) > MAX(e.amount) OR MAX(e.deleted_at) IS NOT NULL
       LIMIT 1`,
    )
    .get();
  if (overAllocated) throw formatError(`费用 #${overAllocated.id} 的有效报销超过费用金额`);
  const emptyBatch = db
    .prepare(
      'SELECT id FROM batches b WHERE NOT EXISTS (SELECT 1 FROM allocations a WHERE a.batch_id = b.id) LIMIT 1',
    )
    .get();
  if (emptyBatch) throw formatError(`报销批次 #${emptyBatch.id} 没有分配`);
  return summarize(db);
}

// Full check of an opened database: file integrity, expected tables, references between
// rows and the cross-row bookkeeping rules. Returns the ledger summary.
function checkLedger(db) {
  const integrity = db.pragma('integrity_check');
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok')
    throw formatError('账本文件已损坏（完整性检查没有通过）', 'LEDGER_DAMAGED');
  if (db.pragma('application_id', { simple: true }) !== APPLICATION_ID)
    throw formatError('这个文件不是钱来账本', 'LEDGER_FOREIGN');
  if (db.pragma('user_version', { simple: true }) !== SCHEMA_VERSION)
    throw formatError('账本版本和程序不一致');
  const tables = tableNames(db);
  if (tables.join(',') !== [...TABLE_NAMES].sort().join(','))
    throw formatError('账本的数据表和本程序不一致', 'LEDGER_DAMAGED');
  if (db.pragma('foreign_key_check').length)
    throw formatError('账本记录之间的引用不完整', 'LEDGER_DAMAGED');
  return checkInvariants(db);
}

function ledgerFiles(dataDir) {
  return {
    database: path.join(dataDir, DATABASE_FILE),
    attachments: path.join(dataDir, ATTACHMENTS_DIR),
  };
}
function homeLayout(home) {
  return {
    home,
    dataDir: path.join(home, DATA_FOLDER),
    backupDir: path.join(home, BACKUP_FOLDER),
    runtimeDir: path.join(home, RUNTIME_FOLDER),
  };
}
function plainDirectory(folder, create = false) {
  if (create) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw formatError(`“${path.basename(folder)}”必须是普通文件夹`);
  return folder;
}

module.exports = {
  APPLICATION_ID,
  SCHEMA_VERSION,
  DATABASE_FILE,
  ATTACHMENTS_DIR,
  DATA_FOLDER,
  BACKUP_FOLDER,
  RUNTIME_FOLDER,
  MAX_CENTS,
  TABLES,
  TABLE_NAMES,
  MIGRATIONS,
  formatError,
  damagedFileError,
  lockDatabase,
  prepareDatabase,
  checkLedger,
  summarize,
  isEmpty,
  ledgerFiles,
  homeLayout,
  plainDirectory,
};
