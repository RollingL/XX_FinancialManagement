# Electron 已有功能接线与隔离验证

> **历史记录（只读）**：本文反映写作当时的情况，其中的“当前”“本轮”“下一步”都指当时。现行规则见 [业务规则](../BUSINESS_RULES.md)，现状见 [STATUS](../STATUS.md)。

日期：2026-10-12。环境：Mac arm64，现有 Electron 44.7.0（Node 24.21.0／ABI149）；没有安装或重建依赖。仅使用全新合成 userData；不接管默认应用数据，不操作既有浏览器服务／账本，不打包、不推送或部署。

## 开始时的源码结论与修复

预支附件和删除已通过通用 `localLedger` IPC 接到共享后端，但近期功能未原生实测。备份和清空只在 Vite 选择 managed 入口，Electron 固定普通 `createLedger`，因此原生显示不支持。原退出逻辑没有等待异步账本关闭，也没有等待所有已接收账本命令。

本轮只修改 `spike/main.cjs` 接线并新增纯模拟测试：

- 显式 `XX_FINANCE_MANAGED_TRIAL=1` 选择既有 managed 后端；要求独立、现有普通目录的 `XX_FINANCE_USER_DATA_DIR` 和绝对 `XX_FINANCE_DATA_DIR`，备份位置来自绝对 `XX_FINANCE_BACKUP_DIR`。ready 前设置 userData／sessionData，日志与 crashDumps 放在该隔离根内。普通默认入口保持原路径与普通账本，不自动接管旧数据。
- IPC 校验主窗口、主 frame 与精确本地入口 URL；关闭后拒绝新账本／OCR 请求。退出先停止 OCR，等待临时资源及所有已接收命令结束，再等待账本关闭、释放锁；重复退出不能绕过等待，失败保留关闭门并显示错误。
- 启动失败有错误收尾，不擅自删除锁。继续禁止弹新窗口、其他导航及权限；只允许主 frame 重载同一个本地入口。

第一次实际清空暴露原导航拦截同时阻止 `window.location.reload()`：账本已清空而页面停留。已修为精确同入口重载允许，并重新跑完整定向原生流程通过。未削弱 IPC 来源校验。

后续发票与费用纠错已在另外两个全新合成userData完成定向原生验证，见[NATIVE_INVOICE_VALIDATION](NATIVE_INVOICE_VALIDATION.md)。本报告下方保留最初收拢轮的实际范围，12项模拟测试在后续轮重跑通过。

## 当前支持矩阵

| 功能 | Mac Electron 开发运行 | 普通既有入口 | Windows／新安装包 |
| --- | --- | --- | --- |
| 费用纠错、发票 | 后续新根实际UI／IPC、失败重试、附件及备份恢复重开通过，见专项报告 | 共享后端；真实旧数据未操作 | 未验证 |
| 预支、到账附件 | 新隔离窗口实际保存、显示、字节核对通过 | 代码仍接共享后端；真实旧数据未操作 | 未验证 |
| 费用截图／OCR | 单张合成图本机识别、人工修正、保存通过 | 原入口未变；本轮未用旧数据验证 | 首次断网 OCR 未验证 |
| 报销批次删除 | 取消不写，确认删除，全资金事实不变通过 | 同一 IPC／后端；真实删除未操作 | 未验证 |
| 完整备份 | 显式 managed 原生入口实际导出并校验通过 | 无 managed 接管，仍不支持该维护页操作 | 未验证 |
| 清空所有数据 | 精确确认、代际拦截、空账本重载和正常关闭通过 | 不支持，不自动加代际或迁移 | 未验证 |
| 新目录恢复 | 本地 CLI 恢复后，新的原生 userData 读取完整事实与附件通过 | 不自动切换现用账本，无 GUI／覆盖恢复 | 未验证 |
| 正常退出 | 原生窗口正常关闭，退出码0，锁释放；挂起与失败时序由12项模拟测试覆盖 | 默认入口的关闭等待也已修复；未用真实账本测试 | 未验证 |

## 实际验证与证据

- `tests/electron-main.test.cjs` **12/12 通过**。所有 Electron、文件系统、账本和 OCR 依赖为 stub；覆盖配置拒绝、路径提前设置、普通／managed 路由、来源与权限、同入口重载、关闭顺序／重复退出、挂起请求及启动／关闭失败。不是实际磁盘故障测试。
- TypeScript／Vite 构建、主脚本语法与差异检查通过；未重跑无关77项、完整 Python 或 OCR 精度套件。
- 真实 Electron 窗口通过命名 `agent-browser` 会话连接仅本机9337。渲染为 `file:`，受限桥可用，renderer 没有 `require`／`process`。
- UI 新建预支并上传合成到账图，附件显示及字节一致。费用单张合成 OCR 完成后手改金额保存，余额为负并显示垫付；不宣称泛化识别准确率。
- 新增报销后删除：取消不写；实际删除保留审计，全量预支、费用、资金流水与余额逐项不变。
- 原生页面完整备份独立校验；输错／取消清空不写，准确确认后业务、操作及附件表归零，受管图片移除、代际变化、页面自动重载；旧代际命令拒绝，userData 中账本外哨兵及先前备份哈希不变。
- 正常关闭后锁不存在，空业务持久化。CLI 将备份恢复到另一个全新 userData；原生重开后完整业务与删除审计、资金和两类附件与备份前一致，新账本身份拒绝源根旧代际。最后正常关闭，锁释放，未强杀。

本地证据目录：`evidence/stage0/native-compat-2026-10-12/`（不进入 Git、未上传）：

| 文件 | 用途 |
| --- | --- |
| `unit-tests.log`、`build.log` | 12项模拟测试及构建 |
| `native-ui-result.json`、`native-browser.log` | 原生 UI／IPC 交互和实际断言 |
| `native-backup.json`、`native-before-reset.json`、`native-empty-state.json` | 合成完整状态及备份哈希 |
| `native-restore-result.json`、`native-restored-ui-result.json` | 正常关闭与新根恢复事实比较 |
| `native-advance-attachment.png`、`native-reset-confirmation.png`、`native-restored-overview.png` | 本地真实原生渲染截图 |

可重复打开本轮合成原生应用：`sh evidence/stage0/native-compat-2026-10-12/start-native.sh`（空账本），或 `start-restored-native.sh`（恢复样例）。两个脚本使用同一个调试端口，应先正常关闭一个再运行另一个。目录均明确指向本轮隔离数据，不替换默认真实路径；调试端口只为本地验收，非分发配置。

仍缺 Windows 测试环境。本轮没有重新生成安装包，不能声称 packaged Electron、Windows、安装升级、首次断网 OCR、强杀／断电通过。旧真实账本若要启用备份或清空，需要另行确定保留范围和备份／接入方案，不能把环境开关直接当成迁移工具。
