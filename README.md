# 钱来 财务管理系统 · 阶段 0

本项目是“钱来 财务管理系统”（原“小徐同学财务管理系统”）的 Windows 离线桌面账本，与 iPhone 口袋账本分开。**唯一当前状态见 [STAGE0_STATUS.md 顶部](docs/STAGE0_STATUS.md#当前状态)**；下文提供运行及操作入口，不代表新的阶段验收。

阶段 0 试用流程：截图识别已内置“记一笔费用”：本机识别 → 核对/修正 → 确认保存 → 费用详情查看附件。费用、附件和现有报销分配保存到独立本地试用账本；尚非生产账本。

总览顶部“登记报销”可直接打开，在面板内选择单笔／多笔费用并分配金额；总览列表只展示和打开详情，不承担多选。截图识别仍在新增费用中。标题日期按设备本地年月日及星期刷新。

2026-10-12 按用户红框移除资金卡“累计预支／登记到账”和待报销卡“已报销”底栏，卡片随内容收紧；预支登记仍从侧栏“预支”进入。左侧品牌及网页／Electron 窗口显示名称改为“钱来 财务管理系统”，问候语“你好，小徐同学”保留。内部应用标识与既有数据目录未改。范围及验证见 [QIANLAI_UI_VALIDATION](docs/QIANLAI_UI_VALIDATION.md)。

本轮独立本地试用地址为 http://127.0.0.1:5190/ ，包含明确标注的合成样例，使用 `evidence/stage0/qianlai-2026-10-12/preview/.local-data/`，不与默认账本同步。服务关闭后，可在项目根目录运行 `./evidence/stage0/qianlai-2026-10-12/preview/start.sh` 重启；该本机副本不进入 Git。原有 5173 服务未被重启或接管。

- [业务需求与验收规范（业务权威）](expense_bookkeeping_spec_v1.1.md)
- [实施方案、取舍与分阶段计划](docs/IMPLEMENTATION_PLAN.md)
- [项目约束](AGENTS.md)
- [阶段 0 状态与证据](docs/STAGE0_STATUS.md)
- [Windows 验证清单](docs/WINDOWS_VALIDATION.md)
- [2026-10-12 离线 OCR 金额字段验证](docs/OCR_FIELD_VALIDATION.md)
- [截图上传与核对说明](docs/OCR_REVIEW_UI.md)
- [账本与附件备份恢复方案及验收清单（仅方案）](docs/BACKUP_RECOVERY_PLAN.md)

## 本地版本与数据边界

Git 只记录源码、锁文件、文档和明确列出的合成样本，不是账本备份。`.gitignore` 默认排除未列入范围的文件；本地账本、附件、用户截图、凭证、依赖、模型、构建产物和整个 `evidence/` 均不纳入本轮版本记录。已有文件全部保留在原位置。文档中 `evidence/` 链接指向本机既有证据，新的 Git 检出不会自带这些证据，也不能仅凭报告文字认定测试通过。

新增文件先审查路径和用途，再按具体文件暂存并查看 `git diff --cached --name-status`；不要使用无范围的暂存或强制纳入被忽略的私有材料。提交身份仅在本仓库设置，优先采用已验证 GitHub profile 和官方 noreply 地址，不修改全局身份。仓库与同步状态统一记录在 [当前状态](docs/STAGE0_STATUS.md#当前状态)。

2026-10-12 用户在本地基础整理后另行授权将安全内容上传到 [RollingL/XX_FinancialManagement 私有仓库](https://github.com/RollingL/XX_FinancialManagement)；此授权不含账本、用户截图、附件、凭证、部署或发布安装包。上传复核将 `tests/test_receipt_fields.py` 与 `tests/trial-ledger.test.cjs` 保留本地并排除版本记录：其中精确支付金额／日期时间的合成来源尚未确认，不直接上传。其他 31 张图片是已明确记录的合成回归素材，不是用户付款截图。

因此远程检出的测试集合与本机历史集合不同：旧日志中的 Node 17 项、Python 24 项包含上述本地保留测试，不能直接作为远程检出版本的通过声明。后续可单独将这些测试改写为确定的合成数据再纳入；本次未改写它们或业务代码。

## 文档维护约定

需求含义以业务规范为准；实施方案记录计划与取舍；STAGE0_STATUS 顶部记录唯一当前状态，下面按日期保留历史与验证证据。专项文档只说明相应流程、测试范围或待实现方案，历史通过结果不自动延伸到新代码或其他操作系统。视觉实现见 [DESIGN](DESIGN.md)：2026-10-12 已按用户批准的本地雾紫白 v2 完成改版；实际 Mac 浏览器检查见 [UI_V2_VALIDATION](docs/UI_V2_VALIDATION.md)。本轮只在本地功能分支提交，不推送或部署。

## 原型

```sh
npm ci
npm run dev
```

打开 http://127.0.0.1:5173/ 。首次创建的本地试用账本为空；已有账本重开不会清空，确认保存后保留。可尝试截图录入、跨类别选择、部分报销、超额阻止、逐行改分配、查看和撤销整批。预支页支持到账新增与记录查看：到账日期、正数金额、选填备注；补款只增加资金、不自动核销。起始余额为 0，允许负余额。启动开发服务会打开或创建账本；只读盘点时不要执行上述命令。

```sh
npm test
npm run build
npm start
```

`npm test` 运行 Node 测试，不包含 Python 解析测试。Python 两组测试入口为 `.venv-ocr/bin/python -B -m unittest discover -s tests -p 'test_*.py'`；`npm run build` 会写入 `dist/`。这些是运行方式，最近一次结果及本次是否执行以 STAGE0_STATUS 为准。

`npm start` 是 Electron 原型窗口；“记一笔费用”中可上传 PNG/JPEG，查看原图、核对并修正金额/日期/商户。只有确认保存才登记费用并归档附件。浏览器版本用 `npm run dev`，直接打开 dist/index.html 不提供 OCR 和保存接口。

## OCR 依赖样例（Mac）

使用 Python 3.12 创建项目 .venv-ocr，不修改系统环境：

```sh
python3.12 -m venv .venv-ocr
.venv-ocr/bin/python -m pip install -r spike/requirements.txt
.venv-ocr/bin/python spike/prepare_models.py
.venv-ocr/bin/python spike/ocr_probe.py spike/fixtures/ocr-sample.png
cd spike
../.venv-ocr/bin/pyinstaller --noconfirm ocr-probe.spec --distpath ocr-dist --workpath ocr-build
cd ..
spike/ocr-dist/ocr-probe/ocr-probe spike/fixtures/ocr-sample.png
```

当前机器使用 Codex 捆绑 Python 3.12 创建 venv。首次执行可能有系统二进制检查等待。探针输出文字/位置及保守金额候选，区分支付、余额和退款；所有结果仍须人工确认，不自动入账。30 张合成图有 1 张小数点识别失败而安全留空；这不是实际票据准确率，详见字段验证报告。

## Electron/SQLite 和打包探针

```sh
npm run probe:electron
npm run package
```

先按上文构建 OCR 辅助程序再 package。开发态探针输出若 OCR 为 not run，不能认定整条 OCR 链路通过。SQLite 使用独立临时数据库，测试后清理。

Windows 必须在 Windows x64 上重新构建和实测，见验证清单。当前 Mac 结果不证明 Windows 兼容性。

当前新增字段解析已接入浏览器及 Electron 的费用录入面板；Windows 仍未验证。

## 上传截图并保存费用

1. 点击“新增费用”或“截图录入”，选择单张 PNG/JPEG（20 MiB / 2000 万像素以内）。
2. 本机识别后填写能够确定的金额、付款日期和商户，不确定项留空；请对照原图核对、补充或修正。
3. 点击“确认并保存费用”。原图复制为附件，刷新后仍可在费用详情查看。
4. 取消录入不写入账本；余额、退款、原价和优惠不会代替实际支出金额。

浏览器开发入口需要项目 .venv-ocr；本机已有。Mac 应用使用随包辅助程序，不要求安装 Python。识别可取消，有 90 秒超时；失败可手填，损坏图片不能作为附件保存。PDF、批量导入、剪贴板识别未接入。

开发浏览器和 `npm start` 使用不同的试用数据目录，不自动同步。浏览器：项目 `.local-data/`；Electron：`app.getPath('userData')/stage0-trial/`。目录包含 SQLite 和 `attachments/`，不纳入应用包。尚未实现正式备份/恢复与迁移，请勿作为唯一财务存档。详见 [录入与附件说明](docs/OCR_REVIEW_UI.md)。

预支最小扩展的兼容策略和定向验证见 [ADVANCE_VALIDATION](docs/ADVANCE_VALIDATION.md)。旧金额保留，缺失日期显示“日期未记录”。若开发服务在代码更新前已启动，需由使用者重新启动服务以加载新的业务命令；本轮未重启原有服务。

“费用支出”及接待／办公拆分均累计所有费用，包含跨月跨年记录；月份、类别、关键词等列表筛选不改变这些卡片汇总。
