# Windows 验证矩阵与离线候选

唯一当前状态见 [STAGE0_STATUS 顶部](STAGE0_STATUS.md#当前状态)。本文分别记录 Windows Server CI 已通过项与 Windows 10 真机待执行项；CI 不替代干净 Windows 10 首次离线验收。

> 2026-10-12 补充：Windows 仍未验证。最新验收需在“记一笔费用”内上传截图，首次断网自动识别金额/日期/商户、手动修正并确认保存；重启后费用与附件存在且字节一致；退款/余额不补位。验证安装目录与用户数据目录分离，升级不丢 trial.sqlite/attachments。Mac 成功不代替这些检查。

2026-10-10 历史环境记录：当时执行环境仅 macOS arm64，没有 Windows x64 构建机器或测试机，未生成 Windows 安装包、未提交 CI。后续 Windows 机器可用性仍需确认，不以 Windows ARM、Mac 浏览器或 Mac 应用代替。
开始前填写：Windows 10 具体版本／构建号、x64 CPU、内存、普通用户权限、候选版本与 SHA256。目标支持仍以实际验收为准。

## 用户验收决定（2026-10-13）

用户确认Mac九项修订实测通过，并决定Windows同阶段也视为验收通过。这是用户认可的阶段验收结论，本次九项修订未重新在Windows真机测试，也没有新Windows包或CI run；此前4a67eec候选的成功CI仅证明其当时版本。详细版本与证据边界见 [ACCEPTED_BASELINE_2026-10-13](ACCEPTED_BASELINE_2026-10-13.md)。

## 当前构建路线（2026-10-13）

用户明确目标为 Windows 10、Intel x64，使用离线电脑；旧 Windows 11 候选基线已被本次目标替代。版本／构建号仍需在目标机用 winver 记录。用户授权私有专用分支 `codex/windows10-offline-acceptance` 构建、下载和失败修复，且已确认免费额度／零付费限制；不合并 main、不发布 Release、不扩权。

`.github/workflows/windows-offline-trial.yml` 使用 GitHub Windows Server 2022 x64 runner、Node 26.10.0、Python 3.12。脚本 `spike/build-windows-trial.ps1` 仅允许 GitHub-hosted 全新目录运行，执行锁定 npm 依赖、Windows Python wheel 与模型准备、PyInstaller、定向测试、Forge package、随包探针、ZIP 和逐文件校验。仅构建便携候选，暂不执行 Squirrel make／安装器。

- Mac 的 OCR helper 是 Mach-O arm64，不能换后缀成为 Windows exe；Windows Python／OCR 必须在 Windows 构建。
- npm 生命周期脚本不整体放开；仅显式运行已审阅的 Electron 下载器，并使用随包官方校验值。
- CRT 仅从构建机 Visual Studio 2022 官方 x64 redist 补齐并记录签名／来源／哈希，不从 System32 抽取。构建机本身仍有全局运行库，不能据此证明干净目标机依赖闭合。
- Python stdio 明确 UTF-8；随包 `--probe` 的 SQLite 或 OCR 失败会以非零退出。最终 ZIP 解压至全新中文空格路径后再次探针，验证两条管道消息及合成 OCR 金额 1280.50。
- 每包包含 START-TEST.cmd、CHECK-RUNTIME.cmd、完整 app、合成素材、来源版本及哈希清单。目标电脑不用安装开发依赖。用 [离线试用说明](WINDOWS_OFFLINE_TRIAL.md) 隔离启动，不直接打开 app 内 exe。
- 2026-10-13 本轮本地 40 项 Node、4 项 Python stdio 与 TypeScript 检查通过。Windows Server 2022 x64 CI 的相同 40 项 Node、4 项 Python、Forge package、随包 SQLite／OCR、UTF-8 worker 管道及中文空格新目录解压清单／探针通过；这些仍不代表干净 Windows 10 验收。

### 本轮实际恢复点与 CI 结果

- 本地 HEAD 保持 `729bd4fc35be4be5f218043ee2a441c548d7bc34`，原修改保留。旧任务已 interrupted；恢复时专用分支仍为 `23041f9485cb0f4c7b3b0c952fd913335592e2fe`，Actions 为 0。
- 72 个 UTF-8 安全源码／文档／测试对应 tree `bbc7a982fd7f9cb67276542b09c8c03a157e76a8`；精确查询确认不存在后继续。首次补树因旧 blob 缺失返回明确 422，按同一审阅范围完整内容建树成功，哈希一致。此次没有审批循环，未更改权限。
- 初始提交 `d6340e54610541b03f24515ed41d0cade7ebcb5c` 的 run `38357196769` 失败于 PowerShell 命令路径非标量；只修复工具路径选择和命名参数绑定。
- 最终源码 `4a67eec82868a9f623795ed879d013237996a51d`；[run 38357413207](https://github.com/RollingL/XX_FinancialManagement/actions/runs/38357413207) 成功，job `115163407045`。
- 私有 [artifact 11793327090](https://github.com/RollingL/XX_FinancialManagement/actions/runs/38357413207/artifacts/11793327090)，外层下载大小 324997728 字节，保留至 2026-10-20T06:37:36Z。包含便携 ZIP 和同名 SHA256；GitHub artifact 外层 ZIP 与便携 ZIP 是不同文件，不混用校验值。
- 下载后本机独立核验：`Qianlai-Windows10-x64-4a67eec82868.zip` 为 325455086 字节，SHA256 `bdbbb2e26c261c82cf200fa980932b73648b6efd31519e92a7a0f7398182baaa` 与同名校验文件一致。270 个文件大小／哈希及清单集合一致；关键 5 个二进制 PE x64、3 个模型哈希及 Electron／OCR 两侧 CRT 齐全，来源 SHA／run 与成功构建一致。包内 certifi 的公开 CA 文件 `cacert.pem` 不含私钥；无试用账本、真实票据或本地证据。此检查不在 Mac 执行 Windows 程序。
- Library 大文件批量保存流程实际返回 `Library prepare_uploads is not available`，未确认任何 Library 文件保存，故无 library_file_id。交付采用上述核实后的私有 Actions artifact 和本机 ZIP／SHA256／`WINDOWS10-ACCEPTANCE.txt`，不改用其它上传方式。
- `main` 保持 `495bd34a20613ec55fabc719ba58c2d8010fdb87`，旧 UI 分支保持 `23041f9485cb0f4c7b3b0c952fd913335592e2fe`。没有 Release、合并、权限修改或真实数据上传；既有服务未接管。证据仅本机 `evidence/stage0/windows-restart-20261013/`。

## 必须分别记录结果
|检查|当前状态|通过证据|
|---|---|---|
|Windows x64 Forge package 便携候选|Windows Server 2022 x64 CI 通过|run 38357413207、job 115163407045；安装器 make 不在本轮范围|
|无 Node/Python 的干净系统，普通用户安装|未验证|安装、启动记录，无外装依赖|
|断网安装并首次 OCR|未验证|空缓存/新用户、网络禁用证据、模型哈希、识别结果|
|随包 --probe SQLite 及 OCR|Windows Server 2022 x64 CI 通过；Win10 未验证|两项 passed，子进程退出码 0；解压后重复通过|
|中文用户名和空格路径|CI 新中文空格解压目录探针通过；Win10 UI 未验证|原生 UI、业务读写及导入导出仍须真机验证|
|100/125/150/200% 缩放|未验证|关键面板无遮挡且操作可达|
|中文输入法、Ctrl+V|未验证|组合输入不提前提交；OCR 剪贴板入口后续阶段实现|
|升级与卸载数据保留|未验证|安装目录与数据目录隔离；试用数据也须保护，不能因尚非正式账本而删除；正式升级验收仍待后续阶段|
|完整备份与恢复失败回退|Windows 未验证；覆盖恢复未实现|Mac 新 managed 根的完整备份／新目录恢复已有实现；按 [备份恢复方案](BACKUP_RECOVERY_PLAN.md) B01–B16 在 Windows 单独验证，真实操作另行授权|
|OCR 子进程权限隔离|未验证|Windows 分支尚无 Mac 同等 OS 禁写约束；需验证不能写账本且无网络依赖|
|SmartScreen、杀毒、签名及公司机器策略|未验证|真实安装反馈，不能靠关闭安全软件通过|
|Mac/Windows 时区不同|未验证|业务日期一致；时间字段另存|
|完整 T01–T30|未验证|在目标 Windows 完整版本执行；阶段 0 不能替代|

## 历史：2026-10-12 金额字段与独立核对面板验证
Mac 新增金额字段验证：30 张合成图 29 张精确符合预期，1 张小数点错误安全留空。Windows 的字段提取、辅助程序重打包与首次离线测试继续全部未验证。后续可复用 spike/fixtures/ocr-fields 下已保存的图片，不能以 Mac 的报告作为 Windows 通过证据。

当时已接浏览器和 Mac Electron 的独立截图核对 UI，随后被费用内置截图流程替代，Mac worker 又增加系统禁写约束。Windows 上 preload/IPC、临时文件清理、取消进程、随包 worker --serve 与首次离线识别均未实测，不能用 Mac 通过记录替代。
