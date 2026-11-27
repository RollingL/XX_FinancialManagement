# 钱来 · 开发指南

怎么装环境、怎么运行、怎么测试、怎么打包。代码结构见 [ARCHITECTURE](ARCHITECTURE.md)。

## 1. 环境

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 26.10.0（Windows 打包 CI 固定用这个） | 2026-11-27 在 Linux + Node 22.23 上构建和全部测试也通过 |
| npm | 随 Node | 只用 `npm ci` 按锁文件安装，不要随手 `npm install` 升级依赖 |
| Python | 3.12 | 只有 OCR 需要；装在项目内的 `.venv-ocr/`，不改系统 Python |

安装依赖、第一次构建需要联网（会下载 Electron 和原生模块）。软件运行本身完全离线。

## 2. 常用命令

```sh
npm ci            # 按锁文件安装依赖
npm run build     # TypeScript 类型检查 + 打包网页到 dist/
npm test          # 全部 Node 测试（tests/*.test.ts 和 tests/*.test.cjs）

# 只跑某一个测试文件
node --test tests/model.test.ts

# Python 字段解析测试（不需要 OCR 模型，系统 Python 3.12+ 即可）
python3 -B -m unittest discover -s tests -p 'test_*.py'
```

预期结果（2026-11-27，Linux）：构建通过；Node 测试 278 项通过、5 项跳过（Windows 专用）；Python 21 项通过。

## 3. 本地运行

**永远用一个新的临时数据目录**，不要碰真实账本。

### 浏览器开发（最快）

```sh
lsof -nP -iTCP:5173 -sTCP:LISTEN     # 先确认 5173 端口空闲
qianlai_dev_root=$(mktemp -d "${TMPDIR:-/tmp}/qianlai-dev.XXXXXX")
XX_FINANCE_DATA_DIR="$qianlai_dev_root/ledger" npm run dev
```

打开 http://127.0.0.1:5173/ 。端口固定为 5173：本机接口只接受这个地址发来的请求，所以不能用 `--port` 换端口。这种方式是普通模式，备份页的功能不可用。

想在浏览器里试备份、恢复、清空，用受管模式：

```sh
root=$(mktemp -d "${TMPDIR:-/tmp}/qianlai-dev.XXXXXX"); mkdir "$root/backups"
XX_FINANCE_MANAGED_TRIAL=1 XX_FINANCE_DATA_DIR="$root/ledger" XX_FINANCE_BACKUP_DIR="$root/backups" npm run dev
```

### 桌面版（Electron）开发

```sh
root=$(mktemp -d "${TMPDIR:-/tmp}/qianlai-native.XXXXXX")
mkdir "$root/user-data" "$root/backups"
XX_FINANCE_MANAGED_TRIAL=1 \
XX_FINANCE_USER_DATA_DIR="$root/user-data" \
XX_FINANCE_DATA_DIR="$root/ledger" \
XX_FINANCE_BACKUP_DIR="$root/backups" \
npm start
```

`user-data` 和 `backups` 要先建好；账本目录由程序自己创建。用同一个 `$root` 再启动一次，可以检查数据是否保留。

### OCR 环境

```sh
python3.12 -m venv .venv-ocr
.venv-ocr/bin/python -m pip install -r spike/requirements.txt
.venv-ocr/bin/python spike/prepare_models.py        # 从锁定的 RapidOCR 包复制 3 个模型并核对哈希
.venv-ocr/bin/python spike/ocr_probe.py spike/fixtures/ocr-sample.png
```

没有 `.venv-ocr` 时，识别会失败；而且**带截图的费用也保存不了**（保存前要用 OCR 子进程检查图片，见审查报告第 10 条）。不带截图的记账不受影响。

## 4. 打包

### Mac（开发验证用）

```sh
cd spike && ../.venv-ocr/bin/pyinstaller --noconfirm ocr-probe.spec --distpath ocr-dist --workpath ocr-build && cd ..
npm run package                      # 输出到 out/
npm run probe:electron               # 用临时数据库检查 SQLite 和随包 OCR
```

Mac 包没有签名和公证，只用于开发验证。

### Windows 离线包

Windows 包**只能在 GitHub Actions 上构建**（`spike/build-windows-trial.ps1` 会拒绝在其他地方运行）：

1. 打开仓库的 Actions → “Windows x64 offline trial candidate” → Run workflow，选择要打包的分支。原来自动触发用的 `codex/windows10-offline-acceptance` 分支已经不存在，现在只能这样手动触发。
2. 构建约需几十分钟，会在 Windows Server 上跑原生启动器测试、定向 Node/Python 测试、打包、解压后实际启动 GUI 并检查。
3. 产物在该次运行页面下载，**只保留 7 天**。包内 `build-info.json` 记录源码提交，同名 `.sha256` 文件记录校验值。
4. 用户使用和升级说明是 [WINDOWS_OFFLINE_TRIAL.md](WINDOWS_OFFLINE_TRIAL.md)（会作为 `READ-ME.txt` 打进包里），真机验收清单是 [WINDOWS_VALIDATION.md](WINDOWS_VALIDATION.md)。

每次构建都会消耗 GitHub Actions 额度（Windows 机器比 Linux 消耗得多），发起前先和用户确认。

## 5. 界面检查

改了界面后，用临时数据目录启动浏览器开发模式，再用浏览器自动化工具实际点一遍。Claude 的云端环境自带 Playwright（`require('playwright')`，`chromium.launch()` 即可），示例：

```js
const {chromium} = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1400, height: 920}, locale: 'zh-CN'});
await page.goto('http://127.0.0.1:5173/');
await page.screenshot({path: 'overview.png'});
```

建议至少检查三种窗口大小：1400×920、1024×768、800×600。截图和临时脚本放在 Git 忽略的位置（例如系统临时目录或 `evidence/`），**不要提交**。

## 6. Git 规则

- **`.gitignore` 是白名单**：开头一行 `*` 先忽略所有文件，再用 `!` 逐个放行。新建的文件如果不在放行名单里，`git status` 里看不到、也不会被提交。新增文件时：
  - 放在已有的放行位置（例如 `prototype/src/*.tsx`、`tests/*.test.ts`、`docs/*.md`）；或
  - 在 `.gitignore` 里加上对应的 `!` 规则（子文件夹要同时放行文件夹和里面的文件）。
  - 提交前用 `git status --short` 确认新文件确实出现了。
- 这样设计是为了防止误传真实账本、截图、备份、证据和模型。**不要用 `git add -f` 强行加入被忽略的文件。**
- 不在 `main` 上直接提交；在分支上改，开 PR，由用户合并。
- 提交信息写清楚改了什么、为什么。

## 7. 每次改动后的汇报格式

分别写清楚，不要混在一起：

- 实际运行了哪些命令，各自结果（通过几项、失败几项、跳过几项）；
- 在什么平台上运行（Linux 云端 / Mac / Windows CI / Windows 10 真机）；
- 哪些**没有**验证。

Mac 或 Linux 上通过，不能说成 Windows 通过；Windows Server CI 通过，也不能说成 Windows 10 真机通过。
