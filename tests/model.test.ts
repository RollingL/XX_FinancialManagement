import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocate,
  balance,
  cents,
  decimal,
  money,
  paid,
  remaining,
  rowCents,
  sum,
  validateAllocation,
} from '../prototype/src/model.ts';
import { demo } from './model-fixture.ts';
test('金额精确到分并拒绝舍入和不安全整数', () => {
  assert.equal(cents('0.01'), 1);
  assert.equal(sum([cents('0.1'), cents('0.2')]), 30);
  for (const x of ['0', '-1', '1.001', '1e3', '9007199254740992', ''])
    assert.throws(() => cents(x));
  assert.throws(() => sum([Number.MAX_SAFE_INTEGER, 1]));
});
test('T01/T03/T04/T05：报销不改变负余额，补预支不改进度', () => {
  const s = demo(),
    e = s.expenses.slice(0, 1);
  assert.equal(balance(e, s.advances), -200000);
  assert.equal(paid(1001, s.batches), 300000);
  s.batches.push({
    id: 3,
    date: '2026-10-09',
    active: true,
    allocations: [{ expenseId: 1001, amount: 200000 }],
  });
  assert.equal(remaining(e[0], s.batches), 0);
  assert.equal(balance(e, s.advances), -200000);
  s.advances.push(400000);
  assert.equal(balance(e, s.advances), 200000);
  assert.equal(remaining(e[0], s.batches), 0);
});
test('T02/T08/T30：仅选中费用按日期分配，超额拒绝', () => {
  const s = demo(),
    e = s.expenses.filter((e) => [1002, 1003].includes(e.id));
  assert.deepEqual(allocate(150000, e, s.batches), [
    { expenseId: 1002, amount: 80000 },
    { expenseId: 1003, amount: 70000 },
  ]);
  assert.throws(() => allocate(200001, e, s.batches));
  assert.throws(() => validateAllocation([{ expenseId: 1002, amount: 80001 }], e, s.batches));
  assert.throws(() =>
    validateAllocation(
      [
        { expenseId: 1002, amount: 1 },
        { expenseId: 1002, amount: 1 },
      ],
      e,
      s.batches,
    ),
  );
});
test('T11/T26：撤销只影响进度，零预支可全部报销', () => {
  const s = demo(),
    before = balance(s.expenses, s.advances);
  s.batches[1].active = false;
  assert.equal(paid(1001, s.batches), 100000);
  assert.equal(balance(s.expenses, s.advances), before);
  assert.equal(allocate(500000, s.expenses.slice(0, 1), [])[0].amount, 500000);
  assert.equal(balance(s.expenses.slice(0, 1), []), -500000);
});
test('A01：编辑可用额排除本批次旧占用', () => {
  const s = demo();
  assert.equal(remaining(s.expenses[0], s.batches, 2), 400000);
});

test('零分配可省略，但非法零格式不能绕过精度校验', () => {
  assert.equal(rowCents('0.00'), 0);
  assert.equal(rowCents(''), 0);
  for (const value of ['0.000', '-0', '0e0']) assert.throws(() => rowCents(value));
});

test('大金额格式化仍保持每一分，含负一分', () => {
  assert.equal(decimal(Number.MAX_SAFE_INTEGER), '90071992547409.91');
  assert.equal(money(Number.MAX_SAFE_INTEGER), '90,071,992,547,409.91');
  assert.equal(money(-1), '-0.01');
  assert.equal(cents(decimal(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test('负余额继续支出的预览精确到分，合计越界拒绝格式化', () => {
  const current = -25;
  assert.equal(money(sum([current, -cents('0.01')])), '-0.26');
  assert.throws(() => sum([current, -cents('90071992547409.91')]), /安全范围/);
});
