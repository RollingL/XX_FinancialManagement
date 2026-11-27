# 钱来 · 架构与代码地图

本文说明程序由哪几部分组成、数据存在哪里、一次保存经过哪些步骤，以及每类改动应该先看哪些文件和测试。业务规则见 [BUSINESS_RULES](BUSINESS_RULES.md)，怎么运行见 [DEVELOPMENT](DEVELOPMENT.md)。

## 1. 总体结构

```
src/
  renderer/   界面（React + TypeScript）
  main/       Electron 主进程和账本后端（Node）
scripts/
  windows/    Windows 便携包的构建脚本和原生启动器
tests/        自动测试和合成测试素材（tests/fixtures/）
```

```
┌──────────────────────── 界面（src/renderer/） ────────────────────────┐
│ main.tsx 主界面 · ReimbursementRecords / BackupPage / Screenshot 等组件 │
│ model.ts 金额计算                                                       │
└───────────────┬───────────────────────────────────┬───────────────────┘
                │ 桌面版：window.localLedger         │ 浏览器开发：fetch /api/ledger
                ▼ （preload.cjs → IPC）              ▼ （vite.config.ts 里的本机中间件）
┌──────────────────── 主进程 / 账本后端（src/main/） ────────────────────┐
│ main.cjs            Electron 入口：找文件夹、窗口、IPC、安全限制、退出  │
│ app-paths.cjs       决定“钱来文件夹”在哪里                              │
│ ledger-service.cjs  程序用的账本：排队执行请求、自动备份、恢复、清空    │
│ ledger.cjs          记账核心（唯一写入口），所有业务校验在这里          │
│ ledger-schema.cjs   账本文件格式：数据表、版本号、升级、一致性检查      │
│ ledger-backup.cjs   备份的写入、列表、清理，以及从备份或旧文件夹读账本  │
│ image-check.cjs     保存截图前检查 PNG / JPEG 是否完好                  │
└────────────────────────────────────────────────────────────────────────┘
```

- 界面不能直接读写文件。桌面版只通过 `preload.cjs` 暴露的一个接口（`localLedger.command`）和主进程通信；主进程只接受主窗口、本地页面发来的请求。
- 浏览器开发模式下，同样的请求走 `POST /api/ledger`，由 `vite.config.ts` 挂载的中间件处理，只接受 `127.0.0.1:5173` 页面带特定请求头的请求。
- 截图只作为凭证保存，程序不读取图片里的文字（2026-11-27 移除了 OCR 识别）。
- 每次写操作都返回**整份最新账本**，界面直接用它刷新。

## 2. 钱来文件夹：数据和程序放在一起

负责人决定（2026-11-27）：用户也是电脑新手，所以**数据和程序放在同一个文件夹里**，换电脑时把整个文件夹复制过去就行。

```
<钱来文件夹>/
  Qianlai.exe            日常双击它（Windows 便携版）
  app/                   程序本身
  数据/                  ★ 账本
    qianlai.sqlite       数据库（只有这一个文件）
    截图/                凭证截图，文件名 <UUID>.png / .jpg
  备份/                  ★ 备份
    截图库/              所有备份共用的截图，按内容命名 <SHA-256>.png / .jpg
    2026-11-27_09-30-12_自动备份/
      qianlai.sqlite     数据库的完整副本
      backup.json        里面有什么：类型、时间、版本、校验码、汇总
      说明.txt           给用户看的说明（怎么恢复）
  运行记录/              Electron 的缓存、日志（logs/startup.log）、崩溃报告；不含账目
  START-TEST.cmd 等      诊断工具（见 WINDOWS_OFFLINE_TRIAL）
```

“钱来文件夹”在哪里由 `app-paths.cjs` 决定：

| 情况 | 钱来文件夹 |
| --- | --- |
| Windows 便携版（打包后） | 解压出来的文件夹本身（`app/resources/../..`），必须有 `windows-portable.json` 标识，否则拒绝启动 |
| 开发（`npm run dev`、`npm start`） | 环境变量 `QIANLAI_HOME`（必须是绝对路径），没有就用项目里的 `.local-data/` |
| 其他打包版本（只用于开发验证） | 程序所在的文件夹（Mac 是 `.app` 旁边） |

- `运行记录` 也在钱来文件夹里，所以 Electron 的“只允许开一个窗口”也是按文件夹算的：同一个文件夹只能开一个钱来；两个不同文件夹（比如旧版和新版）可以同时开。
- 备份按 `截图库` 共享截图：30 份自动备份不会把截图存 30 遍，复制整个文件夹仍然很快。
- 相关环境变量只有两个：`QIANLAI_HOME`（开发用，Windows 便携版忽略它）和 `QIANLAI_STARTUP_DIAGNOSTICS=1`（输出启动阶段日志；便携版总是写 `运行记录/logs/startup.log`）。

## 3. 数据库长什么样

文件格式只在 `ledger-schema.cjs` 里描述一次，`ledger.cjs`（写入）和 `ledger-backup.cjs`（备份、恢复）都用它。

