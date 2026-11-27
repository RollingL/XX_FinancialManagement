# 钱来 · Claude 工作说明

@AGENTS.md

上面导入的 AGENTS.md 是所有人共用的约定，必须遵守。下面是 Claude 额外需要注意的事。

## 每次开始

1. 核对分支和未提交改动（`git status --short --branch`）。
2. 读 [docs/STATUS.md](docs/STATUS.md)；涉及业务规则读 [docs/BUSINESS_RULES.md](docs/BUSINESS_RULES.md)；动代码前读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 里对应的“改什么，先看哪里”。
3. 需求有两种以上理解时，按最可能的理解开始做，并在回复里说明你选了哪种理解。

## 运行环境

Claude 通常在云端 Linux 容器里工作：

- **能做**：`npm ci`、`npm run build`、`npm test`、Python 字段解析测试、用临时数据目录启动浏览器开发模式并用 Playwright 实际操作和截图。
- **不能做**：运行 Windows 或 Mac 桌面版、在 Windows 10 真机验收。OCR 模型默认没有安装，需要按 [DEVELOPMENT 第 3 节](docs/DEVELOPMENT.md#ocr-环境) 自行准备（尚未在云端验证过）。
- 汇报时写明“在 Linux 云端验证”，不要暗示 Windows 或 Mac 也通过了。
- 需要 Windows 包时，通过 GitHub Actions 手动触发（见 [DEVELOPMENT 第 4 节](docs/DEVELOPMENT.md#windows-离线包)），**每次触发前先征得负责人同意**。

## 和负责人沟通

- 负责人是编程新手，用简单中文。先说结论，再说依据；不要贴大段日志。
- 需要做决定时，给出选项、你的建议和理由。
- 自己能完成的步骤（建分支、改代码、跑测试、开 PR）直接做完，再告诉负责人结果。

## 提交和 PR

- 在分支上提交，开 PR 让负责人审阅合并；不直接改 `main`。
- PR 描述包括：改了什么、为什么；实际运行的验证命令和结果（注明平台）；没有验证的部分；是否影响已有数据。
- “整理代码格式”和“改功能”分成不同的 PR 或提交，方便看清真正的改动。
- 合并后更新 [docs/STATUS.md](docs/STATUS.md)。
