const Database = require('better-sqlite3');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async function probe(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, '依赖 验证.sqlite');
  let db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE advance(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL CHECK(amount>0));
 CREATE TABLE expense(id INTEGER PRIMARY KEY,amount INTEGER NOT NULL CHECK(amount>0));
 CREATE TABLE batch(id INTEGER PRIMARY KEY,request TEXT UNIQUE NOT NULL,active INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE allocation(batch_id INTEGER REFERENCES batch(id),expense_id INTEGER REFERENCES expense(id),amount INTEGER CHECK(amount>0),PRIMARY KEY(batch_id,expense_id));
 CREATE VIEW cash AS SELECT 'advance' AS source,id,amount FROM advance UNION ALL SELECT 'expense',id,-amount FROM expense;`);
  db.prepare('INSERT INTO advance VALUES(1,?)').run(300000);
  db.prepare('INSERT INTO expense VALUES(1,?)').run(500000);
  const cash = () => db.prepare('SELECT * FROM cash ORDER BY source,id').all(),
    before = cash();
  const register = db.transaction((request, amount, fail = false) => {
    const previous = db.prepare('SELECT id FROM batch WHERE request=?').get(request);
    if (previous) return previous.id;
    const used = db
      .prepare(
        'SELECT COALESCE(SUM(a.amount),0) AS amount FROM allocation a JOIN batch b ON b.id=a.batch_id WHERE b.active=1 AND expense_id=1',
      )
      .get().amount;
    if (!Number.isSafeInteger(amount) || amount <= 0 || used + amount > 500000)
      throw new Error('allocation limit');
    const id = db.prepare('INSERT INTO batch(request) VALUES(?)').run(request).lastInsertRowid;
    db.prepare('INSERT INTO allocation VALUES(?,1,?)').run(id, amount);
    if (fail) throw new Error('simulated failure');
    return id;
  });
  const first = register('same-request', 100000);
  assert.equal(register('same-request', 100000), first);
  assert.throws(() => register('fail', 200000, true));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM batch').get().n, 1);
  assert.throws(() => register('over', 400001));
  assert.throws(() => db.prepare('INSERT INTO allocation VALUES(999,1,1)').run());
  register('second', 200000);
  assert.deepEqual(cash(), before);
  db.prepare('UPDATE batch SET active=0 WHERE id=?').run(first);
  assert.deepEqual(cash(), before);
  assert.equal(db.prepare('SELECT SUM(amount) AS balance FROM cash').get().balance, -200000);
  await db.backup(path.join(directory, 'snapshot.sqlite'));
  db.close();
  db = new Database(file);
  assert.deepEqual(cash(), before);
  db.close();
  const copy = new Database(path.join(directory, 'snapshot.sqlite'), { readonly: true });
  assert.deepEqual(copy.prepare('SELECT * FROM cash ORDER BY source,id').all(), before);
  copy.close();
  return {
    status: 'passed',
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    checks: [
      'native load',
      'WAL write/read/reopen',
      'foreign key',
      'rollback',
      'over-allocation',
      'same-request retry',
      'reimbursement cash invariant',
      'consistent backup',
    ],
    cash: before,
    balance: -200000,
    scope: 'synthetic dependency probe, not production business layer',
  };
};
