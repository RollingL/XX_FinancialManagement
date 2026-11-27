const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { randomUUID, createHash } = require('node:crypto');
const Database = require('better-sqlite3'),
  { createLedger } = require('../spike/trial-ledger.cjs');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOYVnECAAN+AdcpgjGUAAAAAElFTkSuQmCC',
  'base64',
);
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xx-expense-correction-')),
    service = { recognize: async () => ({ validated: true }) };
  let ledger = createLedger(root, service);
  const additional = [];
  t.after(() => {
    ledger.close();
    for (const item of additional) item.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const f = {
    root,
    get ledger() {
      return ledger;
    },
    reopen() {
      ledger.close();
      ledger = createLedger(root, service);
    },
    another() {
      const item = createLedger(root, service);
      additional.push(item);
      return item;
    },
    db(fn) {
      const db = new Database(path.join(root, 'trial.sqlite'));
      try {
        return fn(db);
      } finally {
        db.close();
      }
    },
  };
  for (const [amount, note] of [
    [10000, '合成预支'],
    [25, '合成补充款'],
  ])
    await ledger.command({
      kind: 'advance',
      requestId: randomUUID(),
      advance: { amount, date: '2026-10-01', note },
    });
  for (const [category, amount, merchant] of [
    ['接待', 30000, '合成接待甲'],
    ['办公', 20000, '合成办公乙'],
  ])
    await ledger.command({
      kind: 'expense',
      requestId: randomUUID(),
      expense: { category, amount, merchant, note: '合成备注', date: '2026-10-02' },
      image: { base64: png.toString('base64') },
    });
  for (const value of [5000, 1000, 1000])
    await ledger.command({
      kind: 'batch',
      requestId: randomUUID(),
      date: '2026-10-03',
      allocations: [{ expenseId: 2, amount: value }],
    });
  await ledger.command({ kind: 'cancel', requestId: randomUUID(), id: 2 });
  await ledger.command({ kind: 'delete-batch', requestId: randomUUID(), id: 3 });
  const state = await read(f);
  state.expenses[0].legacyDetails = { text: '合成旧字段', list: [1, 2] };
  replaceState(f, state);
  return f;
}
const read = (f) => f.ledger.command({ kind: 'read' });
function replaceState(f, state) {
  f.db((db) =>
    db.prepare('UPDATE trial_state SET json=? WHERE id=1').run(JSON.stringify(state, null, 2)),
  );
}
function request(state, changes = {}, id = 1) {
  const expense = state.expenses.find((e) => e.id === id);
  return {
    kind: 'correct-expense',
    requestId: randomUUID(),
    id,
    expected: structuredClone(expense),
    expectedRevision: (state.expenseEvents ?? []).filter((event) => event.expenseId === id).length,
    expense: {
      category: expense.category,
      date: expense.date,
      merchant: expense.merchant,
      amount: expense.amount,
      note: expense.note,
      ...changes,
    },
  };
}
const cash = (state) => ({
  advances: state.advances,
  advanceDetails: state.advanceDetails,
  expenses: state.expenses,
  flows: [
    ...state.advances.map((amount, index) => ({
      kind: 'advance',
      index,
      amount,
      ...state.advanceDetails?.[index],
    })),
    ...state.expenses.map((expense) => ({ kind: 'expense', ...expense, amount: -expense.amount })),
  ],
  balance:
    state.advances.reduce((a, b) => a + b, 0) - state.expenses.reduce((a, e) => a + e.amount, 0),
});
async function snapshot(f) {
  return {
    state: await read(f),
    ...f.db((db) => ({
      raw: db.prepare('SELECT json FROM trial_state').get().json,
      operations: db.prepare('SELECT * FROM operations ORDER BY id').all(),
      attachments: db.prepare('SELECT * FROM attachments ORDER BY id').all(),
    })),
    files: fs
      .readdirSync(path.join(f.root, 'attachments'))
      .sort()
      .map((file) => ({
        file,
        sha256: createHash('sha256')
          .update(fs.readFileSync(path.join(f.root, 'attachments', file)))
          .digest('hex'),
      })),
  };
}
function assertEvent(f, event, input, before, after, revision) {
  assert.deepEqual(event, {
    requestId: input.requestId,
    action: 'correct-expense',
    at: event.at,
    expenseId: input.id,
    revision,
    before,
    after,
  });
  assert.ok(Number.isFinite(Date.parse(event.at)));
  const operation = f.db((db) =>
    db.prepare('SELECT * FROM operations WHERE id=?').get(input.requestId),
  );
  assert.equal(operation.kind, 'correct-expense');
  assert.equal(operation.created_at, event.at);
}

test('integer-cent correction updates the original expense once, preserves all unrelated facts and attachments, and records full revisions', async (t) => {
  const f = await fixture(t);
  let revision = 0;
  for (const amount of [30001, 1]) {
    const before = await snapshot(f),
      input = request(before.state, { amount }),
      after = await f.ledger.command(input),
      saved = await snapshot(f),
      expected = structuredClone(before.state);
    expected.expenses[0].amount = amount;
    expected.expenseEvents = after.expenseEvents;
    assert.deepEqual(after, expected);
    assert.equal(after.expenses.length, 2);
    assert.equal(after.expenses[0].id, 1);
    assert.deepEqual(cash(after), cash(expected));
    assert.equal(
      cash(after).balance - cash(before.state).balance,
      before.state.expenses[0].amount - amount,
    );
    assert.deepEqual(saved.attachments, before.attachments);
    assert.deepEqual(saved.files, before.files);
    assert.deepEqual(
      saved.operations.filter((op) => op.id !== input.requestId),
      before.operations,
    );
    assert.deepEqual(after.expenseEvents.slice(0, -1), before.state.expenseEvents ?? []);
    assertEvent(
      f,
      after.expenseEvents.at(-1),
      input,
      before.state.expenses[0],
      after.expenses[0],
      ++revision,
    );
    assert.deepEqual(
      await f.ledger.command({ kind: 'attachment', id: after.expenses[0].attachmentId }),
      { mime: 'image/png', base64: png.toString('base64') },
    );
  }
  const saved = await snapshot(f);
  f.reopen();
  assert.deepEqual(await snapshot(f), saved);
});

test('metadata correction changes no fund amount and preserves ID, invoice, attachment and unknown legacy fields', async (t) => {
  const f = await fixture(t),
    before = await snapshot(f),
    input = request(before.state, {
      category: '办公',
      date: '2026-09-30',
      merchant: ' 修正后的合成摘要 ',
      note: ' 修正备注 ',
    }),
    after = await f.ledger.command(input),
    expected = structuredClone(before.state);
  Object.assign(expected.expenses[0], {
    category: '办公',
    date: '2026-09-30',
    merchant: '修正后的合成摘要',
    note: '修正备注',
  });
  expected.expenseEvents = after.expenseEvents;
  assert.deepEqual(after, expected);
  assert.deepEqual(cash(after), cash(expected));
  assert.equal(cash(after).balance, cash(before.state).balance);
  assert.deepEqual(after.advances, before.state.advances);
  assert.deepEqual(
    after.expenses.map((e) => ({ id: e.id, amount: e.amount })),
    before.state.expenses.map((e) => ({ id: e.id, amount: e.amount })),
  );
  const saved = await snapshot(f);
  assert.deepEqual(saved.attachments, before.attachments);
  assert.deepEqual(saved.files, before.files);
  assertEvent(f, after.expenseEvents[0], input, before.state.expenses[0], after.expenses[0], 1);
});

test('effective allocations bound correction amounts; inactive history and invoice amounts do not lock editing', async (t) => {
  const f = await fixture(t),
    state = await read(f);
  await assert.rejects(f.ledger.command(request(state, { amount: 4999 }, 2)), /当前有效报销金额/);
  let after = await f.ledger.command(request(state, { amount: 5000 }, 2));
  assert.deepEqual(after.batches, state.batches);
  assert.deepEqual(after.batchEvents, state.batchEvents);
  after = await f.ledger.command(request(after, { merchant: '合成改摘要' }, 2));
  assert.equal(after.expenses[1].merchant, '合成改摘要');
  after.expenses[0].invoice = 999999;
  replaceState(f, after);
  const corrected = await f.ledger.command(request(after, { amount: 1 }));
  assert.equal(corrected.expenses[0].amount, 1);
  assert.equal(corrected.expenses[0].invoice, 999999);
});

test('invalid amounts, dates, fields, IDs and revision inputs reject without state, audit or operation changes', async (t) => {
  const f = await fixture(t);
  await f.ledger.command(request(await read(f), { amount: 2 }));
  const before = await snapshot(f),
    base = request(before.state, { amount: 1 });
  const invalid = [
    ...[0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, '1', NaN, Infinity].map((amount) => ({
      ...base,
      expense: { ...base.expense, amount },
    })),
    ...[
      { date: '2026-02-30' },
      { category: '其他' },
      { merchant: '' },
      { merchant: 'x'.repeat(101) },
      { note: null },
      { note: 'x'.repeat(501) },
      { attachmentId: 'replacement' },
      { invoice: 0 },
      { id: 2 },
    ].map((change) => ({ ...base, expense: { ...base.expense, ...change } })),
    ...[0, -1, 1.2, '1', Number.MAX_SAFE_INTEGER + 1].map((id) => ({ ...base, id })),
    ...[-1, 0.1, '0', undefined, Number.MAX_SAFE_INTEGER + 1].map((expectedRevision) => ({
      ...base,
      expectedRevision,
    })),
    { ...base, image: { base64: png.toString('base64') } },
    { ...base, attachmentId: 'replacement' },
    { ...base, expected: { ...base.expected, legacyDetails: { text: 'different' } } },
    { ...base, expected: null },
  ];
  for (const input of invalid) {
    await assert.rejects(f.ledger.command(input));
    assert.deepEqual(await snapshot(f), before);
  }
  for (const requestId of [
    'a'.repeat(36),
    '-'.repeat(36),
    '1234567-12345-1234-1234-123456789abc',
    'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
    undefined,
    null,
    3,
  ]) {
    for (const input of [
      base,
      {
        kind: 'expense',
        expense: {
          category: '办公',
          date: '2026-10-12',
          merchant: '合成新费用',
          amount: 1,
          note: '',
        },
      },
      { kind: 'advance', advance: { amount: 1, date: '2026-10-12', note: '' } },
      { kind: 'batch', date: '2026-10-12', allocations: [{ expenseId: 1, amount: 1 }] },
      { kind: 'cancel', id: 1 },
      { kind: 'delete-batch', id: 1 },
    ]) {
      await assert.rejects(f.ledger.command({ ...input, requestId }), /保存请求无效/);
      assert.deepEqual(await snapshot(f), before);
    }
  }
  await assert.rejects(f.ledger.command({ ...base, id: 999999 }), /费用不存在/);
  assert.deepEqual(await snapshot(f), before);
});

test('aggregate cents exclude the old amount, accept the last safe cent and reject overflow atomically', async (t) => {
  const f = await fixture(t),
    initial = await read(f);
  initial.expenses[1].amount = Number.MAX_SAFE_INTEGER - initial.expenses[0].amount;
  replaceState(f, initial);
  const before = await snapshot(f);
  await assert.rejects(
    f.ledger.command(request(before.state, { amount: 30001 })),
    /金额合计超出安全范围/,
  );
  assert.deepEqual(await snapshot(f), before);
  const lower = await f.ledger.command(request(before.state, { amount: 29999 })),
    lastSafe = await f.ledger.command(request(lower, { amount: 30000 }));
  assert.equal(
    lastSafe.expenses.reduce((total, e) => total + e.amount, 0),
    Number.MAX_SAFE_INTEGER,
  );
  assert.equal(lastSafe.expenseEvents.length, 2);
});

test('unchanged or whitespace-only corrections create no audit or operation', async (t) => {
  const f = await fixture(t),
    before = await snapshot(f);
  for (const changes of [
    {},
    {
      merchant: ' ' + before.state.expenses[0].merchant + ' ',
      note: ' ' + before.state.expenses[0].note + ' ',
    },
  ]) {
    await assert.rejects(f.ledger.command(request(before.state, changes)), /内容没有变化/);
    assert.deepEqual(await snapshot(f), before);
  }
});

test('revision rejects ABA even when the complete expense value has returned to the old snapshot', async (t) => {
  const f = await fixture(t),
    original = await read(f),
    stale = request(original, { amount: 100 }),
    changed = await f.ledger.command(request(original, { merchant: '合成临时修正' })),
    back = await f.ledger.command(request(changed, { merchant: original.expenses[0].merchant }));
  assert.deepEqual(back.expenses[0], original.expenses[0]);
  assert.equal(back.expenseEvents.length, 2);
  const before = await snapshot(f);
  await assert.rejects(f.ledger.command(stale), /费用已变化/);
  assert.deepEqual(await snapshot(f), before);
});

test('two ledger connections using the same old snapshot allow exactly one correction and refuse the stale writer', async (t) => {
  const f = await fixture(t),
    old = await read(f),
    second = f.another(),
    a = request(old, { amount: 100 }),
    b = request(old, { amount: 200 }),
    results = await Promise.allSettled([f.ledger.command(a), second.command(b)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /费用已变化/);
  const saved = await snapshot(f);
  assert.equal(saved.state.expenseEvents.length, 1);
  assert.equal(saved.state.expenses[0].amount, 100);
  assert.equal(saved.operations.filter((op) => op.kind === 'correct-expense').length, 1);
});

test('revision counts only the target expense and old ledgers are read without backfilling correction metadata', async (t) => {
  const f = await fixture(t),
    before = await snapshot(f);
  assert.equal(Object.hasOwn(before.state, 'expenseEvents'), false);
  f.reopen();
  assert.deepEqual(await snapshot(f), before);
  const withThird = await f.ledger.command({
      kind: 'expense',
      requestId: randomUUID(),
      expense: {
        amount: 9,
        date: '2026-10-12',
        category: '办公',
        merchant: '合成独立费用',
        note: '',
      },
    }),
    thirdCorrected = await f.ledger.command(request(withThird, { amount: 10 }, 3));
  assert.equal(thirdCorrected.expenseEvents[0].revision, 1);
  const input = request(thirdCorrected, { amount: 100 });
  assert.equal(input.expectedRevision, 0);
  const result = await f.ledger.command(input);
  assert.equal(result.expenseEvents[1].revision, 1);
  assert.equal(result.expenseEvents[1].expenseId, 1);
});

test('idempotent requests survive reopen, differing content is rejected, and repeated old requests cannot reapply changes', async (t) => {
  const f = await fixture(t),
    initial = await read(f),
    input = {
      ...request(initial, { amount: 99 }),
      requestId: 'aaaaaaaa-aaaa-1aaa-1aaa-aaaaaaaaaaaa',
    },
    first = await f.ledger.command(input),
    saved = await snapshot(f);
  assert.deepEqual(await f.ledger.command(input), first);
  assert.deepEqual(await snapshot(f), saved);
  f.reopen();
  assert.deepEqual(await f.ledger.command(input), first);
  assert.deepEqual(await snapshot(f), saved);
  await assert.rejects(
    f.ledger.command({ ...input, expense: { ...input.expense, amount: 100 } }),
    /重复请求内容不一致/,
  );
  assert.deepEqual(await snapshot(f), saved);
  const second = await f.ledger.command(request(first, { amount: 101 })),
    newSnapshot = await snapshot(f);
  assert.deepEqual(await f.ledger.command(input), second);
  assert.deepEqual(await snapshot(f), newSnapshot);
});

test('failure inserting the operation rolls back the changed expense and its audit; the original request can retry', async (t) => {
  const f = await fixture(t),
    before = await snapshot(f),
    input = request(before.state, { amount: 7 });
  f.db((db) =>
    db.exec(
      "CREATE TRIGGER fail_correction BEFORE INSERT ON operations WHEN NEW.kind='correct-expense' BEGIN SELECT RAISE(ABORT,'synthetic correction failure'); END",
    ),
  );
  await assert.rejects(f.ledger.command(input), /synthetic correction failure/);
  assert.deepEqual(await snapshot(f), before);
  f.reopen();
  assert.deepEqual(await snapshot(f), before);
  f.db((db) => db.exec('DROP TRIGGER fail_correction'));
  const result = await f.ledger.command(input),
    saved = await snapshot(f);
  assert.equal(result.expenses[0].amount, 7);
  assert.equal(result.expenseEvents.length, 1);
  assert.equal(saved.operations.length, before.operations.length + 1);
  assert.deepEqual(saved.attachments, before.attachments);
  assert.deepEqual(saved.files, before.files);
  assert.deepEqual(await f.ledger.command(input), result);
  assert.deepEqual(await snapshot(f), saved);
});

test('malformed correction history is preserved and rejected instead of being overwritten', async (t) => {
  const f = await fixture(t);
  for (const expenseEvents of [null, false, { synthetic: 'invalid' }]) {
    const current = await read(f);
    current.expenseEvents = expenseEvents;
    replaceState(f, current);
    const before = await snapshot(f),
      input = { ...request({ ...current, expenseEvents: [] }, { amount: 1 }), expectedRevision: 0 };
    await assert.rejects(f.ledger.command(input), /费用纠错历史无效/);
    assert.deepEqual(await snapshot(f), before);
  }
});

test('managed reset removes correction history and stale generations or expected values cannot change a reused expense ID', async (t) => {
  const { createManagedLedger } = require('../spike/managed-ledger.cjs'),
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'xx-correction-generation-')),
    root = path.join(base, 'managed'),
    ledger = createManagedLedger(root);
  t.after(async () => {
    await ledger.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const f = {
      root,
      ledger,
      db(fn) {
        const db = new Database(path.join(root, 'trial.sqlite'));
        try {
          return fn(db);
        } finally {
          db.close();
        }
      },
    },
    initial = await read(f),
    fields = {
      category: '办公',
      date: '2026-10-12',
      merchant: '合成代际费用',
      amount: 1000,
      note: '',
    };
  const original = await ledger.command({
      kind: 'expense',
      requestId: randomUUID(),
      generation: initial.generation,
      expense: fields,
    }),
    first = request(original, { amount: 1100 }),
    corrected = await ledger.command({ ...first, generation: original.generation }),
    stale = request(corrected, { amount: 1300 });
  assert.equal(corrected.expenseEvents.length, 1);
  await ledger.command({
    kind: 'reset-ledger',
    requestId: randomUUID(),
    generation: corrected.generation,
    confirmation: '清空当前账本',
  });
  const empty = await read(f);
  assert.notEqual(empty.generation, corrected.generation);
  assert.equal(Object.hasOwn(empty, 'expenseEvents'), false);
  assert.deepEqual(empty.expenses, []);
  assert.deepEqual((await snapshot(f)).operations, []);
  const fresh = await ledger.command({
    kind: 'expense',
    requestId: randomUUID(),
    generation: empty.generation,
    expense: { ...fields, amount: 1100 },
  });
  assert.deepEqual(fresh.expenses[0], stale.expected);
  const before = await snapshot(f);
  for (const input of [
    { ...first, generation: original.generation },
    { ...stale, generation: original.generation },
  ]) {
    await assert.rejects(ledger.command(input), /代际已变化/);
    assert.deepEqual(await snapshot(f), before);
  }
  await assert.rejects(ledger.command({ ...stale, generation: fresh.generation }), /费用已变化/);
  assert.deepEqual(await snapshot(f), before);
  await assert.rejects(
    ledger.command({ ...first, requestId: randomUUID(), generation: fresh.generation }),
    /费用已变化/,
  );
  assert.deepEqual(await snapshot(f), before);
  assert.equal(Object.hasOwn(await read(f), 'expenseEvents'), false);
});
