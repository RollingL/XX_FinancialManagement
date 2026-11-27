const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const { createManagedLedger } = require('../spike/managed-ledger.cjs');
const { verifyBackup } = require('../spike/ledger-backup.cjs');
const { syntheticPng } = require('./synthetic-image.cjs');
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-restore-ui-'))),
    root = path.join(parent, 'ledger');
  let ledger;
  const open = () => (ledger = createManagedLedger(root, { backupDestination: parent }));
  t.after(async () => {
    await ledger?.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return { root, parent, open };
}
async function advance(ledger, amount) {
  const state = await ledger.command({ kind: 'read' });
  return ledger.command({
    kind: 'advance',
    requestId: randomUUID(),
    generation: state.generation,
    advance: { amount, date: '2026-10-13', note: 'synthetic' },
  });
}
async function backup(ledger) {
  const state = await ledger.command({ kind: 'read' });
  return ledger.command({
    kind: 'create-backup',
    requestId: randomUUID(),
    generation: state.generation,
  });
}
async function plan(ledger, saved) {
  const state = await ledger.command({ kind: 'read' });
  return ledger.command({
    kind: 'prepare-restore',
    generation: state.generation,
    backup: saved.directory,
  });
}
test('restore previews, backs up current facts, switches identity, rejects stale drafts and retries after reopen', async (t) => {
  const f = fixture(t);
  let ledger = f.open();
  await advance(ledger, 101);
  const saved = await backup(ledger);
  const current = await advance(ledger, 202),
    preview = await plan(ledger, saved);
  assert.equal(preview.summary.totalAdvanceCents, '101');
  const input = {
    kind: 'restore-backup',
    requestId: randomUUID(),
    token: preview.token,
    generation: preview.generation,
    confirmation: '恢复备份',
  };
  const result = await ledger.command(input);
  assert.equal(result.completed, true);
  assert.notEqual(result.generation, current.generation);
  const restoredRoot = ledger.root;
  const { warning, ...receipt } = result;
  if (warning) assert.match(warning, /持久化未确认|原连接关闭未确认/);
  assert.equal(verifyBackup(result.backupDirectory).summary.totalAdvanceCents, '303');
  assert.deepEqual((await ledger.command({ kind: 'read' })).advances, [101]);
  await assert.rejects(
    ledger.command({
      kind: 'advance',
      requestId: randomUUID(),
      generation: current.generation,
      advance: { amount: 1, date: '2026-10-13', note: '' },
    }),
    /代际已变化/,
  );
  assert.deepEqual(await ledger.command(input), receipt);
  await assert.rejects(
    ledger.command({ ...input, generation: result.generation }),
    /原确认内容不一致/,
  );
  await ledger.close();
  ledger = f.open();
  assert.equal(ledger.root, restoredRoot);
  assert.deepEqual(await ledger.command(input), receipt);
  await assert.rejects(
    ledger.command({ ...input, generation: result.generation }),
    /原确认内容不一致/,
  );
  await advance(ledger, 303);
  assert.deepEqual((await ledger.command({ kind: 'read' })).advances, [101, 303]);
  assert.deepEqual(await ledger.command(input), receipt);
  await ledger.close();
});
test('stale state/source, wrong confirmation, and foreign token leave current ledger unchanged', async (t) => {
  const f = fixture(t),
    ledger = f.open();
  await advance(ledger, 100);
  const saved = await backup(ledger),
    preview = await plan(ledger, saved),
    input = {
      kind: 'restore-backup',
      requestId: randomUUID(),
      token: preview.token,
      generation: preview.generation,
      confirmation: '恢复备份',
    };
  await assert.rejects(ledger.command({ ...input, confirmation: '恢复' }), /确认文字/);
  await assert.rejects(ledger.command({ ...input, token: randomUUID() }), /预览已失效/);
  const current = await advance(ledger, 200);
  await assert.rejects(ledger.command(input), /账本已变化/);
  assert.deepEqual(await ledger.command({ kind: 'read' }), current);
  const next = await plan(ledger, saved);
  fs.appendFileSync(path.join(saved.directory, 'manifest.json'), ' ');
  await assert.rejects(ledger.command({ ...input, token: next.token }), /哈希/);
  assert.deepEqual(await ledger.command({ kind: 'read' }), current);
  assert.equal(fs.existsSync(path.join(f.root, 'active-ledger.json')), false);
});
test('failed pointer publication preserves original ledger and complete pre-restore backup', async (t) => {
  const f = fixture(t),
    ledger = f.open();
  await advance(ledger, 100);
  const saved = await backup(ledger),
    current = await advance(ledger, 200),
    preview = await plan(ledger, saved),
    original = fs.renameSync;
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (to === path.join(f.root, 'active-ledger.json')) throw Error('synthetic pointer failure');
    return original.call(this, from, to);
  });
  await assert.rejects(
    ledger.command({
      kind: 'restore-backup',
      requestId: randomUUID(),
      token: preview.token,
      generation: preview.generation,
      confirmation: '恢复备份',
    }),
    /synthetic pointer failure/,
  );
  assert.deepEqual(await ledger.command({ kind: 'read' }), current);
  assert.equal(ledger.root, f.root);
  assert.equal(fs.existsSync(path.join(f.root, 'active-ledger.json')), false);
  const backups = fs
    .readdirSync(f.parent)
    .filter((name) => name.startsWith('backup-'))
    .map((name) => verifyBackup(path.join(f.parent, name)));
  assert.ok(backups.some((item) => item.summary.totalAdvanceCents === '300'));
});
test('tampered restore pointer cannot adopt unrelated or unmarked roots', async (t) => {
  const f = fixture(t),
    ledger = f.open();
  await ledger.close();
  fs.writeFileSync(
    path.join(f.root, 'active-ledger.json'),
    JSON.stringify({ version: 1, directory: '../other', ledgerId: randomUUID(), receipt: {} }),
  );
  assert.throws(() => f.open(), /恢复入口标识无效/);
  assert.equal(fs.existsSync(path.join(f.root, '.writer-lock')), false);
});

