'use strict';
// The ledger: one SQLite file (qianlai.sqlite) plus a folder of screenshots (截图/).
// Every bookkeeping rule for saving is checked here. Each save is one transaction and
// returns the whole ledger, in the shape the screens expect (see src/renderer/ledger.ts).
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const Database = require('better-sqlite3');
const { checkImage, MAX_IMAGE_BYTES } = require('./image-check.cjs');
const schema = require('./ledger-schema.cjs');

const REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CATEGORIES = ['接待', '办公'];
const SAVE_KINDS = [
  'expense',
  'correct-expense',
  'delete-expense',
  'set-invoice-issued',
  'advance',
  'correct-advance',
  'delete-advance',
  'batch',
  'cancel',
  'delete-batch',
];

const fail = (message) => {
  throw Object.assign(Error(message), { status: 422 });
};
function amount(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('金额须为安全范围内的正整数分');
  return value;
}
function total(values) {
  const sum = values.reduce((a, b) => a + BigInt(b), 0n);
  if (sum > BigInt(schema.MAX_CENTS)) fail('金额合计超出安全范围');
  return Number(sum);
}
function text(value, max, required = true) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    fail('文本字段无效');
  return value.trim();
}
function date(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    fail('日期无效');
  return value;
}
function exactKeys(value, keys, message) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    fail(message);
}
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const digestOf = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

// ---- Turning rows into the shapes the screens use ----

function expenseView(row) {
  return {
    id: row.id,
    category: row.category,
    date: row.date,
    merchant: row.merchant,
    amount: row.amount,
    note: row.note,
    invoiceIssued: row.invoice_issued === 1,
    ...(row.attachment_id ? { attachmentId: row.attachment_id } : {}),
  };
}
function advanceDetailsView(row) {
  return {
    date: row.date,
    note: row.note,
    createdAt: row.created_at,
    ...(row.attachment_id ? { attachmentId: row.attachment_id } : {}),
  };
}
const advanceSnapshot = (row) => ({ amount: row.amount, details: advanceDetailsView(row) });

function createQueries(db) {
  const q = (sql) => db.prepare(sql);
  return {
    expenses: q('SELECT * FROM expenses WHERE deleted_at IS NULL ORDER BY id'),
    expense: q('SELECT * FROM expenses WHERE id = ? AND deleted_at IS NULL'),
    lastExpenseId: q('SELECT COALESCE(MAX(id), 0) id FROM expenses'),
    expenseTotal: q('SELECT amount FROM expenses WHERE deleted_at IS NULL'),
    insertExpense: q(`INSERT INTO expenses
      (id, category, date, merchant, amount, note, invoice_issued, attachment_id, created_at)
      VALUES (@id, @category, @date, @merchant, @amount, @note, 0, @attachmentId, @createdAt)`),
    updateExpense: q(`UPDATE expenses SET category = @category, date = @date,
      merchant = @merchant, amount = @amount, note = @note WHERE id = @id`),
    setInvoiceIssued: q('UPDATE expenses SET invoice_issued = ? WHERE id = ?'),
    deleteExpense: q('UPDATE expenses SET deleted_at = ? WHERE id = ?'),
    advances: q('SELECT * FROM advances ORDER BY id'),
    advance: q('SELECT * FROM advances WHERE id = ?'),
    advanceCount: q('SELECT COUNT(*) n FROM advances'),
    insertAdvance: q(`INSERT INTO advances (id, amount, date, note, attachment_id, created_at)
      VALUES (@id, @amount, @date, @note, @attachmentId, @createdAt)`),
    updateAdvance: q(
      'UPDATE advances SET amount = @amount, date = @date, note = @note WHERE id = @id',
    ),
    deleteAdvance: q('UPDATE advances SET amount = 0, deleted_at = ? WHERE id = ?'),
    batches: q('SELECT * FROM batches WHERE deleted_at IS NULL ORDER BY id'),
    batch: q('SELECT * FROM batches WHERE id = ? AND deleted_at IS NULL'),
    lastBatchId: q('SELECT COALESCE(MAX(id), 0) id FROM batches'),
    insertBatch: q('INSERT INTO batches (id, date, created_at) VALUES (?, ?, ?)'),
    cancelBatch: q('UPDATE batches SET cancelled_at = ? WHERE id = ?'),
    deleteBatch: q('UPDATE batches SET deleted_at = ? WHERE id = ?'),
    allocations: q('SELECT * FROM allocations ORDER BY batch_id, position'),
    batchAllocations: q('SELECT * FROM allocations WHERE batch_id = ? ORDER BY position'),
    insertAllocation: q(
      'INSERT INTO allocations (batch_id, position, expense_id, amount) VALUES (?, ?, ?, ?)',
    ),
    reimbursed: q(`SELECT COALESCE(SUM(a.amount), 0) total FROM allocations a
      JOIN batches b ON b.id = a.batch_id AND b.cancelled_at IS NULL AND b.deleted_at IS NULL
      WHERE a.expense_id = ?`),
    events: q('SELECT * FROM events ORDER BY seq'),
    revision: q('SELECT COUNT(*) n FROM events WHERE record_type = ? AND record_id = ?'),
    insertEvent: q(`INSERT INTO events
      (request_id, action, record_type, record_id, revision, at, before, after)
      VALUES (@requestId, @action, @type, @id, @revision, @at, @before, @after)`),
    attachment: q('SELECT * FROM attachments WHERE id = ?'),
    insertAttachment: q(`INSERT INTO attachments (id, file, mime, size, sha256, created_at)
      VALUES (@id, @file, @mime, @size, @sha256, @createdAt)`),
    operation: q('SELECT digest FROM operations WHERE request_id = ?'),
    insertOperation: q(
      'INSERT INTO operations (request_id, digest, kind, created_at) VALUES (?, ?, ?, ?)',
    ),
    generation: q("SELECT value FROM meta WHERE key = 'generation'"),
  };
}

