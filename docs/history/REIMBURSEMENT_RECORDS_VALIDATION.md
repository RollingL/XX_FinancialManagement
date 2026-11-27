# 报销记录独立页面与功能分支同步

> **历史记录（只读）**：本文反映写作当时的情况，其中的“当前”“本轮”“下一步”都指当时。现行规则见 [业务规则](../BUSINESS_RULES.md)，现状见 [STATUS](../STATUS.md)。

日期：2026-10-12。用户明确要求“推送 GitHub，然后继续开发”；先推送已完成的八项反馈版本，再独立补齐报销记录页。仍为阶段 0 的单独授权扩展，不进入完整阶段 1，不部署或合并 main。当前状态见 [STAGE0_STATUS](STAGE0_STATUS.md#当前状态)。

## 已完成的 GitHub 同步

- 目标确认：`RollingL/XX_FinancialManagement`，`private=true`，默认分支 main。使用现有授权，没有创建或提取凭证。
- 推送前核对远程只有 main，其 SHA 与本地 origin/main 一致：`495bd34a20613ec55fabc719ba58c2d8010fdb87`。
- 安全复核覆盖全部 7 个可达提交的 99 个路径，以及待推 5 个提交的 63 个历史文本版本、33 个净变更路径。账本、附件、evidence、凭证和两份排除测试未进入历史；未发现新增绝对个人目录、秘密或私密支付样例。
- 没有新增二进制对象；原有 31 张合成图片对象与已审核远程基线一致，未重新解码审阅。新附件测试的内嵌 PNG 为 1×1 合成图片。检查了历史，不仅是工作区忽略规则。
- 正常推送 [codex/ui-mist-lavender-v2](https://github.com/RollingL/XX_FinancialManagement/tree/codex/ui-mist-lavender-v2) 后核对远程 SHA：`23041f9485cb0f4c7b3b0c952fd913335592e2fe`；main 未改变。没有 force、合并或部署。
- 该 SHA 的 Actions runs、check-runs、传统 statuses 数量均为 0；没有可报告的 CI 通过结果。传统状态 API 无条目时返回 pending，不代表存在运行中的检查。

以下新增报销记录模块仅本地提交和试用，**不包含在上述已推 SHA 中**。继续开发授权不作为新模块再次推送或发布的授权。

## 新页面范围

侧栏“报销记录”开放，沿用当前雾紫白主题及简洁卡片；新增页面复用全账本资金卡片，不引入新的资金统计口径。

- 列表显示批次编号、报销日期、原登记总额、涉及费用及有效／已撤销状态；按日期降序，同日编号降序。
- 搜索匹配批次编号、日期和全部关联费用的商户／摘要／备注，不限于列表摘要或当前页；可按月份和状态筛选。
- 列表与分配明细每页 6 条，筛选回首页，记录减少自动夹紧页码。底部有效登记合计来自全部筛选结果，排除已撤销批次；历史登记总额不混作有效金额。
- 批次详情显示完整分配总额，逐项查看本批次分配、费用原额、当前已报销／待报销；可进入关联费用详情并返回批次。缺失费用引用保留编号提示，不编造费用。
- 已撤销批次保留编号、日期及原分配，可继续搜索和查看；不提供再次撤销按钮。
- 页面顶部可打开既有“登记报销”面板；撤销确认与费用详情共用组件、保存锁及同一后端命令。确认说明影响整批、只恢复待报销额、资金不变；默认焦点落在“保留”，确认区滚入可见位置。
- 失败重试保留同一请求 ID；保存中阻止关闭或重复请求。不同请求再次撤销已取消批次的后端既有行为仍为状态不变、各自留一条操作记录，不混称为同请求幂等。

实现：`ReimbursementRecords.tsx`、`batch-records.ts` 与 `main.tsx` 的入口整合。没有新增依赖、修改 Batch 数据结构、修改 SQLite 后端或运行迁移；旧批次无需新增字段。没有新增报销付款、凭证、修改批次或恢复已撤销批次的功能。

## 实际执行验证

| 命令／范围 | 实际结果 |
| --- | --- |
| `node --test tests/batch-records.test.ts` | 10/10 通过：跨类别及第七项关联检索、筛选交集、稳定排序、撤销保留、缺失引用、原输入不变、分页前完整汇总、空结果及安全整数。 |
| `node --test tests/batch-cancellation.test.cjs` | 5/5 通过：跨类整批撤销只改目标 active；完整费用／预支元数据／派生资金流水／余额深比较；额度精确恢复；跨 SQLite 重开幂等；非法请求；操作表故障注入后的事务回滚及原请求重试。 |
| `npm run build` | 最终 TypeScript 检查及 Vite 构建通过，包含焦点和确认区可见性修正。 |
| `git diff --check` | 通过。 |

以上为本轮 **15 项定向测试**，不是完整回归；未运行来源待确认的本地保留测试。

Mac 独立 `agent-browser` 会话 `qianlai-batches-20261012` 实测：

1. 全新空账本及无匹配结果；14 批记录 6／6／2 分页，筛选／翻页均不改变全账本卡片；有效合计不按当前页计算。
2. 关联第七项备注搜索、有效状态及月份交集；8 笔分配按 6／2 查看，关联费用往返及标题焦点正常。
3. 撤销选择“保留”或关闭，完整账本不变；实际撤销后目标原分配及其他批次保留，完整资金不变，筛选结果从 7 减为 6 时页码回到有效页。
4. 同一事件轮次重复激活确认只发一个请求。模拟后端已提交但响应中断，界面保留错误和请求 ID；重试后状态一致，SQLite 中仅一条对应撤销操作。保存中关闭被阻止，刷新后撤销历史仍可读取。
5. 从新页面登记跨页 8 笔分配，全部保存且完整资金不变。1586×992、1024×768、390×844 页面及详情不撑宽文档，表格可自身横向滚动；确认区在底栏上方可见，键盘焦点落在“保留”。

浏览器响应中断检查使用可控 promise 模拟丢失响应；后端请求确实提交，再以同一请求重试。该模拟不等于物理断网／强杀恢复验收。

## 入口、证据与截图

新隔离试用：http://127.0.0.1:5192/ 。副本位于 `evidence/stage0/reimbursement-records-2026-10-12/preview/app/`，合成账本在相邻 `.local-data/`；若服务关闭，在项目根运行 `./evidence/stage0/reimbursement-records-2026-10-12/preview/start.sh`。本机副本不进入 Git。

最终样例为 14 笔合成费用、1 笔合成预支、15 批报销（10 有效、5 已撤销），余额 -1299.99 元；仅供测试，不是空正式账本。原 5173、5190、5191 服务及其试填数据未被接管、重置或迁移；本轮未读取它们的账本。新 5192 PID 为 56074，交付前四个端口均在运行，相关源码与副本字节一致。

本轮证据均保留于上述 evidence 目录并排除 Git：

- [查询测试](../../evidence/stage0/reimbursement-records-2026-10-12/helper-tests.txt)、[撤销事务测试](../../evidence/stage0/reimbursement-records-2026-10-12/cancel-tests.txt)、[最终构建](../../evidence/stage0/reimbursement-records-2026-10-12/build-final.log)。
- [分页／搜索／明细／撤销](../../evidence/stage0/reimbursement-records-2026-10-12/records-ui-result.json)、[重复与重试](../../evidence/stage0/reimbursement-records-2026-10-12/retry-ui-result.json)、[一条实际操作记录](../../evidence/stage0/reimbursement-records-2026-10-12/retry-operation-result.json)、[布局及新增登记](../../evidence/stage0/reimbursement-records-2026-10-12/layout-ui-result.json)。
- [筛选和分页不改变全账本卡片](../../evidence/stage0/reimbursement-records-2026-10-12/summary-ui-result.json)、[已推版本核对](../../evidence/stage0/reimbursement-records-2026-10-12/push-result.json)。
- [服务访问检查](../../evidence/stage0/reimbursement-records-2026-10-12/delivery-http.json)：5192 页面 HTTP 200、数据库静态路径 403，只检查状态码。
- [纯合成总览截图](../../evidence/stage0/reimbursement-records-2026-10-12/reimbursement-records-overview.png)已保存 Library：`libfile_7230cf51fb40819186ac55920ad70405`；文件 `file_000000002c3481f682a3dc7a770db0af`，版本 0。原用户截图和试填账本未上传。

## 未验证与下一步

未重跑 OCR、图片附件、完整 Node／Python 套件；未测 Electron 新包、Windows 安装及首次断网 OCR、正式备份恢复、真实磁盘满、强杀或断电。Mac 浏览器结果不代表这些能力通过。历史操作表不是完整前后值审计，正式迁移与恢复仍待单独实现。

下一步仅评审 5192 新页面及必要修正；用户确认后另行决定新模块同步 GitHub。已推版本与本地新增版本分开报告，不默认合并 main 或进入其他模块。
