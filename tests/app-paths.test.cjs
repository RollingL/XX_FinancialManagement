// Where the program keeps its 数据 and 备份 folders.
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { resolveHome } = require('../src/main/app-paths.cjs');

// An unzipped Windows package: <folder>/Qianlai.exe and <folder>/app/resources/…
function portableFolder(t, marker = { format: 1, product: 'qianlai-finance' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-portable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'app', 'resources');
  fs.mkdirSync(resources, { recursive: true });
  if (marker !== null)
    fs.writeFileSync(
      path.join(resources, 'windows-portable.json'),
      typeof marker === 'string' ? marker : JSON.stringify(marker),
    );
  return { root, resources };
}
const windows = (resourcesPath, env = {}) =>
  resolveHome({ packaged: true, platform: 'win32', resourcesPath, env, projectRoot: '/unused' });

test('the Windows package keeps its data in the unzipped folder itself, whatever the environment says', (t) => {
  const { root, resources } = portableFolder(t);
  assert.deepEqual(windows(resources), { home: root, portable: true });
  assert.deepEqual(windows(resources, { QIANLAI_HOME: path.join(os.tmpdir(), 'elsewhere') }), {
    home: root,
    portable: true,
  });
  // Nothing is created just by working out the location.
  assert.deepEqual(fs.readdirSync(root), ['app']);
});

test('a Windows package without a valid marker refuses to start rather than guess a folder', (t) => {
  for (const [marker, message] of [
    [null, /标识缺失或无效/],
    ['不是 JSON', /标识缺失或无效/],
    [{ format: 2, product: 'qianlai-finance' }, /标识不兼容/],
    [{ format: 1, product: 'other' }, /标识不兼容/],
    [{ format: 1, product: 'qianlai-finance', extra: true }, /标识不兼容/],
  ]) {
    const { resources } = portableFolder(t, marker);
    assert.throws(() => windows(resources), message, JSON.stringify(marker));
  }
});

test('development uses QIANLAI_HOME when given, otherwise .local-data in the project', () => {
  const projectRoot = path.join(os.tmpdir(), 'qianlai-project');
  const dev = (env) =>
    resolveHome({ packaged: false, platform: 'linux', resourcesPath: '', env, projectRoot });
  assert.deepEqual(dev({}), { home: path.join(projectRoot, '.local-data'), portable: false });
  const chosen = path.join(os.tmpdir(), 'qianlai-chosen');
  assert.deepEqual(dev({ QIANLAI_HOME: chosen }), { home: chosen, portable: false });
  assert.throws(() => dev({ QIANLAI_HOME: 'relative/folder' }), /必须是绝对路径/);
  assert.throws(() => dev({ QIANLAI_HOME: '' }), /必须是绝对路径/);
});

test('other packaged builds keep their data in the folder that contains the program', () => {
  const at = (platform, resourcesPath) =>
    resolveHome({ packaged: true, platform, resourcesPath, env: {}, projectRoot: '/unused' }).home;
  assert.equal(at('linux', '/opt/qianlai/resources'), path.resolve('/opt/qianlai'));
  assert.equal(
    at('darwin', '/Users/synthetic/钱来/钱来.app/Contents/Resources'),
    path.resolve('/Users/synthetic/钱来'),
  );
});
