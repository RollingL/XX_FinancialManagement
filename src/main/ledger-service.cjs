'use strict';
// The ledger as the program uses it: everyday bookkeeping plus backups, restore and
// import, clearing, and the daily automatic backup. Requests run one at a time, in order.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { openLedger } = require('./ledger.cjs');
const schema = require('./ledger-schema.cjs');
const backups = require('./ledger-backup.cjs');

const RESET_CONFIRMATION = '清空当前账本';
const RESTORE_CONFIRMATION = '恢复备份';
const KEEP_AUTOMATIC_BACKUPS = 30;
const MAX_PLANS = 4;
const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const conflict = (message) => {
  throw Object.assign(Error(message), { status: 409 });
};
const invalid = (message) => {
  throw Object.assign(Error(message), { status: 422 });
};
const digestOf = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function publicBackup(item) {
  const { manifest } = item;
  return {
    name: item.name,
    directory: item.directory,
    kind: manifest.kind,
    kindLabel: backups.KINDS[manifest.kind],
    createdAt: manifest.createdAt,
    summary: manifest.summary,
    missingAttachmentCount: manifest.missingAttachments.length,
    olderFormat: manifest.schemaVersion < schema.SCHEMA_VERSION,
  };
}

// Opens the ledger in home/数据 (creating it on first use), with backups in home/备份.
function openLedgerService(
  home,
  { now = () => new Date(), keepAutomaticBackups = KEEP_AUTOMATIC_BACKUPS } = {},
) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw Error('数据位置必须是绝对路径');
  const layout = schema.homeLayout(home);
  schema.plainDirectory(home, true);
  schema.plainDirectory(layout.backupDir, true);
  backups.removeStaleTemporary(layout.backupDir);
  const backupOf = (db, kind) =>
    backups.createBackup({
      db,
      attachmentsDir: schema.ledgerFiles(layout.dataDir).attachments,
      backupDir: layout.backupDir,
      kind,
      now,
    });
  const ledger = openLedger(layout.dataDir, {
    now,
    beforeUpgrade: (db) => backupOf(db, 'upgrade'),
  });
  const db = ledger.database,
    attachmentsDir = ledger.files.attachments,
    plans = new Map(),
    backupResults = new Map();
  let automaticDay = null,
    automaticError = null,
    queue = Promise.resolve(),
    closing = false,
    closed = false;

  const generation = () => ledger.generation();
  const empty = () => schema.isEmpty(db);
  function assertGeneration(input) {
    if (input.generation !== generation()) conflict('账本已经换过（清空或恢复），请刷新后重新操作');
  }
  function assertRequest(input) {
    if (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId))
      invalid('请求编号无效');
  }
  function backup(kind) {
    return backupOf(db, kind);
  }

  // At most one automatic backup per calendar day, and none for an empty ledger.
  function automaticBackup() {
    const today = backups.localDay(now());
    if (automaticDay === today) return;
    try {
      if (empty()) return;
      const latest = backups
        .listBackups(layout.backupDir)
        .find((item) => item.manifest.kind === 'auto');
      if (!latest || backups.localDay(new Date(latest.manifest.createdAt)) !== today)
        backup('auto');
      backups.pruneAutomaticBackups(layout.backupDir, keepAutomaticBackups);
      automaticDay = today;
      automaticError = null;
    } catch (error) {
      automaticError = `自动备份没有完成：${error.message}`;
    }
  }

  function information() {
    return {
      generation: generation(),
      version: backups.APPLICATION_VERSION,
      home: layout.home,
      dataDir: layout.dataDir,
      backupDir: layout.backupDir,
      empty: empty(),
      keepAutomaticBackups,
      automaticBackupError: automaticError,
      backups: backups.listBackups(layout.backupDir).map(publicBackup),
    };
  }

  function createManualBackup(input) {
    assertRequest(input);
    if (Object.keys(input).some((key) => !['kind', 'requestId', 'generation'].includes(key)))
      invalid('备份请求无效');
    assertGeneration(input);
    if (backupResults.has(input.requestId)) return backupResults.get(input.requestId);
    const result = publicBackup(backup('manual'));
    backupResults.set(input.requestId, result);
    return result;
  }

  // ---- Restore and import ----

  function discardPlan(token) {
    const plan = plans.get(token);
    if (!plan) return;
    plans.delete(token);
    fs.rmSync(plan.stagingDir, { recursive: true, force: true });
  }
  function resolveSource(input) {
    if (Object.hasOwn(input, 'backup')) {
      const name = input.backup;
      if (
        typeof name !== 'string' ||
        !name ||
        name.startsWith('.') ||
        name !== path.basename(name) ||
        name === backups.STORE
      )
        invalid('备份名称无效');
      return path.join(layout.backupDir, name);
    }
    if (typeof input.source !== 'string' || !path.isAbsolute(input.source))
      invalid('请选择一个文件夹');
    return input.source;
  }
  function prepareRestore(input) {
    const keys = Object.keys(input).sort().join(',');
    if (keys !== 'backup,generation,kind' && keys !== 'generation,kind,source')
      invalid('恢复预览请求无效');
    assertGeneration(input);
    const folder = resolveSource(input),
      source = backups.locateSource(folder);
    if (fs.realpathSync(source.database) === fs.realpathSync(ledger.files.database))
      invalid('这就是现在正在用的账本，不需要恢复');
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-restore-'));
    let staged;
    try {
      staged = backups.stageSource(source, stagingDir, { alsoLookIn: attachmentsDir });
    } catch (error) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    }
    const token = randomUUID();
    plans.set(token, { stagingDir, staged, generation: generation() });
    while (plans.size > MAX_PLANS) discardPlan(plans.keys().next().value);
    return {
      token,
      generation: generation(),
      sourceType: source.type,
      location: source.folder,
      createdAt: source.manifest?.createdAt ?? null,
      kindLabel: source.manifest ? backups.KINDS[source.manifest.kind] : null,
      summary: staged.summary,
      missingAttachmentCount: staged.missing.length,
      upgradedFrom: staged.upgradedFrom,
    };
  }
  function previousMaintenance(input, kind) {
    const previous = db
      .prepare('SELECT digest, kind FROM operations WHERE request_id = ?')
      .get(input.requestId);
    if (!previous) return null;
    const receipt = JSON.parse(
      db.prepare("SELECT value FROM meta WHERE key = 'last_maintenance'").get()?.value ?? 'null',
    );
    if (previous.kind !== kind || receipt?.requestId !== input.requestId)
      conflict('请求编号已经用过，请刷新后重试');
    if (previous.digest !== receipt.digest) conflict('请求编号已经用过，内容不一致');
    return receipt.result;
  }
  // Inside the replacing transaction: new generation, receipt for a repeated request.
  function finishMaintenance(input, kind, digest, result) {
    const at = now().toISOString(),
      next = randomUUID(),
      complete = { ...result, generation: next };
    const meta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    meta.run('generation', next);
    meta.run(
      'last_maintenance',
      JSON.stringify({ requestId: input.requestId, kind, at, digest, result: complete }),
    );
    db.prepare(
      'INSERT INTO operations (request_id, digest, kind, created_at) VALUES (?, ?, ?, ?)',
    ).run(input.requestId, digest, kind, at);
    return complete;
  }
  function restore(input) {
    assertRequest(input);
    if (
      Object.keys(input).sort().join(',') !== 'confirmation,generation,kind,requestId,token' ||
      typeof input.token !== 'string'
    )
      invalid('恢复确认请求无效');
    const digest = digestOf({ kind: input.kind, token: input.token });
    const repeated = previousMaintenance(input, 'restore-backup');
    if (repeated) return repeated;
    if (input.confirmation !== RESTORE_CONFIRMATION) invalid('请输入完整确认文字“恢复备份”');
    assertGeneration(input);
    const plan = plans.get(input.token);
    if (!plan || plan.generation !== generation()) conflict('恢复预览已失效，请重新选择备份');
    const safety = empty() ? null : backup('restore');
    let result;
    try {
      for (const file of plan.staged.files) backups.copyScreenshot(file, attachmentsDir);
      backups.replaceContents(db, plan.staged.database, () => {
        result = finishMaintenance(input, 'restore-backup', digest, {
          restored: true,
          completed: true,
          backup: safety ? safety.name : null,
          backupDirectory: safety ? safety.directory : null,
          missingAttachmentCount: plan.staged.missing.length,
        });
      });
    } finally {
      // Screenshots the ledger does not use (the old ones after a restore, or the copied
      // ones after a failed restore) are removed; the safety backup keeps the old ones.
      backups.removeUnusedScreenshots(db, attachmentsDir);
    }
    for (const token of [...plans.keys()]) discardPlan(token);
    backupResults.clear();
    automaticDay = null;
    return result;
  }
  function reset(input) {
    assertRequest(input);
    if (Object.keys(input).sort().join(',') !== 'confirmation,generation,kind,requestId')
      invalid('清空请求无效');
    const digest = digestOf({ kind: input.kind });
    const repeated = previousMaintenance(input, 'reset-ledger');
    if (repeated) return repeated;
    if (input.confirmation !== RESET_CONFIRMATION) invalid('请输入完整确认文字“清空当前账本”');
    assertGeneration(input);
    const safety = empty() ? null : backup('reset');
    let result;
    db.transaction(() => {
      for (const table of [...schema.TABLES].reverse())
        if (table.name !== 'meta') db.exec(`DELETE FROM ${table.name}`);
      result = finishMaintenance(input, 'reset-ledger', digest, {
        reset: true,
        completed: true,
        backup: safety ? safety.name : null,
        backupDirectory: safety ? safety.directory : null,
      });
      schema.checkLedger(db);
    }).immediate();
    backups.removeUnusedScreenshots(db, attachmentsDir);
    for (const token of [...plans.keys()]) discardPlan(token);
    backupResults.clear();
    return result;
  }

  async function handle(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('请求无效');
    switch (input.kind) {
      case 'read':
        return ledger.read();
      case 'attachment':
        return ledger.command({ kind: 'attachment', id: input.id });
      case 'maintenance-info':
        return information();
      case 'create-backup':
        return createManualBackup(input);
      case 'prepare-restore':
        return prepareRestore(input);
      case 'restore-backup':
        return restore(input);
      case 'reset-ledger':
        return reset(input);
      default: {
        assertGeneration(input);
        const { generation: _ignored, ...save } = input;
        const result = await ledger.command(save);
        automaticBackup();
        return result;
      }
    }
  }
  function command(input) {
    if (closing) return Promise.reject(Object.assign(Error('账本正在关闭'), { status: 409 }));
    const run = queue.then(() => handle(input));
    queue = run.catch(() => {});
    return run;
  }
  function close() {
    if (closed) return Promise.resolve();
    closing = true;
    return queue.then(() => {
      if (closed) return;
      for (const token of [...plans.keys()]) discardPlan(token);
      ledger.close();
      closed = true;
    });
  }

  automaticBackup();
  return {
    command,
    close,
    layout,
    get ledger() {
      return ledger;
    },
  };
}

module.exports = {
  openLedgerService,
  RESET_CONFIRMATION,
  RESTORE_CONFIRMATION,
  KEEP_AUTOMATIC_BACKUPS,
};
