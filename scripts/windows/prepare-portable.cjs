const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

function launchScript(id, probe = false) {
  assert.match(id, /^[A-Za-z0-9-]{1,160}$/, 'Invalid portable build identity');
  const lines = [
    '@echo off',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'set "ERRORLEVEL="',
    'set "RANDOM="',
    'cd /d "%~dp0" || goto :failed',
    'if not exist "%~dp0Qianlai.exe" goto :failed',
    'if not exist "%~dp0diagnostics\\" mkdir "%~dp0diagnostics" 2>nul',
    'if not exist "%~dp0diagnostics\\" goto :failed',
    // New cmd.exe processes can share RANDOM seeds. Claim a fresh directory before
    // writing anything, and retry collisions without changing existing evidence.
    'set "LOG_ATTEMPT=0"',
    ':log_directory',
    'set /a LOG_ATTEMPT+=1 >nul',
    'if %LOG_ATTEMPT% GTR 100 goto :failed',
    `set "LOG_DIR=%~dp0diagnostics\\${probe ? 'probe' : 'start'}-%RANDOM%-%RANDOM%-%LOG_ATTEMPT%"`,
    'mkdir "%LOG_DIR%" 2>nul && goto :log_ready',
    'if exist "%LOG_DIR%" goto :log_directory',
    'goto :failed',
    ':log_ready',
    'set "ELECTRON_ENABLE_LOGGING=1"',
    'set "ELECTRON_LOG_FILE=%LOG_DIR%\\chromium.log"',
    'set "ELECTRON_ENABLE_STACK_DUMPING=1"',
    'set "QIANLAI_STARTUP_DIAGNOSTICS=1"',
    `>"%LOG_DIR%\\status.txt" echo Build=${id}`,
    '>>"%LOG_DIR%\\status.txt" echo Started=%DATE% %TIME%',
    'ver >>"%LOG_DIR%\\status.txt"',
    '"%SystemRoot%\\System32\\tasklist.exe" /fi "IMAGENAME eq qianlai-app.exe" /fo list >"%LOG_DIR%\\processes-before.txt" 2>&1',
    'echo Diagnostic mode only. For daily use, double-click Qianlai.exe.',
    'echo Diagnostic folder: "%LOG_DIR%"',
    // Batch files wait for GUI executables. Direct invocation preserves redirected
    // standard handles; START /WAIT lost those handles in the Windows native test.
    `"%~dp0Qianlai.exe" --diagnostics${probe ? ' --probe' : ''} >"%LOG_DIR%\\stdout.txt" 2>"%LOG_DIR%\\stderr.txt"`,
    'set "LAUNCH_EXIT=%errorlevel%"',
    '>>"%LOG_DIR%\\status.txt" echo ExitCode=%LAUNCH_EXIT%',
    '>>"%LOG_DIR%\\status.txt" echo Ended=%DATE% %TIME%',
    '"%SystemRoot%\\System32\\tasklist.exe" /fi "IMAGENAME eq qianlai-app.exe" /fo list >"%LOG_DIR%\\processes-after.txt" 2>&1',
    'if not "%LAUNCH_EXIT%"=="0" goto :runtime_failed',
    probe
      ? 'echo Runtime check completed. Keep this diagnostic folder for review.'
      : 'echo Closed. Your data stays in this folder.',
    'echo Logs: "%LOG_DIR%"',
    'pause',
    'exit /b 0',
    ':runtime_failed',
    'echo Qianlai stopped. Exit code: %LAUNCH_EXIT%',
    'type "%LOG_DIR%\\stderr.txt"',
    'echo Logs: "%LOG_DIR%"',
    'echo Do not delete any folder here, or disable security software.',
    'pause',
    'exit /b %LAUNCH_EXIT%',
    ':failed',
    'echo Stopped before launch. Check complete extraction, Qianlai.exe and folder write access.',
    'echo Do not delete existing data or disable security software. Report this message.',
    'pause',
    'exit /b 1',
  ];
  return lines.join('\r\n') + '\r\n';
}
function filesBelow(root) {
  const result = [];
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw Error('Portable package must not contain symbolic links');
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) result.push(file);
      else throw Error('Unexpected portable package entry');
    }
  }
  walk(root);
  return result.sort();
}
function verifyInventory(root, manifest) {
  const names = new Set();
  for (const item of manifest) {
    assert.equal(typeof item.file, 'string');
    const file = path.resolve(root, item.file),
      relative = path.relative(root, file);
    assert.ok(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      'Unsafe manifest path',
    );
    assert.ok(!names.has(item.file), 'Duplicate manifest path');
    names.add(item.file);
    assert.equal(fs.statSync(file).size, item.size);
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      item.sha256,
    );
  }
  assert.deepEqual(
    filesBelow(root)
      .map((file) => path.relative(root, file).replaceAll('\\', '/'))
      .filter((file) => file !== 'file-hashes.json')
      .sort(),
    [...names].sort(),
  );
}
// The probe checks SQLite in a temporary folder of its own; it never opens a ledger.
function probePackage(app, launcher) {
  const env = { ...process.env, PATH: path.join(process.env.SystemRoot, 'System32') };
  for (const key of Object.keys(env))
    if (key.startsWith('QIANLAI_') || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  const output = execFileSync(launcher || path.join(app, 'qianlai-app.exe'), ['--probe'], {
    env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const report = JSON.parse(output);
  assert.equal(report.packaged, true);
  assert.equal(report.sqlite?.status, 'passed');
  assert.equal(report.sqlite?.platform, 'win32');
  assert.equal(report.sqlite?.arch, 'x64');
  return report;
}
async function prepare() {
  assert.equal(
    process.platform,
    'win32',
    'Only the Windows build runner may prepare this candidate',
  );
  assert.equal(process.arch, 'x64');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  if (process.argv[2] === '--verify-extracted') {
    assert.equal(process.argv.length, 4);
    const extracted = fs.realpathSync(process.argv[3]),
      temp = fs.realpathSync(process.env.RUNNER_TEMP),
      relative = path.relative(temp, extracted);
    assert.ok(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      'Only verify the new runner temp extraction',
    );
    verifyInventory(
      extracted,
      JSON.parse(fs.readFileSync(path.join(extracted, 'file-hashes.json'), 'utf8')),
    );
    console.log(
      JSON.stringify(
        {
          scope: 'Extracted portable candidate on Windows runner; not clean Windows 10 acceptance',
          probe: probePackage(path.join(extracted, 'app'), path.join(extracted, 'Qianlai.exe')),
        },
        null,
        2,
      ),
    );
    return;
  }
  assert.equal(process.argv.length, 2);
  const root = path.resolve(__dirname, '..', '..'),
    sha = process.env.GITHUB_SHA;
  assert.match(sha || '', /^[a-f0-9]{40}$/);
  assert.match(process.env.GITHUB_RUN_ID || '', /^\d+$/);
  const buildId = `qianlai-${sha}-${process.env.GITHUB_RUN_ID}`;
  const app = path.join(root, 'out', 'Qianlai-win32-x64');
  const destination = path.join(
    root,
    'out',
    'windows-offline',
    `Qianlai-Windows10-x64-${sha.slice(0, 12)}`,
  );
  assert.ok(!fs.existsSync(destination), 'Refuse to overwrite a previous portable candidate');
  const { listPackage } = await import('@electron/asar');
  const entries = listPackage(path.join(app, 'resources', 'app.asar'));
  for (const entry of entries)
    assert.ok(
      !/(^|[\\/])(?:evidence|\.local-data|\.git|\.env|credentials|backups)(?:[\\/.]|$)|\.(?:sqlite|db|pem|pfx|p12)$/i.test(
        entry,
      ),
      `Private path in packaged source: ${entry}`,
    );
  assert.ok(entries.some((entry) => entry.replaceAll('\\', '/').endsWith('/dist/index.html')));
  const launcher = path.join(root, 'out', 'windows-launcher', 'Qianlai.exe');
  require('./package-check.cjs').checkWindowsLauncher(launcher);
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(app, path.join(destination, 'app'), { recursive: true });
  fs.copyFileSync(launcher, path.join(destination, 'Qianlai.exe'));
  fs.writeFileSync(
    path.join(destination, 'app', 'resources', 'windows-portable.json'),
    JSON.stringify({ format: 1, product: 'qianlai-finance' }),
  );
  const report = probePackage(path.join(destination, 'app'), path.join(destination, 'Qianlai.exe'));
  fs.mkdirSync(path.join(destination, 'samples'));
  fs.copyFileSync(
    path.join(root, 'tests', 'fixtures', 'synthetic-payment.png'),
    path.join(destination, 'samples', 'synthetic-payment.png'),
  );
  fs.writeFileSync(path.join(destination, 'START-TEST.cmd'), launchScript(buildId));
  fs.writeFileSync(path.join(destination, 'CHECK-RUNTIME.cmd'), launchScript(buildId, true));
  fs.writeFileSync(
    path.join(destination, 'READ-ME.txt'),
    '\ufeff' + fs.readFileSync(path.join(root, 'docs', 'WINDOWS_OFFLINE_TRIAL.md'), 'utf8'),
  );
  fs.writeFileSync(
    path.join(destination, 'build-info.json'),
    JSON.stringify(
      {
        sourceCommit: sha,
        runId: process.env.GITHUB_RUN_ID,
        builtAt: new Date().toISOString(),
        buildOS: os.release(),
        node: process.version,
        scope:
          'Windows Server build smoke test only; Windows 10 clean offline acceptance NOT YET VERIFIED',
        probe: report,
      },
      null,
      2,
    ),
  );
  const manifest = filesBelow(destination).map((file) => ({
    file: path.relative(destination, file).replaceAll('\\', '/'),
    size: fs.statSync(file).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  }));
  // The package never contains a ledger, backups or runtime files.
  assert.ok(!manifest.some((item) => /^(?:数据|备份|运行记录)\//.test(item.file)));
  fs.writeFileSync(path.join(destination, 'file-hashes.json'), JSON.stringify(manifest, null, 2));
  console.log(destination);
}
if (require.main === module)
  prepare().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { launchScript, filesBelow, verifyInventory };
