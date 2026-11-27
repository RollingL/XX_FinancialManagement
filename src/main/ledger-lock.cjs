const fs = require('node:fs'),
  path = require('node:path');
const { randomUUID } = require('node:crypto'),
  { isDeepStrictEqual } = require('node:util');
const Database = require('better-sqlite3');
const identity = require('./process-identity.cjs');
const LOCK = '.writer-lock',
  OWNER = 'owner.json',
  GUARD = '.writer-guard.sqlite';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const startFormats = {
  win32: /^windows:\d{15,20}$/,
  darwin: /^darwin:[A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/,
  linux: /^linux:[a-f\d-]{36}:\d+$/,
};
const fail = (message) => {
  throw Object.assign(Error(message), { status: 409 });
};
const unavailable = (reason) => fail('账本正在使用或有残留锁，未接管账本：' + reason);
function plain(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()))
    unavailable('锁路径不是普通' + (directory ? '目录' : '文件'));
  return stat;
}
function readOwner(directory) {
  plain(directory, true);
  if (fs.readdirSync(directory).sort().join(',') !== OWNER)
    unavailable('锁内容无法识别，请保留原目录');
  const file = path.join(directory, OWNER),
    stat = plain(file);
  if (stat.size > 4096) unavailable('锁所有者信息过大');
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    unavailable('锁所有者信息无法读取');
  }
  if (
    !owner ||
    Array.isArray(owner) ||
    !uuid.test(owner.token || '') ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(owner.createdAt))
  )
    unavailable('锁所有者信息不完整');
  const keys = Object.keys(owner).sort().join(',');
  if (keys === 'createdAt,pid,token') return { owner, legacy: true };
  if (
    keys !== 'createdAt,hostId,pid,processStart,token,version' ||
    owner.version !== 2 ||
    !(
      owner.hostId === null ||
      (typeof owner.hostId === 'string' && /^[a-f\d]{64}$/.test(owner.hostId))
    ) ||
    !(
      owner.processStart === null ||
      (typeof owner.processStart === 'string' &&
        startFormats[process.platform]?.test(owner.processStart))
    )
  )
    unavailable('锁所有者版本无法识别');
  return { owner, legacy: false };
}
// Every new owner uses the same OS-backed SQLite guard for acquire/recover/release.
// Never unlink this file: unlinking an advisory lock would split ownership across inodes.
function withGuard(root, action) {
  const file = path.join(root, GUARD);
  for (const suffix of ['', '-journal', '-wal', '-shm'])
    if (fs.lstatSync(file + suffix, { throwIfNoEntry: false })) plain(file + suffix);
  let db;
  try {
    db = new Database(file, { timeout: 3000 });
    db.exec('BEGIN IMMEDIATE');
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db?.inTransaction) db.exec('ROLLBACK');
    if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
      unavailable('另一个实例正在启动或关闭，请稍后重试');
    throw error;
  } finally {
    db?.close();
  }
}
function staleOwner(snapshot, root, allowLegacyRecovery) {
  const { owner, legacy } = snapshot;
  if (legacy) {
    if (!allowLegacyRecovery || !identity.isLocalVolume(root))
      unavailable('旧版锁缺少机器身份，仅支持已确认的本机数据目录恢复');
    if (identity.processIdentity(owner.pid).state !== 'absent')
      unavailable('旧版锁的进程仍存在或无法确认已退出');
    return 'legacy-owner-absent';
  }
  const host = identity.hostIdentity();
  if (!host || owner.hostId !== host) unavailable('锁来自其他机器或机器身份无法确认');
  const process = identity.processIdentity(owner.pid);
  if (process.state === 'absent') return 'owner-absent';
  if (
    process.state === 'alive' &&
    owner.processStart &&
    process.startedAt &&
    owner.processStart !== process.startedAt
  )
    return 'pid-reused';
  unavailable('原实例仍在运行或进程身份无法确认，请先正常关闭原实例');
}
function acquireLedgerLock(root, { allowLegacyRecovery = false } = {}) {
  plain(root, true);
  const token = randomUUID(),
    owner = {
      version: 2,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
      hostId: identity.hostIdentity(),
      processStart: identity.processIdentity(process.pid).startedAt ?? null,
    };
  const lockDir = path.join(root, LOCK),
    candidate = path.join(root, '.writer-candidate-' + token);
  fs.mkdirSync(candidate, { mode: 0o700 });
  const fd = fs.openSync(path.join(candidate, OWNER), 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(owner) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let acquired = false,
    recovered = null;
  try {
    withGuard(root, () => {
      if (fs.lstatSync(lockDir, { throwIfNoEntry: false })) {
        const snapshot = readOwner(lockDir),
          reason = staleOwner(snapshot, root, allowLegacyRecovery);
        // Re-read under the guard; preserve original evidence instead of deleting a stale owner.
        if (!isDeepStrictEqual(readOwner(lockDir), snapshot)) unavailable('锁在检查时发生变化');
        staleOwner(snapshot, root, allowLegacyRecovery);
        const preserved = path.join(root, '.recovered-writer-lock-' + randomUUID());
        fs.renameSync(lockDir, preserved);
        recovered = { reason, directory: preserved };
      }
      // Fully written owner metadata appears atomically, including after a crash during initialization.
      fs.renameSync(candidate, lockDir);
      acquired = true;
    });
  } finally {
    if (!acquired && fs.existsSync(candidate)) {
      fs.unlinkSync(path.join(candidate, OWNER));
      fs.rmdirSync(candidate);
    }
  }
  let released = false;
  function release() {
    if (released) return;
    withGuard(root, () => {
      const current = readOwner(lockDir);
      if (!isDeepStrictEqual(current.owner, owner)) fail('账本锁所有者或内容已变化，未释放锁');
      const retired = path.join(root, '.released-writer-lock-' + token);
      fs.renameSync(lockDir, retired);
      released = true;
      // Database closure precedes release. A crash during this cleanup cannot leave an active empty lock.
      try {
        fs.unlinkSync(path.join(retired, OWNER));
        fs.rmdirSync(retired);
      } catch {}
    });
  }
  return { token, release, recovered };
}
module.exports = { acquireLedgerLock };
