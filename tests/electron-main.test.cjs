const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { EventEmitter } = require('node:events'),
  { pathToFileURL } = require('node:url'),
  { randomUUID } = require('node:crypto');
const mainFile = path.resolve(__dirname, '../spike/main.cjs'),
  source = fs.readFileSync(mainFile, 'utf8');
const base = path.resolve(path.sep, 'synthetic-electron-main'),
  USER = path.join(base, 'user'),
  DATA = path.join(base, 'ledger'),
  BACKUP = path.join(base, 'backups'),
  DEFAULT_USER = path.join(base, 'default-user');
const managedEnv = {
  XX_FINANCE_MANAGED_TRIAL: '1',
  XX_FINANCE_USER_DATA_DIR: USER,
  XX_FINANCE_DATA_DIR: DATA,
  XX_FINANCE_BACKUP_DIR: BACKUP,
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(setImmediate);
}
function event() {
  return {
    prevented: 0,
    preventDefault() {
      this.prevented++;
    },
  };
}
function harness(options = {}) {
  const calls = [],
    errors = [],
    logs = [],
    exitCodes = [],
    dialogs = [],
    handlers = new Map(),
    windows = [],
    ready = deferred(),
    quitEvents = [];
  const files = new Map([
    [USER, 'directory'],
    [DATA, 'directory'],
    [BACKUP, 'directory'],
    ...(options.files || []),
  ]);
  const platform = options.platform || process.platform,
    resources = path.join(base, 'resources');
  const worker = path.join(
    options.packaged ? resources : path.join(path.dirname(mainFile), 'ocr-dist'),
    'ocr-probe',
    platform === 'win32' ? 'ocr-probe.exe' : 'ocr-probe',
  );
  if (options.probe && !options.workerMissing) files.set(worker, 'file');
  for (const missing of options.missing || []) files.delete(missing);
  const contents = new Map(options.contents || []);
  const fakeFs = {
    readFileSync(file) {
      if (!contents.has(file)) throw Error('synthetic missing contents');
      return contents.get(file);
    },
    writeFileSync(file, value) {
      calls.push({ kind: 'writeFile', file });
      contents.set(file, value);
      files.set(file, 'file');
    },
    lstatSync(file) {
      const kind = files.get(file);
      if (!kind) throw Object.assign(Error('synthetic ENOENT'), { code: 'ENOENT' });
      return {
        isDirectory: () => kind === 'directory',
        isFile: () => kind === 'file',
        isSymbolicLink: () => kind === 'symlink',
        size: contents.get(file)?.length || 10,
      };
    },
    realpathSync(file) {
      return file;
    },
    mkdirSync(file) {
      calls.push({ kind: 'mkdir', file });
      if (!files.has(file)) files.set(file, 'directory');
    },
    existsSync: (file) => files.has(file),
    mkdtempSync(prefix) {
      const file = path.join(base, 'probe-temp');
      calls.push({ kind: 'mkdtemp', prefix, file });
      return file;
    },
    rmSync(file, settings) {
      calls.push({ kind: 'rm', file, settings });
    },
  };
  const processEvents = new EventEmitter();
  const app = new EventEmitter(),
    paths = { userData: DEFAULT_USER };
  app.isPackaged = !!options.packaged;
  app.requestSingleInstanceLock = () => {
    calls.push({ kind: 'single-instance' });
    return options.primary !== false;
  };
  app.getPath = (name) => paths[name] || path.join(base, name);
  app.setPath = (name, value) => {
    calls.push({ kind: 'setPath', name, value });
    paths[name] = value;
  };
  app.whenReady = () => {
    calls.push({ kind: 'whenReady' });
    return ready.promise;
  };
  app.exit = (code) => {
    calls.push({ kind: 'exit', code });
    exitCodes.push(code);
  };
  app.quit = () => {
    calls.push({ kind: 'quit' });
    const attempt = event();
    quitEvents.push(attempt);
    app.emit('before-quit', attempt);
  };
  const service = {
    finished: options.serviceFinished || Promise.resolve(),
    stop() {
      calls.push({ kind: 'service.stop' });
      options.stop?.();
    },
    recognize(bytes, settings) {
      calls.push({ kind: 'recognize', bytes, settings });
      return options.recognize
        ? options.recognize(bytes, settings)
        : Promise.resolve({ synthetic: true });
    },
  };
  const ledger = {
    command(payload) {
      calls.push({ kind: 'command', payload });
      return options.command ? options.command(payload) : Promise.resolve({ synthetic: true });
    },
    close() {
      calls.push({ kind: 'ledger.close' });
      return options.close ? options.close() : Promise.resolve();
    },
  };
  class BrowserWindow extends EventEmitter {
    constructor(config) {
      super();
      calls.push({ kind: 'window', config });
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: 'about:blank' };
      this.webContents.getURL = () => this.webContents.mainFrame.url;
      this.webContents.setWindowOpenHandler = (handler) => {
        this.openHandler = handler;
      };
      this.webContents.session = {
        setPermissionRequestHandler: (handler) => {
          this.permissionRequest = handler;
        },
        setPermissionCheckHandler: (handler) => {
          this.permissionCheck = handler;
        },
      };
      windows.push(this);
    }
    isMinimized() {
      return !!options.minimized;
    }
    restore() {
      calls.push({ kind: 'restore' });
    }
    show() {
      calls.push({ kind: 'show' });
    }
    focus() {
      calls.push({ kind: 'focus' });
    }
    async loadFile(file) {
      calls.push({ kind: 'loadFile', file });
      this.webContents.mainFrame.url = pathToFileURL(file).href;
      if (options.loadError) throw options.loadError;
    }
  }
  const ipcMain = new EventEmitter();
  ipcMain.handle = (name, handler) => {
    assert.equal(handlers.has(name), false);
    handlers.set(name, handler);
  };
  function factory(kind, args) {
    calls.push({ kind, args });
    if (options.ledgerError) throw options.ledgerError;
    return ledger;
  }
  const fakeExecFile = () => {
    throw Error('Native process execution is forbidden in this test');
  };
  fakeExecFile[require('node:util').promisify.custom] = async (file, args, settings) => {
    if (!options.probe) throw Error('Unexpected probe execution');
    calls.push({ kind: 'execFile', file, args, settings });
    return {
      stdout: JSON.stringify(
        Object.hasOwn(options, 'ocrResult') ? options.ocrResult : { status: 'passed' },
      ),
      stderr: '',
    };
  };
  function fakeRequire(name) {
    if (name === 'electron')
      return {
        app,
        BrowserWindow,
        ipcMain,
        dialog: {
          showOpenDialog: async (win, settings) => {
            calls.push({ kind: 'choose', win, settings });
            return options.choose ? options.choose() : { canceled: true, filePaths: [] };
          },
          showErrorBox: (title, message) => dialogs.push({ title, message }),
        },
      };
    if (name === './windows-runtime.cjs')
      return { configureWindowsPortable: () => options.portable || null };
    if (name === './ocr-service.cjs')
      return {
        MAX_BYTES: 20 * 1024 * 1024,
        createOcrService: (...args) => {
          calls.push({ kind: 'createOcrService', args });
          return service;
        },
      };
    if (name === './trial-ledger.cjs')
      return { createLedger: (...args) => factory('createLedger', args) };
    if (name === './managed-ledger.cjs')
      return { createManagedLedger: (...args) => factory('createManagedLedger', args) };
    if (name === './sqlite-probe.cjs')
      return async (directory) => {
        calls.push({ kind: 'sqliteProbe', directory });
        return Object.hasOwn(options, 'sqliteResult') ? options.sqliteResult : { status: 'passed' };
      };
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:child_process')
      return {
        execFile: fakeExecFile,
        spawn: (file, args, settings) => {
          calls.push({ kind: 'spawn', file, args, settings });
          const child = new EventEmitter();
          child.unref = () => calls.push({ kind: 'unref' });
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
      };
    if (['node:path', 'node:os', 'node:util', 'node:url'].includes(name)) return require(name);
    throw Error(`Unexpected module in isolated Electron test: ${name}`);
  }
  let startupError;
  try {
    vm.runInNewContext(
      source,
      {
        require: fakeRequire,
        __dirname: path.dirname(mainFile),
        process: {
          argv: [
            'synthetic-electron',
            mainFile,
            ...(options.probe ? ['--probe'] : []),
            ...(options.supervised ? ['--qianlai-supervised'] : []),
          ],
          on: processEvents.on.bind(processEvents),
          pid: 12345,
          env: { ...(options.env || {}) },
          platform,
          resourcesPath: resources,
        },
        console: {
          log: (value) => logs.push(String(value)),
          error: (value) => errors.push(String(value)),
        },
        Buffer,
        ArrayBuffer,
        AbortController,
        Promise,
      },
      { filename: mainFile },
    );
  } catch (error) {
    startupError = error;
  }
  const count = (kind) => calls.filter((call) => call.kind === kind).length;
  const trusted = () => ({
    sender: windows[0].webContents,
    senderFrame: windows[0].webContents.mainFrame,
  });
  return {
    app,
    processEvents,
    service,
    ledger,
    calls,
    errors,
    logs,
    exitCodes,
    dialogs,
    handlers,
    windows,
    paths,
    quitEvents,
    startupError,
    count,
    trusted,
    async start() {
      ready.resolve();
      await flush();
    },
    beforeQuit() {
      const attempt = event();
      app.emit('before-quit', attempt);
      return attempt;
    },
  };
}

