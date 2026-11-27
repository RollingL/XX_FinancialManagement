const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
const { createLedger } = require('../spike/trial-ledger.cjs'),
  { seedLegacyInvoices } = require('./legacy-invoice-fixture.cjs');
test('legacy invoice associations and release history do not lock expense corrections or affect reimbursement limits', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-retired-invoice-edit-')),
    ledger = createLedger(root, { recognize: async () => ({}) });
  t.after(() => {
    ledger.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const send = (body) => ledger.command({ requestId: randomUUID(), ...body });
  await send({
    kind: 'expense',
    expense: { amount: 10000, date: '2026-10-16', category: '接待', merchant: '合成', note: '' },
  });
  const before = seedLegacyInvoices(root, 1);
  let s = before;
  const correct = (amount) => ({
    kind: 'correct-expense',
    id: 1,
    expected: structuredClone(s.expenses[0]),
    expectedRevision: s.expenseEvents?.length ?? 0,
    expense: { amount, date: '2026-10-16', category: '接待', merchant: '合成', note: '' },
  });
  s = await send(correct(8000));
  assert.deepEqual(s.invoices, before.invoices);
  assert.deepEqual(s.invoiceEvents, before.invoiceEvents);
  s = await send({
    kind: 'batch',
    date: '2026-10-16',
    allocations: [{ expenseId: 1, amount: 2000 }],
  });
  await assert.rejects(send(correct(1999)), /有效报销/);
  assert.deepEqual(await ledger.command({ kind: 'read' }), s);
});