- 文件标记：SQLite 的 `application_id` = `0x514C4149`（“QLAI”），不是这个标记的文件一律不打开、不修改。
- 格式版本：SQLite 的 `user_version`，现在是 **1**（`SCHEMA_VERSION`）。
- 设置：`journal_mode=DELETE`、`synchronous=FULL`、`foreign_keys=ON`。用 DELETE 而不是 WAL，是为了数据库始终只有一个文件，复制文件夹时不会漏掉。
- 所有表都是 `STRICT`（类型不对直接拒绝），单条记录的规则写成表约束：金额是 1 到 2⁵³−1 的整数分、日期必须是真实日期、时间必须是标准格式、类别只能是接待或办公、文字长度有上限。

| 表 | 内容 |
| --- | --- |
| `meta` | 账本编号 `ledger_id`、代际 `generation`、创建时间，以及最近一次恢复或清空的回执 |
| `attachments` | 截图：编号、文件名、类型、大小、SHA-256 |
| `expenses` | 费用。删除只记 `deleted_at`，编号永不重用；`invoice_issued` 是开票提醒 |
| `advances` | 预支。编号从 0 连续递增；删除时金额改 0、记 `deleted_at`，编号、日期、备注保留 |
| `batches` | 报销批次。撤销记 `cancelled_at`，删除记 `deleted_at`，编号永不重用 |
| `allocations` | 批次里每一笔分配：批次、顺序、费用、金额 |
| `events` | 纠错、删除、撤销、开票提醒的前后记录（审计） |
| `operations` | 每个保存请求的编号、内容摘要、类型、时间（防重复提交） |

界面看到的账本形状（`LedgerState`，见 `src/renderer/ledger.ts`）由 `ledger.cjs` 的 `buildView` 从这些表拼出来，和以前的 JSON 形状相同，所以界面不用改。

**跨记录的规则**不能写成表约束，由 `checkLedger` 在每次打开、备份、恢复时检查：文件完整性（`integrity_check`）、表是否齐全、引用是否完整（`foreign_key_check`）、预支编号连续、每笔费用的有效报销不超过费用金额、已删除费用没有有效报销、每个批次至少有一笔分配、账本标识齐全、合计不超出安全范围。

### 以后改格式怎么做

1. 把 `SCHEMA_VERSION` 加 1，改 `TABLES`。
2. 在 `MIGRATIONS[旧版本号]` 写升级步骤（一个函数，在同一个事务里执行）。
3. 加测试：旧版本账本能升级、升级失败不改动任何东西、旧版本的备份能恢复。

打开旧版本账本时，程序会先做一份“升级前备份”，再在一个事务里逐版升级；升级失败什么都不改。比程序新的版本拒绝打开（提示用新版本）。恢复或导入旧版本的备份时，升级只在临时副本上做，原备份不动。

## 4. 一次保存经过哪些步骤

以“新增一笔带截图的费用”为例：

1. 界面生成请求编号（UUID），把表单、截图（Base64）和当前代际发给主进程。
2. `ledger-service.cjs`：请求排队，一次只执行一个；检查代际和当前账本一致。
3. `ledger.cjs`：
   1. 校验类别、日期、文字长度、金额。
   2. 计算请求内容摘要；如果同一编号已经处理过：内容相同就直接返回当前账本，不同就拒绝。
   3. 有截图时：`image-check.cjs` 检查图片结构（PNG 逐块核对校验码，JPEG 核对帧头和结束标记；最大 20 MiB、2000 万像素），通过后写入 `数据/截图/` 并刷盘。界面在上传时也会先用浏览器解码一次，这是两道独立的检查。
   4. 开一个数据库事务：插入附件记录、费用记录、请求记录；提交。
   5. 事务失败时删掉第 3 步写入的图片。
4. `ledger-service.cjs`：如果今天还没有自动备份，就做一份。自动备份失败不影响这次保存，备份页会显示原因。
5. 返回整份账本，界面刷新。

## 5. 其他关键机制

- **防止两个程序同时写**：打开账本时用 SQLite 的独占模式（`locking_mode=EXCLUSIVE`）拿到操作系统的文件锁，直到关闭才放开。程序崩溃或被强制结束时，操作系统会自动释放这个锁，所以**不会出现“锁残留导致打不开”**。另一个钱来打开同一账本会看到“正被另一个钱来窗口使用”。
- **代际（generation）**：每个账本有一个代际编号，清空和恢复时更换。界面读账本时记住它，之后每次写操作都带上；对不上就拒绝，防止旧窗口把数据写进换过的账本。
- **备份**（`ledger-backup.cjs` 的 `createBackup`）：用 `VACUUM INTO` 写一份一致的数据库副本，检查副本，再把截图放进 `截图库`；先写在隐藏的 `.tmp-` 文件夹里，完整后才改名为正式名字，所以中断的备份不会被当成完整备份。写备份时截图已经找不到或损坏的，会记在 `backup.json` 和 `说明.txt` 里。
- **自动备份**：每天打开程序或第一次保存时做一份（空账本不做），只保留最新 30 份**自动**备份；手动备份和安全备份（恢复前、清空前、升级前）不自动删除。`截图库` 里没有任何备份再用的截图会被删除；如果 `备份/` 里有读不懂的文件夹，就跳过这一步，宁可多留。
- **恢复和导入**（同一个流程）：
  1. 预览：找到来源（备份列表里的一份、某份备份文件夹、旧的钱来文件夹或它的 `数据` 文件夹），把数据库**复制到临时文件夹**，在副本上升级和检查，核对每张截图。来源始终不被修改；正被另一个钱来打开的来源会被拒绝。
  2. 确认（输入“恢复备份”）：先给当前账本做“恢复前备份”，把截图复制进来，再在**一个事务**里用副本的内容替换所有表，同时换新代际、记回执；最后删掉不再使用的截图。中途失败时账本保持原样。
  3. 同一个确认请求重试时直接返回第一次的结果，不会恢复两次。