// Every runtime path below is synthetic; filesystem and ledger modules are replaced before execution.
function assertProbeIsolation(h) {
  for (const kind of [
    'createOcrService',
    'createLedger',
    'createManagedLedger',
    'window',
    'command',
  ])
    assert.equal(h.count(kind), 0, kind);
  assert.equal(h.handlers.size, 0);
  assert.equal(h.count('sqliteProbe'), 1);
  assert.equal(h.count('rm'), 1);
  assert.equal(
    h.calls.find((call) => call.kind === 'rm').file,
    h.calls.find((call) => call.kind === 'mkdtemp').file,
  );
}
test('probe rejects a missing OCR worker in development and packaged modes without opening a ledger', async () => {
  for (const packaged of [false, true]) {
    const h = harness({ probe: true, packaged, platform: 'win32', workerMissing: true });
    await h.start();
    assert.deepEqual(h.exitCodes, [1]);
    assert.equal(h.logs.length, 0);
    assert.match(h.errors[0], /缺少本地 OCR/);
    assert.equal(h.count('execFile'), 0);
    assertProbeIsolation(h);
  }
});

test('probe requires explicit passed statuses from both SQLite and OCR', async () => {
  for (const key of ['sqliteResult', 'ocrResult'])
    for (const result of [{ status: 'failed' }, { status: 'not run' }, {}, null]) {
      const h = harness({ probe: true, packaged: true, platform: 'win32', [key]: result });
      await h.start();
      assert.deepEqual(h.exitCodes, [1]);
      assert.equal(h.logs.length, 0);
      assert.match(h.errors[0], /依赖探针未通过/);
      assert.equal(h.count('execFile'), key === 'sqliteResult' ? 0 : 1);
      assertProbeIsolation(h);
    }
});

