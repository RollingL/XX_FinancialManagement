# 阶段 0 状态与交接

## 当前状态

更新：2026-10-12，私有 GitHub 上传准备。**仍处阶段 0；已有 Mac 本地试用保存闭环，阶段 0 尚未整体通过，Windows 全部未验收。** 本节是唯一当前状态；下方日期化记录只说明各历史时点，不自动代表新代码通过或用户仍认可旧视觉。

业务权威：[需求规范 v1.1](../expense_bookkeeping_spec_v1.1.md)。入口：[README](../README.md)。计划：[IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md)。本项目与 iPhone 口袋账本分开。

### 已实现与未完成边界

| 范围 | 当前结论 |
| --- | --- |
| 费用及附件 | 接待／办公摘要＋总额录入、筛选、详情；单张 PNG/JPEG 本机 OCR 辅助金额／日期／商户，人工确认后保存费用与受管附件 |
| 报销 | 多对多分批／合并、跨类别分配、新增及撤销整批持久化；修改已保存批次尚未接入，模型测试不能代替修改功能 |
| 资金口径 | 两类费用共用余额，报销仅登记进度且不改变资金；余额不受列表筛选影响，允许负余额并显示本人垫付；预支录入尚未实现 |
| 试用存储 | SQLite 单行 JSON 状态＋附件元数据＋请求操作表；不是正式关系模型、迁移框架或完整前后值审计 |
| 数据目录 | 浏览器：项目 `.local-data/`；Electron：各运行环境 `app.getPath('userData')/stage0-trial/`。分别保存、不自动同步；首次创建为空，已有数据重开保留 |
| 未完成业务 | 正式预支／退还、物品明细、费用纠错、报销修改、退款、发票多对多额度及查重、PDF、批量／剪贴板导入、导出 |
| 备份与迁移 | 仅新增 [具体方案与 B01–B16 验收清单](BACKUP_RECOVERY_PLAN.md)，功能未实现、清单未执行；本轮未复制、恢复或迁移真实数据，未声称已有可用备份 |
| Windows 与分发 | x64 构建、干净安装、首次断网 OCR、升级、路径、DPI、输入法、时区及进程权限隔离未验证；签名及完整许可审计未完成 |
| 视觉 | 用户本次明确反馈不满意，尚未提供新偏好；既有设计文件仅记录实现。建议先评审费用列表与录入两个关键页面，本轮不改 UI |
| Git 与私有远程 | 已创建 [RollingL/XX_FinancialManagement](https://github.com/RollingL/XX_FinancialManagement)，API 确认 owner=RollingL、private=true、default_branch=main；83 个安全文件的首次提交／推送待完成。作者 Rolling. 与 GitHub noreply 仅配置本仓库，全局配置未改 |

操作细节见 [OCR_REVIEW_UI](OCR_REVIEW_UI.md)。现有资金逻辑符合“公司到账统一预支、支出共用资金池、报销不收付款”的口径，但尚不能通过 UI 录入预支，不能宣称完整资金业务已经实现。请求幂等不等于交易查重，同一截图再次确认仍可能新增费用。

### 已有验证证据及限制

以下为本机已有 2026-10-12 的完整历史集合记录。基础整理时未重跑；随后本轮上传复核另行运行了提交范围中的 15 项 Node、17 项 Python 测试，均通过。未重跑真实 OCR、构建、UI、Windows 或备份恢复验证。

上传隐私复核将两份精确支付样本来源尚未确认的测试保留本地、排除远程；旧 Node 17／Python 24 项记录包含这两份文件，不能直接视为远程检出版本已通过。下述历史证据仍按原范围保留说明。

- [Node 日志](../evidence/stage0/expense-ocr-2026-10-12/unit-tests.log)：17 项通过，包含精度、分配、SQLite 重开、幂等、失败清理和完整派生资金流水／预支／余额比较。
- [Python 日志](../evidence/stage0/expense-ocr-2026-10-12/python-tests.log)：24 项解析测试通过；[构建日志](../evidence/stage0/expense-ocr-2026-10-12/build.log)记录 Vite 构建完成，历史交接记录 TypeScript 检查通过。
- [合成 OCR 回归](../evidence/stage0/expense-ocr-2026-10-12/synthetic-regression.log)：30 张中 29 张精确匹配、1 张安全留空、0 个错误支出建议；严格端到端检查未全部通过。
- [四张真实截图字段匹配](../evidence/stage0/expense-ocr-2026-10-12/real-samples.json)、[浏览器保存记录](../evidence/stage0/expense-ocr-2026-10-12/browser-real-samples.json)：仅代表已授权的四张样本，不是泛化准确率。
- [Mac 原生检查](../evidence/stage0/expense-ocr-2026-10-12/native-checks.json)、[OCR 进程隔离](../evidence/stage0/expense-ocr-2026-10-12/ocr-process-isolation.json)：历史记录支持重启附件可读、私有目录排除及 Mac 禁网禁写；不替代 Windows 验收。
- `spike/sqlite-probe.cjs` 的关系表、外键、资金视图和一致快照属于隔离依赖探针，不能作为试用账本已具备正式模型、完整备份或恢复的证明。

`evidence/` 全部保留本地并排除在本轮 Git 范围外，因此新的检出不自带上述证据。旧 `ship` 仅覆盖当时界面／材料审查，不是软件交付、Windows、安全或用户当前视觉认可。

### 当前授权和最小下一步

用户在基础整理后追加授权：建立 RollingL/XX_FinancialManagement 私有仓库、提交并上传安全审阅的代码与文档；使用现有登录，不创建／提取凭证，不扩展权限。真实账本、用户付款截图、附件、密钥、环境及构建产物不得上传，不部署。不修改业务或 UI，不实现备份，不操作或迁移真实账本；不自动执行历史计划或进入阶段 1。

1. 完成精确清单的初始提交与私有上传，核对 owner、private、main 及远程 SHA；若同名仓库出现则先读历史，不覆盖不明内容。
2. 确认需要保留的试用数据入口、已有外部备份及指定备份位置，再单独排期合成账本备份／恢复演练；方案本身不是实施授权。
3. 收集视觉不满意的具体点或参考方向，先评审布局、信息层级、配色及主要流程，再决定代码修改范围。见 [界面方向记录](PROTOTYPE_DIRECTION.md)。
4. 固定 Windows 11 x64 测试机与具体版本；条件未具备前持续标记未验证。

## 历史：2026-10-12 私有上传隐私复核

- 用户明确批准 RollingL 下的同名私有仓库，范围仅安全源码与文档，无部署。
- GitHub 连接与 gh 现有登录均核实为 RollingL（ID 34366131），profile 名称为 Rolling.；账号创建于 2017-12-08。依据 [GitHub 官方 noreply 格式](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference#your-noreply-email-address)，采用 `34366131+RollingL@users.noreply.github.com`，不使用个人邮箱，不修改全局配置。
- 两份测试 `tests/test_receipt_fields.py`、`tests/trial-ledger.test.cjs` 的精确支付金额／日期时间不能确认与真实样本无关，按保守隐私边界仅保留本地并排除提交；不在报告中复制这些值，不改写原测试文件。
- 其余源码、文档与明确列出的合成素材继续审阅；本地证据、账本、用户截图、附件和凭证保持排除。后续同步结果以本页顶部及实际 Git 提交为准。
- 安全暂存范围为 83 个文件，31 张图片均对应已记录的合成素材；排除的两份测试哈希与操作前一致，运行代码、UI 及需求规范未改。可访问账号仓库清单未发现同名仓库后创建成功，API 返回 owner=RollingL、private=true、default_branch=main。
- 本轮实际命令：`node --test tests/model.test.ts tests/ocr-ui.test.ts tests/ocr-service.test.cjs tests/ledger-http.test.cjs`，15 项通过；`.venv-ocr/bin/python -B -m unittest discover -s tests -p 'test_ocr_fields.py'`，17 项通过。仅使用合成字段、临时目录与模拟 worker，无真实账本、真实 OCR 或真实图片操作。本机日志保存于 `evidence/stage0/github-upload-2026-10-12/`，不上传。

## 历史：2026-10-12 本地版本与文档基础整理

- 授权：只整理 Git、文档和备份恢复方案，视觉问题只记录建议。
- 开始时不是 Git 仓库；项目及上级均无 `.agents` 目录。目标文档打开文件检查未见写入者，后续编辑前核对指纹；这不代表其他开发任务已停机。
- 已初始化本地 `main`；未配置远程。显式身份检查失败：缺少可用提交邮箱，未自行设置姓名、邮箱或全局身份，初始提交待完成。
- `.gitignore` 改为默认排除，仅放行已审阅源码、文档、锁文件和明确列名的合成图片。真实账本、附件、用户截图、凭证、依赖、模型、构建及本地证据不纳入。
- 当前状态集中到本页顶部；实施计划标注目标模型与未实现功能；旧内存／独立不入账面板说明保留为历史；视觉文档补充新反馈。
- 新增 BACKUP_RECOVERY_PLAN，覆盖两类入口隔离、WAL 一致性、附件与完整事实校验、覆盖前备份、故障回退及迁移边界；B01–B16 全部未执行。
- 本轮仅做文件／Git／文档检查；不启动应用，不重跑账目或 OCR 测试，不读写账本、附件或凭证，不复制真实数据。
- 实际静态检查：85 个纳入路径与显式清单一致，暂存内容逐文件与审阅字节一致；31 张图片仅为已记录的 1 张早期合成图与清单中的 30 张合成图，没有额外图片、账本或私有证据。24 个禁止路径和 7 个允许路径的忽略规则检查通过（使用路径字符串，不读取凭证）。
- 修改了 10 个既有文档／忽略规则文件，新增 1 个备份方案；对照开始时 84 个候选文件的 SHA-256，其余 74 个保持不变，包含业务代码、UI、原始需求、测试、锁文件与合成样本。未发现目标文件的外部变化；未据此证明其他任务已停止。
- 10 份修改文档的 85 处相对链接与锚点检查通过（其中 14 处证据链接仅本机存在）；本页只有一个“当前状态”入口，备份验收 B01–B16 均标为未执行。本次修改文件的 `git diff --cached --check` 通过；全量初始暂存检查只提示原始需求第 3、4 行已有 Markdown 行尾双空格，原规范未改写。
- Git 无远程、无提交，未猜测提交身份。真实数据目录未访问，故未做账本逐字节前后比对；本任务没有对其读写、复制、迁移或恢复，不声称排除了外部任务的写入。

## 历史记录阅读说明

以下保留原始开发过程和当时证据。“当前”“本轮”“下一步”等词只对应该历史小节日期；后续范围与授权以顶部为准。基础整理前“未初始化 Git”的描述属于旧状态，已被本次本地初始化替代。

## 历史：2026-10-12 费用内置截图与试用保存

用户本轮明确要求取代独立 OCR 面板，并将截图随费用保存。此前“纯内存/不入账/无附件归档”描述为历史状态。本次仅扩展这一阶段 0 试用闭环，没有开展预支、发票、正式迁移备份等阶段 1 完整开发。

- 主入口：记一笔费用 → 选择截图 → 核对/修正金额、日期、商户 → 确认保存 → 详情查看原图附件。
- 独立 SQLite 试用账本从空开始；费用/已有报销分配及附件刷新后保留，避免混用合成预支。具体目录及限制见 OCR_REVIEW_UI.md。
- 四张用户真实截图：Mac 本机 OS 禁网下金额、日期、商户均与用户给定值一致；浏览器全部经过上传、自动填表、保存、附件打开、刷新重开。重新打开 SQLite 并逐字节比对四个受管副本与原图，一致。
- 不硬编码商户或目标值。微信负号金额依赖已完成支出状态与版式；支出日期取支付/转账时间，不取收款时间。原价、优惠、余额、退款均不补位。
- 原有 30 张合成图回归：29 张完全匹配，1 张全角小数点识别为中点后安全留空，0 错误自动建议；不宣称全部准确。
- Mac 应用包：随包 OCR 对真实截图自动填表通过；手动改金额、取消无记录、仅余额截图三项留空、手动填写合成费用、保存后详情/刷新附件可读取通过。首次冷加载超过浏览器默认 25 秒等待，但在服务 90 秒期限内完成。
- 自动测试：Node 17 项通过（含 SQLite 重开、幂等、防超额、完整资金事实与余额对比、失败无半笔数据、HTTP 来源限制）；Python 24 项通过；TypeScript/Vite 构建通过。
- 证据：`evidence/stage0/expense-ocr-2026-10-12/`。真实图片、交易单号与完整 OCR 文本不写入证据；界面截图只用合成材料。
- Windows x64、干净首次断网安装、升级、中文路径、高 DPI、签名/公证与正式备份恢复：**未验证/未实现**，Mac 结果不代替 Windows 验收。

- 最终 Mac 包跨应用重启后附件仍可读取；1024×768 下页面与抽屉无横向溢出；开发服务器直接访问数据库返回 403。最终包未包含 .local-data 或四张真实截图。真实测试副本已清理，正常入口恢复为空试用账本。
- Mac OCR 子进程补充 OS 文件写入禁令：直接写入尝试被拒绝，禁网且禁写下随包 helper 识别通过；不依赖“进程没有调用数据库”来声称隔离。Windows 权限隔离仍未验证。
- 界面审查最终 ship，仅覆盖已评分的设计文档同步修复；详情图已避开入场动画重新捕获。见本轮 evidence/review.md。

## 历史：2026-10-12 独立截图核对面板（后被费用内置流程替代）
- 用户追加授权：将本地 OCR 接到原型，上传脱敏截图、原图预览、核对三金额、留空及手改；暂不入账，未进入阶段 1。
- 页面右上角新增“截图识别核对”。支持单张 PNG/JPEG，最大 20 MiB / 2000 万像素；取消、错误/重试、90 秒超时；关闭清除本次内容。
- 浏览器使用现有 Vite 的同源本机接口；Electron 使用仅 recognize/cancel 的受限 IPC；共用本地 stdio worker。正常识别复用模型，取消后下次重启。
- 图片只在本机临时处理，正常完成/失败/取消/超时清理临时文件，不上传、不归档、不写 SQLite 或费用内存状态。异常断电/强杀仍可能有系统临时残件。
- 14 项 Node 测试、17 项 Python 解析回归通过；真实 worker 的复用、取消/重试、临时文件清理均通过。证据：evidence/stage0/ocr-ui-2026-10-12/。
- 浏览器实际上传支付、退款、不确定图片通过；手动精度校验、修正、完成前后列表与余额不变、关闭清除、坏图恢复通过。
- Mac .app 已重建。实际桌面上传经 IPC 调用随包 OCR，支付/余额及退款字段通过，非法 IPC 被拒绝。首次随包加载超过工具的 25 秒等待窗口，后续成功且未触发 90 秒超时；没有据此给出性能保证。
- Mac worker 系统级 deny network*；Windows 构建、安装、首次离线及其他实测仍全部未验证。真实截图泛化准确率未验证。
- [操作与数据边界](OCR_REVIEW_UI.md)。UI 审查 ship 仅限截图及前端实现，不代表完整软件交付。


## 历史：2026-10-12 金额字段探针
- 用户反馈录入与报销分配基本可用；仅授权继续阶段 0 字段提取验证，未进入阶段 1。
- 增加保守金额解析：实际支付候选、账户余额、退款及其他干扰金额独立保留；退款/未付款/冲突/低置信度不建议新支出，全部仍需人工确认，不写账本。
- Mac 系统禁网下，30 张合成图片端到端实测：29 张精确符合预期、0 个错误支出建议、1 个安全留空。严格测试退出 1，不称全部通过。
- 全角小数点被 OCR 读为中点；不自动纠字，原图与原始结果保留。17 项解析单元测试通过。
- 详见 [OCR 字段验证报告](OCR_FIELD_VALIDATION.md)。真实脱敏样本、Windows 实测仍未验证。
- 本轮独立 OCR 辅助程序已重建，并通过 3 个样本（每个两次）的系统禁网字段回归；该字段独立验证时未接原型；随后追加的 UI/包验证以本页顶部当前状态为准。


## 历史：2026-10-10 依赖验证及早期交接（含 10 月 12 日同期补记）

### 当时产出
- docs/IMPLEMENTATION_PLAN.md：需求默认项、冲突补充、模型、资金公式、交互、依赖计划、阶段与验收。
- AGENTS.md：业务不变量、安全、验证边界；合并上级文档的 agent-browser 工作流。
- prototype/：React/TypeScript 三关键界面与必要的费用详情；合成内存数据，刷新重置。
- spike/：隔离 SQLite 探针、Python/打包 OCR 探针、三模型复制及哈希校验、Forge 资源配置。
- DESIGN.md、.impeccable/design.json：从实际原型记录设计规范。
- README.md、docs/WINDOWS_VALIDATION.md：启动方式及 Windows 待验证操作。
- out/XXFinanceStage0-darwin-arm64/XXFinanceStage0.app：Mac arm64 阶段 0 应用（10 月 12 日已更新截图核对），未做分发签名/公证，不是真实账本。

### 当时实际执行
|项目|结果|证据/边界|
|---|---|---|
|TypeScript 检查与 Vite 生产构建|通过|evidence/stage0/build.log|
|金额/负余额/分配/撤销/编辑额度/非法零格式/大金额格式化|7 项自动测试通过|model-tests.log；模型测试，不等于全部业务验收|
|浏览器三面板|通过本轮交互检查|ui-list/entry/allocation.png；步骤见 ui-checks.md|
|小窗口|1024×768 与 720×720 无文档横向溢出|ui-1024/ui-720.png；表格可局部滚动，不代表手机适配或 Windows DPI|
|原型资源|无外站资源加载|ui-resource-check.json；当前浏览器记录|
|Electron 原生 SQLite|通过|electron-dev-probe.log；darwin arm64，临时合成数据库|
|SQLite 探针覆盖|原生加载、WAL 写读/重开、外键、失败回滚、超额拒绝、同请求重试、撤销不改流水、快照读回|依赖样例，不是生产业务层；未声称完整幂等/历史/并发实现|
|Python OCR|通过单张合成中文图识别|ocr-python.json；文字、框、置信度，无字段提取|
|PyInstaller OCR 辅助程序|构建并运行通过|ocr-build.log、ocr-bundled.json|
|OS 级禁网 OCR|Mac sandbox-exec deny network* 下通过|ocr-network-denied.json；不是干净 Windows 首次断网测试|
|Forge Mac arm64 应用包|构建通过|package-macos.log；已包含 OCR 子程序、模型、样本和现有许可文件|
|随包探针|packaged=true，SQLite/OCR 均 passed|electron-packaged-probe.json，进程退出码 0|
|随包真实界面|加载本地 file 页面，余额正确，window.require 不存在|electron-ui-check.json、electron-packaged-ui.png；不等于完整 Electron 安全审计|
|原型审查|ship，仅覆盖提供的截图及主要界面代码|prototype-review.md；无正式产品交付含义|

### 实测版本
- macOS 27.0.1（26A434），arm64。
- 构建 Node 26.10.0 / npm 12.2.0；Electron 44.7.0 内嵌 Node 24.21.0，模块 ABI 149。
- Forge 8.0.1；better-sqlite3 13.0.3；React 19.3.0；Vite 8.3.4；TypeScript 7.0.2。
- 项目隔离 Python 3.12.14；RapidOCR 3.10.0；ONNX Runtime 1.31.0；PyInstaller 6.22.3。
- npm 版本及传递依赖见 package-lock.json、npm-versions.txt；Python Mac 快照见 spike/requirements-macos-arm64.lock.txt。
- 模型：PP-OCRv6 small det/rec、legacy mobile cls，字典在识别模型 character 元数据中。三个 SHA256 与包内模型声明核对一致。

### OCR 结果不能过度解释
10 月 10 日基线只有 spike/fixtures/ocr-sample.png 一张合成图。10 月 12 日新增 30 张合成图及保守金额字段解析，结果见上方补充。
当时已接单张图片核对与取消，仍没有真实脱敏数据集、日期/票据其他字段解析、PDF 分页、批量队列、剪贴板入口或账本确认入账。
两次复用同一个 engine 的推理耗时写在 JSON 中；初始化/导入/系统首次检查可能另耗时，不能用这些数字宣称整机冷启动性能或识别准确率。

### 遇到的问题及处理
1. 沙箱内 npm DNS、本机端口和原生进程受到限制；使用获批的网络/本机执行路径完成，不把此限制当作产品失败。
2. Electron Node 下载器长时间无输出，改用官方 GitHub 文件下载，并与 npm Electron checksums.json 核对 SHA256 后安装；未用第三方镜像替换。随后 Forge package 成功。
3. npm 12 警告 electron-winstaller、fsevents 安装脚本未批准。Mac 原型/打包已实际成功；Windows 安装器脚本审核与运行仍须处理，不声称 Windows make 可用。
4. PyInstaller 缓存写入系统用户目录受限，使用 /private/tmp/xx-finance-pyinstaller 缓存重建通过。
5. ONNX Runtime 初次导入出现 telemetry device ID 写入提示；显式调用 disable_telemetry_events，并在系统 deny network* 下运行通过。正式 Windows 包仍须验证无外连。
6. 原生界面日志出现 macOS sandbox_extension_issue_file 提示，实际本地页面已成功加载。是否在签名/公证后仍出现未验证。

### 当时未验证 / 未实现
- Windows 全部构建、安装、升级、干净离线首次 OCR、中文用户名、空格路径、输入法、DPI、时区矩阵。详见 WINDOWS_VALIDATION.md。
- 真实/脱敏 OCR 样本集与字段准确性、PDF、批量队列、坏图全集、CPU/内存性能基线；单图取消/超时已有本轮检查。
- 发票多对多正式存储及额度、正式业务 CRUD/幂等/版本历史、附件事务、完整备份恢复、导出。
- 完整第三方传递依赖许可及上游 NOTICE 审计，Windows 签名和公司机器策略。
- 当前 UI 发票额度是合成显示字段，不冒充完整发票关联模块；不提供独立报销状态开关。

### 当时建议的下一步（不构成当前授权）
用户已体验并反馈三个关键界面基本可用；阶段 0 后续优先补真实脱敏 OCR 样本与本轮留空问题验证。Windows x64 构建/干净离线验证继续待条件具备后执行。
Windows 条件不具备时继续保留未验证，不以 Mac 包、静态网页或此技术探针宣称首版完成。
阶段 1 需后续明确推进后再开始，不能将原型内存结构直接当生产账本使用。