test('restore initialization failure closes its candidate connection and preserves the current ledger on reopen', async (t) => {
  const f = fixture(t);
  let ledger = f.open();
  await advance(ledger, 101);
  const saved = await backup(ledger),
    current = await advance(ledger, 202),
    preview = await plan(ledger, saved),
    pragma = Database.prototype.pragma;
  let candidate;
  const injected = t.mock.method(Database.prototype, 'pragma', function (sql, ...args) {
    if (
      !this.readonly &&
      path.basename(path.dirname(this.name)).startsWith('restored-') &&
      sql === 'journal_mode = WAL'
    ) {
      candidate = this;
      throw Error('synthetic candidate initialization failure');
    }
    return pragma.call(this, sql, ...args);
  });
  await assert.rejects(
    ledger.command({
      kind: 'restore-backup',
      requestId: randomUUID(),
      token: preview.token,
      generation: preview.generation,
      confirmation: '恢复备份',
    }),
    (error) =>
      /synthetic candidate initialization failure/.test(error.message) &&
      /恢复前完整备份/.test(error.message),
  );
  assert.equal(candidate.open, false);
  assert.equal(fs.existsSync(path.join(path.dirname(candidate.name), '.writer-lock')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'active-ledger.json')), false);
  assert.deepEqual(await ledger.command({ kind: 'read' }), current);
  injected.mock.restore();
  await ledger.close();
  ledger = f.open();
  assert.deepEqual(await ledger.command({ kind: 'read' }), current);
  assert.equal(ledger.root, f.root);
});

test('restore retains a failed old connection for close before any ledger lock is released', async (t) => {
  const f = fixture(t),
    ledger = f.open();
  await advance(ledger, 101);
  const saved = await backup(ledger);
  await advance(ledger, 202);
  const preview = await plan(ledger, saved),
    close = Database.prototype.close;
  let retained,
    attempts = 0;
  t.mock.method(Database.prototype, 'close', function (...args) {
    if (!this.readonly && this.name === path.join(f.root, 'trial.sqlite')) {
      attempts++;
      if (attempts === 1) {
        retained = this;
        throw Error('synthetic old connection close failure');
      }
    }
    return close.call(this, ...args);
  });
  const result = await ledger.command({
    kind: 'restore-backup',
    requestId: randomUUID(),
    token: preview.token,
    generation: preview.generation,
    confirmation: '恢复备份',
  });
  assert.equal(result.completed, true);
  assert.match(result.warning, /原连接关闭未确认/);
  assert.equal(retained.open, true);
  assert.deepEqual((await ledger.command({ kind: 'read' })).advances, [101]);
  assert.equal(fs.existsSync(path.join(f.root, '.writer-lock')), true);
  assert.equal(fs.existsSync(path.join(ledger.root, '.writer-lock')), true);
  await ledger.close();
  assert.equal(attempts, 2);
  assert.equal(retained.open, false);
  assert.equal(fs.existsSync(path.join(f.root, '.writer-lock')), false);
  assert.equal(fs.existsSync(path.join(ledger.root, '.writer-lock')), false);
});

