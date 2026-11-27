# 钱来 · 项目约定

所有 AI 助手和开发者共用这份约定。Claude 另外读 [CLAUDE.md](CLAUDE.md)。

## 项目是什么

“钱来”是一个**单人、单账本、人民币、完全离线**的报销台账桌面软件：记录接待和办公费用、公司预支到账、报销进度，算出余额和本人垫付。

- 技术：Electron + React + TypeScript + SQLite（better-sqlite3），OCR 用本地 Python 子进程（RapidOCR + ONNX Runtime）。
- 目标：Windows 10 Intel x64 离线使用（便携 ZIP）；Mac 用于开发。
- 仓库：私有仓库 `RollingL/XX_FinancialManagement`，默认分支 `main`。

## 开始工作前

1. `git status --short --branch` 和 `git log -5 --oneline`，确认分支和有没有未提交的改动。
2. 读 [docs/STATUS.md](docs/STATUS.md)（现状）。
3. 要改业务逻辑，先读 [docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md)（现行规则）；要改代码，先读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 对应章节；怎么运行和测试见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。
4. 已知问题和改进建议见 [docs/REVIEW_2026-11-27.md](docs/REVIEW_2026-11-27.md)。
5. `docs/history/` 是过去的流水记录，只在需要追溯某个决定时看，**不要**把里面的“当前”“下一步”当成现在的要求。

## 和项目负责人沟通

- 负责人是**编程新手**。用简单的中文说明结果，少用术语；必须用术语时顺便解释一句。
- 需要负责人做决定时，同时给出你的建议和理由。
- 能自己完成的事情就自己做，不要让负责人去操作命令行。
- 以下事情要先得到负责人明确同意：动真实账本或真实图片、发布或分发安装包、触发 Windows 打包（消耗 GitHub 额度）、合并到 `main`、删除数据或备份、引入新的大依赖。

## 常用命令

```sh
npm ci                 # 安装依赖（按锁文件）
npm run build          # 类型检查 + 构建网页
npm test               # 全部 Node 测试
python3 -B -m unittest discover -s tests -p 'test_*.py'   # Python 字段解析测试
```