function buildView(q) {
  const advances = q.advances.all(),
    allocations = new Map();
  for (const row of q.allocations.all()) {
    if (!allocations.has(row.batch_id)) allocations.set(row.batch_id, []);
    allocations.get(row.batch_id).push({ expenseId: row.expense_id, amount: row.amount });
  }
  const expenseEvents = [],
    advanceEvents = [],
    batchEvents = [];
  for (const event of q.events.all()) {
    const common = { requestId: event.request_id, action: event.action, at: event.at },
      before = JSON.parse(event.before),
      after = event.after === null ? null : JSON.parse(event.after);
    if (event.record_type === 'expense')
      expenseEvents.push({
        ...common,
        expenseId: event.record_id,
        revision: event.revision,
        before,
        after,
      });
    else if (event.record_type === 'advance')
      advanceEvents.push({
        ...common,
        advanceId: event.record_id,
        revision: event.revision,
        before,
        after,
      });
    else if (event.action === 'delete-batch')
      batchEvents.push({ ...common, batchId: event.record_id, before, after });
  }
  return {
    expenses: q.expenses.all().map(expenseView),
    batches: q.batches.all().map((row) => ({
      id: row.id,
      date: row.date,
      active: row.cancelled_at === null,
      allocations: allocations.get(row.id) ?? [],
    })),
    advances: advances.map((row) => row.amount),
    advanceDetails: Object.fromEntries(
      advances.map((row) => [
        row.id,
        { ...advanceDetailsView(row), ...(row.deleted_at ? { deleted: true } : {}) },
      ]),
    ),
    expenseEvents,
    advanceEvents,
    batchEvents,
    generation: q.generation.get().value,
  };
}

// ---- Saving ----

function validateNewRecord(input) {
  if (input.kind === 'expense') {
    const e = input.expense;
    if (!e || !CATEGORIES.includes(e.category)) fail('费用类别无效');
    date(e.date);
    text(e.merchant, 100);
    text(e.note, 500, false);
    amount(e.amount);
  } else if (input.kind === 'advance') {
    const a = input.advance;
    if (!a || typeof a !== 'object') fail('预支到账记录无效');
    amount(a.amount);
    date(a.date);
    text(a.note ?? '', 500, false);
  }
}
function validateRequest(input) {
  if (
    !SAVE_KINDS.includes(input.kind) ||
    typeof input.requestId !== 'string' ||
    !REQUEST_ID.test(input.requestId)
  )
    fail('保存请求无效');
  if (Object.hasOwn(input, 'invoiceLinks')) fail('发票管理已停用，请刷新页面后重新登记报销');
  if (input.kind === 'delete-batch' && (!Number.isSafeInteger(input.id) || input.id <= 0))
    fail('批次编号无效');
  validateNewRecord(input);
  if (['expense', 'advance'].includes(input.kind) && input.image) {
    if (
      typeof input.image.base64 !== 'string' ||
      input.image.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(input.image.base64)
    )
      fail('附件无效');
  }
}

