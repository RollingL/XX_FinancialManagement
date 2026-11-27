// Electron entry: finds the home folder, opens the ledger, creates the window and
// passes the window's requests to the ledger. Shuts down only after saves finish.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const isProbe = process.argv.includes('--probe');
const projectRoot = path.join(__dirname, '..', '..');
const appMenu = require('./app-menu.cjs');
app.commandLine.appendSwitch('lang', appMenu.INTERFACE_LANGUAGE);

function ensureDirectory(folder) {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error(`“${path.basename(folder)}”必须是普通文件夹，请保留现有文件`);
  return folder;
}
// Electron's own files (cache, logs, crash reports) stay inside the home folder too,
// and the one-window-only lock is tied to that folder.
function useRuntimeFolder(root) {
  ensureDirectory(root);
  app.setPath('userData', root);
  app.setPath('sessionData', root);
  for (const name of ['logs', 'crashDumps'])
    app.setPath(name, ensureDirectory(path.join(root, name)));
}

// The probe checks SQLite in its own sub-folder, whose files are all closed by the time it
// finishes, so that sub-folder must be removed. The rest of the temporary folder is
// Electron's own profile (for example the GPU cache), which Electron's helper processes keep
// open until the program has exited; Windows cannot delete open files, so removing it is only
// tried. It never holds ledger data.
function removeProbeFolder(sqliteDir) {
  fs.rmSync(sqliteDir, { recursive: true, force: true });
  try {
    fs.rmSync(probeDir, { recursive: true, force: true });
  } catch {
    // Left in the system temporary folder; see above.
  }
}

let layout = null,
  portable = null,
  probeDir = null;
try {
  if (isProbe) {
    probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qianlai-probe-'));
    app.setPath('userData', probeDir);
    app.setPath('sessionData', probeDir);
  } else {
    const resolved = require('./app-paths.cjs').resolveHome({
      packaged: app.isPackaged,
      platform: process.platform,
      resourcesPath: process.resourcesPath,
      env: process.env,
      projectRoot,
    });
    layout = require('./ledger-schema.cjs').homeLayout(resolved.home);
    if (resolved.portable) portable = { launcher: path.join(resolved.home, 'Qianlai.exe') };
    ensureDirectory(layout.home);
    useRuntimeFolder(layout.runtimeDir);
  }
} catch (error) {
  console.error(`启动配置无效：${error.message}`);
  dialog.showErrorBox('无法启动钱来', error.message);
  app.exit(1);
  throw error;
}

// Startup diagnostics contain stages only, never ledger facts or request contents.
let diagnosticsPath;
function startupEvent(stage, details = {}) {
  if (isProbe) return;
  if (process.env.QIANLAI_STARTUP_DIAGNOSTICS !== '1' && !portable) return;
  const line =
    '[qianlai-startup] ' +
    JSON.stringify({ time: new Date().toISOString(), pid: process.pid, stage, ...details });
  console.error(line);
  if (diagnosticsPath) {
    try {
      if (fs.existsSync(diagnosticsPath)) {
        const stat = fs.lstatSync(diagnosticsPath);
        if (!stat.isFile() || stat.isSymbolicLink()) return;
        if (stat.size > 1024 * 1024) {
          const previous = diagnosticsPath + '.previous';
          if (fs.existsSync(previous)) {
            const old = fs.lstatSync(previous);
            if (!old.isFile() || old.isSymbolicLink()) return;
            fs.unlinkSync(previous);
          }
          fs.renameSync(diagnosticsPath, previous);
        }
      }
      fs.appendFileSync(diagnosticsPath, line + '\n', { mode: 0o600 });
    } catch {
      /* A diagnostic failure never affects the ledger. */
    }
  }
}
if (portable) diagnosticsPath = path.join(app.getPath('logs'), 'startup.log');
startupEvent('main-enter', { platform: process.platform });
startupEvent('paths-ready');
app.on('child-process-gone', (_event, details) =>
  startupEvent('child-process-gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
  }),
);
app.on('quit', (_event, exitCode) => startupEvent('quit', { exitCode }));

let ledger,
  mainWindow,
  closing = false,
  closed = false,
  disposal,
  fatal = false;
const pendingLedger = new Set();
function dispose() {
  return (disposal ??= (async () => {
    startupEvent('cleanup-start');
    await Promise.allSettled([...pendingLedger]);
    await ledger?.close();
    startupEvent('cleanup-complete');
  })());
}
function shutdown() {
  if (closing) return;
  closing = true;
  dispose()
    .then(() => {
      closed = true;
      if (fatal) app.exit(1);
      else app.quit();
    })
    .catch(() => {
      startupEvent('cleanup-failed');
      dialog.showErrorBox(
        '关闭未完成',
        '关闭过程没有完成，账本已保留。重新打开钱来时会再次检查账本。',
      );
      app.exit(1);
    });
}

