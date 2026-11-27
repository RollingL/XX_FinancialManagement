const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkWindowsPackage, checkWindowsLauncher } = require('../spike/windows-package-check.cjs');
const win = { platform: 'win32', arch: 'x64' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-package-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pe = Buffer.alloc(256);
  pe.write('MZ');
  pe.writeUInt32LE(64, 60);
  pe.writeUInt32LE(0x4550, 64);
  pe.writeUInt16LE(0x8664, 68);
  pe.writeUInt16LE(112, 84);
  pe.writeUInt16LE(0x20b, 88);
  pe.writeUInt16LE(2, 156);
  const binaries = [
    path.join(root, 'node_modules/better-sqlite3/prebuilds/win32-x64.node'),
    path.join(root, 'out/windows-launcher/Qianlai.exe'),
  ];
  for (const file of binaries) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pe);
  }
  return { root, binaries, pe };
}
test('Windows package input guard rejects foreign host or architecture before touching resources', () => {
  for (const [arch, host] of [
    ['x64', { platform: 'darwin', arch: 'arm64' }],
    ['arm64', win],
    ['ia32', win],
    ['x64', { platform: 'win32', arch: 'arm64' }],
  ])
    assert.throws(() => checkWindowsPackage('/must-not-be-read', arch, host), /Windows x64/);
});
test('complete synthetic x64 input set passes presence checks without claiming runtime validation', (t) => {
  const { root } = fixture(t);
  assert.doesNotThrow(() => checkWindowsPackage(root, 'x64', win));
});
test('the SQLite binary and launcher must exist and contain an x64 PE header', (t) => {
  const { root, binaries, pe } = fixture(t);
  for (const file of binaries) {
    for (const bad of [Buffer.from('Mac Mach-O'), Buffer.from(pe)]) {
      if (bad.length === pe.length) bad.writeUInt16LE(0xaa64, 68);
      fs.writeFileSync(file, bad);
      assert.throws(() => checkWindowsPackage(root, 'x64', win), /Windows x64 PE/);
    }
    const corrupt = Buffer.from(pe);
    corrupt.writeUInt32LE(0xffffffff, 60);
    fs.writeFileSync(file, corrupt);
    assert.throws(() => checkWindowsPackage(root, 'x64', win), /Windows x64 PE/);
    fs.unlinkSync(file);
    assert.throws(() => checkWindowsPackage(root, 'x64', win), /ENOENT/);
    fs.writeFileSync(file, pe);
  }
});
test('Forge guard is attached before Windows packaging and leaves non-Windows packaging unchanged', async (t) => {
  const { root } = fixture(t),
    config = require('../forge.config.cjs');
  await config.hooks.prePackage(config, 'darwin', 'arm64');
  if (process.platform !== 'win32')
    await assert.rejects(config.hooks.prePackage(config, 'win32', 'x64'), /Windows x64/);
  assert.ok(fs.existsSync(root));
});

test('portable entry must be a GUI x64 executable, not a console or PE32 build', (t) => {
  const { root, pe } = fixture(t),
    file = path.join(root, 'out/windows-launcher/Qianlai.exe');
  for (const [offset, value] of [
    [156, 3],
    [88, 0x10b],
    [84, 2],
  ]) {
    const bad = Buffer.from(pe);
    bad.writeUInt16LE(value, offset);
    fs.writeFileSync(file, bad);
    assert.throws(() => checkWindowsLauncher(file), /GUI x64/);
  }
});
