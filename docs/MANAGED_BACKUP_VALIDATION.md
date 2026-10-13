# 本地完整备份与新目录恢复验证

日期：2026-10-12。范围：Mac arm64、新建隔离合成账本；阶段 0 扩展，本地交付，未再次推送。当前状态统一见 [STAGE0_STATUS](STAGE0_STATUS.md#当前状态)，格式及剩余验收见 [BACKUP_RECOVERY_PLAN](BACKUP_RECOVERY_PLAN.md)。

## 已实现

`spike/ledger-backup.cjs` 使用 SQLite Online Backup API 生成副本，保留完整 `trial_state`、操作记录、附件元数据及受管附件（含合法孤立文件）。副本独立规范化、校验结构／完整性／业务额度／全部文件 SHA-256；清单与 COMPLETE 标记最后发布，既有目标不覆盖。恢复仅到新目录，原数据库字节与业务事实保持，新根具有不同账本身份。备份不重建业务、运行 OCR 或产生收付款。

`spike/managed-ledger.cjs` 为新根提供生命周期锁和维护闸门。既有无标识目录拒绝接管；残留锁不自动抢占；本版普通入口也不能绕过持锁入口。未完成清空日志阻止备份。清空代际及回执是可选技术字段，旧数据不回填，见 [清空验证](LEDGER_RESET_VALIDATION.md)。

5195 的“备份”页面支持导出完整备份，保存位置由本机启动配置决定，渲染层不能选择任意路径。恢复目前为 CLI，不提供 GUI 恢复或覆盖恢复。默认浏览器／Electron 旧入口显示维护不支持，未自动升级或迁移。

## 实际验证

- 最终联合测试 **77/77 通过**：备份 22、维护 25、清空 10、客户端代际 4、批次删除 11、批次撤销 5。TypeScript／Vite 构建通过。维护 guard 的既有预支兼容另有 6/6 通过；未跑完整 Node／Python／OCR／Electron 套件。
- 5194 合成往返：4 笔费用、1 笔预支、2 个保留批次（有效／撤销）、1 条删除审计、2 个登记附件和 1 个合法孤立文件。正常 SIGTERM 关闭后，经 CLI 备份、验证、恢复到两个新目录；完整 JSON、操作及附件元数据、逐项资金流水、余额和全部文件哈希一致，源数据库哈希未变。运行中 CLI 备份与既有目标覆盖均拒绝。
- 5194 恢复后浏览器实际读出费用、预支、有效／撤销状态与负余额；费用及预支附件解码和接口字节哈希一致。直接 `/@fs/` 请求数据库、标识与附件均返回 403。
- 5195 页面导出后的完整备份通过后端验证；备份前后全部业务、操作、附件元数据和附件文件哈希不变。随后两次合成清空、权限故障及续清理后，该已导出备份和外部合成原图哈希均保持不变。
- 故障定向覆盖：WAL 快照、缺失／篡改附件、孤立文件、错误清单／路径／版本／额度、输出失败、发布竞争目录、完成标记后的同步失败、锁竞争、清空待办与跨账本代际隔离。模拟失败不等于真实断电。

证据均仅本地保存、不纳入 Git：

| 证据 | 内容 |
| --- | --- |
| `evidence/stage0/reset-ledger-2026-10-12/final-tests.log`、`build.log` | 最终 77 项测试及构建 |
| `evidence/stage0/managed-backup-2026-10-12/roundtrip-result.json`、`roundtrip-cli.log` | 5194 两次完整恢复及源哈希 |
| 同目录 `restored-ui-result.json`、`shutdown-result.json` | 恢复 UI、私有文件限制及正常关闭 |
| 同目录 `backend-tests.txt`、`managed-tests.txt`、`guard-compat-tests.txt`、`cli-smoke.json` | 模块／兼容及最后 CLI 往返 |
| `evidence/stage0/reset-ledger-2026-10-12/before-ui-result.json`、`ui-backup.json` | 页面导出、取消及完整文件哈希 |

## 入口与边界

最新隔离预览：http://127.0.0.1:5195/ 。重启脚本：`evidence/stage0/reset-ledger-2026-10-12/preview/start.sh`。其账本、导出位置只属于本轮合成测试；5194 保留较早的恢复验证预览，5193 保留删除模块预览。没有读取、复制、迁移或清空 5173／5190／5191／5192 的旧数据，本轮清空也未碰 5193／5194。

CLI 使用 `node spike/ledger-maintenance.cjs`，必须显式传目录：`backup --source <managedRoot> --destination <existingParent>`、`verify --backup <backupDir>`、`restore --backup <backupDir> --target <newRoot>`。CLI 导出前须正常关闭该 managed 根的实例；页面导出由活跃服务持锁完成。新目录恢复不会切换现用账本。真实数据操作另行明确范围，不应把示例路径换成现用账本后直接执行。

目前未实现正式迁移、覆盖恢复、自动备份、保留轮换、GUI 恢复或无标识旧账本接管。Mac 正常 SIGTERM 关闭已测；Vite `r`／配置热重启不支持，SIGINT、强杀、断电、跨盘、Windows、Electron 打包和升级均未验收。哈希校验不是加密或来源认证。真实账本未备份，不能把本轮合成结果当作真实资料已有保护。
