# 钱来开发交接

2026-11-27 交接。目标是让 Claude 从 GitHub 默认分支继续维护现有离线账本。交接提交沿用 `21d14a715646e784eb5b6bef62e881000914b75b` 的产品源码和测试，保留该 Windows 构建及其祖先历史。本次更新聚焦文档与 Claude 项目入口。

## 接手第一轮

1. 在私有仓库 `RollingL/XX_FinancialManagement` 检出 `main`，用 `git status --short --branch` 和 `git log -5 --oneline` 核对本地改动及版本。`CLAUDE.md` 导入 [AGENTS.md](../AGENTS.md)。
2. 读 [当前状态](STAGE0_STATUS.md#当前状态)，按 [README](../README.md#mac-开发) 安装锁定依赖并跑构建与测试。已有用户账本、备份、截图和验证日志都留在原机器。以合成资料进行首轮验证。
3. 根据接到的具体任务选择下面的源码入口与测试。原 [需求](../expense_bookkeeping_spec_v1.1.md) 和 [实施方案](IMPLEMENTATION_PLAN.md) 记录早期目标。以 [当前状态](STAGE0_STATUS.md#当前状态) 中日期较新的业务决策为准。

## 代码入口

| 任务 | 先看 | 对应测试 |
| --- | --- | --- |
| 费用、报销和资金计算 | `prototype/src/main.tsx`、`model.ts`、`reimbursement-draft.ts`、`ReimbursementRecords.tsx`，写入在 `spike/trial-ledger.cjs` | `model.test.ts`、`batch-*.test.*`、`record-crud.test.cjs`、`expense-correction.test.*` |
| 开票提醒及 CSV | `prototype/src/InvoiceReminder.tsx`、`expense-export.ts`，提醒在 `trial-ledger.cjs` 写入 | `invoice-reminder.test.cjs`、`expense-export.test.ts`、`invoice-backup.test.cjs` |
| OCR 与原图 | `prototype/src/ExpenseScreenshot.tsx`，`spike/ocr-service.cjs` → `ocr_probe.py` → `ocr_fields.py` / `receipt_fields.py`。图片由 `ImagePreview.tsx` 查看 | `expense-image.test.ts`、`ocr-service.test.cjs`、`test_ocr_fields.py`、`test_ocr_stdio.py`，合成图片在 `spike/fixtures/` |
| IPC、桌面启动及退出 | `spike/main.cjs`、`preload.cjs`，浏览器对照 `vite.config.ts`、`ocr-http.cjs` 和 `trial-ledger.cjs` 的 middleware | `electron-main.test.cjs`、`ledger-http.test.cjs` |
| 数据目录、备份恢复与锁 | `spike/managed-ledger.cjs`、`ledger-lock.cjs`、`process-identity.cjs`、`ledger-backup.cjs`、`ledger-reset.cjs` | `managed-*.test.cjs`、`ledger-backup.test.cjs`、`ledger-reset.test.cjs`、`ledger-lock.test.cjs` |
| Windows 可携带包 | `spike/windows-launcher.cpp`、`windows-runtime.cjs`、`prepare-windows-portable.cjs`、`build-windows-trial.ps1`、`.github/workflows/windows-offline-trial.yml` | `windows-*.test.cjs`、`windows-gui-smoke.cjs`，流程见 [Windows 构建与运行](WINDOWS_OFFLINE_TRIAL.md) |

## 独立的 Electron 开发入口

用新临时根启动现有桌面 app。开发版写入该根下的账本、附件、备份和 Electron 用户数据。使用同一根重开可以验证持久化。测试恢复前可在其中新建合成业务记录。

```sh
qianlai_test_root=$(mktemp -d "${TMPDIR:-/tmp}/qianlai-native.XXXXXX")
mkdir "$qianlai_test_root/user-data" "$qianlai_test_root/backups"
XX_FINANCE_MANAGED_TRIAL=1 \
XX_FINANCE_USER_DATA_DIR="$qianlai_test_root/user-data" \
XX_FINANCE_DATA_DIR="$qianlai_test_root/ledger" \
XX_FINANCE_BACKUP_DIR="$qianlai_test_root/backups" \
npm start
```

`user-data` 和备份目标应预先创建为普通目录。新账本根由程序创建并加管理标识。只测试浏览器时用 README 的固定端口入口。Mac OCR 依赖本地 `.venv-ocr` 和模型。制作打包版 OCR helper 时，在 `spike/` 运行 `../.venv-ocr/bin/pyinstaller --noconfirm ocr-probe.spec --distpath ocr-dist --workpath ocr-build`，然后从仓库根执行 `npm run package`。`probe:electron` 需要这个打包 helper 并用独立临时数据库。

## 存储和数据安全

- `trial.sqlite` 中的 `trial_state` 保存一行状态 JSON，`operations` 保存请求信息，`attachments` 保存受管文件元数据及校验。预支保留旧金额数组和稳定编号，删除使用零金额墓碑。旧发票、关联、审计及原图仍可通过备份验证和恢复。
- 受管入口的 `active-ledger.json` 可指向同级 `restored-*` 根。恢复流程先预览并校验，用户确认后备份现有账本，再发布新活动指针。定位真实数据时从原入口解析指针，保留整套目录、附件与独立备份。仅复制入口下的 SQLite 可能得到旧状态或缺失附件。
- Windows 便携入口为完整解压目录的 `Qianlai.exe`。应用数据位于 `trial-data/`，独立备份位于旁边 `backups/`。根目录原生启动器负责进程组清理，账本锁校验同机器 PID 加启动身份。遇到锁提示保留现有目录和日志，按 [诊断记录](WINDOWS_STARTUP_DIAGNOSIS_2026-10-15.md) 取证。
- 真实账本迁移或升级需要先确认实际数据根、完整备份和回退路径。把更新与还原演练放在合成副本。文档、CSV、备份和源码属于不同交付物。

## 接续验证顺序

1. 构建与单元回归后，用独立数据根验证一笔预支、一笔带截图费用、部分报销、开票提醒、完整备份、恢复和重开。报销变更前后比较完整资金事实。涉及 OCR 时核对实付字段与原图附件。
2. Windows 证据固定在历史 CI 源码 `21d14a7` 与运行 `38852211112`。旧产物已过保留期。下一次 Windows 构建需单独确认目的和额度，使用现有专用分支的工作流。
3. 用干净 Windows 10 Intel x64 目标机做首次断网启动和 OCR，记录具体系统版本、运行包 SHA、中文路径、输入法、显示缩放、关闭/重开，以及合成备份恢复。真实账本升级须另行确认。目标矩阵见 [Windows 验证](WINDOWS_VALIDATION.md)。
4. 阶段 0 尚未覆盖实际退款与退还预支、已保存报销批次编辑、物品明细、附件替换、材料包和生产迁移。由用户选定下一项后实施。

10 月 13 日的 Mac 用户实测验收与 Windows 用户阶段认可见 [已验收基线](ACCEPTED_BASELINE_2026-10-13.md)，10 月 16 日独立的 CI 及本机验证见 [稳定性记录](WINDOWS_STABILITY_2026-10-16.md)。在这些记录之外，交接轮的实际命令与结果见 [当前状态](STAGE0_STATUS.md#当前状态)。
