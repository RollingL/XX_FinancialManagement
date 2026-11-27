// Drives the real desktop program (Electron) the way a person does, in temporary 钱来
// folders with synthetic data only. Run with `npm run test:desktop` (Linux needs a
// display, for example `xvfb-run -a npm run test:desktop`). Set QIANLAI_E2E_SHOTS to a
// folder outside the repository to keep screenshots for a visual check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { _electron } = require('playwright-core');
const electronPath = require('electron');

const root = path.join(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'synthetic-payment.png');
const version = require('../package.json').version;
const shots = process.env.QIANLAI_E2E_SHOTS;
const STEP = { timeout: 15_000 };

function environment(home) {
  const env = { ...process.env, QIANLAI_HOME: home };
  for (const name of Object.keys(env))
    if (name.startsWith('QIANLAI_') && name !== 'QIANLAI_HOME') delete env[name];
  return env;
}
function temporaryFolder(t, prefix) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}
async function launch(t, home) {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [root, '--no-sandbox'],
    cwd: root,
    env: environment(home),
  });
  t.after(() => app.close().catch(() => {}));
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.getByRole('navigation', { name: '主导航' }).waitFor(STEP);
  return { app, page };
}
async function shot(page, name) {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}
const read = (page) => page.evaluate(() => window.localLedger.command({ kind: 'read' }));
// Saves through the window's own bridge, exactly as the screens do (used for setup only).
async function save(page, input) {
  return page.evaluate(
    async (payload) => {
      const state = await window.localLedger.command({ kind: 'read' });
      return window.localLedger.command({ ...payload, generation: state.generation });
    },
    { requestId: randomUUID(), ...input },
  );
}
const go = (page, name) =>
  page.locator('aside.sidebar').getByRole('button', { name, exact: true }).click();
const summary = (page) => page.getByRole('region', { name: '资金与费用统计' });
const sideStatus = (page) => page.locator('aside.sidebar .backup-status');
async function chooseFolderNextTime(app, folder) {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, folder);
}
async function confirmRestore(page) {
  await page.getByPlaceholder('恢复备份').fill('恢复备份');
  await page.getByRole('button', { name: '备份当前账本并恢复' }).click();
  await page.getByRole('navigation', { name: '主导航' }).waitFor(STEP);
  await page.getByText('已用选中的内容恢复账本').waitFor(STEP);
}
const folderNames = (folder) => fs.readdirSync(folder).sort();
const backupsOf = (home, kind) =>
  fs.readdirSync(path.join(home, '备份')).filter((name) => name.endsWith(`_${kind}`));
const withoutGeneration = ({ generation, ...state }) => state;