// The screenshot is written and flushed before the transaction; if the transaction
// fails the caller removes the file again, so no half-saved record keeps a picture.
function writeAttachment(attachmentsDir, base64, createdAt) {
  const bytes = Buffer.from(base64, 'base64'),
    { suffix, mime } = checkImage(bytes),
    id = randomUUID(),
    file = id + suffix,
    target = path.join(attachmentsDir, file);
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return {
    path: target,
    row: {
      id,
      file,
      mime,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      createdAt,
    },
  };
}

function createWriters(q) {
  const revisionOf = (type, id) => q.revision.get(type, id).n;
  const reimbursedOf = (expenseId) => q.reimbursed.get(expenseId).total;
  function recordEvent(input, type, id, revision, at, before, after) {
    q.insertEvent.run({
      requestId: input.requestId,
      action: input.kind === 'cancel' ? 'cancel-batch' : input.kind,
      type,
      id,
      revision,
      at,
      before: JSON.stringify(before),
      after: after === null ? null : JSON.stringify(after),
    });
  }
  function checkedExpense(input) {
    const row = q.expense.get(input.id);
    if (!row) fail('费用不存在');
    const current = expenseView(row),
      revision = revisionOf('expense', input.id);
    if (revision !== input.expectedRevision || !isDeepStrictEqual(current, input.expected))
      fail('费用已变化，请刷新后重新核对');
    return { current, revision };
  }

  return {
    expense(input, at, attachment) {
      const e = input.expense;
      total([...q.expenseTotal.all().map((row) => row.amount), e.amount]);
      const id = q.lastExpenseId.get().id + 1;
      if (!Number.isSafeInteger(id)) fail('费用编号超出安全范围');
      q.insertExpense.run({
        id,
        category: e.category,
        date: e.date,
        merchant: e.merchant.trim(),
        amount: e.amount,
        note: e.note.trim(),
        attachmentId: attachment?.id ?? null,
        createdAt: at,
      });
    },
    advance(input, at, attachment) {
      const a = input.advance,
        value = amount(a.amount);
      total([...q.advances.all().map((row) => row.amount), value]);
      q.insertAdvance.run({
        id: q.advanceCount.get().n,
        amount: value,
        date: date(a.date),
        note: text(a.note ?? '', 500, false),
        attachmentId: attachment?.id ?? null,
        createdAt: at,
      });
    },
    'correct-advance': (input, at) => changeAdvance(input, at, true),
    'delete-advance': (input, at) => changeAdvance(input, at, false),
    'set-invoice-issued'(input, at) {
      exactKeys(
        input,
        ['expected', 'expectedRevision', 'id', 'invoiceIssued', 'kind', 'requestId'],
        '开票提醒保存请求无效',
      );
      if (
        !Number.isSafeInteger(input.id) ||
        input.id <= 0 ||
        !isCount(input.expectedRevision) ||
        typeof input.invoiceIssued !== 'boolean'
      )
        fail('开票提醒保存请求无效');
      const { current, revision } = checkedExpense(input);
      if (current.invoiceIssued === input.invoiceIssued) fail('开票提醒没有变化');
      q.setInvoiceIssued.run(input.invoiceIssued ? 1 : 0, input.id);
      const after = { ...current, invoiceIssued: input.invoiceIssued };
      recordEvent(input, 'expense', input.id, revision + 1, at, current, after);
    },
    'correct-expense': (input, at) => changeExpense(input, at, true),
    'delete-expense': (input, at) => changeExpense(input, at, false),
    batch(input, at) {
      date(input.date);
      const expenses = q.expenses.all();
      if (
        !Array.isArray(input.allocations) ||
        !input.allocations.length ||
        input.allocations.length > expenses.length
      )
        fail('分配无效');
      const seen = new Set();
      for (const row of input.allocations) {
        const expense = expenses.find((e) => e.id === row?.expenseId);
        if (!expense || seen.has(row.expenseId)) fail('费用不存在或重复分配');
        seen.add(row.expenseId);
        amount(row.amount);
        if (row.amount > expense.amount - reimbursedOf(expense.id))
          fail('分配超过当前待报销额，请刷新后重试');
      }
      total(input.allocations.map((row) => row.amount));
      const id = q.lastBatchId.get().id + 1;
      if (!Number.isSafeInteger(id)) fail('批次编号超出安全范围');
      q.insertBatch.run(id, input.date, at);
      input.allocations.forEach((row, position) =>
        q.insertAllocation.run(id, position, row.expenseId, row.amount),
      );
    },
    cancel(input, at) {
      const batch = q.batch.get(input.id);
      if (!batch) fail('批次不存在');
      // Cancelling an already cancelled batch changes nothing; the request is still recorded.
      if (batch.cancelled_at !== null) return;
      q.cancelBatch.run(at, batch.id);
      const before = batchSnapshot(batch);
      recordEvent(input, 'batch', batch.id, revisionOf('batch', batch.id) + 1, at, before, {
        ...before,
        active: false,
      });
    },
    'delete-batch'(input, at) {
      const batch = q.batch.get(input.id);
      if (!batch) fail('批次不存在');
      q.deleteBatch.run(at, batch.id);
      const revision = revisionOf('batch', batch.id) + 1;
      recordEvent(input, 'batch', batch.id, revision, at, batchSnapshot(batch), null);
    },
  };

  function batchSnapshot(row) {
    return {
      id: row.id,
      date: row.date,
      active: row.cancelled_at === null,
      allocations: q.batchAllocations
        .all(row.id)
        .map((item) => ({ expenseId: item.expense_id, amount: item.amount })),
    };
  }
  function changeAdvance(input, at, correction) {
    exactKeys(
      input,
      [
        ...(correction ? ['advance'] : []),
        'expected',
        'expectedAmount',
        'expectedRevision',
        'id',
        'kind',
        'requestId',
      ],
      '预支修改请求无效',
    );
    if (!isCount(input.id) || !isCount(input.expectedRevision)) fail('预支修改请求无效');
    const row = q.advance.get(input.id);
    if (!row || row.deleted_at !== null) fail('预支记录不存在或已删除');
    const current = advanceSnapshot(row),
      revision = revisionOf('advance', input.id);
    if (
      revision !== input.expectedRevision ||
      current.amount !== input.expectedAmount ||
      !isDeepStrictEqual(current.details, input.expected)
    )
      fail('预支记录已变化，请刷新后重新核对');
    let after = null;
    if (correction) {
      exactKeys(input.advance, ['amount', 'date', 'note'], '预支修改字段无效');
      const a = input.advance;
      after = {
        amount: amount(a.amount),
        details: { ...current.details, date: date(a.date), note: text(a.note, 500, false) },
      };
      total(q.advances.all().map((item) => (item.id === row.id ? after.amount : item.amount)));
      if (isDeepStrictEqual(current, after)) fail('预支内容没有变化');
      q.updateAdvance.run({
        id: row.id,
        amount: after.amount,
        date: after.details.date,
        note: after.details.note,
      });
    } else q.deleteAdvance.run(at, row.id);
    recordEvent(input, 'advance', row.id, revision + 1, at, current, after);
  }
  function changeExpense(input, at, correction) {
    exactKeys(
      input,
      [
        ...(correction ? ['expense'] : []),
        'expected',
        'expectedRevision',
        'id',
        'kind',
        'requestId',
      ],
      '费用纠错请求无效',
    );
    if (!Number.isSafeInteger(input.id) || input.id <= 0 || !isCount(input.expectedRevision))
      fail('费用纠错请求无效');
    const { current, revision } = checkedExpense(input),
      paid = reimbursedOf(input.id);
    if (!correction) {
      if (paid > 0) fail('费用仍有有效报销分配，请先撤销对应报销批次');
      q.deleteExpense.run(at, input.id);
      recordEvent(input, 'expense', input.id, revision + 1, at, current, null);
      return;
    }
    const e = input.expense;
    if (
      !e ||
      typeof e !== 'object' ||
      Array.isArray(e) ||
      Object.keys(e).sort().join(',') !== 'amount,category,date,merchant,note' ||
      !CATEGORIES.includes(e.category)
    )
      fail('费用纠错字段无效，不能替换附件或添加其他业务字段');
    const after = {
      ...current,
      category: e.category,
      date: date(e.date),
      merchant: text(e.merchant, 100),
      amount: amount(e.amount),
      note: text(e.note, 500, false),
    };
    if (after.amount < paid) fail('费用金额不能小于当前有效报销金额');
    total(q.expenses.all().map((row) => (row.id === input.id ? after.amount : row.amount)));
    if (isDeepStrictEqual(current, after)) fail('费用内容没有变化');
    q.updateExpense.run({
      id: after.id,
      category: after.category,
      date: after.date,
      merchant: after.merchant,
      amount: after.amount,
      note: after.note,
    });
    recordEvent(input, 'expense', input.id, revision + 1, at, current, after);
  }
}

