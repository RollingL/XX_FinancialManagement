# 钱来 · 架构与代码地图

本文说明程序由哪几部分组成、数据存在哪里、一次保存经过哪些步骤，以及每类改动应该先看哪些文件和测试。业务规则见 [BUSINESS_RULES](BUSINESS_RULES.md)，怎么运行见 [DEVELOPMENT](DEVELOPMENT.md)。

> 名字说明：代码目录已在 2026-11-27 整理为 `src/main`、`src/renderer`、`scripts/windows`。数据相关的 `trial`、`stage0`、`isolated-test` 等名字（数据目录、数据库文件、环境变量）还是历史遗留，实际就是正式账本，下一轮重做数据层时统一改名；在那之前**不要单独改它们**，否则旧账本会打不开。

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
│ main.cjs            Electron 入口：窗口、IPC、安全限制、退出收尾        │
│ managed-ledger.cjs  受管账本外壳：写入锁、代际、备份、恢复、清空        │
│ ledger.cjs          账本读写核心（唯一写入口），所有业务校验在这里      │
│ image-check.cjs     保存截图前检查 PNG / JPEG 是否完好                  │
│ ledger-backup.cjs   完整备份导出 / 校验 / 恢复，以及账本严格校验        │
│ ledger-reset.cjs    清空账本（带日志，中断后可继续）                    │
│ ledger-lock.cjs + process-identity.cjs  写入锁                          │
└────────────────────────────────────────────────────────────────────────┘
```

- 界面不能直接读写文件。桌面版只通过 `preload.cjs` 暴露的一个接口（`localLedger.command`）和主进程通信；主进程只接受主窗口、本地页面发来的请求。
- 浏览器开发模式下，同样的请求走 `POST /api/ledger`，由 `vite.config.ts` 挂载的中间件处理，只接受 `127.0.0.1:5173` 页面带特定请求头的请求。
- 截图只作为凭证保存，程序不读取图片里的文字（2026-11-27 移除了 OCR 识别）。
- 每次写操作都返回**整份最新账本**，界面直接用它刷新。

## 2. 两种账本模式

| 模式 | 什么时候用 | 有什么 |
| --- | --- | --- |
| 普通模式 `createLedger`（`ledger.cjs`） | `npm run dev` 默认用项目下 `.local-data/`；`npm start` 不带环境变量时用 Electron 的 `userData/stage0-trial/` | 只有记账，**没有**写入锁、备份、恢复、清空 |
| 受管模式 `createManagedLedger`（`managed-ledger.cjs`） | 设置 `XX_FINANCE_MANAGED_TRIAL=1` 并给出绝对路径；Windows 便携版和 Mac 测试包启动时会自动设置 | 写入锁、代际、完整备份、恢复、清空 |

相关环境变量：

| 变量 | 作用 |
| --- | --- |
| `XX_FINANCE_MANAGED_TRIAL=1` | 启用受管模式 |
| `XX_FINANCE_DATA_DIR` | 账本根目录（受管模式必须是绝对路径） |
| `XX_FINANCE_BACKUP_DIR` | 完整备份写到哪里（必须是已存在的绝对路径） |
| `XX_FINANCE_USER_DATA_DIR` | Electron 的 userData（已存在的普通目录），日志等也放这里 |
| `XX_FINANCE_STARTUP_DIAGNOSTICS=1` | 输出启动阶段日志 |

## 3. 数据存在哪里、长什么样

### 账本根目录

```
<账本根>/
  trial.sqlite            SQLite 数据库（WAL 模式，synchronous=FULL）
  attachments/            截图副本，文件名 <UUID>.png / .jpg
  managed-ledger.json     受管标识（formatVersion、ledgerId、sourceKind="isolated-test"）
  active-ledger.json      恢复后才有：指向当前实际使用的 restored-* 目录
  .writer-lock/           写入锁（软件运行时存在）
  .writer-guard.sqlite    锁的辅助文件，不要删
  reset-journal.json      清空进行中才有