test('probe succeeds only with both passed reports and the platform-specific worker, without UI startup', async () => {
  for (const platform of ['darwin', 'win32'])
    for (const packaged of [false, true]) {
      const h = harness({ probe: true, packaged, platform });
      await h.start();
      assert.deepEqual(h.exitCodes, [0]);
      assert.deepEqual(h.errors, []);
      assert.equal(h.logs.length, 1);
      assert.deepEqual(JSON.parse(h.logs[0]), {
        sqlite: { status: 'passed' },
        packaged,
        ocr: { status: 'passed' },
      });
      const execution = h.calls.find((call) => call.kind === 'execFile'),
        root = packaged
          ? path.join(base, 'resources')
          : path.join(path.dirname(mainFile), 'ocr-dist');
      assert.equal(
        execution.file,
        path.join(root, 'ocr-probe', platform === 'win32' ? 'ocr-probe.exe' : 'ocr-probe'),
      );
      assert.equal(
        execution.args[0],
        packaged
          ? path.join(base, 'resources', 'ocr-sample.png')
          : path.join(path.dirname(mainFile), 'fixtures', 'ocr-sample.png'),
      );
      assertProbeIsolation(h);
    }
});

test('invalid native configuration fails before readiness, OCR or database creation', () => {
  const cases = [
    { env: { XX_FINANCE_MANAGED_TRIAL: '1' } },
    { env: { XX_FINANCE_MANAGED_TRIAL: '1', XX_FINANCE_USER_DATA_DIR: USER } },
    { env: { ...managedEnv, XX_FINANCE_DATA_DIR: 'relative-ledger' } },
    { env: { XX_FINANCE_USER_DATA_DIR: 'relative-user' } },
    { env: { XX_FINANCE_USER_DATA_DIR: USER }, missing: [USER] },
    { env: { XX_FINANCE_USER_DATA_DIR: USER }, files: [[USER, 'symlink']] },
    { env: { XX_FINANCE_USER_DATA_DIR: USER }, files: [[USER, 'file']] },
    { env: { XX_FINANCE_USER_DATA_DIR: USER }, files: [[path.join(USER, 'logs'), 'symlink']] },
    {
      env: { XX_FINANCE_USER_DATA_DIR: USER },
      files: [[path.join(USER, 'crashDumps'), 'symlink']],
    },
    { env: { ...managedEnv, XX_FINANCE_BACKUP_DIR: 'relative-backups' } },
  ];
  for (const input of cases) {
    const h = harness(input);
    assert.ok(h.startupError);
    assert.deepEqual(h.exitCodes, [1]);
    for (const kind of [
      'whenReady',
      'createOcrService',
      'createLedger',
      'createManagedLedger',
      'window',
    ])
      assert.equal(h.count(kind), 0, kind);
  }
});

