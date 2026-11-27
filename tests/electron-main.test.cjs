const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { EventEmitter } = require('node:events'),
  { pathToFileURL } = require('node:url'),
  { randomUUID } = require('node:crypto');
const mainFile = path.resolve(__dirname, '../src/main/main.cjs'),
  source = fs.readFileSync(mainFile, 'utf8');
const schema = require('../src/main/ledger-schema.cjs');
const base = path.resolve(path.sep, 'synthetic-electron-main'),
  HOME = path.join(base, '钱来'),
  { dataDir: DATA, backupDir: BACKUP, runtimeDir: RUNTIME } = schema.homeLayout(HOME);
// Values made inside the isolated main-process context have their own Array and Object.
const plain = (value) => JSON.parse(JSON.stringify(value));
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
  const files = new Map([[HOME, 'directory'], [RUNTIME, 'directory'], ...(options.files || [])]);
  const platform = options.platform || process.platform,
    resources = path.join(base, 'resources');
  for (const missing of options.missing || []) files.delete(missing);
  const fakeFs = {
    lstatSync(file) {
      const kind = files.get(file);
      if (!kind) throw Object.assign(Error('synthetic ENOENT'), { code: 'ENOENT' });
      return {
        isDirectory: () => kind === 'directory',
        isFile: () => kind === 'file',
        isSymbolicLink: () => kind === 'symlink',
        size: 10,
      };
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
    renameSync(from, to) {
      calls.push({ kind: 'rename', from, to });
      if (options.renameError) throw options.renameError;
    },
    appendFileSync(file, text) {
      calls.push({ kind: 'append', file, text });
    },
    unlinkSync(file) {
      calls.push({ kind: 'unlink', file });
    },
  };
  const processEvents = new EventEmitter();
  const app = new EventEmitter(),
    paths = {};
  app.isPackaged = !!options.packaged;
  app.commandLine = {
    appendSwitch: (name, value) => calls.push({ kind: 'switch', name, value }),
  };
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
  app.relaunch = () => calls.push({ kind: 'relaunch' });
  app.quit = () => {
    calls.push({ kind: 'quit' });
    const attempt = event();
    quitEvents.push(attempt);
    app.emit('before-quit', attempt);
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
  function fakeRequire(name) {
    if (name === 'electron')
      return {
        app,
        BrowserWindow,
        ipcMain,
        Menu: {
          buildFromTemplate: (template) => ({ template }),
          setApplicationMenu: (menu) => calls.push({ kind: 'menu', menu }),
        },
        dialog: {
          showOpenDialog: async (win, settings) => {
            calls.push({ kind: 'choose', win, settings });
            return options.choose ? options.choose() : { canceled: true, filePaths: [] };
          },
          showErrorBox: (title, message) => dialogs.push({ title, message }),
          showMessageBoxSync: (settings) => {
            calls.push({ kind: 'messageBox', settings });
            return options.messageBoxChoice ?? 0;
          },
        },
        shell: {
          openPath: async (folder) => {
            calls.push({ kind: 'openPath', folder });
            return options.openPathProblem ?? '';
          },
        },
      };
    if (name === './app-paths.cjs')
      return {
        resolveHome: (args) => {
          calls.push({ kind: 'resolveHome', args });
          if (options.homeError) throw options.homeError;
          return options.resolved || { home: HOME, portable: false };
        },
      };
    if (name === './ledger-schema.cjs') return schema;
    if (name === './app-menu.cjs') return require('../src/main/app-menu.cjs');
    if (name === './ledger-service.cjs')
      return { openLedgerService: (...args) => factory('openLedgerService', args) };
    if (name === './sqlite-probe.cjs')
      return async (directory) => {
        calls.push({ kind: 'sqliteProbe', directory });
        return Object.hasOwn(options, 'sqliteResult') ? options.sqliteResult : { status: 'passed' };
      };
    if (name === 'node:fs') return fakeFs;
    if (name === 'node:child_process')
      return {
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
  for (const kind of ['resolveHome', 'openLedgerService', 'window', 'command'])
    assert.equal(h.count(kind), 0, kind);
  assert.equal(h.handlers.size, 0);
  assert.equal(h.count('sqliteProbe'), 1);
  assert.equal(h.count('rm'), 1);
  const temporary = h.calls.find((call) => call.kind === 'mkdtemp').file;
  assert.equal(h.calls.find((call) => call.kind === 'rm').file, temporary);
  assert.equal(h.paths.userData, temporary);
  assert.equal(h.paths.sessionData, temporary);
}
test('probe requires an explicit passed SQLite status', async () => {
  for (const result of [{ status: 'failed' }, { status: 'not run' }, {}, null]) {
    const h = harness({ probe: true, packaged: true, platform: 'win32', sqliteResult: result });
    await h.start();
    assert.deepEqual(h.exitCodes, [1]);
    assert.equal(h.logs.length, 0);
    assert.match(h.errors[0], /依赖探针未通过/);
    assertProbeIsolation(h);
  }
});

test('probe succeeds with a passed SQLite report, without UI startup', async () => {
  for (const platform of ['darwin', 'win32'])
    for (const packaged of [false, true]) {
      const h = harness({ probe: true, packaged, platform });
      await h.start();
      assert.deepEqual(h.exitCodes, [0]);
      assert.deepEqual(h.errors, []);
      assert.equal(h.logs.length, 1);
      assert.deepEqual(JSON.parse(h.logs[0]), { sqlite: { status: 'passed' }, packaged });
      assertProbeIsolation(h);
    }
});

test('an unusable home folder stops startup before readiness or opening any ledger', () => {
  const cases = [
    { homeError: Error('QIANLAI_HOME 必须是绝对路径') },
    { files: [[HOME, 'file']] },
    { files: [[HOME, 'symlink']] },
    { files: [[RUNTIME, 'symlink']] },
    { files: [[path.join(RUNTIME, 'logs'), 'symlink']] },
    { files: [[path.join(RUNTIME, 'crashDumps'), 'file']] },
  ];
  for (const input of cases) {
    const h = harness(input);
    assert.ok(h.startupError, JSON.stringify(input.files));
    assert.deepEqual(h.exitCodes, [1]);
    assert.equal(h.dialogs[0].title, '无法启动钱来');
    for (const kind of ['whenReady', 'openLedgerService', 'window'])
      assert.equal(h.count(kind), 0, kind);
  }
});

test('Electron keeps its cache, logs and crash reports in the 运行记录 folder, set before readiness', async () => {
  const h = harness({ env: { QIANLAI_HOME: HOME }, packaged: true, platform: 'linux' });
  assert.equal(h.startupError, undefined);
  const { args } = h.calls.find((call) => call.kind === 'resolveHome');
  assert.deepEqual(
    { ...args, env: { ...args.env } },
    {
      packaged: true,
      platform: 'linux',
      resourcesPath: path.join(base, 'resources'),
      env: { QIANLAI_HOME: HOME },
      projectRoot: path.resolve(__dirname, '..'),
    },
  );
  for (const name of ['userData', 'sessionData']) assert.equal(h.paths[name], RUNTIME);
  for (const name of ['logs', 'crashDumps']) assert.equal(h.paths[name], path.join(RUNTIME, name));
  const ready = h.calls.findIndex((item) => item.kind === 'whenReady');
  assert.ok(
    h.calls
      .filter((call) => call.kind === 'setPath')
      .every((call) => h.calls.indexOf(call) < ready),
  );
  assert.equal(h.count('openLedgerService'), 0);
  await h.start();
  assert.deepEqual(h.calls.find((call) => call.kind === 'openLedgerService').args, [HOME]);
});

test('a missing home and 运行记录 folder are created on first start', async () => {
  const h = harness({ missing: [HOME, RUNTIME] });
  assert.equal(h.startupError, undefined);
  const made = h.calls.filter((call) => call.kind === 'mkdir').map((call) => call.file);
  for (const folder of [
    HOME,
    RUNTIME,
    path.join(RUNTIME, 'logs'),
    path.join(RUNTIME, 'crashDumps'),
  ])
    assert.ok(made.includes(folder), folder);
  await h.start();
  assert.equal(h.count('window'), 1);
});

test('the window keeps the desktop security settings', async () => {
  const h = harness();
  await h.start();
  const config = h.calls.find((call) => call.kind === 'window').config;
  assert.equal(config.webPreferences.sandbox, true);
  assert.equal(config.webPreferences.contextIsolation, true);
  assert.equal(config.webPreferences.nodeIntegration, false);
});

test('built-in controls use Chinese and Windows gets no menu with Reload or Developer Tools', async () => {
  for (const platform of ['win32', 'linux']) {
    const h = harness({ platform });
    assert.deepEqual(
      plain(h.calls.filter((call) => call.kind === 'switch')),
      [{ kind: 'switch', name: 'lang', value: 'zh-CN' }],
      'set before readiness',
    );
    await h.start();
    assert.deepEqual(plain(h.calls.filter((call) => call.kind === 'menu')), [
      { kind: 'menu', menu: null },
    ]);
    assert.ok(
      h.calls.findIndex((call) => call.kind === 'menu') <
        h.calls.findIndex((call) => call.kind === 'window'),
    );
  }
  const mac = harness({ platform: 'darwin' });
  await mac.start();
  const { template } = mac.calls.find((call) => call.kind === 'menu').menu;
  const items = template.flatMap((group) => [group, ...group.submenu]);
  assert.deepEqual(
    template.map((group) => group.label),
    ['钱来', '编辑', '窗口'],
  );
  for (const role of ['quit', 'copy', 'paste', 'selectAll'])
    assert.ok(
      items.some((item) => item.role === role),
      role,
    );
  for (const role of ['reload', 'forceReload', 'toggleDevTools', 'viewMenu'])
    assert.ok(!items.some((item) => item.role === role), role);
  assert.ok(items.every((item) => item.type === 'separator' || /^[一-龥]/.test(item.label)));
});

test('ledger IPC requires the exact main sender, frame and entry file URL', async () => {
  const h = harness();
  await h.start();
  assert.deepEqual([...h.handlers.keys()], ['ledger:command']);
  const ledger = h.handlers.get('ledger:command'),
    valid = h.trusted(),
    frame = valid.senderFrame,
    url = frame.url;
  for (const bad of [
    { sender: {}, senderFrame: frame },
    { sender: valid.sender, senderFrame: { url } },
  ])
    await assert.rejects(ledger(bad, { kind: 'read' }), /拒绝非主窗口/);
  for (const badUrl of [
    'https://example.invalid/',
    url + '?query=1',
    url + '#fragment',
    pathToFileURL(path.join(base, 'other.html')).href,
  ]) {
    frame.url = badUrl;
    await assert.rejects(ledger(valid, { kind: 'read' }), /拒绝非主窗口/);
  }
  assert.equal(h.count('command'), 0);
  frame.url = url;
  assert.deepEqual(await ledger(valid, { kind: 'read' }), { synthetic: true });
  assert.equal(h.count('command'), 1);
});

test('only the same-entry main-frame reload is allowed, while closing, foreign navigation and permissions stay blocked', async () => {
  const close = deferred(),
    h = harness({ close: () => close.promise });
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

test('repeated quit cannot bypass pending writes or asynchronous ledger close', async () => {
  const write = deferred(),
    close = deferred();
  const h = harness({
    command: () => write.promise,
    close: () => close.promise,
  });
  await h.start();
  const pending = h.handlers.get('ledger:command')(h.trusted(), { kind: 'synthetic-write' });
  await flush();
  assert.equal(h.count('command'), 1);
  assert.equal(h.beforeQuit().prevented, 1);
  assert.equal(h.beforeQuit().prevented, 1);
  assert.equal(h.count('ledger.close'), 0);
  await assert.rejects(h.handlers.get('ledger:command')(h.trusted(), { kind: 'read' }), /正在关闭/);
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
    h = harness({ command: () => write.promise });
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
    close: () => Promise.reject(Error('synthetic close failure')),
  });
  await h.start();
  assert.equal(h.beforeQuit().prevented, 1);
  await flush();
  assert.equal(h.count('quit'), 0);
  assert.deepEqual(h.exitCodes, [1]);
  assert.equal(h.dialogs.length, 1);
  assert.match(h.dialogs[0].message, /账本已保留/);
  assert.equal(h.beforeQuit().prevented, 1);
  await flush();
  assert.equal(h.count('ledger.close'), 1);
  await assert.rejects(h.handlers.get('ledger:command')(h.trusted(), { kind: 'read' }), /正在关闭/);
});

test('startup failure waits for available ledger cleanup before exiting with an error', async () => {
  const close = deferred(),
    h = harness({
      loadError: Error('synthetic page startup failure'),
      close: () => close.promise,
    });
  await h.start();
  assert.equal(h.count('ledger.close'), 1);
  assert.deepEqual(h.exitCodes, []);
  assert.equal(h.count('quit'), 0);
  close.resolve();
  await flush();
  assert.deepEqual(h.exitCodes, [1]);
  assert.equal(h.count('quit'), 0);
});

test('ledger creation failure exits with an error without opening a window', async () => {
  const h = harness({ ledgerError: Error('synthetic database startup failure') });
  await h.start();
  assert.equal(h.count('window'), 0);
  assert.equal(h.count('ledger.close'), 0);
  assert.deepEqual(h.exitCodes, [1]);
  assert.equal(h.count('quit'), 0);
  assert.match(h.dialogs[0].message, /synthetic database startup failure/);
});

test('startup cleanup failure exits with error and records that the ledger and lock remain', async () => {
  const h = harness({
    loadError: Error('synthetic startup failure'),
    close: () => Promise.reject(Error('synthetic close failure')),
  });
  await h.start();
  assert.deepEqual(h.exitCodes, [1]);
  assert.equal(h.count('quit'), 0);
  assert.ok(h.errors.some((message) => message.includes('启动收尾未完成，账本已保留')));
  assert.equal(h.count('ledger.close'), 1);
});

test('only the native folder chooser can name a folder outside 备份, and cancelling or closing stops it', async () => {
  const generation = 'synthetic-generation',
    folder = path.join(base, '旧的钱来');
  const h = harness({ choose: async () => ({ canceled: false, filePaths: [folder] }) });
  await h.start();
  const handler = h.handlers.get('ledger:command');
  await handler(h.trusted(), { kind: 'choose-restore', generation });
  const choose = h.calls.find((c) => c.kind === 'choose');
  assert.equal(choose.settings.defaultPath, BACKUP);
  assert.deepEqual(plain(choose.settings.properties), ['openDirectory']);
  assert.deepEqual(plain(h.calls.find((c) => c.kind === 'command').payload), {
    kind: 'prepare-restore',
    generation,
    source: folder,
  });
  await assert.rejects(
    handler(h.trusted(), { kind: 'choose-restore', generation, source: '/renderer/path' }),
    /无效/,
  );
  await assert.rejects(
    handler(h.trusted(), { kind: 'prepare-restore', generation, source: '/renderer/path' }),
    /恢复预览请求无效/,
  );
  assert.equal(h.count('choose'), 1);
  assert.equal(h.count('command'), 1);
  await handler(h.trusted(), {
    kind: 'prepare-restore',
    generation,
    backup: '2026-11-27_自动备份',
  });
  assert.equal(h.count('command'), 2);
  const canceled = harness();
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
    closing = harness({ choose: () => choosing.promise });
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

test('the window can open only the 备份 folder or the whole 钱来 folder in the file manager', async () => {
  const h = harness({ missing: [BACKUP] });
  await h.start();
  const handler = h.handlers.get('ledger:command');
  assert.deepEqual(plain(await handler(h.trusted(), { kind: 'show-folder', which: 'backups' })), {
    opened: true,
  });
  assert.ok(h.calls.some((call) => call.kind === 'mkdir' && call.file === BACKUP));
  await handler(h.trusted(), { kind: 'show-folder', which: 'home' });
  assert.deepEqual(
    h.calls.filter((call) => call.kind === 'openPath').map((call) => call.folder),
    [BACKUP, HOME],
  );
  for (const payload of [
    { kind: 'show-folder', which: 'data' },
    { kind: 'show-folder', which: '/etc' },
    { kind: 'show-folder', which: 'home', path: '/etc' },
  ])
    await assert.rejects(handler(h.trusted(), payload), /文件夹无效/);
  assert.equal(h.count('openPath'), 2);
  assert.equal(h.count('command'), 0);
  const failing = harness({ openPathProblem: '合成的打开失败' });
  await failing.start();
  await assert.rejects(
    failing.handlers.get('ledger:command')(failing.trusted(), {
      kind: 'show-folder',
      which: 'home',
    }),
    /没能打开文件夹：合成的打开失败/,
  );
});

test('a damaged ledger can be renamed aside (never deleted) so the program reopens empty', async () => {
  const damaged = Object.assign(Error('账本文件已损坏，无法读取'), { code: 'LEDGER_DAMAGED' });
  const accept = harness({ ledgerError: damaged, messageBoxChoice: 1 });
  await accept.start();
  const box = accept.calls.find((call) => call.kind === 'messageBox').settings;
  assert.equal(box.message, '账本文件已损坏，无法读取');
  assert.deepEqual(plain(box.buttons), ['退出', '改名保存并重新打开']);
  assert.equal(box.cancelId, 0);
  const rename = accept.calls.find((call) => call.kind === 'rename');
  assert.equal(rename.from, DATA);
  assert.match(rename.to, /数据-有问题-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
  assert.equal(path.dirname(rename.to), HOME);
  assert.equal(accept.count('relaunch'), 1);
  assert.equal(accept.count('rm'), 0);
  assert.deepEqual(accept.exitCodes, [0]);
  assert.deepEqual(accept.dialogs, []);
  assert.equal(accept.count('window'), 0);

  const decline = harness({ ledgerError: damaged, messageBoxChoice: 0 });
  await decline.start();
  assert.equal(decline.count('rename'), 0);
  assert.equal(decline.count('relaunch'), 0);
  assert.deepEqual(decline.exitCodes, [1]);
  assert.deepEqual(decline.dialogs, []);

  const failed = harness({
    ledgerError: damaged,
    messageBoxChoice: 1,
    renameError: Error('合成的改名失败'),
  });
  await failed.start();
  assert.match(failed.dialogs[0].message, /改名没有成功：合成的改名失败/);
  assert.deepEqual(failed.exitCodes, [1]);

  for (const code of ['LEDGER_NEWER', 'LEDGER_IN_USE', undefined]) {
    const other = harness({ ledgerError: Object.assign(Error('合成的其他问题'), { code }) });
    await other.start();
    assert.equal(other.count('messageBox'), 0, code);
    assert.equal(other.count('rename'), 0, code);
    assert.equal(other.dialogs[0].message, '合成的其他问题');
    assert.deepEqual(other.exitCodes, [1]);
  }
});

test('opt-in startup diagnostics distinguish ledger, UI, child exit and cleanup without logging payloads', async () => {
  const h = harness({
    env: { QIANLAI_STARTUP_DIAGNOSTICS: '1' },
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
  const quiet = harness();
  await quiet.start();
  assert.deepEqual(quiet.errors, []);
  const probe = harness({
    probe: true,
    env: { QIANLAI_STARTUP_DIAGNOSTICS: '1' },
  });
  await probe.start();
  assert.deepEqual(probe.errors, []);
  assert.equal(probe.logs.length, 1);
});

test('startup failure diagnostics retain the original error and do not claim completed cleanup early', async () => {
  const close = deferred(),
    h = harness({
      env: { QIANLAI_STARTUP_DIAGNOSTICS: '1' },
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
  const secondary = harness({ primary: false });
  await secondary.start();
  assert.equal(secondary.count('quit'), 1);
  assert.equal(secondary.count('whenReady'), 0);
  assert.equal(secondary.count('openLedgerService'), 0);
  assert.equal(secondary.count('window'), 0);
  const primary = harness({ minimized: true });
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
      h = harness({ command: () => write.promise });
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

test('the inner Windows program hands off to Qianlai.exe in the same folder without opening a ledger', async () => {
  const resolved = { home: HOME, portable: true };
  const redirect = harness({ resolved, platform: 'win32', packaged: true });
  await redirect.start();
  assert.equal(redirect.count('spawn'), 1);
  assert.equal(redirect.count('whenReady'), 0);
  assert.equal(redirect.count('openLedgerService'), 0);
  assert.deepEqual(redirect.exitCodes, [0]);
  const spawn = redirect.calls.find((c) => c.kind === 'spawn');
  assert.equal(spawn.file, path.join(HOME, 'Qianlai.exe'));
  assert.equal(spawn.settings.shell, false);
  assert.equal(spawn.settings.windowsHide, true);
  const supervised = harness({ resolved, platform: 'win32', packaged: true, supervised: true });
  await supervised.start();
  assert.equal(supervised.count('spawn'), 0);
  assert.deepEqual(supervised.calls.find((c) => c.kind === 'openLedgerService').args, [HOME]);
  // The portable build always writes its startup stages to 运行记录/logs/startup.log.
  const log = path.join(RUNTIME, 'logs', 'startup.log');
  const lines = supervised.calls.filter((c) => c.kind === 'append' && c.file === log);
  assert.ok(lines.some((c) => c.text.includes('"stage":"page-loaded"')));
});

test('fatal runtime errors clean up and exit nonzero with a visible explanation', async () => {
  const h = harness();
  await h.start();
  h.processEvents.emit('uncaughtException', Error('private ledger details'));
  await flush();
  assert.equal(h.count('ledger.close'), 1);
  assert.deepEqual(h.exitCodes, [1]);
  assert.equal(h.dialogs.length, 1);
  assert.equal(h.dialogs[0].message.includes('private'), false);
});

test('idle Windows session end starts cleanup without vetoing shutdown', async () => {
  const h = harness();
  await h.start();
  const attempt = event();
  h.windows[0].emit('query-session-end', attempt);
  assert.equal(attempt.prevented, 0);
  await flush();
  assert.equal(h.count('ledger.close'), 1);
  assert.equal(h.count('quit'), 1);
});
