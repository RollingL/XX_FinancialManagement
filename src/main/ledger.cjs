// The ledger: one SQLite file plus an attachments folder, one writer at a time.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const Database = require('better-sqlite3');
const { checkImage, MAX_IMAGE_BYTES } = require('./image-check.cjs');
const fail = (message) => {
  throw Object.assign(Error(message), { status: 422 });
};
function amount(n) {
  if (!Number.isSafeInteger(n) || n <= 0) fail('金额须为安全范围内的正整数分');
  return n;
}
function advanceAmount(state, n, index) {
  if (n === 0 && state.advanceDetails?.[index]?.deleted === true) return 0;
  return amount(n);
}
function total(values) {
  const n = values.reduce((a, b) => a + BigInt(b), 0n);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) fail('金额合计超出安全范围');
  return Number(n);
}
function text(s, max, required = true) {
  if (typeof s !== 'string' || s.length > max || (required && !s.trim())) fail('文本字段无效');
  return s.trim();
}
function date(s) {
  if (
    typeof s !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s).toISOString().slice(0, 10) !== s
  )
    fail('日期无效');
  return s;
}
function batchEvents(state) {
  const events = state.batchEvents === undefined ? [] : state.batchEvents;
  if (!Array.isArray(events)) fail('现有批次操作历史无效，请保留账本');
  return events;
}
function createLedger(root, managedToken) {
  if (fs.lstatSync(path.join(root, 'managed-ledger.json'), { throwIfNoEntry: false })) {
    const lock = path.join(root, '.writer-lock'),
      ownerFile = path.join(lock, 'owner.json');
    try {
      const lockStat = fs.lstatSync(lock),
        ownerStat = fs.lstatSync(ownerFile);
      if (
        typeof managedToken !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          managedToken,
        ) ||
        !lockStat.isDirectory() ||
        lockStat.isSymbolicLink() ||
        !ownerStat.isFile() ||
        ownerStat.isSymbolicLink() ||
        ownerStat.size > 4096 ||
        JSON.parse(fs.readFileSync(ownerFile, 'utf8')).token !== managedToken
      )
        fail('受管账本只能通过持锁入口打开');
    } catch {
      fail('受管账本只能通过持锁入口打开，未修改账本');
    }
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const attachments = path.join(root, 'attachments');
  fs.mkdirSync(attachments, { recursive: true, mode: 0o700 });
  let db;
  try {
    db = new Database(path.join(root, 'trial.sqlite'));
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.exec(`CREATE TABLE IF NOT EXISTS trial_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, file TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL);`);
    db.prepare('INSERT OR IGNORE INTO trial_state VALUES(1,?)').run(
      JSON.stringify({ expenses: [], batches: [], advances: [] }),
    );
  } catch (error) {
    try {
      if (db?.open) db.close();
      error.uncertainConnection = false;
    } catch (closeError) {
      error.uncertainConnection = true;
      error.message += '；初始化连接关闭未确认：' + closeError.message;
    }
    throw error;
  }
  const read = () => JSON.parse(db.prepare('SELECT json FROM trial_state WHERE id=1').get().json);
  let busy = false;
  async function command(input) {
    if (!input || typeof input !== 'object') fail('请求无效');
    if (input.kind === 'maintenance-info')
      return { supported: false, backupConfigured: false, canReset: false };
    if (input.kind === 'read') return read();
    if (input.kind === 'attachment') {
      if (typeof input.id !== 'string') fail('附件编号无效');
      const record = db.prepare('SELECT * FROM attachments WHERE id=?').get(input.id);
      if (!record) fail('附件不存在');
      const bytes = fs.readFileSync(path.join(attachments, record.file));
      if (
        bytes.length !== record.size ||
        createHash('sha256').update(bytes).digest('hex') !== record.sha256
      )
        fail('附件损坏，请保留现有数据并检查备份');
      return { mime: record.mime, base64: bytes.toString('base64') };
    }
    if (busy) fail('正在保存，请稍后再试');
    busy = true;
    let savedFile,
      committed = false;
    try {
      if (
        ![
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
        ].includes(input.kind) ||
        typeof input.requestId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId)
      )
        fail('保存请求无效');
      if (Object.hasOwn(input, 'invoiceLinks')) fail('发票管理已停用，请刷新页面后重新登记报销');
      if (input.kind === 'delete-batch' && (!Number.isSafeInteger(input.id) || input.id <= 0))
        fail('批次编号无效');
      const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const previous = db.prepare('SELECT digest FROM operations WHERE id=?').get(input.requestId);
      if (previous) {
        if (previous.digest !== digest) fail('重复请求内容不一致，请重新打开面板');
        return read();
      }
      let attachment;
      if (input.kind === 'expense') {
        const e = input.expense;
        if (!e || !['接待', '办公'].includes(e.category)) fail('费用类别无效');
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
      if (['expense', 'advance'].includes(input.kind) && input.image) {
        if (
          typeof input.image.base64 !== 'string' ||
          input.image.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(input.image.base64)
        )
          fail('附件无效');
        const bytes = Buffer.from(input.image.base64, 'base64'),
          { suffix, mime } = checkImage(bytes);
        const id = randomUUID(),
          file = id + suffix;
        const fd = fs.openSync(path.join(attachments, file), 'wx', 0o600);
        savedFile = path.join(attachments, file);
        try {
          fs.writeFileSync(fd, bytes);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        attachment = {
          id,
          file,
          size: bytes.length,
          mime,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }
      const result = db
        .transaction(() => {
          const state = read(),
            createdAt = new Date().toISOString();
          if (input.kind === 'advance') {
            const a = input.advance;
            if (!a || typeof a !== 'object') fail('预支到账记录无效');
            const value = amount(a.amount),
              day = date(a.date),
              note = text(a.note ?? '', 500, false);
            if (!Array.isArray(state.advances)) fail('现有预支数据无效，请保留账本');
            total([...state.advances.map((n, index) => advanceAmount(state, n, index)), value]);
            const details = state.advanceDetails ?? {};
            if (
              typeof details !== 'object' ||
              Array.isArray(details) ||
              Object.hasOwn(details, state.advances.length)
            )
              fail('现有预支记录信息无效，请保留账本');
            // Amounts remain the single source of funds. Legacy entries are never rewritten or dated.
            state.advanceDetails = {
              ...details,
              [state.advances.length]: {
                date: day,
                note,
                createdAt,
                ...(attachment ? { attachmentId: attachment.id } : {}),
              },
            };
            state.advances.push(value);
          } else if (input.kind === 'expense') {
            const e = input.expense;
            total([...state.expenses.map((e) => e.amount), e.amount]);
            const id =
              Math.max(
                0,
                ...state.expenses.map((e) => e.id),
                ...(state.expenseEvents ?? []).map((event) => event.expenseId),
              ) + 1;
            if (!Number.isSafeInteger(id)) fail('费用编号超出安全范围');
            state.expenses.push({
              id,
              category: e.category,
              date: e.date,
              merchant: e.merchant.trim(),
              amount: e.amount,
              note: e.note.trim(),
              invoice: 0,
              ...(attachment ? { attachmentId: attachment.id } : {}),
            });
          } else if (['correct-advance', 'delete-advance'].includes(input.kind)) {
            const correction = input.kind === 'correct-advance',
              keys = correction
                ? 'advance,expected,expectedAmount,expectedRevision,id,kind,requestId'
                : 'expected,expectedAmount,expectedRevision,id,kind,requestId';
            if (
              Object.keys(input).sort().join(',') !== keys ||
              !Number.isSafeInteger(input.id) ||
              input.id < 0 ||
              !Number.isSafeInteger(input.expectedRevision) ||
              input.expectedRevision < 0
            )
              fail('预支修改请求无效');
            const id = input.id,
              events = state.advanceEvents ?? [],
              details = state.advanceDetails ?? {};
            if (
              !Array.isArray(events) ||
              !Array.isArray(state.advances) ||
              typeof details !== 'object' ||
              details === null ||
              Array.isArray(details)
            )
              fail('现有预支记录无效，请保留账本');
            if (id >= state.advances.length || details[id]?.deleted === true)
              fail('预支记录不存在或已删除');
            const current = { amount: amount(state.advances[id]), details: details[id] ?? null },
              revision = events.filter((event) => event.advanceId === id).length;
            if (
              revision !== input.expectedRevision ||
              current.amount !== input.expectedAmount ||
              !isDeepStrictEqual(current.details, input.expected)
            )
              fail('预支记录已变化，请刷新后重新核对');
            let after = null;
            if (correction) {
              const a = input.advance;
              if (
                !a ||
                typeof a !== 'object' ||
                Array.isArray(a) ||
                Object.keys(a).sort().join(',') !== 'amount,date,note'
              )
                fail('预支修改字段无效');
              after = {
                amount: amount(a.amount),
                details: {
                  ...(current.details ?? { createdAt }),
                  date: date(a.date),
                  note: text(a.note, 500, false),
                },
              };
              total(
                state.advances.map((n, index) =>
                  index === id ? after.amount : advanceAmount(state, n, index),
                ),
              );
              if (isDeepStrictEqual(current, after)) fail('预支内容没有变化');
              state.advances[id] = after.amount;
              state.advanceDetails = { ...details, [id]: after.details };
            } else {
              state.advances[id] = 0;
              state.advanceDetails = {
                ...details,
                [id]: { ...(current.details ?? {}), deleted: true },
              };
            }
            state.advanceEvents = [
              ...events,
              {
                requestId: input.requestId,
                action: input.kind,
                at: createdAt,
                advanceId: id,
                revision: revision + 1,
                before: structuredClone(current),
                after: after ? structuredClone(after) : null,
              },
            ];
          } else if (input.kind === 'set-invoice-issued') {
            if (
              Object.keys(input).sort().join(',') !==
                'expected,expectedRevision,id,invoiceIssued,kind,requestId' ||
              !Number.isSafeInteger(input.id) ||
              input.id <= 0 ||
              !Number.isSafeInteger(input.expectedRevision) ||
              input.expectedRevision < 0 ||
              typeof input.invoiceIssued !== 'boolean'
            )
              fail('开票提醒保存请求无效');
            const index = state.expenses.findIndex((e) => e.id === input.id);
            if (index < 0) fail('费用不存在');
            const current = state.expenses[index],
              events = state.expenseEvents ?? [];
            if (!Array.isArray(events)) fail('费用操作历史无效，请保留账本');
            const revision = events.filter((event) => event.expenseId === input.id).length;
            if (revision !== input.expectedRevision || !isDeepStrictEqual(current, input.expected))
              fail('费用已变化，请刷新后重新核对');
            if ((current.invoiceIssued === true) === input.invoiceIssued) fail('开票提醒没有变化');
            const after = { ...current, invoiceIssued: input.invoiceIssued };
            state.expenses[index] = after;
            state.expenseEvents = [
              ...events,
              {
                requestId: input.requestId,
                action: input.kind,
                at: createdAt,
                expenseId: input.id,
                revision: revision + 1,
                before: structuredClone(current),
                after: structuredClone(after),
              },
            ];
          } else if (['correct-expense', 'delete-expense'].includes(input.kind)) {
            if (
              Object.keys(input).sort().join(',') !==
                (input.kind === 'correct-expense'
                  ? 'expected,expectedRevision,expense,id,kind,requestId'
                  : 'expected,expectedRevision,id,kind,requestId') ||
              !Number.isSafeInteger(input.id) ||
              input.id <= 0 ||
              !Number.isSafeInteger(input.expectedRevision) ||
              input.expectedRevision < 0
            )
              fail('费用纠错请求无效');
            const index = state.expenses.findIndex((e) => e.id === input.id);
            if (index < 0) fail('费用不存在');
            const current = state.expenses[index],
              events = state.expenseEvents === undefined ? [] : state.expenseEvents;
            if (!Array.isArray(events)) fail('现有费用纠错历史无效，请保留账本');
            const revision = events.filter((event) => event.expenseId === input.id).length;
            if (revision !== input.expectedRevision || !isDeepStrictEqual(current, input.expected))
              fail('费用已变化，请刷新后重新核对');
            const paid = total(
              state.batches
                .filter((batch) => batch.active)
                .flatMap((batch) =>
                  batch.allocations
                    .filter((row) => row.expenseId === input.id)
                    .map((row) => row.amount),
                ),
            );
            if (input.kind === 'delete-expense') {
              if (paid > 0) fail('费用仍有有效报销分配，请先撤销对应报销批次');
              state.expenses.splice(index, 1);
              state.expenseEvents = [
                ...events,
                {
                  requestId: input.requestId,
                  action: 'delete-expense',
                  at: createdAt,
                  expenseId: input.id,
                  revision: revision + 1,
                  before: structuredClone(current),
                  after: null,
                },
              ];
              // Retired invoice data and associations remain unchanged for historical backups.
            } else {
              const e = input.expense;
              if (
                !e ||
                typeof e !== 'object' ||
                Array.isArray(e) ||
                Object.keys(e).sort().join(',') !== 'amount,category,date,merchant,note' ||
                !['接待', '办公'].includes(e.category)
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
              total(
                state.expenses.map((expense, position) =>
                  position === index ? after.amount : expense.amount,
                ),
              );
              if (isDeepStrictEqual(current, after)) fail('费用内容没有变化');
              state.expenses[index] = after;
              state.expenseEvents = [
                ...events,
                {
                  requestId: input.requestId,
                  action: 'correct-expense',
                  at: createdAt,
                  expenseId: input.id,
                  revision: revision + 1,
                  before: structuredClone(current),
                  after: structuredClone(after),
                },
              ];
            }
          } else if (input.kind === 'batch') {
            date(input.date);
            if (
              !Array.isArray(input.allocations) ||
              !input.allocations.length ||
              input.allocations.length > state.expenses.length
            )
              fail('分配无效');
            const seen = new Set();
            for (const a of input.allocations) {
              const e = state.expenses.find((e) => e.id === a.expenseId);
              if (!e || seen.has(a.expenseId)) fail('费用不存在或重复分配');
              seen.add(a.expenseId);
              amount(a.amount);
              const paid = total(
                state.batches
                  .filter((b) => b.active)
                  .flatMap((b) =>
                    b.allocations.filter((x) => x.expenseId === e.id).map((x) => x.amount),
                  ),
              );
              if (a.amount > e.amount - paid) fail('分配超过当前待报销额，请刷新后重试');
            }
            const allocations = input.allocations.map((a) => ({
              expenseId: a.expenseId,
              amount: a.amount,
            }));
            total(allocations.map((a) => a.amount));
            const id =
              Math.max(
                0,
                ...state.batches.map((b) => b.id),
                ...batchEvents(state).map((event) => event.batchId),
              ) + 1;
            if (!Number.isSafeInteger(id)) fail('批次编号超出安全范围');
            state.batches.push({ id, date: input.date, active: true, allocations });
          } else if (input.kind === 'cancel') {
            const batch = state.batches.find((b) => b.id === input.id);
            if (!batch) fail('批次不存在');
            batch.active = false;
          } else {
            const batch = state.batches.find((b) => b.id === input.id);
            if (!batch) fail('批次不存在');
            const events = batchEvents(state),
              before = structuredClone(batch);
            state.batches = state.batches.filter((item) => item.id !== batch.id);
            state.batchEvents = [
              ...events,
              {
                requestId: input.requestId,
                action: 'delete-batch',
                at: createdAt,
                batchId: batch.id,
                before,
                after: null,
              },
            ];
          }
          if (attachment)
            db.prepare('INSERT INTO attachments VALUES(@id,@file,@sha256,@size,@mime)').run(
              attachment,
            );
          db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(state));
          db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(
            input.requestId,
            digest,
            input.kind,
            createdAt,
          );
          return state;
        })
        .immediate();
      committed = true;
      return result;
    } finally {
      if (savedFile && !committed) fs.rmSync(savedFile, { force: true });
      busy = false;
    }
  }
  return { command, close: () => db.close() };
}
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
      send(403, { error: '只允许本机原型页面访问试用账本' });
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
module.exports = { createLedger, ledgerMiddleware };