test(
  'first start, recording by hand, and what the window shows around the page',
  { timeout: 180_000 },
  async (t) => {
    const home = temporaryFolder(t, 'qianlai-e2e-');
    let { app, page } = await launch(t, home);
    assert.deepEqual(folderNames(home), ['备份', '数据', '运行记录']);
    const shell = await app.evaluate(({ app: electronApp, Menu }) => ({
      menu: Menu.getApplicationMenu(),
      locale: electronApp.getLocale(),
    }));
    if (process.platform !== 'darwin') assert.equal(shell.menu, null, 'no English default menu');
    assert.equal(shell.locale, 'zh-CN');
    await page.getByText('从第一笔费用开始').waitFor(STEP);
    await sideStatus(page).getByText('还没有备份').waitFor(STEP);
    await shot(page, '01-empty');

    // An advance of 1000.00 arrives.
    await go(page, '预支');
    await page.getByRole('button', { name: '登记预支到账' }).first().click();
    await page.getByLabel('实际到账金额（元）').fill('1000.00');
    await page.getByLabel('实际到账日期').fill('2026-11-01');
    await page.getByLabel('备注（选填）').fill('合成预支');
    await page.getByRole('button', { name: '确认登记到账' }).click();
    await page.getByText(/已登记预支到账 1,?000\.00 元/).waitFor(STEP);

    // An expense of 1280.50 with a synthetic screenshot: the balance goes below zero.
    await go(page, '接待费用');
    await page.getByRole('button', { name: '新增费用' }).first().click();
    await page.locator('input[type="file"]').setInputFiles(fixture);
    await page.getByText('支付截图已准备好').waitFor(STEP);
    await page.getByLabel('实际支出金额（元）').fill('1280.50');
    await page.getByLabel('实际支出日期').fill('2026-11-02');
    await page.getByLabel('商户', { exact: true }).fill('合成商户');
    await shot(page, '02-new-expense');
    await page.getByRole('button', { name: '确认并保存费用' }).click();
    await summary(page).getByText('本人垫付 ¥280.50').waitFor(STEP);

    // Reimbursing 500.00 records progress only: the balance stays the same.
    await page.getByRole('button', { name: '登记报销' }).first().click();
    await page.getByLabel('报销选择费用 1 合成商户').check();
    await page.getByLabel('本次报销登记金额（元）').fill('500.00');
    await shot(page, '03-reimburse');
    await page.getByRole('button', { name: '确认登记' }).click();
    await page.getByText(/已登记报销 500\.00 元/).waitFor(STEP);
    await summary(page).getByText('本人垫付 ¥280.50').waitFor(STEP);
    await summary(page).getByText('780.50').waitFor(STEP);

    // The invoice reminder saves by itself.
    // The box shows as ticked only once the save is done, so click and wait for the save.
    await page.getByLabel('查看费用 1 详情').click();
    const invoiced = page.getByLabel('是否已开票');
    await invoiced.click();
    await page.getByRole('region', { name: '开票提醒' }).getByText('已标记开票').waitFor(STEP);
    assert.equal(await invoiced.isChecked(), true);
    await shot(page, '04-detail');
    await page.getByLabel('关闭面板').click();

    // The first save of the day made the automatic backup, and the side bar says so.
    await sideStatus(page).getByText('上次备份').waitFor(STEP);
    await sideStatus(page)
      .getByText(/^今天 \d\d:\d\d$/)
      .waitFor(STEP);
    assert.equal(backupsOf(home, '自动备份').length, 1);

    // The side bar stays on screen, so 备份 is reachable at the bottom of a long page.
    for (let i = 0; i < 8; i++)
      await save(page, {
        kind: 'expense',
        expense: {
          category: '办公',
          date: '2026-11-03',
          merchant: `合成文具${i}`,
          amount: 100 + i,
          note: '',
        },
      });
    await page.reload();
    await page.getByRole('navigation', { name: '主导航' }).waitFor(STEP);
    await page.setViewportSize({ width: 1024, height: 640 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const backupEntry = page
      .locator('aside.sidebar')
      .getByRole('button', { name: '备份', exact: true });
    const box = await backupEntry.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 640, JSON.stringify(box));
    await shot(page, '05-scrolled-1024');

    // Everything is still there after closing and opening again.
    const before = await read(page);
    await app.close();
    ({ app, page } = await launch(t, home));
    const after = await read(page);
    assert.deepEqual(withoutGeneration(after), withoutGeneration(before));
    assert.equal(after.expenses[0].merchant, '合成商户');
    assert.equal(after.expenses[0].invoiceIssued, true);
    const screenshot = await page.evaluate(
      (id) => window.localLedger.command({ kind: 'attachment', id }),
      after.expenses[0].attachmentId,
    );
    assert.equal(screenshot.mime, 'image/png');
    await app.close();
  },
);

test(
  'backups: now, to a USB drive, restore, import, clear, and moving the folder',
  { timeout: 240_000 },
  async (t) => {
    const base = temporaryFolder(t, 'qianlai-e2e-');
    const home = path.join(base, '钱来'),
      usb = path.join(base, '合成U盘'),
      oldHome = path.join(base, '旧电脑上的钱来'),
      empty = path.join(base, '空文件夹');
    fs.mkdirSync(usb);
    fs.mkdirSync(empty);

    // An old 钱来 folder to import from later.
    {
      const { app, page } = await launch(t, oldHome);
      await save(page, {
        kind: 'advance',
        advance: { amount: 50000, date: '2026-10-01', note: '' },
      });
      await save(page, {
        kind: 'expense',
        expense: {
          category: '接待',
          date: '2026-10-02',
          merchant: '旧合成商户',
          amount: 1200,
          note: '',
        },
        image: { base64: fs.readFileSync(fixture).toString('base64') },
      });
      await app.close();
    }

    let { app, page } = await launch(t, home);
    await save(page, {
      kind: 'advance',
      advance: { amount: 300000, date: '2026-11-01', note: '' },
    });
    await save(page, {
      kind: 'expense',
      expense: {
        category: '接待',
        date: '2026-11-02',
        merchant: '合成商户',
        amount: 128800,
        note: '',
      },
      image: { base64: fs.readFileSync(fixture).toString('base64') },
    });
    const seeded = await read(page);
    await go(page, '备份');
    await page.getByRole('heading', { name: '自动备份' }).waitFor(STEP);
    await page.getByText(`钱来 版本 ${version}`).waitFor(STEP);

    // 立即备份.
    await page.getByRole('button', { name: '立即备份' }).click();
    await page.getByText(/已备份：.*_手动备份/).waitFor(STEP);

    // 备份到 U 盘: the system folder chooser is answered here.
    await chooseFolderNextTime(app, usb);
    await page.getByRole('button', { name: '备份到 U 盘…' }).click();
    await page.getByText('已备份到：').waitFor(STEP);
    await shot(page, '11-usb-backup');
    assert.deepEqual(folderNames(usb), ['钱来备份']);
    const usbBackup = folderNames(path.join(usb, '钱来备份')).find((name) =>
      name.endsWith('_手动备份'),
    );
    assert.ok(usbBackup);
    assert.equal(folderNames(path.join(usb, '钱来备份', '截图库')).length, 1);

    // A later change, then restore the manual backup from the list.
    await save(page, {
      kind: 'expense',
      expense: {
        category: '办公',
        date: '2026-11-04',
        merchant: '恢复后应消失',
        amount: 1,
        note: '',
      },
    });
    await page.reload();
    await go(page, '备份');
    const list = page.getByRole('list', { name: '备份列表' });
    await list
      .getByRole('listitem')
      .filter({ hasText: '手动备份' })
      .first()
      .getByRole('button', { name: '用这份恢复' })
      .click();
    await page.getByText('请输入').first().waitFor(STEP);
    await confirmRestore(page);
    assert.deepEqual(withoutGeneration(await read(page)), withoutGeneration(seeded));
    assert.equal(backupsOf(home, '恢复前备份').length, 1);

    // A folder with no ledger is refused with a plain Chinese reason.
    await go(page, '备份');
    await chooseFolderNextTime(app, empty);
    await page.getByRole('button', { name: '从其他文件夹恢复或导入…' }).click();
    const refusal = page.getByRole('alert').filter({ hasText: '没有找到钱来账本或备份' });
    await refusal.waitFor(STEP);
    assert.doesNotMatch(await refusal.innerText(), /Error|invoking/);

    // Import the old 钱来 folder.
    await chooseFolderNextTime(app, oldHome);
    await page.getByRole('button', { name: '从其他文件夹恢复或导入…' }).click();
    await page.getByText('另一个钱来文件夹里的账本').waitFor(STEP);
    await shot(page, '12-import-preview');
    await confirmRestore(page);
    const imported = await read(page);
    assert.deepEqual(
      imported.expenses.map((e) => e.merchant),
      ['旧合成商户'],
    );

    // Restore the USB backup, as a new computer would.
    await go(page, '备份');
    await chooseFolderNextTime(app, path.join(usb, '钱来备份', usbBackup));
    await page.getByRole('button', { name: '从其他文件夹恢复或导入…' }).click();
    await page.getByPlaceholder('恢复备份').waitFor(STEP);
    await confirmRestore(page);
    const fromUsb = await read(page);
    assert.deepEqual(withoutGeneration(fromUsb), withoutGeneration(seeded));
    const shotFile = await page.evaluate(
      (id) => window.localLedger.command({ kind: 'attachment', id }),
      fromUsb.expenses[0].attachmentId,
    );
    assert.equal(shotFile.mime, 'image/png');

    // Clear everything, after a safety backup.
    await go(page, '备份');
    await page.getByRole('button', { name: '清空所有数据' }).click();
    await page.locator('#reset-confirmation').fill('清空当前账本');
    await page.getByRole('button', { name: '备份后清空当前账本' }).click();
    await page.getByRole('navigation', { name: '主导航' }).waitFor(STEP);
    await page.getByText('从第一笔费用开始').waitFor(STEP);
    assert.equal((await read(page)).expenses.length, 0);
    assert.equal(backupsOf(home, '清空前备份').length, 1);

    // Restore the pre-clear backup, close, and copy the whole folder somewhere else.
    await go(page, '备份');
    await list
      .getByRole('listitem')
      .filter({ hasText: '清空前备份' })
      .first()
      .getByRole('button', { name: '用这份恢复' })
      .click();
    await confirmRestore(page);
    const restored = await read(page);
    assert.equal(restored.expenses.length, 1);
    await app.close();
    assert.equal(fs.existsSync(path.join(home, '数据', 'qianlai.sqlite-journal')), false);
    const copied = path.join(base, '新电脑', '钱来');
    fs.cpSync(home, copied, { recursive: true });
    ({ app, page } = await launch(t, copied));
    assert.deepEqual(withoutGeneration(await read(page)), withoutGeneration(restored));

    // A second program on the same folder hands over to the open window and quits.
    const second = spawn(electronPath, [root, '--no-sandbox'], {
      cwd: root,
      env: environment(copied),
      stdio: 'ignore',
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('the second program did not quit')), 30_000);
      second.once('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    assert.equal(code, 0);
    assert.equal(app.windows().length, 1, 'the first window is still open');
    await app.close();
  },
);