// Opens (or creates) the ledger in dataDir and keeps it locked until close().
// beforeUpgrade(db, fromVersion) runs before an older format is upgraded, so the
// caller can make a backup first.
function openLedger(dataDir, { beforeUpgrade, now = () => new Date() } = {}) {
  schema.plainDirectory(dataDir, true);
  const files = schema.ledgerFiles(dataDir);
  schema.plainDirectory(files.attachments, true);
  const db = new Database(files.database, { timeout: 1000 });
  let prepared;
  try {
    schema.lockDatabase(db);
    prepared = schema.prepareDatabase(db, {
      create: true,
      identity: () => ({
        ledgerId: randomUUID(),
        generation: randomUUID(),
        createdAt: now().toISOString(),
      }),
      beforeUpgrade: beforeUpgrade && ((from) => beforeUpgrade(db, from)),
    });
    schema.checkLedger(db);
  } catch (error) {
    db.close();
    throw schema.damagedFileError(error);
  }
  const q = createQueries(db),
    writers = createWriters(q),
    read = () => buildView(q);

  function readAttachment(id) {
    if (typeof id !== 'string') fail('附件编号无效');
    const record = q.attachment.get(id);
    if (!record) fail('附件不存在');
    let bytes;
    try {
      bytes = fs.readFileSync(path.join(files.attachments, record.file));
    } catch {
      fail('附件文件找不到了，请检查备份');
    }
    if (
      bytes.length !== record.size ||
      createHash('sha256').update(bytes).digest('hex') !== record.sha256
    )
      fail('附件损坏，请保留现有数据并检查备份');
    return { mime: record.mime, base64: bytes.toString('base64') };
  }

  function save(input) {
    validateRequest(input);
    const digest = digestOf(input),
      previous = q.operation.get(input.requestId);
    if (previous) {
      if (previous.digest !== digest) fail('重复请求内容不一致，请重新打开面板');
      return read();
    }
    const at = now().toISOString();
    let attachment;
    if (['expense', 'advance'].includes(input.kind) && input.image)
      attachment = writeAttachment(files.attachments, input.image.base64, at);
    try {
      return db
        .transaction(() => {
          if (attachment) q.insertAttachment.run(attachment.row);
          writers[input.kind](input, at, attachment?.row);
          q.insertOperation.run(input.requestId, digest, input.kind, at);
          return read();
        })
        .immediate();
    } catch (error) {
      if (attachment) fs.rmSync(attachment.path, { force: true });
      throw error;
    }
  }

  // Saves run start to finish without waiting, so two saves can never interleave.
  async function command(input) {
    if (!input || typeof input !== 'object') fail('请求无效');
    if (input.kind === 'read') return read();
    if (input.kind === 'attachment') return readAttachment(input.id);
    return save(input);
  }

  return {
    command,
    read,
    database: db,
    dataDir,
    files,
    created: prepared.created,
    upgradedFrom: prepared.upgradedFrom,
    generation: () => q.generation.get().value,
    close: () => db.close(),
  };
}

// Browser development mode only: serves POST /api/ledger to the local Vite page.
function ledgerMiddleware(ledger, origin) {
  return async (req, res, next) => {
    if (req.url !== '/api/ledger') {
      next();
      return;
    }
    const send = (status, value) => {
      if (!res.destroyed) {
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify(value));
      }
    };
    if (
      req.method !== 'POST' ||
      req.headers.host !== new URL(origin).host ||
      req.headers.origin !== origin ||
      req.headers['x-ledger-request'] !== '1' ||
      req.headers['content-type'] !== 'application/json'
    ) {
      send(403, { error: '只允许本机开发页面访问账本' });
      return;
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES * 1.4 + 8192) fail('请求过大');
        chunks.push(chunk);
      }
      const result = await ledger.command(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      send(200, result);
    } catch (e) {
      send(e.status || 500, { error: e.status ? e.message : '本地读写失败，请保留表单并重试' });
    }
  };
}

module.exports = { openLedger, ledgerMiddleware };
