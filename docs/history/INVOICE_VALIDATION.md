# 发票管理最小闭环验证

> **历史记录（只读）**：本文反映写作当时的情况，其中的“当前”“本轮”“下一步”都指当时。现行规则见 [业务规则](../BUSINESS_RULES.md)，现状见 [STATUS](../STATUS.md)。

后续更新：本报告记录集成轮结果；费用纠错与发票的Mac Electron原生UI／IPC、附件、失败重试、备份恢复及正常重开已另行验证，见[NATIVE_INVOICE_VALIDATION](NATIVE_INVOICE_VALIDATION.md)。下方原生未测项为当轮历史边界，Windows及安装包仍未验证。

2026-10-12。本轮是阶段0既有试用账本的授权扩展，已完成本地集成；不是阶段1、完整发票产品或Windows验收。沿用 `codex/ui-mist-lavender-v2`，接管基线 `e3a7449efa7a310529a2c9c3c7e9f6110ff70f17`。接管时9个已修改及9个未跟踪文件全部保留复用。收到旧任务及5个子代理停止通知后才开始写入。

## 实际交付

- 侧栏发票页：PNG/JPEG原图选择或拖入、手工票面字段、待核对身份归档及一次确认、同原票补图、搜索、未关联筛选、六条分页。
- 发票与已有费用多对多分配；编辑排除本票旧分配，费用侧包含旧 `expense.invoice` 基线及其他发票分配。票侧和费用侧同时校验，金额均为安全整数分。
- 号码／代码规范化保留前导零，不硬编码税务号码位数。同号码且代码相同或任一缺失时保守拒绝；同原图哈希拒绝重复。待核对票不能关联，确认身份不自动关联，补图不增加票额。
- 发票详情显示原图、分配、前后审计和修订；费用详情显示关联票额和票据。解除仍保留关联历史，并继续阻止本阶段费用纠错。
- SQLite事务保存发票事实、审计、附件引用及请求；重复请求返回既有结果。可选 `invoices`／`invoiceEvents` 不回填旧数据，不改SQL结构。备份validator、managed重开支持全部四种发票操作。
- 归档／确认／补图／分配及解除不修改费用、预支、资金或报销事实。

归档要求有效日期、正票面额和原图；未知身份可先待核对，其他金额或日期不编造。本阶段保存后不能更改票面金额、日期、购销方或备注，界面在保存前明确提醒；不支持票据作废、外部验真或税务合规认定。

## 本轮修复

1. 发票警示卡片的 `.invoice-warning` 原为全局规则，会污染既有费用列表；现仅作用于发票抽屉，实际页面确认费用提示保持原紧凑样式。
2. 发票详情改用既有抽屉的父容器结构，正文滚动与固定底栏一致；1440×1000、1024×768、390×844均检查。
3. 组合字符号码经大写转换后可能不再满足NFKC，出现保存成功但备份／重开拒绝。前端、后端及备份检查统一在大写后再次NFKC，新增三个回归用例验证等价身份查重、确认、重开和恢复。

## 自动验证

首次联合定向 **140/140通过**：

```sh
node --test tests/invoice-ledger.test.cjs tests/invoice-backup.test.cjs \
  tests/invoice-ui.test.ts tests/invoice-image.test.ts \
  tests/expense-correction.test.cjs tests/expense-correction-backup.test.cjs \
  tests/expense-correction-ui.test.ts tests/ledger-backup.test.cjs \
  tests/image-file.test.ts tests/batch-cancellation.test.cjs \
  tests/batch-delete.test.cjs tests/advance-ledger.test.cjs tests/model.test.ts
```

归一化修复后仅重跑受影响的发票后端18、备份9、客户端19，**46/46通过**；不是把历史计数累加为一次完整回归。最终 `npm run build`（TypeScript＋Vite）及 `git diff --check` 通过。

覆盖：票／费用双侧额度含超0.01、旧票额基线、排除本票、身份及原图重复、失败回滚与附件清理、幂等及修订冲突、完整资金／报销不变量、历史禁改、可选字段旧账本兼容、附件与审计链检查、备份恢复和重开。均为合成临时根。

日志：`evidence/stage0/invoices-2026-10-12/final-tests.log`、`normalization-tests.log`、`final-build.log`。未运行两份来源待确认的排除测试，未重跑全量OCR或Python回归。

## 实际浏览器验证

工具为agent-browser独立会话 `qianlai-invoices-20261012`。新空根启动后仅种入8笔合成费用、1笔预支、1条费用纠错及1个报销批次。费用合计800元、预支100元、余额−700元、已报销10元；发票操作始终不改变这些完整事实。