test('a failed candidate preparation close retains its lock until exit retries the connection', async (t) => {
  const f = fixture(t),
    ledger = f.open();
  await advance(ledger, 101);
  const saved = await backup(ledger),
    current = await advance(ledger, 202),
    preview = await plan(ledger, saved),
    close = Database.prototype.close;
  let retained,
    attempts = 0;
  const injected = t.mock.method(Database.prototype, 'close', function (...args) {
    if (
      !this.readonly &&
      path.basename(this.name) === 'trial.sqlite' &&
      path.basename(path.dirname(this.name)).startsWith('restored-') &&
      fs.existsSync(path.join(path.dirname(this.name), '.writer-lock'))
    ) {
      retained = this;
      attempts++;
      if (attempts <= 2) throw Error('synthetic candidate close failure');
    }
    return close.call(this, ...args);
  });
  await assert.rejects(
    ledger.command({
      kind: 'restore-backup',
      requestId: randomUUID(),
      token: preview.token,
      generation: preview.generation,
      confirmation: '恢复备份',
    }),
    /候选连接关闭未确认/,
  );
  assert.equal(retained.open, true);
  assert.deepEqual(await ledger.command({ kind: 'read' }), current);
  assert.equal(fs.existsSync(path.join(f.root, 'active-ledger.json')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(retained.name), '.writer-lock')), true);
  await ledger.close();
  assert.equal(retained.open, false);
  assert.equal(fs.existsSync(path.join(path.dirname(retained.name), '.writer-lock')), false);
  injected.mock.restore();
});

test('restored state retains both reminder values, attachments and histories across the original upgrade entry', async (t) => {
  const parent = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-upgrade-reminder-')),
    ),
    root = path.join(parent, 'ledger');
  let ledger = createManagedLedger(root, { backupDestination: parent });
  t.after(async () => {
    await ledger.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const send = async (body) =>
    ledger.command({
      requestId: randomUUID(),
      generation: (await ledger.command({ kind: 'read' })).generation,
      ...body,
    });
  const image = { base64: syntheticPng({ seed: 1 }).toString('base64') };
  await advance(ledger, 101);
  for (const category of ['接待', '办公'])
    await send({
      kind: 'expense',
      expense: { category, amount: 200, date: '2026-10-16', merchant: '合成' + category, note: '' },
      image,
    });
  for (const [id, value] of [
    [1, true],
    [2, true],
    [2, false],
  ]) {
    const s = await ledger.command({ kind: 'read' });
    await send({
      kind: 'set-invoice-issued',
      id,
      expected: s.expenses.find((e) => e.id === id),
      expectedRevision: (s.expenseEvents ?? []).filter((e) => e.expenseId === id).length,
      invoiceIssued: value,
    });
  }
  await send({
    kind: 'batch',
    date: '2026-10-16',
    allocations: [
      { expenseId: 1, amount: 1 },
      { expenseId: 2, amount: 99 },
    ],
  });
  const original = await ledger.command({ kind: 'read' }),
    saved = await backup(ledger),
    attachments = original.expenses.map((e) => e.attachmentId),
    bytes = [];
  for (const id of attachments) bytes.push(await send({ kind: 'attachment', id }));
  const afterBackup = await advance(ledger, 202),
    preview = await plan(ledger, saved),
    result = await ledger.command({
      kind: 'restore-backup',
      requestId: randomUUID(),
      token: preview.token,
      generation: preview.generation,
      confirmation: '恢复备份',
    }),
    active = ledger.root;
  assert.deepEqual(
    { ...(await ledger.command({ kind: 'read' })), generation: original.generation },
    original,
  );
  assert.equal(verifyBackup(result.backupDirectory).summary.totalAdvanceCents, '303');
  for (let restart = 0; restart < 2; restart++) {
    await ledger.close();
    ledger = createManagedLedger(root, { backupDestination: parent });
    assert.equal(ledger.root, active);
    assert.deepEqual(
      { ...(await ledger.command({ kind: 'read' })), generation: original.generation },
      original,
    );
    const currentBytes = [];
    for (const id of attachments) currentBytes.push(await send({ kind: 'attachment', id }));
    assert.deepEqual(currentBytes, bytes);
  }
  const preserved = new Database(path.join(root, 'trial.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    assert.deepEqual(
      {
        ...JSON.parse(preserved.prepare('SELECT json FROM trial_state').get().json),
        generation: afterBackup.generation,
      },
      afterBackup,
    );
  } finally {
    preserved.close();
  }
});
