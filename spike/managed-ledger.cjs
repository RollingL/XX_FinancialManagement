// Opt-in isolated ledgers only. Existing unmarked trial roots are never adopted.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const Database = require('better-sqlite3');
const { createLedger } = require('./trial-ledger.cjs');
const { resetLedger, readResetStatus, CONFIRMATION } = require('./ledger-reset.cjs');
const { acquireLedgerLock } = require('./ledger-lock.cjs');
const MARKER = 'managed-ledger.json';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (message) => {
  throw Object.assign(Error(message), { status: 409 });
};
function regular(file, directory = false) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') fail(`受管账本缺少 ${path.basename(file)}，请保留原目录`);
    throw e;
  }
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()))
    fail(`受管账本路径须为普通${directory ? '目录' : '文件'}：${path.basename(file)}`);
  return stat;
}
function writeJson(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function inspectManagedRoot(root, { complete = true } = {}) {
  regular(root, true);
  const markerPath = path.join(root, MARKER),
    stat = regular(markerPath);
  if (stat.size > 4096) fail('受管账本标识无效，请保留原目录');
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    fail('受管账本标识无效，请保留原目录');
  }
  if (
    !marker ||
    Array.isArray(marker) ||
    Object.keys(marker).sort().join(',') !== 'formatVersion,ledgerId,sourceKind' ||
    marker.formatVersion !== 1 ||
    typeof marker.ledgerId !== 'string' ||
    !uuid.test(marker.ledgerId) ||
    marker.sourceKind !== 'isolated-test'
  )
    fail('受管账本标识无效；仅支持本版本创建的隔离测试账本');
  if (complete) {
    regular(path.join(root, 'trial.sqlite'));
    regular(path.join(root, 'attachments'), true);
  }
  for (const suffix of ['-wal', '-shm']) {
    const file = path.join(root, 'trial.sqlite' + suffix);
    try {
      fs.lstatSync(file);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    regular(file);
  }
  return marker;
}
function acquireManagedLock(root, { create = false, allowLegacyRecovery = false } = {}) {
  if (typeof root !== 'string' || !root.trim()) fail('必须明确指定隔离账本目录');
  root = path.resolve(root);
  // Resolve parent aliases once; the final root itself must still pass the no-symlink check.
  root = path.join(fs.realpathSync(path.dirname(root)), path.basename(root));
  let created = false;
  if (create) {
    try {
      fs.mkdirSync(root, { mode: 0o700 });
      created = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (created)
      writeJson(path.join(root, MARKER), {
        formatVersion: 1,
        ledgerId: randomUUID(),
        sourceKind: 'isolated-test',
      });
  }
  const marker = inspectManagedRoot(root, { complete: !created }),
    { token, release } = acquireLedgerLock(root, { allowLegacyRecovery });
  try {
    const latest = inspectManagedRoot(root, { complete: !created });
    if (latest.ledgerId !== marker.ledgerId) fail('账本标识已变化，请保留目录');
  } catch (e) {
    release();
    throw e;
  }
  return { root, marker, created, release, token };
}
function createManagedLedger(
  root,
  { createBackup, backupDestination, allowLegacyRecovery = false } = {},
) {
  if (backupDestination !== undefined) {
    if (typeof backupDestination !== 'string' || !path.isAbsolute(backupDestination))
      fail('备份目录必须由启动配置指定绝对路径');
    regular(backupDestination, true);
    backupDestination = fs.realpathSync(backupDestination);
  }
  const anchor = acquireManagedLock(root, { create: true, allowLegacyRecovery }),
    locks = [anchor],
    retiredLedgers = new Set();
  let lock = anchor,
    ledger = null,
    rawState,
    opening = false,
    restoreReceipt = null,
    restorePointer = null;
  const pointerPath = path.join(anchor.root, 'active-ledger.json');
  try {
    if (fs.lstatSync(pointerPath, { throwIfNoEntry: false })) {
      const stat = regular(pointerPath);
      if (stat.size > 8192) fail('恢复入口标识过大');
      const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
      if (
        !pointer ||
        Object.keys(pointer).sort().join(',') !== 'directory,ledgerId,receipt,version' ||
        pointer.version !== 1 ||
        typeof pointer.directory !== 'string' ||
        !/^restored-[a-f0-9-]{36}$/.test(pointer.directory) ||
        !uuid.test(pointer.directory.slice(9)) ||
        !uuid.test(pointer.ledgerId)
      )
        fail('恢复入口标识无效');
      const receipt = pointer.receipt;
      if (
        !receipt ||
        Object.keys(receipt).sort().join(',') !==
          'backupDirectory,fromGeneration,generation,requestId,token' ||
        !uuid.test(receipt.requestId) ||
        !uuid.test(receipt.token) ||
        typeof receipt.backupDirectory !== 'string' ||
        !path.isAbsolute(receipt.backupDirectory) ||
        typeof receipt.fromGeneration !== 'string' ||
        !/^([a-f0-9-]{36}):([a-f0-9-]{36})$/.test(receipt.fromGeneration) ||
        !receipt.fromGeneration.split(':').every((value) => uuid.test(value)) ||
        typeof receipt.generation !== 'string' ||
        !receipt.generation.startsWith(pointer.ledgerId + ':') ||
        !uuid.test(receipt.generation.slice(pointer.ledgerId.length + 1))
      )
        fail('恢复回执无效');
      lock = acquireManagedLock(path.join(path.dirname(anchor.root), pointer.directory), {
        allowLegacyRecovery,
      });
      locks.push(lock);
      if (lock.marker.ledgerId !== pointer.ledgerId) fail('恢复账本身份与入口不一致');
      restoreReceipt = receipt;
      restorePointer = pointer;
    }
  } catch (e) {
    for (const item of locks.reverse()) item.release();
    throw e;
  }
  let database = path.join(lock.root, 'trial.sqlite');
  const publicGeneration = (raw) => `${lock.marker.ledgerId}:${raw ?? 'legacy'}`;
  function readRaw() {
    const db = new Database(database, { readonly: true, fileMustExist: true });
    try {
      return JSON.parse(db.prepare('SELECT json FROM trial_state WHERE id=1').get().json);
    } finally {
      db.close();
    }
  }
  function status() {
    return readResetStatus(lock.root);
  }
  function open() {
    opening = true;
    try {
      const value = createLedger(lock.root, lock.token);
      opening = false;
      return value;
    } catch (e) {
      opening = e.uncertainConnection !== false;
      throw e;
    }
  }
  try {
    if (!lock.created) require('./ledger-backup.cjs').inspectDatabase(database);
    if (lock.created) {
      ledger = open();
      const db = new Database(database, { fileMustExist: true });
      try {
        db.transaction(() => {
          const state = JSON.parse(
            db.prepare('SELECT json FROM trial_state WHERE id=1').get().json,
          );
          state.generation = randomUUID();
          db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(state));
        }).immediate();
      } finally {
        db.close();
      }
    }
    rawState = readRaw();
    if (
      rawState.generation !== undefined &&
      (typeof rawState.generation !== 'string' || !uuid.test(rawState.generation))
    )
      fail('账本代际无效，请保留原目录');
    let pending = true;
    try {
      pending = status().pending;
    } catch (e) {
      if (!e.pending) throw e;
    }
    if (!pending && !ledger) ledger = open();
  } catch (e) {
    if (opening) throw Error(`受管账本打开失败，连接状态无法确认，保留锁：${e.message}`);
    if (ledger) {
      try {
        ledger.close();
      } catch {
        throw Error(`受管账本打开失败，保留锁：${e.message}`);
      }
    }
    for (const item of [...locks].reverse()) item.release();
    throw Error(`现有受管账本不完整，未初始化或补表：${e.message}`);
  }
  let active = null,
    closing = false,
    closed = false,
    closePromise;
  const backupResults = new Map(),
    restorePlans = new Map();
  function run(action) {
    if (closing || closed)
      return Promise.reject(Object.assign(Error('账本正在关闭或已经关闭'), { status: 409 }));
    if (active)
      return Promise.reject(
        Object.assign(Error('账本正在保存或维护，请稍后再试'), { status: 409 }),
      );
    active = Promise.resolve()
      .then(action)
      .finally(() => {
        active = null;
      });
    return active;
  }
  function pendingError() {
    throw Object.assign(Error('清空尚未完成，普通操作与备份已暂停，请继续本次清理'), {
      status: 409,
      code: 'RESET_PENDING',
      pending: true,
    });
  }
  function normalStatus() {
    const value = status();
    if (value.pending) pendingError();
    return value;
  }
  function assertGeneration(input) {
    if (input.generation !== publicGeneration(rawState.generation))
      fail('账本代际已变化，请刷新后重新操作');
  }
  function request(input) {
    if (typeof input.requestId !== 'string' || !uuid.test(input.requestId))
      fail('维护请求编号无效');
  }
  function publicState(state) {
    return { ...state, generation: publicGeneration(state.generation) };
  }
  function information() {
    const value = status();
    rawState = readRaw();
    return {
      supported: true,
      canRestore: !!backupDestination,
      backupConfigured: !!backupDestination,
      canReset: uuid.test(rawState.generation || ''),
      generation: publicGeneration(rawState.generation),
      pendingReset: value.pending
        ? {
            requestId: value.requestId,
            fromGeneration: publicGeneration(value.fromGeneration),
            phase: value.phase,
          }
        : null,
    };
  }
  async function exportBackup(destinationParent) {
    normalStatus();
    const marker = inspectManagedRoot(lock.root);
    if (marker.ledgerId !== lock.marker.ledgerId) fail('账本标识已变化，停止备份');
    const db = new Database(database, { readonly: true, fileMustExist: true });
    try {
      return await (createBackup || require('./ledger-backup.cjs').createBackup)({
        db,
        dataDir: lock.root,
        destinationParent,
        ledgerId: marker.ledgerId,
        sourceKind: 'isolated-test',
      });
    } finally {
      db.close();
    }
  }
  async function reset(input) {
    request(input);
    if (input.confirmation !== CONFIRMATION) fail('请输入完整确认文字“清空当前账本”');
    const prefix = lock.marker.ledgerId + ':',
      from =
        typeof input.generation === 'string' && input.generation.startsWith(prefix)
          ? input.generation.slice(prefix.length)
          : '';
    if (!uuid.test(from)) fail('账本代际已变化或旧账本不支持清空，请刷新后重试');
    const pending = status();
    rawState = readRaw();
    if (pending.pending) {
      if (pending.requestId !== input.requestId || pending.fromGeneration !== from) pendingError();
    } else {
      if (
        rawState.resetReceipt?.requestId === input.requestId &&
        rawState.resetReceipt?.fromGeneration === from
      )
        return { reset: true, completed: true, generation: publicGeneration(rawState.generation) };
      if (input.generation !== publicGeneration(rawState.generation))
        fail('账本代际已变化，请刷新后重试');
    }
    if (ledger) {
      await ledger.close();
      ledger = null;
    }
    try {
      rawState = resetLedger({
        root: lock.root,
        requestId: input.requestId,
        generation: from,
        confirmation: input.confirmation,
      });
      backupResults.clear();
      return { reset: true, completed: true, generation: publicGeneration(rawState.generation) };
    } finally {
      rawState = readRaw();
      let unfinished = true;
      try {
        unfinished = status().pending;
      } catch (e) {
        if (!e.pending) throw e;
      }
      if (!unfinished && !closing) ledger = open();
    }
  }
  const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  function prepareRestore(input) {
    assertGeneration(input);
    if (!backupDestination) fail('恢复前须配置完整备份目录');
    if (Object.keys(input).some((key) => !['kind', 'generation', 'backup'].includes(key)))
      fail('恢复预览参数无效');
    const verified = require('./ledger-backup.cjs').verifyBackup(input.backup),
      token = randomUUID();
    rawState = readRaw();
    const plan = {
      directory: verified.directory,
      sourceDigest: digest(verified.manifest),
      stateDigest: digest(rawState),
      generation: publicGeneration(rawState.generation),
    };
    restorePlans.set(token, plan);
    if (restorePlans.size > 8) restorePlans.delete(restorePlans.keys().next().value);
    return {
      token,
      generation: plan.generation,
      summary: {
        ...verified.summary,
        invoiceCount: require('./ledger-backup.cjs').inspectDatabase(
          path.join(verified.directory, 'database.sqlite'),
        ).invoiceCount,
      },
      createdAt: verified.manifest.createdAt,
      directory: verified.directory,
    };
  }
  async function restore(input) {
    request(input);
    if (input.confirmation !== '恢复备份' || !uuid.test(input.token || ''))
      fail('请输入完整确认文字“恢复备份”');
    if (
      Object.keys(input).some(
        (key) => !['kind', 'requestId', 'generation', 'token', 'confirmation'].includes(key),
      )
    )
      fail('恢复确认参数无效');
    if (restoreReceipt?.requestId === input.requestId) {
      if (
        restoreReceipt.token !== input.token ||
        restoreReceipt.fromGeneration !== input.generation
      )
        fail('恢复请求编号已经使用，原确认内容不一致');
      return { restored: true, completed: true, ...restoreReceipt };
    }
    assertGeneration(input);
    const plan = restorePlans.get(input.token);
    if (!plan) fail('恢复预览已失效，请重新选择备份');
    rawState = readRaw();
    if (
      plan.generation !== publicGeneration(rawState.generation) ||
      plan.stateDigest !== digest(rawState)
    )
      fail('预览后账本已变化，请重新选择备份');
    const { verifyBackup, restoreBackup } = require('./ledger-backup.cjs');
    if (digest(verifyBackup(plan.directory).manifest) !== plan.sourceDigest)
      fail('预览后备份已变化，请重新选择备份');
    const preserved = await exportBackup(backupDestination);
    if (digest(verifyBackup(plan.directory).manifest) !== plan.sourceDigest)
      fail('备份在恢复前已变化，当前账本未改变');
    const target = path.join(path.dirname(anchor.root), 'restored-' + randomUUID());
    let newLock = null,
      nextLedger = null,
      candidateDatabase = null,
      published = false,
      candidateOpening = false;
    try {
      const restored = restoreBackup({ backupDir: plan.directory, targetDir: target });
      if (digest(restored.manifest) !== plan.sourceDigest)
        fail('恢复备份与预览不一致，当前账本未改变');
      newLock = acquireManagedLock(target, { allowLegacyRecovery });
      const db = (candidateDatabase = new Database(path.join(target, 'trial.sqlite'), {
        fileMustExist: true,
      }));
      let nextState;
      try {
        db.pragma('synchronous = FULL');
        db.transaction(() => {
          nextState = JSON.parse(db.prepare('SELECT json FROM trial_state WHERE id=1').get().json);
          nextState.generation = randomUUID();
          delete nextState.resetReceipt;
          db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(nextState));
        }).immediate();
      } finally {
        db.close();
        candidateDatabase = null;
      }
      require('./ledger-backup.cjs').inspectDatabase(path.join(target, 'trial.sqlite'));
      candidateOpening = true;
      nextLedger = createLedger(target, newLock.token);
      candidateOpening = false;
      const receipt = {
        requestId: input.requestId,
        token: input.token,
        fromGeneration: input.generation,
        generation: newLock.marker.ledgerId + ':' + nextState.generation,
        backupDirectory: preserved.directory,
      };
      if (inspectManagedRoot(anchor.root).ledgerId !== anchor.marker.ledgerId)
        fail('恢复入口身份已变化');
      const pointerExists = !!fs.lstatSync(pointerPath, { throwIfNoEntry: false });
      if (pointerExists !== !!restorePointer) fail('恢复入口已变化，请保留当前账本');
      if (pointerExists) {
        regular(pointerPath);
        const current = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
        if (digest(current) !== digest(restorePointer)) fail('恢复入口已变化，请保留当前账本');
      }
      const temporary = path.join(anchor.root, '.active-' + randomUUID() + '.json');
      const nextPointer = {
        version: 1,
        directory: path.basename(target),
        ledgerId: restored.ledgerId,
        receipt,
      };
      try {
        writeJson(temporary, nextPointer);
        fs.renameSync(temporary, pointerPath);
        published = true;
      } finally {
        if (!published && fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
      const previous = ledger;
      ledger = nextLedger;
      nextLedger = null;
      lock = newLock;
      locks.push(newLock);
      database = path.join(target, 'trial.sqlite');
      rawState = nextState;
      restoreReceipt = receipt;
      restorePointer = nextPointer;
      backupResults.clear();
      restorePlans.clear();
      retiredLedgers.add(previous);
      // The durable pointer is the commit point; all previous roots and locks remain until normal close.
      let warning;
      try {
        const fd = fs.openSync(anchor.root, 'r');
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch (e) {
        warning = '恢复已切换，但目录持久化未确认，请保留所有目录并正常退出：' + e.message;
      }
      try {
        await previous.close();
        retiredLedgers.delete(previous);
      } catch (e) {
        warning = '恢复已切换，原连接关闭未确认，请保留原目录：' + e.message;
      }
      return { restored: true, completed: true, ...receipt, ...(warning ? { warning } : {}) };
    } catch (e) {
      if (!published) {
        let safeToRelease = !candidateOpening || e.uncertainConnection === false;
        const abandoned = nextLedger ?? candidateDatabase;
        if (abandoned)
          try {
            await abandoned.close();
          } catch (closeError) {
            safeToRelease = false;
            retiredLedgers.add(abandoned);
            locks.push(newLock);
            e.message += '；候选连接关闭未确认：' + closeError.message;
          }
        if (newLock && safeToRelease)
          try {
            newLock.release();
          } catch (releaseError) {
            e.message += '；候选锁未释放：' + releaseError.message;
          }
        else if (newLock && candidateOpening)
          e.message += '；候选连接状态无法确认，保留其锁直至进程退出';
        e.message +=
          '；当前账本未切换，恢复前完整备份：' + preserved.directory + '；新候选目录：' + target;
      }
      throw e;
    }
  }
  function command(input) {
    return run(async () => {
      if (!input || typeof input !== 'object') fail('请求无效');
      if (input.kind === 'maintenance-info') return information();
      if (input.kind === 'reset-ledger') return await reset(input);
      if (input.kind === 'restore-backup') {
        normalStatus();
        return await restore(input);
      }
      normalStatus();
      if (!ledger) fail('账本连接不可用，请保留数据并重新打开受管实例');
      if (input.kind === 'read') {
        rawState = await ledger.command(input);
        return publicState(rawState);
      }
      if (input.kind === 'prepare-restore') return prepareRestore(input);
      assertGeneration(input);
      if (input.kind === 'create-backup') {
        request(input);
        if (Object.keys(input).some((key) => !['kind', 'requestId', 'generation'].includes(key)))
          fail('备份仅使用服务启动时配置的目录');
        if (!backupDestination) fail('尚未配置本机备份目录');
        if (backupResults.has(input.requestId)) return backupResults.get(input.requestId);
        const result = await exportBackup(backupDestination);
        backupResults.set(input.requestId, result);
        return result;
      }
      const { generation, ...payload } = input,
        result = await ledger.command(payload);
      if (input.kind === 'attachment') return result;
      rawState = result;
      return publicState(rawState);
    });
  }
  function backup(destinationParent) {
    return run(() => exportBackup(destinationParent));
  }
  function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (active)
        try {
          await active;
        } catch {}
      if (ledger) await ledger.close();
      ledger = null;
      for (const retired of retiredLedgers) {
        await retired.close();
        retiredLedgers.delete(retired);
      }
      if (opening) fail('账本连接关闭状态无法确认，保留锁，请保留原目录');
      for (const item of [...locks].reverse()) item.release();
      closed = true;
    })();
    return closePromise;
  }
  return {
    command,
    backup,
    close,
    get root() {
      return lock.root;
    },
    get ledgerId() {
      return lock.marker.ledgerId;
    },
  };
}
module.exports = { createManagedLedger, acquireManagedLock, inspectManagedRoot };
