# 最小费用纠错：实现与验证

> **历史记录（只读）**：本文反映写作当时的情况，其中的“当前”“本轮”“下一步”都指当时。现行规则见 [业务规则](../BUSINESS_RULES.md)，现状见 [STATUS](../STATUS.md)。

后续更新：本报告记录集成轮结果；费用纠错与发票的Mac Electron原生UI／IPC、附件、失败重试、备份恢复及正常重开已另行验证，见[NATIVE_INVOICE_VALIDATION](NATIVE_INVOICE_VALIDATION.md)。下方原生未测项为当轮历史边界，Windows及安装包仍未验证。

日期：2026-10-12。阶段0后续明确授权范围；本轮只使用新建合成目录，未读取、迁移、清空真实账本或既有试用实例。结果仅本地交付，未推送、部署、安装依赖或重新打包。唯一当前状态见 [STAGE0_STATUS](STAGE0_STATUS.md#当前状态)。

## 已实现范围

费用详情提供“纠正录入错误”。仅从未关联任何报销分配（包含有效、已撤销及删除审计中的历史）且 `invoice === 0` 的费用可修改金额、日期、类别、商户／采购摘要和备注。不能替换附件、作废费用或代替真实退款；界面明确提示该边界。新金额必须为正整数分，字符串解析拒绝多余小数、非法日期及不安全合计。

`correct-expense` 在即时事务内比较完整 `expected` 费用快照和每笔 `expectedRevision`，再复核历史限制。只替换五个允许字段，编号、附件及其他元数据保留。金额变化按“原余额＋原金额－新金额”反映；其他费用、预支、批次与分配不动。完整 `before`／`after`、操作时间和连续修订号写入可选 `expenseEvents`，与请求操作同事务提交。无变化、过时快照、ABA修订冲突或事务失败均不留半笔数据。

编辑期间同步锁阻止重复激活。相同草稿重试使用原请求及原快照；丢响应后改草稿使用新请求，但仍须通过原修订校验。切回原草稿重用原请求，因此已提交的纠错不重复记账。详情按新到旧展示全部五个字段的前后值，每页六条。

备份检查费用审计字段、稳定元数据、连续修订链、最后快照与当前费用一致，以及审计和操作的双向对应、类型和时间。合法纠错后可以再登记报销，历史较小金额不会错误限制后来的分配。旧JSON没有审计字段时不补写；SQL结构、备份格式版本和清单摘要字段不变。

本轮复核发现原写入口接受不符合分段格式的36字符请求ID，而备份会拒绝该记录；现统一为备份已有的UUID格式校验，并验证六类写命令的非法ID无写入。没有增加UUID版本限制或改写旧记录。

主要实现：[后端](../../spike/trial-ledger.cjs)、[备份校验](../../spike/ledger-backup.cjs)、[客户端规则](../../prototype/src/expense-correction.ts)、[纠错表单与审计](../../prototype/src/ExpenseCorrection.tsx)、[入口与提交](../../prototype/src/main.tsx)。

## 本轮自动检查

Mac arm64，本机既有依赖。实际联合执行下列文件，**85/85通过、0失败**；随后 `npm run build`（`tsc --noEmit && vite build`）通过。没有把其他轮次的测试计数累加为本轮结果。

| 文件 | 用例数 | 主要覆盖 |
| --- | ---: | --- |
| [expense-correction.test.cjs](../../tests/expense-correction.test.cjs) | 14 | 金额差额及完整其他事实不变、附件字节、三种报销历史及票额限制、非法输入与安全整数、双连接过时快照、ABA、独立修订、无变化、幂等重开、操作失败回滚、清空后旧请求拒绝、UUID一致性 |
| [expense-correction-backup.test.cjs](../../tests/expense-correction-backup.test.cjs) | 7 | 多次纠错后再报销、两个新目录恢复与重开、交错修订、后来撤销／删除报销、非法审计及重封哈希拒绝、旧JSON字节兼容 |
| [expense-correction-ui.test.ts](../../tests/expense-correction-ui.test.ts) | 12 | 资格、草稿精度、余额、快照隔离、稳定请求、改草稿新ID及切回复用、历史排序分页 |
| [ledger-backup.test.cjs](../../tests/ledger-backup.test.cjs) | 22 | 既有完整备份、恢复、路径／发布竞态、代际及清空日志校验 |
| [advance-ledger.test.cjs](../../tests/advance-ledger.test.cjs) | 6 | 既有预支及元数据兼容、失败回滚和资金事实 |
| [batch-cancellation.test.cjs](../../tests/batch-cancellation.test.cjs) | 5 | 撤销事务及完整资金不变 |
| [batch-delete.test.cjs](../../tests/batch-delete.test.cjs) | 11 | 删除事务、审计、幂等及完整资金不变 |
| [model.test.ts](../../tests/model.test.ts) | 8 | 金额精度、负余额、分配与汇总边界 |

本机日志：[联合测试](../../evidence/stage0/expense-correction-2026-10-12/final-tests.log)、[构建](../../evidence/stage0/expense-correction-2026-10-12/build.log)。运行器 [run-checks.cjs](../../evidence/stage0/expense-correction-2026-10-12/run-checks.cjs) 明确列出八份测试，不运行被排除的本地测试。

## 实际隔离页面与恢复

入口 http://127.0.0.1:5196/ ，命名会话 `qianlai-correction-20261012`；使用 agent-browser help、core工作流和新快照元素引用操作。预览代码副本、账本、导出及恢复副本全部位于 `evidence/stage0/expense-correction-2026-10-12/`。源图为已有合成fixture，本轮未调用OCR；附件保存校验桩不代表OCR验证。旧服务未重启或接管。

- 取消及无变化／三位小数输入不写入。合成费用100.00→80.01，余额−160.00→−140.01，差额准确为19.99；修改日期、类别、摘要和备注保存后持久化，元数据变化不改变余额。原编号、其他完整记录及附件SHA-256保持一致。
- 有效、撤销、删除审计中的费用均禁改并显示原因。费用5打开纠错后，通过同一合成后端新增报销，再提交旧页面时被拒绝，完整状态保持新增报销后的原值；新增报销前后完整资金事实相同。
- 阻塞已提交响应时同步两次激活只有一个请求；模拟响应丢失后草稿保留。改草稿产生新ID并被过时修订拒绝；切回原草稿复用完全相同请求，成功返回且只新增一条审计。
- 实际提交八次纠错后核对审计6／2分页和全部五个字段，刷新完整状态相同。1586×992、1024×768和390×844无文档横向溢出，表单底栏可见，审计表宽度不超容器；已查看实际截图。
- 页面“导出完整备份”成功，导出前后状态相同。通过CLI校验并恢复到全新 `restored-ui-backup/`，数据库初始副本字节与备份一致；完整原始JSON、20条请求、八条纠错、资金事实及附件哈希与源一致。恢复根两次managed重开可读，旧源代际请求被拒绝，关闭释放锁；源账本完整状态未变。恢复后未另开浏览器或Electron窗口。

| 证据 | 内容 |
| --- | --- |
| [ui-basic-result.json](../../evidence/stage0/expense-correction-2026-10-12/ui-basic-result.json) | 取消／非法输入、精确差额、日期、附件及三窗口 |
| [ui-retry-result.json](../../evidence/stage0/expense-correction-2026-10-12/ui-retry-result.json) | 双激活、丢响应、改草稿及原请求重试 |
| [ui-history-result.json](../../evidence/stage0/expense-correction-2026-10-12/ui-history-result.json) | 新增关联竞态、八次审计、6／2分页与布局 |
| [ui-backup-result.json](../../evidence/stage0/expense-correction-2026-10-12/ui-backup-result.json)、[restore-result.json](../../evidence/stage0/expense-correction-2026-10-12/restore-result.json) | 页面导出、CLI恢复、managed重开及完整比较 |
| [390px表单](../../evidence/stage0/expense-correction-2026-10-12/correction-form-390.png)、[390px审计](../../evidence/stage0/expense-correction-2026-10-12/correction-history-390.png)、[桌面审计](../../evidence/stage0/expense-correction-2026-10-12/correction-history-1586.png)、[备份页面](../../evidence/stage0/expense-correction-2026-10-12/correction-backup.png) | 全部为本机合成截图，未上传 |

验证工具修正：首次通用date填充未保留React受控值，导致第一笔只保存金额及文本；改用原生日输入框键盘后日期正确保存，作为第二次元数据纠错核对。浏览器JSON辅助器括号错误发生于写入前；恢复检查初始手算请求数19有误，实际为20（包含并发新增报销），改为与源请求全集比较后通过。保留这些检查过程，不将失败尝试记作产品通过，也未为这些工具问题修改产品代码。

## 限制与下一步

本轮未运行完整OCR／Python、两份来源待确认的排除测试、费用纠错的Electron交互、Windows、安装升级、强杀／断电或真实账本。上一轮原生收拢已实际完成，提交为 `5ce1e60`，其12项测试与Mac原生证据见 [NATIVE_COMPAT_VALIDATION](NATIVE_COMPAT_VALIDATION.md)，不替代本轮纠错的原生验收。

最小下一步是评审5196纠错流程及限制，再按实际使用入口安排后续工作；Windows环境、正常旧账本备份接入、迁移／覆盖恢复、关联费用调整仍需单独明确范围。本次不自动推进。上述证据、合成账本和截图仅保留本机，Git不收录 `evidence/`；新的检出不自带证据。