// The Windows launcher runs the whole process tree inside a private Windows Job.
let redirected = false;
if (portable && !process.argv.includes('--qianlai-supervised')) {
  redirected = true;
  try {
    const launcher = spawn(portable.launcher, [], {
      env: { ...process.env },
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
      shell: false,
    });
    launcher.on('error', () => {
      dialog.showErrorBox('无法启动钱来', '请完整解压离线包，从 Qianlai.exe 启动。');
      app.exit(1);
    });
    launcher.once('spawn', () => {
      launcher.unref();
      app.exit(0);
    });
  } catch (error) {
    dialog.showErrorBox('无法启动钱来', error.message);
    app.exit(1);
  }
}
const primary = redirected ? false : isProbe || app.requestSingleInstanceLock();
if (!redirected && !primary) app.quit();
app.on('second-instance', () => {
  if (mainWindow && !closing) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
app.on('before-quit', (event) => {
  if (isProbe || closed || !primary) return;
  event.preventDefault();
  shutdown();
});
process.on?.('SIGTERM', shutdown);
process.on?.('SIGINT', shutdown);
function fatalShutdown(stage) {
  fatal = true;
  startupEvent(stage);
  if (!closing)
    dialog.showErrorBox(
      '钱来已停止运行',
      '程序遇到异常，正在关闭，账本已保留。请重新打开；如果反复出现，请保留“运行记录”文件夹。',
    );
  shutdown();
}
process.on?.('uncaughtException', () => fatalShutdown('fatal-exception'));
process.on?.('unhandledRejection', () => fatalShutdown('unhandled-rejection'));

const pad = (n) => String(n).padStart(2, '0');
function stamp(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}
// A damaged or unreadable ledger can be renamed (never deleted) so the program opens
// with an empty ledger; the user then restores from a backup on the 备份 page.
// Returns 'relaunch', 'shown' (the user saw the message and chose to quit) or 'none'.
function offerSetAside(error) {
  if (!['LEDGER_DAMAGED', 'LEDGER_INVALID', 'LEDGER_FOREIGN'].includes(error.code)) return 'none';
  const aside = `${layout.dataDir}-有问题-${stamp()}`;
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: '账本打不开',
    message: error.message,
    detail:
      `可以把现在的“${path.basename(layout.dataDir)}”文件夹改名为“${path.basename(aside)}”保存起来（不会删除），` +
      '然后用空账本打开钱来，再到“备份”页选一份备份恢复。',
    buttons: ['退出', '改名保存并重新打开'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (choice !== 1) return 'shown';
  fs.renameSync(layout.dataDir, aside);
  app.relaunch();
  return 'relaunch';
}

function folderFor(which) {
  if (which === 'backups') return ensureDirectory(layout.backupDir);
  if (which === 'home') return layout.home;
  throw Object.assign(Error('文件夹无效'), { status: 422 });
}

if (primary)
  app
    .whenReady()
    .then(async () => {
      startupEvent('app-ready');
      if (closing) return;
      if (isProbe) {
        const sqliteDir = path.join(probeDir, 'sqlite');
        let exitCode = 1;
        try {
          const sqlite = await require('./sqlite-probe.cjs')(sqliteDir);
          if (sqlite?.status !== 'passed') throw Error('SQLite 依赖探针未通过');
          console.log(JSON.stringify({ sqlite, packaged: app.isPackaged }, null, 2));
          exitCode = 0;
        } catch (error) {
          console.error(error);
        }
        try {
          removeProbeFolder(sqliteDir);
        } catch (error) {
          console.error(error);
          exitCode = 1;
        }
        app.exit(exitCode);
        return;
      }
      const template = appMenu.menuTemplate(process.platform);
      Menu.setApplicationMenu(template && Menu.buildFromTemplate(template));
      startupEvent('ledger-opening');
      ledger = require('./ledger-service.cjs').openLedgerService(layout.home);
      startupEvent('ledger-open');
      const win = new BrowserWindow({
        width: 1400,
        height: 920,
        minWidth: 800,
        minHeight: 600,
        title: '钱来财务管理系统',
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      mainWindow = win;
      startupEvent('window-created');
      win.webContents.on('render-process-gone', (_event, details) => {
        startupEvent('render-process-gone', { reason: details.reason, exitCode: details.exitCode });
        if (details.reason !== 'clean-exit') fatalShutdown('renderer-failed');
      });
      const entry = path.join(projectRoot, 'dist', 'index.html'),
        entryURL = pathToFileURL(entry).href;
      const trusted = (event) =>
        event.sender === win.webContents &&
        event.senderFrame === win.webContents.mainFrame &&
        event.senderFrame.url === entryURL;
      const invalid = (message) => Object.assign(Error(message), { status: 422 });
      async function handle(payload) {
        if (payload?.kind === 'choose-restore') {
          if (
            Object.keys(payload).sort().join(',') !== 'generation,kind' ||
            typeof payload.generation !== 'string'
          )
            throw invalid('恢复选择请求无效');
          const selected = await dialog.showOpenDialog(win, {
            title: '选择一份备份，或旧的钱来文件夹',
            defaultPath: layout.backupDir,
            properties: ['openDirectory'],
          });
          if (selected.canceled) return null;
          if (closing || selected.filePaths.length !== 1)
            throw invalid('恢复选择已取消或程序正在关闭');
          return ledger.command({
            kind: 'prepare-restore',
            generation: payload.generation,
            source: selected.filePaths[0],
          });
        }
        if (payload?.kind === 'backup-elsewhere') {
          if (
            Object.keys(payload).sort().join(',') !== 'generation,kind,requestId' ||
            typeof payload.generation !== 'string'
          )
            throw invalid('备份请求无效');
          const selected = await dialog.showOpenDialog(win, {
            title: '选择 U 盘或其他位置，把账本备份到那里',
            buttonLabel: '备份到这里',
            properties: ['openDirectory', 'createDirectory'],
          });
          if (selected.canceled) return null;
          if (closing || selected.filePaths.length !== 1)
            throw invalid('备份位置选择已取消或程序正在关闭');
          return ledger.command({
            kind: 'create-backup',
            requestId: payload.requestId,
            generation: payload.generation,
            destination: selected.filePaths[0],
          });
        }
        if (payload?.kind === 'show-folder') {
          if (Object.keys(payload).sort().join(',') !== 'kind,which') throw invalid('文件夹无效');
          const problem = await shell.openPath(folderFor(payload.which));
          if (problem) throw invalid('没能打开文件夹：' + problem);
          return { opened: true };
        }
        // Only the native choosers above may name a folder outside 备份/.
        if (payload?.kind === 'prepare-restore' && Object.hasOwn(payload, 'source'))
          throw invalid('恢复预览请求无效');
        if (payload?.kind === 'create-backup' && Object.hasOwn(payload, 'destination'))
          throw invalid('备份请求无效');
        return ledger.command(payload);
      }
      ipcMain.handle('ledger:command', async (event, payload) => {
        if (!trusted(event)) throw Error('拒绝非主窗口请求');
        if (closing) throw Error('程序正在关闭，请稍后重新打开');
        const pending = Promise.resolve().then(() => handle(payload));
        pendingLedger.add(pending);
        try {
          return await pending;
        } catch (e) {
          throw Error(e.status ? e.message : '本地读写失败，请保留表单并重试');
        } finally {
          pendingLedger.delete(pending);
        }
      });
      win.once('closed', () => {
        startupEvent('window-closed');
      });
      win.on('close', (event) => {
        if (!closed) {
          event.preventDefault();
          shutdown();
        }
      });
      win.on('query-session-end', (event) => {
        if (!closed) {
          if (pendingLedger.size) event.preventDefault();
          shutdown();
        }
      });
      win.on('session-end', () => {
        closing = true;
        void dispose().catch(() => startupEvent('session-cleanup-incomplete'));
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guardNavigation = (event) => {
        if (closing || !event.isMainFrame || event.url !== entryURL) event.preventDefault();
      };
      win.webContents.on('will-navigate', guardNavigation);
      win.webContents.on('will-frame-navigate', guardNavigation);
      win.webContents.on('will-redirect', guardNavigation);
      win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      win.webContents.session.setPermissionCheckHandler(() => false);
      await win.loadFile(entry);
      startupEvent('page-loaded');
    })
    .catch(async (error) => {
      closing = true;
      startupEvent('startup-failed');
      console.error(`账本启动失败：${error.message}`);
      let outcome = 'none';
      if (!isProbe && !ledger)
        try {
          outcome = offerSetAside(error);
        } catch (renameError) {
          error.message += `；改名没有成功：${renameError.message}`;
        }
      if (!isProbe && outcome === 'none') dialog.showErrorBox('无法打开钱来', error.message);
      try {
        await dispose();
      } catch {
        startupEvent('cleanup-failed');
        console.error('启动收尾未完成，账本已保留');
      }
      app.exit(outcome === 'relaunch' ? 0 : 1);
    });
app.on('window-all-closed', () => app.quit());
