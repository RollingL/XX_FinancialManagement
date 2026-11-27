# Windows 验证矩阵

目标环境为 Windows 10 Intel x64，使用可完整解压的离线便携 ZIP。实际操作及升级步骤见 [Windows 离线使用说明](WINDOWS_OFFLINE_TRIAL.md)。本文区分用户阶段验收、候选包 CI 与目标机实测。

## 最近一次已验证的候选包

2026-10-16 的候选包对应源码 `21d14a715646e784eb5b6bef62e881000914b75b`。GitHub Windows Server 2022 x64 的 [run 38852211112](https://github.com/RollingL/XX_FinancialManagement/actions/runs/38852211112) 成功。原生启动器 5 项、定向 Node 110 项、Python 通信 4 项通过。最终 ZIP 在新的中文空格路径解压后，随包 SQLite／OCR 探针通过，GUI 经诊断 CMD 与 `Qianlai.exe` 正常启动、关闭并确认进程清理；合成空账本与旧目录标识保留。下载后核对了 ZIP SHA-256 和 272 个文件的大小及哈希。文件名、校验值及错误修复过程见 [稳定性交付记录](history/WINDOWS_STABILITY_2026-10-16.md)。

这是该提交在 Windows Server runner 的构建与运行证据。产物保留期已于 2026-10-23 结束，**目前没有可下载的 Windows 包**，需要重新构建。

2026-10-13，用户确认 Mac 九项实测通过，并决定 Windows 同阶段视为验收通过。该阶段决定对应 [当日冻结基线](history/ACCEPTED_BASELINE_2026-10-13.md)。当时未用包含九项修订的包重新做 Windows 真机实测，已有用户反馈针对更早的候选包。

## 构建入口

[Windows 工作流](../.github/workflows/windows-offline-trial.yml) 使用 Windows Server 2022 x64、Node 26.10.0、Python 3.12。配置写的是在专用分支 `codex/windows10-offline-acceptance` 推送时运行，但该分支已不存在（2026-11-27 核实），现在只能在 Actions 页面手动触发，步骤见 [开发指南](DEVELOPMENT.md#windows-离线包)。构建脚本 [build-windows-trial.ps1](../spike/build-windows-trial.ps1) 要求全新 GitHub-hosted 构建目录，负责锁定 npm 依赖、准备 Windows Python wheels 与模型、PyInstaller、原生 x64 启动器、定向测试、Forge package、ZIP 和解压验证。发起下一次构建前核对授权、免费额度约束和待构建的提交。

- 通过包内 `build-info.json` 核对源码提交，通过同名校验文件核对内层便携 ZIP。GitHub artifact 外层 ZIP 有独立哈希。
- Electron 及 OCR 的 Windows CRT 来自构建机 Visual Studio 2022 官方 x64 redist。Mac OCR 辅助程序为 Mach-O arm64，Windows 辅助程序须用 Windows x64 构建。
- 日常入口为根目录 `Qianlai.exe`，诊断入口为 `START-TEST.cmd` 与 `CHECK-RUNTIME.cmd`。ZIP 含完整 app、合成素材、来源版本与文件哈希，不要求目标机安装开发依赖。
- 当前出包途径是便携 ZIP。签名、安装器与卸载器均未验证。

## 目标机待验收

先记录 `winver` 版本／内部版本号、x64 CPU、权限、候选包源码与 ZIP SHA-256。在普通用户可写的新目录解压，用合成数据操作。单独记录通过、失败和未执行项。

| 检查 | 已有证据 | 仍需在目标 Windows 10 检查 |
| --- | --- | --- |
| 初次断网与 OCR | CI 随包 SQLite／OCR、UTF-8 worker 及探针通过 | 无 Node/Python 的空缓存环境完全断网首次启动；识别金额、日期、商户，核对修改后保存，余额／退款不得补位，重开附件字节一致 |
| 窗口与退出 | CI 实际 GUI 启动、正常关闭、进程清理与重开通过 | 连续启动、Alt+F4、任务管理器强制结束、系统关机后的恢复与账本保护 |
| 路径与显示 | CI 中文空格解压路径通过 | 中文用户名与空格路径下的业务读写、导入／导出；100/125/150/200% 缩放、中文输入法 |
| 旧版数据与备份 | CI 保留合成空账本和旧包标识；Mac 合成完整恢复通过 | 按 [升级步骤](WINDOWS_OFFLINE_TRIAL.md#升级已有账本) 使用完整合成旧目录副本，核对历史、余额、附件、活动指针和新目录恢复失败回退。真实账本操作另行授权 |
| 主机策略与子进程 | Windows 包内运行时和进程监督由 CI 检查 | SmartScreen、杀毒及公司策略；Windows OCR 没有 Mac 等效的 OS 禁写验证 |
| 业务与时区 | 定向事务测试覆盖报销与资金独立，Mac 关键流程验证通过 | 在目标机按当前业务规则复核日期、资金、报销、开票提醒、备份与附件；正式完整验收范围仍需用户确认 |

## 历史候选与诊断

- 2026-10-15 的 [启动故障记录](history/WINDOWS_STARTUP_DIAGNOSIS_2026-10-15.md) 针对 `3155f9d938adaf03c744a9088ad56c3f49b6dfaa`、run `38379683352`。已确认二次启动提示来自账本锁。首次闪退根因缺原机日志。
- 2026-10-13 首个 Windows 10 路线便携候选源码为 `4a67eec82868a9f623795ed879d013237996a51d`。[run 38357413207](https://github.com/RollingL/XX_FinancialManagement/actions/runs/38357413207) 成功，job `115163407045`。包 `Qianlai-Windows10-x64-4a67eec82868.zip` 的 SHA-256 为 `bdbbb2e26c261c82cf200fa980932b73648b6efd31519e92a7a0f7398182baaa`，下载端核对 270 个文件。Artifact `11793327090` 的记录保留期截止 2026-10-20。更早的 Windows 11 目标已被 Windows 10 x64 取代。
- 2026-10-12 的 [金额提取探针记录](history/OCR_FIELD_VALIDATION.md) 为 Mac 数据，30 个合成图中 29 个精确匹配，1 个安全留空。旧独立截图核对面板后来被费用录入内的截图流程替换。
