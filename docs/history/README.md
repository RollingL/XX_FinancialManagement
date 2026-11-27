# 历史资料

这里是 2026-10-10 ～ 2026-11-27 由 Codex 开发期间留下的计划、验证记录和交接文档，**原样保留，只修正了链接**。文中的 `spike/`、`prototype/` 目录已在 2026-11-27 改为 `src/main/`、`src/renderer/`，OCR 已在同日移除。它们反映写作当时的情况，里面的“当前”“本轮”“下一步”都指当时，部分内容已经被后来的决定推翻（例如发票管理已简化为开票提醒、CSV 列数多次变化）。

现在的情况请看：[现状](../STATUS.md) · [业务规则](../BUSINESS_RULES.md) · [架构](../ARCHITECTURE.md) · [开发指南](../DEVELOPMENT.md)。

文中很多链接指向 `evidence/`（原电脑上的本地验证证据），这些文件从未上传到仓库，所以打不开。

## 总览与计划

| 文档 | 内容 |
| --- | --- |
| [STAGE0_STATUS](STAGE0_STATUS.md) | 10 月 10 日 ～ 11 月 27 日的状态流水，按日期倒序 |
| [HANDOFF](HANDOFF.md) | Codex 写给 Claude 的交接说明（11 月 27 日） |
| [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.md) | 10 月 10 日的实施方案和目标数据模型，后附多次授权记录 |
| [ACCEPTED_BASELINE_2026-10-13](ACCEPTED_BASELINE_2026-10-13.md) | 10 月 13 日用户验收的版本基线 |
| [BACKUP_RECOVERY_PLAN](BACKUP_RECOVERY_PLAN.md) | 备份恢复方案和验收清单 B01–B16 |
| [PROTOTYPE_DIRECTION](PROTOTYPE_DIRECTION.md) | 界面方向的早期讨论 |

## 各功能的验证记录

| 文档 | 功能 |
| --- | --- |
| [OCR_FIELD_VALIDATION](OCR_FIELD_VALIDATION.md) | OCR 金额字段提取（30 张合成图） |
| [OCR_REVIEW_UI](OCR_REVIEW_UI.md) | 截图录入流程与字段规则 |
| [UI_V2_VALIDATION](UI_V2_VALIDATION.md) | 雾紫白 v2 界面改版 |
| [ADVANCE_VALIDATION](ADVANCE_VALIDATION.md) | 预支到账 |
| [QIANLAI_UI_VALIDATION](QIANLAI_UI_VALIDATION.md) | 改名“钱来”和显示调整 |
| [QIANLAI_FEEDBACK_VALIDATION](QIANLAI_FEEDBACK_VALIDATION.md) | 八项反馈（分页、预支截图、图片拖入等） |
| [REIMBURSEMENT_RECORDS_VALIDATION](REIMBURSEMENT_RECORDS_VALIDATION.md) | 报销记录页 |
| [BATCH_DELETE_VALIDATION](BATCH_DELETE_VALIDATION.md) | 删除误填报销批次 |
| [MANAGED_BACKUP_VALIDATION](MANAGED_BACKUP_VALIDATION.md) | 完整备份与恢复 |
| [LEDGER_RESET_VALIDATION](LEDGER_RESET_VALIDATION.md) | 清空账本 |
| [NATIVE_COMPAT_VALIDATION](NATIVE_COMPAT_VALIDATION.md) | Electron 原生兼容 |
| [EXPENSE_CORRECTION_VALIDATION](EXPENSE_CORRECTION_VALIDATION.md) | 费用纠错 |
| [INVOICE_VALIDATION](INVOICE_VALIDATION.md) | 发票管理（**已撤下**） |
| [NATIVE_INVOICE_VALIDATION](NATIVE_INVOICE_VALIDATION.md) | 发票与纠错的原生验证（发票部分**已撤下**） |
| [EXPENSE_CSV_VALIDATION](EXPENSE_CSV_VALIDATION.md) | 费用 CSV（当时 12 列，现为 9 列） |
| [MAC_FEEDBACK_VALIDATION](MAC_FEEDBACK_VALIDATION.md) | 10 月 13 日 Mac 九项修订 |

## Windows

| 文档 | 内容 |
| --- | --- |
| [WINDOWS_STARTUP_DIAGNOSIS_2026-10-15](WINDOWS_STARTUP_DIAGNOSIS_2026-10-15.md) | 真机启动故障（残留锁）诊断 |
| [WINDOWS_STABILITY_2026-10-16](WINDOWS_STABILITY_2026-10-16.md) | 启动稳定性修复与最后一次 Windows CI 构建 |

## 其他

| 文档 | 内容 |
| --- | --- |
| [DEPENDENCY_LICENSES](DEPENDENCY_LICENSES.md) | OCR 时期的依赖许可记录（OCR 已于 2026-11-27 移除） |
