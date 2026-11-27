# Windows 验证矩阵

目标环境为 Windows 10 Intel x64，使用可完整解压的离线便携 ZIP。实际操作及升级步骤见 [Windows 离线使用说明](WINDOWS_OFFLINE_TRIAL.md)。本文区分用户阶段验收、候选包 CI 与目标机实测。

## 最近一次已验证的候选包

2026-11-27 的候选包对应源码 `3791d0b6c01e66b0305cdf4d98b64764154d5db8`（移除 OCR、数据层重做和界面改进之后）。GitHub Windows Server 2022 x64 的 [run 46059203104](https://github.com/RollingL/XX_FinancialManagement/actions/runs/46059203104) 成功：原生启动器 5 项、定向 Node 110 项通过；打包后随包 SQLite 自检通过；ZIP 在新的中文空格路径解压后核对清单，`Qianlai.exe` 真实启动界面、正常关闭并确认进程清理，加一笔合成费用后重新打开账目不变并产生一份自动备份，把整个文件夹复制到别处打开账目也一致。

- 文件：`Qianlai-Windows10-x64-3791d0b6c01e.zip`（89 个文件），SHA-256 `4d29d0bb1050392ec9e577d2f6bcbb33694327a93a5af6c7dacc981bc94ee52d`。Claude 下载后核对了这个校验值，并确认包里有 SmartScreen 和 U 盘备份的说明、没有账本或备份文件。
- GitHub 上的产物 2026-12-04 过期；项目文件夹里另存了一份。
- 同一天前两次构建（run 46056239323、46058599811）分别发现并修好了两个只在 Windows 上出现的问题：测试收尾时先删临时文件夹后关账本；SQLite 自检删不掉 Electron 自己开着的临时文件。

这是 Windows Server runner 上的构建与运行证据，**不等于 Windows 10 真机验收**。

更早的 2026-10-16 候选包（源码 `21d14a7`，带 OCR，[run 38852211112](https://github.com/RollingL/XX_FinancialManagement/actions/runs/38852211112)）的记录见 [稳定性交付记录](history/WINDOWS_STABILITY_2026-10-16.md)。

2026-10-13，用户确认 Mac 九项实测通过，并决定 Windows 同阶段视为验收通过。该阶段决定对应 [当日冻结基线](history/ACCEPTED_BASELINE_2026-10-13.md)。当时未用包含九项修订的包重新做 Windows 真机实测，已有用户反馈针对更早的候选包。

## 构建入口

[Windows 工作流](../.github/workflows/windows-portable.yml) 使用 Windows Server 2022 x64 和 Node 26.10.0，只能在 Actions 页面手动触发（工作流文件需先合并到 `main`），步骤见 [开发指南](DEVELOPMENT.md#windows-离线包)。构建脚本 [build-portable.ps1](../scripts/windows/build-portable.ps1) 要求全新 GitHub-hosted 构建目录，负责锁定 npm 依赖、编译原生 x64 启动器、定向测试、Forge package、ZIP 和解压验证。发起下一次构建前核对授权、免费额度约束和待构建的提交。

- 通过包内 `build-info.json` 核对源码提交，通过同名校验文件核对内层便携 ZIP。GitHub artifact 外层 ZIP 有独立哈希。
- SQLite 原生模块和启动器都静态链接 C/C++ 运行库，目标机不需要另装 VC 运行库（2026-11-27 核对 SQLite Windows 模块只依赖 `KERNEL32.dll`）。
- 日常入口为根目录 `Qianlai.exe`，诊断入口为 `START-TEST.cmd` 与 `CHECK-RUNTIME.cmd`。ZIP 含完整 app、合成素材、来源版本与文件哈希，不要求目标机安装开发依赖。
- 当前出包途径是便携 ZIP。签名、安装器与卸载器均未验证。

## 目标机待验收

先记录 `winver` 版本／内部版本号、x64 CPU、权限、候选包源码与 ZIP SHA-256。在普通用户可写的新目录解压，用合成数据操作。单独记录通过、失败和未执行项。

| 检查 | 已有证据 | 仍需在目标 Windows 10 检查 |
| --- | --- | --- |
| 初次断网与截图附件 | 旧版 CI 随包 SQLite 探针通过 | 无开发工具的空缓存环境完全断网首次启动；上传合成截图并手动填写后保存，重开后附件一致；损坏图片被拒绝 |
| 窗口与退出 | 旧版 CI 实际 GUI 启动、正常关闭、进程清理与重开通过；Linux 测试确认进程被强制结束后锁自动解除 | 连续启动、Alt+F4、任务管理器强制结束、系统关机后重新打开不需要任何手动处理，账本完好 |
| 路径与显示 | CI 中文空格解压路径通过 | 中文用户名与空格路径下的业务读写、导入／导出；100/125/150/200% 缩放、中文输入法 |
| 搬家、升级与备份 | Linux 云端真实桌面版（每个 PR 自动跑）：自动／手动备份、备份到 U 盘（模拟的文件夹）、恢复、从旧文件夹导入、清空、复制整个文件夹后打开均通过（合成数据） | 把整个文件夹复制到另一台电脑或 U 盘后打开；按 [升级步骤](WINDOWS_OFFLINE_TRIAL.md#升级到新版本) 从旧的钱来文件夹导入；插真实 U 盘点“备份到 U 盘…”，再在另一个文件夹的钱来里从这份备份恢复；拔掉 U 盘后备份要给出中文提示。真实账本操作另行授权 |
| 主机策略与子进程 | Windows 包内运行时和进程监督由 CI 检查 | 首次打开出现“Windows 已保护你的电脑”时，按使用说明点“更多信息”→“仍要运行”能打开；杀毒及公司策略 |
| 中文界面 | Linux 云端真实桌面版：没有菜单栏，日期框显示中文格式 | 窗口没有英文菜单；日期选择框、“选择截图”和“选择文件夹”对话框是中文；“备份”页最下面显示版本号 |
| 业务与时区 | 定向事务测试覆盖报销与资金独立，Mac 关键流程验证通过 | 在目标机按当前业务规则复核日期、资金、报销、开票提醒、备份与附件；正式完整验收范围仍需用户确认 |

## 历史候选与诊断

- 2026-10-15 的 [启动故障记录](history/WINDOWS_STARTUP_DIAGNOSIS_2026-10-15.md) 针对 `3155f9d938adaf03c744a9088ad56c3f49b6dfaa`、run `38379683352`。已确认二次启动提示来自账本锁。首次闪退根因缺原机日志。
- 2026-10-13 首个 Windows 10 路线便携候选源码为 `4a67eec82868a9f623795ed879d013237996a51d`。[run 38357413207](https://github.com/RollingL/XX_FinancialManagement/actions/runs/38357413207) 成功，job `115163407045`。包 `Qianlai-Windows10-x64-4a67eec82868.zip` 的 SHA-256 为 `bdbbb2e26c261c82cf200fa980932b73648b6efd31519e92a7a0f7398182baaa`，下载端核对 270 个文件。Artifact `11793327090` 的记录保留期截止 2026-10-20。更早的 Windows 11 目标已被 Windows 10 x64 取代。
- 2026-10-12 的 [金额提取探针记录](history/OCR_FIELD_VALIDATION.md) 是 OCR 时期的 Mac 数据；OCR 已于 2026-11-27 移除，仅作历史参考。