test('explicit userData, sessionData, logs and crash paths are isolated before readiness', async () => {
  const h = harness({ env: managedEnv });
  assert.equal(h.startupError, undefined);
  for (const name of ['userData', 'sessionData']) assert.equal(h.paths[name], USER);
  for (const name of ['logs', 'crashDumps']) assert.equal(h.paths[name], path.join(USER, name));
  assert.ok(
    h.calls
      .filter((call) => call.kind === 'setPath')
      .every(
        (call) => h.calls.indexOf(call) < h.calls.findIndex((item) => item.kind === 'whenReady'),
      ),
  );
  assert.equal(h.count('createManagedLedger'), 0);
  await h.start();
  assert.equal(h.count('createManagedLedger'), 1);
});

test('ordinary startup keeps the prior default or explicit ledger route without managed takeover', async () => {
  for (const env of [{}, { XX_FINANCE_DATA_DIR: DATA }]) {
    const h = harness({ env });
    await h.start();
    assert.equal(h.count('createLedger'), 1);
    assert.equal(h.count('createManagedLedger'), 0);
    assert.equal(h.count('setPath'), 0);
    assert.equal(
      h.calls.find((call) => call.kind === 'createLedger').args[0],
      env.XX_FINANCE_DATA_DIR || path.join(DEFAULT_USER, 'stage0-trial'),
    );
    assert.deepEqual(h.exitCodes, []);
  }
});

test('managed startup passes only the configured root, service and backup destination', async () => {
  const h = harness({ env: managedEnv });
  await h.start();
  assert.equal(h.count('createLedger'), 0);
  assert.equal(h.count('createManagedLedger'), 1);
  const { args } = h.calls.find((call) => call.kind === 'createManagedLedger');
  assert.equal(args[0], DATA);
  assert.equal(args[1], h.service);
  assert.equal(args[2].backupDestination, BACKUP);
  const config = h.calls.find((call) => call.kind === 'window').config;
  assert.equal(config.webPreferences.sandbox, true);
  assert.equal(config.webPreferences.contextIsolation, true);
  assert.equal(config.webPreferences.nodeIntegration, false);
});

test('ledger and OCR IPC require the exact main sender, frame and entry file URL', async () => {
  const h = harness({ env: managedEnv });
  await h.start();
  const ledger = h.handlers.get('ledger:command'),
    ocr = h.handlers.get('ocr:recognize'),
    valid = h.trusted(),
    frame = valid.senderFrame,
    url = frame.url;
  const payload = { id: randomUUID(), bytes: new Uint8Array([137, 80, 78, 71]).buffer };
  for (const bad of [
    { sender: {}, senderFrame: frame },
    { sender: valid.sender, senderFrame: { url } },
  ]) {
    await assert.rejects(ledger(bad, { kind: 'read' }), /拒绝非主窗口/);
    await assert.rejects(ocr(bad, payload), /拒绝非主窗口/);
  }
  for (const badUrl of [
    'https://example.invalid/',
    url + '?query=1',
    url + '#fragment',
    pathToFileURL(path.join(base, 'other.html')).href,
  ]) {
    frame.url = badUrl;
    await assert.rejects(ledger(valid, { kind: 'read' }), /拒绝非主窗口/);
    await assert.rejects(ocr(valid, payload), /拒绝非主窗口/);
  }
  assert.equal(h.count('command'), 0);
  assert.equal(h.count('recognize'), 0);
  frame.url = url;
  assert.deepEqual(await ledger(valid, { kind: 'read' }), { synthetic: true });
  assert.deepEqual(await ocr(valid, payload), { synthetic: true });
  assert.equal(h.count('command'), 1);
  assert.equal(h.count('recognize'), 1);
});

