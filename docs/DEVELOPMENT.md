# 钱来 · 开发指南

怎么装环境、怎么运行、怎么测试、怎么打包。代码结构见 [ARCHITECTURE](ARCHITECTURE.md)。

## 1. 环境

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 26.10.0（Windows 打包 CI 固定用这个） | 2026-11-27 在 Linux + Node 22.23 上构建和全部测试也通过 |
| npm | 随 Node | 只用 `npm ci` 按锁文件安装，不要随手 `npm install` 升级依赖 |

安装依赖、第一次构建需要联网（会下载 Electron 和原生模块）。软件运行本身完全离线。

## 2. 常用命令

```sh
npm ci                  # 按锁文件安装依赖
npm run check           # 一次跑完下面三项（和 PR 自动检查一样）
npm run format:check    # 检查代码格式（Prettier）
npm run build           # TypeScript 类型检查 + 打包网页到 dist/
npm test                # 全部测试（tests/*.test.ts 和 tests/*.test.cjs）

npm run format          # 自动整理代码格式
npm run test:coverage   # 跑测试并列出哪些代码还没被测试覆盖
node --test tests/model.test.ts   # 只跑某一个测试文件
```

预期结果（2026-11-27 重做数据层后，Linux + Node 22）：格式检查通过；构建通过；测试 231 项通过、5 项跳过（Windows 专用）。

### PR 自动检查

每个 PR 和每次合并到 `main`，GitHub 都会自动跑 `.github/workflows/ci.yml`：在 Ubuntu 上 `npm ci` → 格式检查 → 构建 → 全部测试。PR 页面底部会显示通过（绿勾）或失败（红叉）。失败时点进去看是哪一步，修好再推送即可。这项检查只在 Linux 上跑，**不代表** Windows 也通过。

## 3. 本地运行

**永远用一个新的临时文件夹**，不要碰真实账本。程序把这个文件夹当作“钱来文件夹”，在里面建 `数据`、`备份`（桌面版还有 `运行记录`），结构见 [ARCHITECTURE 第 2 节](ARCHITECTURE.md#2-钱来文件夹数据和程序放在一起)。用环境变量 `QIANLAI_HOME`（绝对路径）指定它；不指定时用项目里的 `.local-data/`（已被 Git 忽略）。

### 浏览器开发（最快）

```sh
lsof -nP -iTCP:5173 -sTCP:LISTEN     # 先确认 5173 端口空闲
QIANLAI_HOME=$(mktemp -d "${TMPDIR:-/tmp}/qianlai-dev.XXXXXX") npm run dev
```

打开 http://127.0.0.1:5173/ 。端口固定为 5173：本机接口只接受这个地址发来的请求，所以不能用 `--port` 换端口。备份、恢复、清空在浏览器里也能用；“从其他文件夹恢复或导入”在浏览器里是输入文件夹路径（桌面版是弹出选择框）。

### 桌面版（Electron）开发

```sh
QIANLAI_HOME=$(mktemp -d "${TMPDIR:-/tmp}/qianlai-native.XXXXXX") npm start
```

用同一个文件夹再启动一次，可以检查数据是否保留；把整个文件夹复制到别处再用新位置启动，可以检查“复制文件夹搬家”。

试上传截图时，用 `tests/fixtures/` 里的合成图片，不要用真实截图。

## 4. 打包

### Mac（开发验证用）

```sh
npm run package                      # 输出到 out/
npm run probe:electron               # 用临时数据库检查 SQLite 能否运行
```

Mac 包没有签名和公证，只用于开发验证。

### Windows 离线包

Windows 包**只能在 GitHub Actions 上构建**（`scripts/windows/build-portable.ps1` 会拒绝在其他地方运行）：

1. 打开仓库的 Actions → “Windows portable package” → Run workflow，选择要打包的分支。只能手动触发；工作流文件要先合并到 `main`，按钮才会出现。
2. 构建会在 Windows Server 上编译并测试原生启动器、跑定向 Node 测试、打包、解压后实际启动 GUI 并检查。移除 OCR 后不再需要 Python。
3. 产物在该次运行页面下载，**只保留 7 天**。包内 `build-info.json` 记录源码提交，同名 `.sha256` 文件记录校验值。
4. 用户使用和升级说明是 [WINDOWS_OFFLINE_TRIAL.md](WINDOWS_OFFLINE_TRIAL.md)（会作为 `READ-ME.txt` 打进包里），真机验收清单是 [WINDOWS_VALIDATION.md](WINDOWS_VALIDATION.md)。

每次构建都会消耗 GitHub Actions 额度（Windows 机器比 Linux 消耗得多），发起前先和用户确认。

## 5. 界面检查

改了界面后，用临时数据目录启动，再用浏览器自动化工具实际点一遍。Claude 的云端环境自带 Playwright（`require('playwright')`），有两种方式：

- **浏览器开发模式**：先按第 3 节启动 `npm run dev`，再用 `chromium.launch()` 打开 http://127.0.0.1:5173/ 。
- **真实桌面版**：在 Linux 云端也能跑 Electron（需要虚拟显示器 `xvfb-run`），这样检查的是和用户一样的程序：

```js
// xvfb-run -a node check.cjs
const { _electron } = require('playwright');
const app = await _electron.launch({
  executablePath: 'node_modules/electron/dist/electron',
  args: ['.', '--no-sandbox'],
  env: { ...process.env, QIANLAI_HOME: '<临时文件夹的绝对路径>' },
});
const page = await app.firstWindow();
await page.screenshot({ path: 'overview.png' });
```

`node_modules/electron/dist` 不存在时，先运行 `node node_modules/electron/install.js` 下载 Electron。

桌面版里“从其他文件夹恢复或导入”会弹出系统的选择文件夹对话框，自动化时可以在主进程里替换它：`await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, '<另一个临时钱来文件夹>')`。

建议至少检查三种窗口大小：1400×920、1024×768、800×600。截图和临时脚本放在 Git 忽略的位置（例如系统临时目录或 `evidence/`），**不要提交**。

## 6. Git 规则

- **`.gitignore` 是白名单**：开头一行 `*` 先忽略所有文件，再用 `!` 逐个放行。新建的文件如果不在放行名单里，`git status` 里看不到、也不会被提交。新增文件时：
  - 放在已有的放行位置（例如 `src/renderer/*.tsx`、`src/main/*.cjs`、`tests/*.test.ts`、`docs/*.md`）；或
  - 在 `.gitignore` 里加上对应的 `!` 规则（子文件夹要同时放行文件夹和里面的文件）。
  - 提交前用 `git status --short` 确认新文件确实出现了。
- 这样设计是为了防止误传真实账本、截图、备份和证据。**不要用 `git add -f` 强行加入被忽略的文件。**
- 不在 `main` 上直接提交；在分支上改，开 PR，由用户合并。
- 提交信息写清楚改了什么、为什么。

## 7. 每次改动后的汇报格式

分别写清楚，不要混在一起：

- 实际运行了哪些命令，各自结果（通过几项、失败几项、跳过几项）；
- 在什么平台上运行（Linux 云端 / Mac / Windows CI / Windows 10 真机）；
- 哪些**没有**验证。

Mac 或 Linux 上通过，不能说成 Windows 通过；Windows Server CI 通过，也不能说成 Windows 10 真机通过。