本地运行一定要用临时数据目录，命令见 [DEVELOPMENT 第 3 节](docs/DEVELOPMENT.md#3-本地运行)。

## 业务铁律（改账目逻辑前必读）

完整规则在 [BUSINESS_RULES](docs/BUSINESS_RULES.md)，下面几条任何改动都不能破坏：

1. **公司的所有拨款都记“预支”。** 余额 = 全部有效预支 − 全部费用；允许负数；本人垫付 = max(0, −余额)；余额不受列表筛选影响。
2. **报销只记进度，不动钱。** 报销的新增、撤销、删除都不能改变余额或任何资金记录。
3. **报销进度只从分配算出来**：已报销 = 有效批次分配之和；不允许手动“已报销”开关；单笔累计分配不超过费用金额；批次总额 = 分配之和。
4. **金额用整数“分”**，从文字精确解析，不用浮点数；合计检查安全整数范围。业务日期和操作时间分开保存。
5. **识别、预览、上传截图、勾选开票、导出都不自动记账。** OCR 结果只是候选，必须用户确认。
6. **纠错和删除要留痕**：费用纠错保留编号、原图和前后记录，金额不得低于有效已报销合计；有有效报销的费用不能删除（由用户先撤销批次，系统不自动撤销）；预支删除改为 0 金额并保留编号和记录；旧记录缺日期就保持缺失。
7. **旧发票数据只保留不使用**：不进入资金、报销、筛选、CSV，也不限制纠错。
8. **未支持的业务（退款、退还预支等）不能用“改金额”“删记录”冒充。**

## 数据安全

- **只用临时的合成数据做开发和验证。** 不打开、不复制、不修改真实账本、真实截图和真实备份。
- 测试数据、截图、证据一律虚构，并且一眼能看出是虚构的（例如商户名用“合成商户”）。
- 改动以下任何一项之前，先读 [ARCHITECTURE 第 3、5 节](docs/ARCHITECTURE.md#3-数据存在哪里长什么样) 和对应测试，并在 PR 里写清楚对旧数据的影响：数据库结构、账本 JSON 字段、备份格式、恢复流程、写入锁、数据目录位置和名字。
- 账本 JSON 的规则同时写在 `spike/trial-ledger.cjs`（保存）和 `spike/ledger-backup.cjs`（校验，每次启动受管账本也会用它检查）。**两处必须一起改**，并用旧格式数据测试“还能打开、还能备份恢复”。
- 不要改数据目录名（`trial-data`、`stage0-trial`、`restored-*`）和标识文件内容，除非同时提供经过测试的自动迁移。

## 代码约定

- `spike/` 是正式后端（Electron 主进程、账本、备份、OCR 服务），`prototype/src/` 是正式界面。名字是历史遗留。
- 新写或大改的代码要**正常换行、可读**，不要把逻辑塞进一行。现有代码大量是压缩写法，改到哪里可以顺手整理哪里，但“整理格式”和“改功能”分成不同的提交。
- 不为一次性的需求引入新依赖；不引入 ORM、云服务、远程字体、统计 SDK。
- 界面里给用户看的文字用自然的中文，不出现“试用、原型、合成、阶段 0”这类开发用语。
- 桌面安全设置（`sandbox`、`contextIsolation`、IPC 来源校验、禁止跳转和权限）不能放松。

## 测试要求

- 改账目逻辑必须同时加或改测试。报销相关的测试要比较改动前后**完整的资金数据和余额**，不能只看一个数字。
- 提交前至少跑 `npm run build` 和 `npm test`；动了 OCR 字段解析再跑 Python 测试。
- 只有失败的测试需要反复重跑；没有改动时不必重复跑全部测试。
- 不能为了让测试通过而跳过、删除或放宽测试。

## 验证和汇报

- 分别写清楚：实际跑了哪些命令和结果、在哪个平台上跑的、哪些没有验证。
- Mac 或 Linux 通过 ≠ Windows 通过；Windows Server CI 通过 ≠ Windows 10 真机通过；单元测试通过 ≠ 界面实际可用。
- 界面改动要用浏览器自动化工具在临时账本里实际操作并截图检查（方法见 [DEVELOPMENT 第 5 节](docs/DEVELOPMENT.md#5-界面检查)）。截图和证据放在 Git 忽略的位置，不提交。

## Git

- **`.gitignore` 是白名单**：新文件默认不会被 git 记录。新增文件时要么放在已放行的位置，要么在 `.gitignore` 里加 `!` 规则，提交前用 `git status --short` 确认。**不要用 `git add -f`。** 详见 [DEVELOPMENT 第 6 节](docs/DEVELOPMENT.md#6-git-规则)。
- 只提交审阅过的源码、文档和明确虚构的测试素材。真实账本、附件、备份、本地证据、模型、构建产物、凭证永远不提交。
- 在分支上开发，通过 PR 合并；不直接推 `main`，不强推。

## 文档维护

- 现行文档只有这几份：`README.md`、`AGENTS.md`、`CLAUDE.md`、`docs/STATUS.md`、`docs/BUSINESS_RULES.md`、`docs/ARCHITECTURE.md`、`docs/DEVELOPMENT.md`，以及 Windows 用户说明 `docs/WINDOWS_OFFLINE_TRIAL.md`（会打进安装包）和验收清单 `docs/WINDOWS_VALIDATION.md`。
- 每次改动后更新受影响的现行文档：功能或验证变化 → `STATUS.md`；规则变化 → `BUSINESS_RULES.md`；结构变化 → `ARCHITECTURE.md`。
- **不再为每一轮工作新建验证报告文档。** 本轮做了什么、怎么验证的，写在 PR 描述里。
- 文档用简单清楚的中文，写“是什么、为什么”，不写流水账。