test('only the same-entry main-frame reload is allowed, while closing, foreign navigation and permissions stay blocked', async () => {
  const close = deferred(),
    h = harness({ env: managedEnv, close: () => close.promise });
  await h.start();
  const win = h.windows[0],
    url = win.webContents.mainFrame.url;
  assert.equal(win.openHandler().action, 'deny');
  const events = ['will-navigate', 'will-frame-navigate', 'will-redirect'];
  for (const name of events) {
    const reload = { ...event(), isMainFrame: true, url };
    win.webContents.emit(name, reload);
    assert.equal(reload.prevented, 0, name + ' main reload');
    for (const navigation of [
      { isMainFrame: false, url },
      { isMainFrame: true, url: 'https://example.invalid/' },
      { isMainFrame: true, url: url + '#fragment' },
      { isMainFrame: true, url: url + '?query=1' },
      {},
    ]) {
      const attempt = { ...event(), ...navigation };
      win.webContents.emit(name, attempt);
      assert.equal(attempt.prevented, 1, name + ' foreign navigation');
    }
  }
  let allowed = true;
  win.permissionRequest({}, 'synthetic-permission', (value) => {
    allowed = value;
  });
  assert.equal(allowed, false);
  assert.equal(win.permissionCheck(), false);
  assert.equal(h.beforeQuit().prevented, 1);
  for (const name of events) {
    const attempt = { ...event(), isMainFrame: true, url };
    win.webContents.emit(name, attempt);
    assert.equal(attempt.prevented, 1, name + ' closing reload');
  }
  close.resolve();
  await flush();
});

test('repeated quit cannot bypass pending writes, OCR cleanup or asynchronous ledger close', async () => {
  const finished = deferred(),
    write = deferred(),
    close = deferred();
  const h = harness({
    env: managedEnv,
    serviceFinished: finished.promise,
    command: () => write.promise,
    close: () => close.promise,
  });
  await h.start();
  const pending = h.handlers.get('ledger:command')(h.trusted(), { kind: 'synthetic-write' });
  await flush();
  assert.equal(h.count('command'), 1);
  assert.equal(h.beforeQuit().prevented, 1);
  assert.equal(h.beforeQuit().prevented, 1);
  assert.equal(h.count('service.stop'), 1);
  assert.equal(h.count('ledger.close'), 0);
  await assert.rejects(h.handlers.get('ledger:command')(h.trusted(), { kind: 'read' }), /正在关闭/);
  await assert.rejects(
    h.handlers.get('ocr:recognize')(h.trusted(), { id: randomUUID(), bytes: new ArrayBuffer(1) }),
    /正在关闭/,
  );
  assert.equal(h.count('recognize'), 0);
  finished.resolve();
  await flush();
  assert.equal(h.count('ledger.close'), 0);
  write.resolve({ saved: true });
  assert.deepEqual(await pending, { saved: true });
  await flush();
  assert.equal(h.count('ledger.close'), 1);
  assert.equal(h.count('quit'), 0);
  assert.equal(h.beforeQuit().prevented, 1);
  close.resolve();
  await flush();
  assert.equal(h.count('quit'), 1);
  assert.equal(h.quitEvents[0].prevented, 0);
  assert.equal(h.count('ledger.close'), 1);
});

test('a rejected pending command still settles before safe shutdown', async () => {
  const write = deferred(),
    h = harness({ env: managedEnv, command: () => write.promise });
  await h.start();
  const pending = h.handlers.get('ledger:command')(h.trusted(), { kind: 'synthetic-write' }),
    rejection = assert.rejects(pending, /synthetic command failure/);
  await flush();
  h.beforeQuit();
  await flush();
  assert.equal(h.count('ledger.close'), 0);
  write.reject(Object.assign(Error('synthetic command failure'), { status: 409 }));
  await rejection;
  await flush();
  assert.equal(h.count('ledger.close'), 1);
  assert.equal(h.count('quit'), 1);
  assert.equal(h.dialogs.length, 0);
});