```

### 数据库里的三张表

| 表 | 内容 |
| --- | --- |
| `trial_state` | **只有一行**，`json` 列是整份账本（见下） |
| `operations` | 每个保存请求的编号、内容摘要、类型、时间（用于防重复提交） |
| `attachments` | 截图元数据：编号、文件名、SHA-256、大小、类型 |

整份账本 JSON 的结构以 `src/renderer/ledger.ts` 里的 `LedgerState` 类型为准，主要字段：

| 字段 | 内容 |
| --- | --- |
| `expenses` | 费用列表。含历史字段 `invoice`（旧票额，新费用固定为 0）、可选 `invoiceIssued`、`attachmentId` |
| `advances` | 预支金额数组（分）。**数组下标就是预支编号**，删除时金额改为 0 |
| `advanceDetails` | 以下标为键的预支附加信息：日期、备注、创建时间、截图、是否已删除 |
| `batches` | 报销批次：编号、日期、是否有效、分配列表；旧数据可能有 `invoiceLinks` |
| `expenseEvents` / `advanceEvents` / `batchEvents` | 修改、删除的前后记录（审计） |
| `invoices` / `invoiceEvents` | 旧发票数据，只保留 |
| `generation` | 受管账本的“代际”编号，清空或恢复时更换 |
| `resetReceipt` | 最近一次清空的回执 |

> 这是一份“试用期”留下的存储方式：没有正规表结构，也没有数据格式版本号和升级机制。改动数据格式前，务必先读 [审查报告第 6 条](REVIEW_2026-11-27.md#6-账本数据结构还是试用版)，并同时更新 `ledger.cjs`（写入）和 `ledger-backup.cjs`（校验），否则旧备份可能恢复不了、软件可能打不开。

### Windows 便携版的目录

由 `windows-runtime.cjs` 设置：

```
<解压目录>/
  Qianlai.exe                 原生启动器（scripts/windows/launcher.cpp 编译），日常双击它
  app/ …                      Electron 程序（app/qianlai-app.exe）
  START-TEST.cmd              诊断启动
  CHECK-RUNTIME.cmd           只检查 SQLite 能否运行
  samples/                    一张合成示例截图，可用来试“上传截图”
  READ-ME.txt                 = docs/WINDOWS_OFFLINE_TRIAL.md
  trial-data/                 ★ 全部真实数据
    trial-marker.txt
    user-data/
      stage0-trial/           最初的账本根（受管）
      restored-<UUID>/        每次恢复生成一个，旧的保留
      logs/startup.log
  backups/                    ★ 完整备份，每份一个 backup-<UUID>/ 文件夹
  diagnostics/                诊断日志
```

### Mac 测试包的目录

只有带 `mac-trial.json` 标识的 Mac 包才会自动使用 `.app` 旁边的 `mac-trial-data/`（`user-data/ledger` 为账本根，`backups/` 为备份）。其他情况按普通模式。

### 完整备份的格式

```
backup-<UUID>/
  database.sqlite     数据库一致性快照（SQLite backup 接口）
  attachments/        截图副本
  manifest.json       格式、版本、账本编号、每个文件的大小和 SHA-256、业务汇总
  COMPLETE            最后写入的完成标记；没有它说明备份不完整