通过项目：

- 空状态；选择图片和填写后取消，完整状态不变；待核对票不能关联；身份确认不自动关联。
- PNG及JPEG实际解码、归档、补图、已保存图片读取；PDF与损坏PNG拒绝。拖入为浏览器 `DataTransfer/DragEvent` 模拟，另有真实文件输入选择，不宣称OS原生拖拽已验收。
- 不同图重复身份、不同号码同原图均拒绝，完整状态不变；同步双击只生成一张票。
- 跨页选4笔分配300元；费用超0.01及票额超0.01拒绝。改额排除本票旧分配，多张票共享费用额度；搜索及翻页保持完整已选内容。
- 提交成功后人为丢弃响应，再用同草稿重试，完整状态和审计无重复；解除草稿取消无写入；完整解除不改资金或报销，费用仍因历史关联禁改。
- 发票9张按6/3分页、8笔关联按6/2分页、7条审计按6/1分页；后续JPEG补图使首票审计增至8条。搜索定位、未关联筛选、费用侧两张票关联显示正确。
- 三种窗口下无文档级横向溢出；分配和详情底栏始终在视口内；页面和附件正常刷新读取。
- 5197正常关闭释放锁，以最终代码重开，完整状态一致。

最终合成账本为9张发票、17条发票审计、28条请求记录、11份受管附件。完整前后比对见 `before-ui.json`、`after-ui.json`、`page-backup.json`；步骤与布局见 `browser.log`、`ui-checks.json`、`layout-checks.json`。

验证工具本身曾出现等待参数／提示文案错误及空字符串fill未清空搜索，相关脚本已修正并从原状态继续，未重复归档或清空数据。最初受限环境禁止监听导致新5197启动失败并留下本任务锁；确认该进程已退出后将锁移至证据目录，再正常启动。没有删除或接管其他账本的锁。这些不记为产品通过用例。

## 页面备份与新目录恢复

从5197“备份”页实际点击导出完整备份，再用 `spike/ledger-maintenance.cjs verify/restore` 恢复到此前不存在的新目录。没有覆盖、迁移或切换源账本。

- 完整JSON、28条请求、附件元数据及完整资金流水／余额一致，发票和费用历史保留。
- 11份附件在源／备份／恢复中哈希一致，均匹配本轮脚本生成的原图；无孤立附件。原图保留。
- 恢复期间源数据库字节哈希及完整事实不变。
- 恢复账本两次managed重开成功，每次均通过命令读取全部附件并核对哈希。
- 额外临时合成场景验证：解除关联后备份恢复，源及恢复账本仍拒绝费用纠错。

结果：`restoration-checks.json`、`cli-verify.json`、`cli-restore.json`；恢复根 `evidence/stage0/invoices-2026-10-12/restored-from-page/`，仅作证据，不自动接管任何使用入口。

## 试用与截图

当前可打开 http://127.0.0.1:5197/ ，从侧栏“发票”进入。独立源码副本和受管根均位于 `evidence/stage0/invoices-2026-10-12/preview/`；正常关闭后可用同目录 `start.sh` 重启。不得重复运行 `seed.cjs`，其仅允许全新根。原5173／5190–5196、默认Electron数据与真实账本均未读取、修改、重置、关闭或迁移。

三张纯合成截图已保存到Library，本地身份元数据写入成功：

| 截图 | library_file_id |
| --- | --- |
| invoice-list-desktop.png | `libfile_f0944b68057c81919bf599532448e7c9` |
| invoice-detail-desktop.png | `libfile_ad4994d253048191b55f36537ba1d11d` |
| invoice-allocation-mobile.png | `libfile_ff716163c82c8191b8d1cc0f20d42b02` |

截图、验证脚本、账本、原图、备份及恢复根都仅留本地并被Git忽略。Library仅保存用户要求的合成UI截图，不含真实票据或账目。提交仅含审阅过的源码、测试和文档；不push、merge或部署。

## 未测与下一步

本次发票Electron界面／IPC、Windows、安装包、首次断网OCR、升级、中文路径／DPI／输入法／跨时区矩阵、断电／强杀均未测。历史Mac原生测试不自动覆盖本次发票。未做云OCR、外部验真或税务判断；PDF、发票OCR、材料导出、票据元数据纠错／作废尚未实现。

下一步优先在另一个新合成userData定向验证发票Electron链路；Windows仍需要实际x64测试环境。本轮没有推进新的业务模块或真实数据接入。