test('failed close keeps the closing gate and never reports a successful quit', async () => {
  const h = harness({
    env: managedEnv,
    close: () => Promise.reject(Error('synthetic close failure')),
  });
  await h.start();
  assert.equal(h.beforeQuit().prevented, 1);
  await flush();
  assert.equal(h.count('quit'), 0);
  assert.deepEqual(h.exitCodes, [1]);
  assert.equal(h.dialogs.length, 1);
  assert.match(h.dialogs[0].message, /已保留账本/);
  assert.equal(h.beforeQuit().prevented, 1);
  await flush();
  assert.equal(h.count('ledger.close'), 1);
  assert.equal(h.count('service.stop'), 1);
  await assert.rejects(h.handlers.get('ledger:command')(h.trusted(), { kind: 'read' }), /正在关闭/);
  await assert.rejects(
    h.handlers.get('ocr:recognize')(h.trusted(), { id: randomUUID(), bytes: new ArrayBuffer(1) }),
    /正在关闭/,
  );
});

test('startup failure waits for available ledger cleanup before exiting with an error', async () => {
  const close = deferred(),
    h = harness({
      env: managedEnv,
      loadError: Error('synthetic page startup failure'),
      close: () => close.promise,
    });
  await h.start();
  assert.equal(h.count('service.stop'), 1);
  assert.equal(h.count('ledger.close'), 1);
  assert.deepEqual(h.exitCodes, []);
  assert.equal(h.count('quit'), 0);
  close.resolve();
  await flush();
  assert.deepEqual(h.exitCodes, [1]);
  assert.equal(h.count('quit'), 0);
});

test('ledger creation failure stops OCR and waits for its cleanup without opening a window', async () => {
  const finished = deferred(),
    h = harness({
      env: managedEnv,
      ledgerError: Error('synthetic database startup failure'),
      serviceFinished: finished.promise,
    });
  await h.start();
  assert.equal(h.count('service.stop'), 1);
  assert.equal(h.count('window'), 0);
  assert.equal(h.count('ledger.close'), 0);
  assert.deepEqual(h.exitCodes, []);
  finished.resolve();
  await flush();
  assert.deepEqual(h.exitCodes, [1]);
  assert.equal(h.count('quit'), 0);
});

test('startup cleanup failure exits with error and records that the ledger and lock remain', async () => {
  const h = harness({
    env: managedEnv,
    loadError: Error('synthetic startup failure'),
    close: () => Promise.reject(Error('synthetic close failure')),
  });
  await h.start();
  assert.deepEqual(h.exitCodes, [1]);
  assert.equal(h.count('quit'), 0);
  assert.ok(h.errors.some((message) => message.includes('保留账本及锁')));
  assert.equal(h.count('ledger.close'), 1);
});

test('native restore chooser pins the source to a user-selected directory and passes generation, with cancellation and shutdown protection', async () => {
  const generation = 'synthetic-generation',
    folder = path.join(base, 'synthetic-backup');
  const h = harness({
    env: managedEnv,
    choose: async () => ({ canceled: false, filePaths: [folder] }),
  });
  await h.start();
  const handler = h.handlers.get('ledger:command');
  await handler(h.trusted(), { kind: 'choose-restore', generation });
  assert.equal(h.count('choose'), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find((c) => c.kind === 'command').payload)), {
    kind: 'prepare-restore',
    generation,
    backup: folder,
  });
  await assert.rejects(
    handler(h.trusted(), { kind: 'choose-restore', generation, backup: '/renderer/path' }),
    /无效/,
  );
  assert.equal(h.count('choose'), 1);
  const canceled = harness({ env: managedEnv });
  await canceled.start();
  assert.equal(
    await canceled.handlers.get('ledger:command')(canceled.trusted(), {
      kind: 'choose-restore',
      generation,
    }),
    null,
  );
  assert.equal(canceled.count('command'), 0);
  const choosing = deferred(),
    closing = harness({ env: managedEnv, choose: () => choosing.promise });
  await closing.start();
  const pending = closing.handlers.get('ledger:command')(closing.trusted(), {
    kind: 'choose-restore',
    generation,
  });
  await flush();
  closing.beforeQuit();
  choosing.resolve({ canceled: false, filePaths: [folder] });
  await assert.rejects(pending, /正在关闭/);
  assert.equal(closing.count('command'), 0);
  await flush();
});