```

## 4. 一次保存经过哪些步骤

以“新增一笔带截图的费用”为例：

1. 界面生成请求编号（UUID），把表单和截图（Base64）发给主进程。
2. 受管模式：检查没有正在进行的清空、请求带的代际和当前一致，同一时间只处理一个写请求。
3. `ledger.cjs`：
   1. 校验类别、日期、文字长度、金额。
   2. 计算请求内容摘要；如果同一编号已经处理过：内容相同就直接返回当前账本，不同就拒绝。
   3. 有截图时：`image-check.cjs` 检查图片结构（PNG 逐块核对校验码，JPEG 核对帧头和结束标记；最大 20 MiB、2000 万像素），通过后写入 `attachments/` 并刷盘。界面在上传时也会先用浏览器解码一次，这是两道独立的检查。
   4. 开一个数据库事务：读出整份 JSON → 修改 → 写回；插入附件记录和请求记录；提交。
   5. 事务失败时删掉第 3 步写入的图片。
4. 返回整份账本，界面刷新。

## 5. 其他关键机制

- **代际（generation）**：每个受管账本有一个代际编号，清空和恢复时更换。界面读账本时记住它，之后每次写操作都带上；对不上就拒绝，防止旧窗口把数据写进新账本。
- **写入锁**：`ledger-lock.cjs` 在账本根下建立 `.writer-lock/owner.json`，记录进程号、机器编号和进程启动时间。异常退出后，下次启动会确认原进程确实已经不在，才接管锁（原锁信息会被保留到 `.recovered-writer-lock-*`）。Windows 上查询机器编号和进程启动时间要调用 PowerShell；查询失败时锁无法自动接管。已知风险见 [审查报告第 3 条](REVIEW_2026-11-27.md#3-启动锁太复杂异常退出后可能一直打不开)。
- **启动时的严格校验**：受管账本每次打开都会用 `ledger-backup.cjs` 的 `inspectDatabase` 做完整检查（表结构、每条记录、审计链、金额上限等），不通过就拒绝打开，保护数据不被继续写坏。
- **恢复**：见 [业务规则第 8 节](BUSINESS_RULES.md#完整备份恢复清空)。实现上新目录发布后写一个新的 `active-ledger.json`（先写临时文件再改名），这一步就是“切换完成”的标志。
- **退出**：关闭窗口时先拒绝新请求、等已受理的保存完成、关闭数据库、释放锁，最后才退出。
- **Windows 启动器**：`Qianlai.exe` 把整个 Electron 进程树放进一个 Windows Job，退出时只清理自己启动的子进程。
- **桌面安全**：开启 `sandbox`、`contextIsolation`，关闭 `nodeIntegration`；拒绝打开新窗口、跳转到其他页面和所有权限请求；页面有内容安全策略（`src/renderer/index.html`）。

## 6. 改什么，先看哪里

| 任务 | 先看 | 对应测试（`tests/`） |
| --- | --- | --- |
| 余额、报销分配计算 | `src/renderer/model.ts`、`reimbursement-draft.ts`、`expense-summary.ts` | `model.test.ts`、`batch-save-retry.test.ts`、`batch-delete-ui-model.test.ts`、`expense-summary.test.ts` |
| 费用 / 预支 / 报销的保存规则 | `src/main/ledger.cjs` | `ledger-core.test.cjs`（核心规则）、`record-crud.test.cjs`、`advance-ledger.test.cjs`、`batch-cancellation.test.cjs`、`batch-delete.test.cjs`、`expense-correction.test.cjs`、`invoice-reminder.test.cjs` |
| 主界面、页面交互 | `src/renderer/main.tsx` 及同目录组件 | `ui-actions.test.ts`、`records.test.ts`、`batch-records.test.ts`、`expense-correction-ui.test.ts`、`advance-editor.test.ts` |
| 截图附件 | `src/renderer/Screenshot.tsx`、`image-file.ts`、`src/main/image-check.cjs` | `screenshot.test.ts`、`image-file.test.ts`、`image-check.test.cjs`、`advance-attachment.test.cjs`；合成图片在 `tests/fixtures/`，测试里生成图片用 `tests/synthetic-image.cjs` |
| CSV 导出 | `expense-export.ts`、`expense-download.ts` | `expense-export.test.ts`、`expense-download.test.ts` |
| 备份、恢复、清空 | `src/main/managed-ledger.cjs`、`ledger-backup.cjs`、`ledger-reset.cjs`、`ledger-maintenance.cjs`（命令行工具）、`src/renderer/BackupPage.tsx` | `managed-ledger.test.cjs`、`managed-restore.test.cjs`、`ledger-backup.test.cjs`、`ledger-reset.test.cjs`、`record-backup.test.cjs`、`invoice-backup.test.cjs`、`expense-correction-backup.test.cjs`、`ledger-generation.test.ts` |
| 写入锁 | `src/main/ledger-lock.cjs`、`process-identity.cjs` | `ledger-lock.test.cjs` |
| Electron 启动、IPC、退出 | `src/main/main.cjs`、`preload.cjs` | `electron-main.test.cjs` |
| 浏览器开发接口 | `vite.config.ts`、`ledger.cjs` 的 `ledgerMiddleware` | `ledger-http.test.cjs` |
| Windows 便携包 | `src/main/windows-runtime.cjs`、`scripts/windows/`（`launcher.cpp`、`prepare-portable.cjs`、`package-check.cjs`、`build-portable.ps1`）、`.github/workflows/windows-portable.yml` | `windows-*.test.cjs`、`windows-gui-smoke.cjs`（只在 Windows 构建里跑） |
