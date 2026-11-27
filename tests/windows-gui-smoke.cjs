// Invoked only after packaging, against the newly extracted runner-temp copy.
// Exercises the real GUI and default portable paths; never accepts a user ledger.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const psScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.action -eq 'capture') {
    $main = Get-Process -Id ([int]$request.pid) -ErrorAction Stop
    if (![StringComparer]::OrdinalIgnoreCase.Equals($main.Path, $request.executable)) { throw 'Main PID path mismatch' }
    $processes = @(Get-CimInstance Win32_Process)
    $ids = [Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add([int]$request.pid)
    do {
        $added = $false
        foreach ($item in $processes) {
            if ($ids.Contains([int]$item.ParentProcessId) -and !$ids.Contains([int]$item.ProcessId)) {
                [void]$ids.Add([int]$item.ProcessId); $added = $true
            }
        }
    } while ($added)
    $records = @()
    foreach ($processId in $ids) {
        $item = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (!$item) { continue }
        if (!$item.Path -or !$item.Path.StartsWith($request.appRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected descendant path' }
        $records += @{ pid=$processId; path=$item.Path; started=$item.StartTime.ToUniversalTime().Ticks.ToString() }
    }
    ConvertTo-Json -InputObject $records -Compress
} elseif ($request.action -eq 'close') {
    $main = Get-Process -Id ([int]$request.pid) -ErrorAction Stop
    if (![StringComparer]::OrdinalIgnoreCase.Equals($main.Path, $request.executable) -or
        $main.StartTime.ToUniversalTime().Ticks.ToString() -ne $request.started) { throw 'Main process identity changed' }
    if (!$main.CloseMainWindow()) { throw 'Runner has no closable real application window' }
    'true'
} elseif ($request.action -eq 'find-launcher') {
    $records = @()
    foreach ($entry in @(Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + [int]$request.entryPid))) {
        $item = Get-Process -Id ([int]$entry.ProcessId) -ErrorAction SilentlyContinue
        if ($item -and [StringComparer]::OrdinalIgnoreCase.Equals($item.Path, $request.executable)) {
            $records += @{ pid=$item.Id; path=$item.Path; started=$item.StartTime.ToUniversalTime().Ticks.ToString() }
        }
    }
    ConvertTo-Json -InputObject $records -Compress
} elseif ($request.action -eq 'abort-owned-launcher') {
    $item = Get-Process -Id ([int]$request.record.pid) -ErrorAction SilentlyContinue
    if ($item -and [StringComparer]::OrdinalIgnoreCase.Equals($item.Path, $request.record.path) -and
        $item.StartTime.ToUniversalTime().Ticks.ToString() -eq $request.record.started) { $item.Kill() }
    'true'
} elseif ($request.action -eq 'remaining') {
    $remaining = @()
    foreach ($record in $request.records) {
        $item = Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
        if ($item -and $item.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.started) { $remaining += $record.pid }
    }
    ConvertTo-Json -InputObject $remaining -Compress
} else { throw 'Unknown synthetic smoke action' }
`;
function powershell(request) {
  const exe = path.join(
    process.env.SystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const output = execFileSync(
    exe,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(psScript, 'utf16le').toString('base64'),
    ],
    { input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 30000 },
  );
  return JSON.parse(output.trim());
}
function events(file, offset) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .slice(offset)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('[qianlai-startup] '))
    .flatMap((line) => {
      try {
        return [JSON.parse(line.slice('[qianlai-startup] '.length))];
      } catch {
        return [];
      }
    });
}
const { TABLE_NAMES } = require('../src/main/ledger-schema.cjs');
const dataDir = (root) => path.join(root, '数据');
function ledgerSnapshot(root) {
  const { DatabaseSync } = require('node:sqlite'),
    directory = dataDir(root);
  const db = new DatabaseSync(path.join(directory, 'qianlai.sqlite'), { readOnly: true });
  let rows;
  try {
    rows = Object.fromEntries(
      TABLE_NAMES.map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]),
    );
  } finally {
    db.close();
  }
  const attachments = fs
    .readdirSync(path.join(directory, '截图'))
    .sort()
    .map((name) => ({ name, hash: hash(path.join(directory, '截图', name)) }));
  return { rows, attachments };
}
// One obviously synthetic expense, written while the program is closed, so the reopen and
// the copied-folder run have real content to keep.
function addSyntheticExpense(root) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir(root), 'qianlai.sqlite'));
  try {
    db.exec(`INSERT INTO expenses (id, category, date, merchant, amount, note, created_at)
      VALUES (1, '办公', '2026-11-01', '合成商户', 12345, '合成冒烟记录', '2026-11-01T00:00:00.000Z')`);
  } finally {
    db.close();
  }
}
function automaticBackups(root) {
  const backups = path.join(root, '备份');
  if (!fs.existsSync(backups)) return [];
  return fs
    .readdirSync(backups)
    .filter((name) => name.endsWith('_自动备份'))
    .filter((name) => fs.existsSync(path.join(backups, name, 'backup.json')));
}
async function run(root, iteration, diagnosticCmd = false) {
  const log = path.join(root, '运行记录', 'logs', 'startup.log');
  const offset = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0;
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.startsWith('QIANLAI_') ||
      key.startsWith('ELECTRON_') ||
      key === 'NODE_OPTIONS' ||
      key === 'NODE_PATH'
    )
      delete env[key];
  const command = diagnosticCmd ? process.env.ComSpec || 'cmd.exe' : path.join(root, 'Qianlai.exe');
  const args = diagnosticCmd ? ['/d', '/c', 'START-TEST.cmd'] : ['--diagnostics'];
  const child = spawn(command, args, {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end('\n');
  let exit,
    spawnError,
    diagnostic = '';
  child.once('error', (error) => {
    spawnError = error;
  });
  child.once('exit', (code, signal) => {
    exit = { code, signal };
  });
  const keep = (chunk) => {
    diagnostic = (diagnostic + chunk.toString('utf8')).slice(-16384);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  try {
    let startup, main;
    for (let attempt = 0; attempt < 240; attempt++) {
      assert.ifError(spawnError);
      assert.equal(exit, undefined, `GUI exited before loading: ${diagnostic}`);
      startup = events(log, offset);
      main = startup.find((event) => event.stage === 'ledger-open');
      if (main && startup.some((event) => event.stage === 'page-loaded' && event.pid === main.pid))
        break;
      await delay(250);
    }
    assert.ok(
      main && Number.isSafeInteger(main.pid) && main.pid > 0,
      `No ledger-open event: ${diagnostic}`,
    );
    assert.ok(
      startup.some((event) => event.stage === 'page-loaded' && event.pid === main.pid),
      `Real GUI did not load: ${diagnostic}`,
    );
    const executable = path.join(root, 'app', 'qianlai-app.exe');
    const records = powershell({
      action: 'capture',
      pid: main.pid,
      executable,
      appRoot: path.join(root, 'app'),
    });
    const identity = records.find((record) => record.pid === main.pid);
    assert.ok(identity, 'Main identity not captured');
    assert.equal(
      powershell({ action: 'close', pid: main.pid, executable, started: identity.started }),
      true,
    );
    for (let attempt = 0; attempt < 120 && !exit; attempt++) await delay(250);
    assert.deepEqual(exit, { code: 0, signal: null }, `GUI did not close cleanly: ${diagnostic}`);
    assert.ok(
      events(log, offset).some(
        (event) => event.stage === 'cleanup-complete' && event.pid === main.pid,
      ),
      `Cleanup was not confirmed: ${diagnostic}`,
    );
    let remaining = [];
    for (let attempt = 0; attempt < 10; attempt++) {
      remaining = powershell({ action: 'remaining', records });
      if (!remaining.length) break;
      await delay(250);
    }
    assert.deepEqual(remaining, [], 'A process from this application invocation remains');
    assert.equal(
      fs.existsSync(path.join(dataDir(root), 'qianlai.sqlite-journal')),
      false,
      'Normal GUI close left the database journal',
    );
    return {
      iteration,
      entry: diagnosticCmd ? 'optional diagnostic CMD' : 'Qianlai.exe',
      mainPid: main.pid,
      trackedProcesses: records.length,
      ledgerOpen: true,
      pageLoaded: true,
      cleanupComplete: true,
      normalClose: true,
    };
  } finally {
    // A failed optional CMD run must not strand its GUI supervisor. Only children
    // of this invocation with the exact fresh-candidate path and creation time qualify.
    if (diagnosticCmd && child.pid) {
      for (const record of powershell({
        action: 'find-launcher',
        entryPid: child.pid,
        executable: path.join(root, 'Qianlai.exe'),
      }))
        powershell({ action: 'abort-owned-launcher', record });
    }
    if (!exit && !spawnError) {
      child.kill();
      for (let attempt = 0; attempt < 40 && !exit; attempt++) await delay(100);
    }
  }
}
async function main() {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.argv.length, 3);
  const root = fs.realpathSync(process.argv[2]),
    temp = fs.realpathSync(process.env.RUNNER_TEMP),
    relative = path.relative(temp, root);
  assert.ok(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'Only the fresh runner-temp extraction is accepted',
  );
  require('../scripts/windows/prepare-portable.cjs').verifyInventory(
    root,
    JSON.parse(fs.readFileSync(path.join(root, 'file-hashes.json'), 'utf8')),
  );
  for (const name of ['数据', '备份', '运行记录'])
    assert.equal(fs.existsSync(path.join(root, name)), false, `Refuse to use an existing ${name}`);
  const first = await run(root, 1, true);
  for (const name of ['数据', '备份', '运行记录'])
    assert.ok(
      fs.statSync(path.join(root, name)).isDirectory(),
      `First start did not create ${name}`,
    );
  assert.deepEqual(automaticBackups(root), [], 'An empty ledger was backed up');
  addSyntheticExpense(root);
  const before = ledgerSnapshot(root);
  const second = await run(root, 2);
  assert.deepEqual(ledgerSnapshot(root), before, 'Reopen changed ledger facts or attachments');
  assert.equal(automaticBackups(root).length, 1, 'Opening a non-empty ledger made no daily backup');
  // Moving to another computer = copying the whole folder. Run the copy and check it.
  const copy = root + '-copy';
  assert.equal(fs.existsSync(copy), false);
  fs.cpSync(root, copy, { recursive: true });
  const third = await run(copy, 3);
  assert.deepEqual(ledgerSnapshot(copy), before, 'The copied folder lost ledger facts');
  assert.deepEqual(ledgerSnapshot(root), before, 'Running the copy changed the original');
  console.log(
    JSON.stringify(
      {
        scope:
          'Real packaged GUI, portable folder, reopen and copied-folder run on Windows build runner; not Windows 10 clean offline/Alt+F4/shutdown/power-loss acceptance',
        runs: [first, second, third],
        ledgerPreserved: true,
        copiedFolderWorks: true,
      },
      null,
      2,
    ),
  );
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