test('new marked Mac bundle isolates its default data and refuses an unowned existing folder', async () => {
  const resources = path.join(base, 'resources'),
    marker = path.join(resources, 'mac-trial.json'),
    buildId = randomUUID(),
    root = path.resolve(resources, '../../../mac-trial-data'),
    tag = path.join(root, 'trial-marker.txt');
  const contents = [[marker, JSON.stringify({ format: 1, buildId })]];
  const h = harness({ packaged: true, platform: 'darwin', files: [[marker, 'file']], contents });
  await h.start();
  assert.equal(h.count('createManagedLedger'), 1);
  assert.equal(
    h.calls.find((c) => c.kind === 'createManagedLedger').args[0],
    path.join(root, 'user-data', 'ledger'),
  );
  assert.equal(h.paths.userData, path.join(root, 'user-data'));
  assert.equal(h.count('createLedger'), 0);
  const reopen = harness({
    packaged: true,
    platform: 'darwin',
    files: [
      [marker, 'file'],
      [root, 'directory'],
      [tag, 'file'],
    ],
    contents: [...contents, [tag, buildId + '\n']],
  });
  await reopen.start();
  assert.equal(reopen.count('createManagedLedger'), 1);
  for (const extra of [[], [[tag, 'file']]]) {
    const rejected = harness({
      packaged: true,
      platform: 'darwin',
      files: [[marker, 'file'], [root, 'directory'], ...extra],
      contents: [...contents, [tag, 'different']],
    });
    assert.deepEqual(rejected.exitCodes, [1]);
    assert.equal(rejected.count('whenReady'), 0);
    assert.equal(rejected.count('createManagedLedger'), 0);
    assert.equal(rejected.count('writeFile'), 0);
  }
});

test('opt-in startup diagnostics distinguish ledger, UI, child exit and cleanup without logging payloads', async () => {
  const h = harness({
    env: { ...managedEnv, XX_FINANCE_STARTUP_DIAGNOSTICS: '1' },
    platform: 'win32',
  });
  await h.start();
  const events = () =>
    h.errors
      .filter((line) => line.startsWith('[qianlai-startup] '))
      .map((line) => JSON.parse(line.slice('[qianlai-startup] '.length)));
  assert.deepEqual(
    events().map((item) => item.stage),
    [
      'main-enter',
      'paths-ready',
      'app-ready',
      'ledger-opening',
      'ledger-open',
      'window-created',
      'page-loaded',
    ],
  );
  h.app.emit(
    'child-process-gone',
    {},
    { type: 'GPU', reason: 'crashed', exitCode: -1073741819, name: 'PRIVATE CHILD NAME' },
  );
  h.windows[0].webContents.emit(
    'render-process-gone',
    {},
    { reason: 'oom', exitCode: -1, payload: 'PRIVATE LEDGER FACTS' },
  );
  assert.ok(
    events().some((item) => item.stage === 'child-process-gone' && item.exitCode === -1073741819),
  );
  assert.ok(events().some((item) => item.stage === 'render-process-gone' && item.reason === 'oom'));
  assert.equal(h.count('quit'), 0);
  assert.equal(h.count('ledger.close'), 0);
  assert.equal(h.count('command'), 0);
  assert.equal(h.errors.join('\n').includes('PRIVATE'), false);
  h.beforeQuit();
  await flush();
  assert.ok(events().some((item) => item.stage === 'cleanup-complete'));
  const quiet = harness({ env: managedEnv });
  await quiet.start();
  assert.deepEqual(quiet.errors, []);
  const probe = harness({
    probe: true,
    env: { ...managedEnv, XX_FINANCE_STARTUP_DIAGNOSTICS: '1' },
  });
  await probe.start();
  assert.deepEqual(probe.errors, []);
  assert.equal(probe.logs.length, 1);
});