- **清空**：先做“清空前备份”（空账本不做），再在一个事务里删除所有记录、换新代际、记回执，最后删掉截图文件。
- **打不开的账本**：数据库损坏、不是钱来账本或检查不通过时，启动会提示，并可以选择把 `数据` 文件夹改名为 `数据-有问题-<时间>`（不删除），然后用空账本打开，再到备份页恢复。
- **早期测试版数据**（`trial-data`、`trial.sqlite`、`stage0-trial`）不再读取；选中它们会提示“这是早期测试版的数据，新版不能读取”。
- **退出**：关闭窗口时先拒绝新请求、等已受理的保存完成、关闭数据库，最后才退出。
- **Windows 启动器**：`Qianlai.exe` 把整个 Electron 进程树放进一个 Windows Job，退出时只清理自己启动的子进程。
- **桌面安全**：开启 `sandbox`、`contextIsolation`，关闭 `nodeIntegration`；拒绝打开新窗口、跳转到其他页面和所有权限请求；页面有内容安全策略（`src/renderer/index.html`）。只有主进程弹出的“选择文件夹”对话框能指定 `备份/` 以外的文件夹；界面只能请求打开 `备份` 或钱来文件夹本身。

## 6. 改什么，先看哪里

| 任务 | 先看 | 对应测试（`tests/`） |
| --- | --- | --- |
| 余额、报销分配计算 | `src/renderer/model.ts`、`reimbursement-draft.ts`、`expense-summary.ts` | `model.test.ts`、`batch-save-retry.test.ts`、`batch-delete-ui-model.test.ts`、`expense-summary.test.ts` |
| 费用 / 预支 / 报销的保存规则 | `src/main/ledger.cjs` | `ledger-core.test.cjs`（核心规则）、`record-crud.test.cjs`、`advance-ledger.test.cjs`、`batch-cancellation.test.cjs`、`batch-delete.test.cjs`、`expense-correction.test.cjs`、`invoice-reminder.test.cjs` |
| 数据表、版本号、升级、一致性检查、文件锁 | `src/main/ledger-schema.cjs` | `ledger-schema.test.cjs` |
| 备份、恢复、导入、清空、自动备份 | `src/main/ledger-service.cjs`、`ledger-backup.cjs`、`src/renderer/BackupPage.tsx` | `ledger-service.test.cjs`、`ledger-backup.test.cjs`、`ledger-generation.test.ts` |
| 主界面、页面交互 | `src/renderer/main.tsx` 及同目录组件 | `ui-actions.test.ts`、`records.test.ts`、`batch-records.test.ts`、`expense-correction-ui.test.ts`、`advance-editor.test.ts` |
| 截图附件 | `src/renderer/Screenshot.tsx`、`image-file.ts`、`src/main/image-check.cjs` | `screenshot.test.ts`、`image-file.test.ts`、`image-check.test.cjs`、`advance-attachment.test.cjs`；合成图片在 `tests/fixtures/`，测试里生成图片用 `tests/synthetic-image.cjs` |
| CSV 导出 | `expense-export.ts`、`expense-download.ts` | `expense-export.test.ts`、`expense-download.test.ts` |
| 钱来文件夹的位置 | `src/main/app-paths.cjs` | `app-paths.test.cjs` |
| Electron 启动、IPC、退出、打不开时改名 | `src/main/main.cjs`、`preload.cjs` | `electron-main.test.cjs` |
| 浏览器开发接口 | `vite.config.ts`、`ledger.cjs` 的 `ledgerMiddleware` | `ledger-http.test.cjs` |
| Windows 便携包 | `scripts/windows/`（`launcher.cpp`、`prepare-portable.cjs`、`package-check.cjs`、`build-portable.ps1`）、`.github/workflows/windows-portable.yml` | `windows-*.test.cjs`、`windows-gui-smoke.cjs`（只在 Windows 构建里跑，包括“复制整个文件夹后还能打开”） |

测试共用的临时账本工具在 `tests/ledger-fixture.cjs`：`ledgerFixture` 建一个临时账本（因为账本被独占锁住，测试通过 `f.db` 用账本自己的连接查看和修改数据），`seedVariedLedger` 填入各种类型的合成记录。
