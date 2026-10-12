# Windows 验证矩阵（当前全部未验证）

唯一当前状态见 [STAGE0_STATUS 顶部](STAGE0_STATUS.md#当前状态)。本文是待执行矩阵，不是 Windows 通过报告；本次基础整理未运行构建、安装或恢复。

> 2026-10-12 补充：Windows 仍未验证。最新验收需在“记一笔费用”内上传截图，首次断网自动识别金额/日期/商户、手动修正并确认保存；重启后费用与附件存在且字节一致；退款/余额不补位。验证安装目录与用户数据目录分离，升级不丢 trial.sqlite/attachments。Mac 成功不代替这些检查。

2026-10-10 历史环境记录：当时执行环境仅 macOS arm64，没有 Windows x64 构建机器或测试机，未生成 Windows 安装包、未提交 CI。后续 Windows 机器可用性仍需确认，不以 Windows ARM、Mac 浏览器或 Mac 应用代替。
开始前填写：Windows 11 具体版本/构建号、x64 CPU、内存、普通用户权限、安装包版本与 SHA256。Windows 10 不在当前兼容承诺内。

## 构建候选命令（PowerShell；未在 Windows 执行）

```powershell
npm ci
py -3.12 -m venv .venv-ocr
.\.venv-ocr\Scripts\python.exe -m pip install -r spike\requirements.txt
.\.venv-ocr\Scripts\python.exe spike\prepare_models.py
Push-Location spike
..\.venv-ocr\Scripts\pyinstaller.exe --noconfirm ocr-probe.spec --distpath ocr-dist --workpath ocr-build
Pop-Location
npm test
npm run make
```

- 不拷贝 Mac 的 node_modules、.venv-ocr 或 ocr-dist；Windows 原生重装和构建。
- requirements-macos-arm64.lock.txt 是 Mac 已测传递依赖快照，不是 Windows 锁文件。Windows 解析 requirements.txt 后记录自己的完整锁定清单。
- npm 12 默认可能阻止 electron-winstaller 安装脚本；Mac 首次安装确有警告。Windows 构建前审阅对应脚本、按 npm install-scripts 工作流批准所需包；未验证此安装器初始化与打包结果。
- npm test 使用 Node 的 TypeScript 类型剥离能力；当前已测 Node 26.10.0，Windows 首次先用相同主版本验证。
- Forge package/make 将已构建的 ocr-dist/ocr-probe 整个目录作为资源纳入；缺辅助程序不应当当作完整离线包。
- Windows 生成的程序带 --probe 可运行隔离 SQLite 与 OCR 探针：探针数据库在新临时目录生成并清理，素材为随包合成截图。
- `--probe` 使用独立临时合成数据库；正常窗口已使用 SQLite 试用账本并保存费用、附件和报销分配。测试必须显式指定隔离目录，不把正常窗口当作不保存的演示。

## 必须分别记录结果
|检查|当前状态|通过证据|
|---|---|---|
|Windows x64 原生模块重建、Forge make|未验证|完整构建日志、包 SHA256、架构|
|无 Node/Python 的干净系统，普通用户安装|未验证|安装、启动记录，无外装依赖|
|断网安装并首次 OCR|未验证|空缓存/新用户、网络禁用证据、模型哈希、识别结果|
|随包 --probe SQLite 及 OCR|未验证|status passed，完整子进程退出码|
|中文用户名和空格路径|未验证|读写、OCR、导入导出实际操作|
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