test('startup failure diagnostics retain the original error and do not claim completed cleanup early', async () => {
  const close = deferred(),
    h = harness({
      env: { ...managedEnv, XX_FINANCE_STARTUP_DIAGNOSTICS: '1' },
      loadError: Error('synthetic load failure'),
      close: () => close.promise,
    });
  await h.start();
  assert.ok(h.errors.some((line) => line.includes('synthetic load failure')));
  assert.ok(h.errors.some((line) => line.includes('"stage":"startup-failed"')));
  assert.equal(
    h.errors.some((line) => line.includes('"stage":"cleanup-complete"')),
    false,
  );
  close.resolve();
  await flush();
  assert.deepEqual(h.exitCodes, [1]);
  assert.ok(h.errors.some((line) => line.includes('"stage":"cleanup-complete"')));
});

test('secondary instance never opens a ledger and existing primary regains focus', async () => {
  const secondary = harness({ env: managedEnv, primary: false });
  await secondary.start();
  assert.equal(secondary.count('quit'), 1);
  assert.equal(secondary.count('whenReady'), 0);
  assert.equal(secondary.count('createManagedLedger'), 0);
  assert.equal(secondary.count('window'), 0);
  const primary = harness({ env: managedEnv, minimized: true });
  await primary.start();
  primary.app.emit('second-instance');
  assert.equal(primary.count('restore'), 1);
  assert.equal(primary.count('show'), 1);
  assert.equal(primary.count('focus'), 1);
  primary.beforeQuit();
  await flush();
  primary.app.emit('second-instance');
  assert.equal(primary.count('focus'), 1);
});

test('window close and session query wait for a pending write and release once', async () => {
  for (const name of ['close', 'query-session-end']) {
    const write = deferred(),
      h = harness({ env: managedEnv, command: () => write.promise });
    await h.start();
    const pending = h.handlers.get('ledger:command')(h.trusted(), { kind: 'synthetic-write' });
    await flush();
    const attempt = event();
    h.windows[0].emit(name, attempt);
    assert.equal(attempt.prevented, 1);
    await flush();
    assert.equal(h.count('ledger.close'), 0);
    write.resolve({ saved: true });
    await pending;
    await flush();
    assert.equal(h.count('ledger.close'), 1);
    assert.equal(h.count('quit'), 1);
    const completed = event();
    h.windows[0].emit(name, completed);
    assert.equal(completed.prevented, 0);
  }
});

test('internal portable executable hands off to the supervised launcher without opening a ledger', async () => {
  const portable = { launcher: path.join(base, 'Qianlai.exe'), allowLegacyRecovery: true };
  const redirect = harness({ env: managedEnv, portable, platform: 'win32' });
  await redirect.start();
  assert.equal(redirect.count('spawn'), 1);
  assert.equal(redirect.count('whenReady'), 0);
  assert.equal(redirect.count('createManagedLedger'), 0);
  assert.deepEqual(redirect.exitCodes, [0]);
  const spawn = redirect.calls.find((c) => c.kind === 'spawn');
  assert.equal(spawn.file, portable.launcher);
  assert.equal(spawn.settings.shell, false);
  assert.equal(spawn.settings.windowsHide, true);
  for (const key of Object.keys(managedEnv)) assert.equal(spawn.settings.env[key], undefined);
  const supervised = harness({ env: managedEnv, portable, platform: 'win32', supervised: true });
  await supervised.start();
  assert.equal(supervised.count('spawn'), 0);
  assert.equal(
    supervised.calls.find((c) => c.kind === 'createManagedLedger').args[2].allowLegacyRecovery,
    true,
  );
});

test('fatal runtime errors clean up and exit nonzero with a visible explanation', async () => {
  const h = harness({ env: managedEnv });
  await h.start();
  h.processEvents.emit('uncaughtException', Error('private ledger details'));
  await flush();
  assert.equal(h.count('ledger.close'), 1);
  assert.deepEqual(h.exitCodes, [1]);
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.dialogs[0].message.includes('private'), false);
});

test('idle Windows session end starts cleanup without vetoing shutdown', async () => {
  const h = harness({ env: managedEnv });
  await h.start();
  const attempt = event();
  h.windows[0].emit('query-session-end', attempt);
  assert.equal(attempt.prevented, 0);
  await flush();
  assert.equal(h.count('ledger.close'), 1);
  assert.equal(h.count('quit'), 1);
});
