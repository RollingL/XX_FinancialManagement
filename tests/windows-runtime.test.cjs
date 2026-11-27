const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { configureWindowsPortable } = require('../spike/windows-runtime.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-runtime-'));
  fs.mkdirSync(path.join(root, 'app', 'resources'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'app', 'resources', 'windows-portable.json'),
    JSON.stringify({ format: 1, product: 'qianlai-finance' }),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const run = (root, env = {}) => {
  const result = configureWindowsPortable({
    packaged: true,
    platform: 'win32',
    resourcesPath: path.join(root, 'app', 'resources'),
    env,
  });
  return { env, result };
};
test('direct executable configures managed local data/backup paths without CMD environment', (t) => {
  const root = fixture(t),
    { env } = run(root);
  assert.equal(env.XX_FINANCE_MANAGED_TRIAL, '1');
  assert.equal(env.XX_FINANCE_DATA_DIR, path.join(root, 'trial-data', 'user-data', 'stage0-trial'));
  assert.ok(fs.statSync(env.XX_FINANCE_BACKUP_DIR).isDirectory());
});
test('upgrade retains the old build marker and every existing file without rebinding build identity', (t) => {
  const root = fixture(t),
    data = path.join(root, 'trial-data'),
    user = path.join(data, 'user-data');
  fs.mkdirSync(user, { recursive: true });
  const marker = 'qianlai-' + 'a'.repeat(40) + '-123';
  fs.writeFileSync(path.join(data, 'trial-marker.txt'), marker + '\n');
  fs.writeFileSync(path.join(user, 'synthetic-preserve.txt'), 'unchanged');
  run(root);
  assert.equal(fs.readFileSync(path.join(data, 'trial-marker.txt'), 'utf8'), marker + '\n');
  assert.equal(fs.readFileSync(path.join(user, 'synthetic-preserve.txt'), 'utf8'), 'unchanged');
});
test('unmarked or redirected data directories fail closed without taking ownership', (t) => {
  const root = fixture(t),
    data = path.join(root, 'trial-data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'keep'), 'synthetic');
  assert.throws(() => run(root), /标识/);
  assert.deepEqual(fs.readdirSync(data), ['keep']);
});
test('explicit isolated paths and probes remain isolated, missing bundle marker fails closed', (t) => {
  const root = fixture(t),
    env = { XX_FINANCE_USER_DATA_DIR: '/explicit' };
  assert.equal(run(root, env).result, null);
  assert.equal(
    configureWindowsPortable({
      packaged: true,
      platform: 'win32',
      resourcesPath: '/missing',
      env: {},
      probe: true,
    }),
    null,
  );
  fs.unlinkSync(path.join(root, 'app', 'resources', 'windows-portable.json'));
  assert.throws(() => run(root), /完整|标识/);
});
