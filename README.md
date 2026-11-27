# 钱来 · 本地财务管理系统

一个**单人、单账本、人民币、完全离线**的报销台账桌面软件。用来记录接待和办公费用、公司预支到账和报销进度，随时知道“还剩多少钱”和“自己垫了多少钱”。

- 目标电脑：Windows 10 Intel x64，断网也能用（便携 ZIP，解压即用）。
- 开发：Mac 或 Linux。
- 技术：Electron + React + TypeScript + SQLite，截图识别用本地 Python OCR。

## 核心规则（三句话）

1. 公司打来的钱，一律记“**预支**”。
2. **余额 = 全部预支 − 全部费用**，可以是负数，负数部分就是“本人垫付”。
3. **报销只记录进度，不改变余额。**

完整规则见 [业务规则](docs/BUSINESS_RULES.md)。

## 现在能做什么

- 记费用（接待 / 办公）：手动填写，或上传支付截图让本机 OCR 辅助填写，确认后保存，截图一起保存。可纠错、删除误填。
- 记预支到账，可附到账截图，可修改、删除误填。
- 登记报销：一次报多笔、一笔分几次报、跨类别都可以；可撤销、删除误填批次。
- 费用详情里标记“是否已开票”。
- 导出当前筛选的费用 CSV。
- 完整备份、从备份恢复、清空账本。

还没做的功能和已知问题见 [现状](docs/STATUS.md)。

## 文档

| 文档 | 给谁看 | 内容 |
| --- | --- | --- |
| [现状](docs/STATUS.md) | 所有人 | 现在能用什么、验证到什么程度、下一步 |
| [审查报告（2026-11-27）](docs/REVIEW_2026-11-27.md) | 负责人 | 接手时发现的问题和改进建议 |
| [业务规则](docs/BUSINESS_RULES.md) | 所有人 | 软件现在遵守的全部记账规则 |
| [Windows 使用与升级说明](docs/WINDOWS_OFFLINE_TRIAL.md) | 使用者 | 解压、启动、升级、备份、出问题时怎么办（会打进安装包） |
| [Windows 验收清单](docs/WINDOWS_VALIDATION.md) | 验收者 | 在目标 Windows 10 上要检查的项目 |
| [架构与代码地图](docs/ARCHITECTURE.md) | 开发者 | 程序结构、数据存放、改什么先看哪里 |
| [开发指南](docs/DEVELOPMENT.md) | 开发者 | 环境、运行、测试、打包、Git 规则 |
| [AGENTS.md](AGENTS.md) · [CLAUDE.md](CLAUDE.md) | AI 助手 | 开发约定 |
| [DESIGN.md](DESIGN.md) · [PRODUCT.md](PRODUCT.md) | 开发者 | 界面规范、产品定位 |
| [原始需求 v1.1](expense_bookkeeping_spec_v1.1.md) | 参考 | 最初的完整需求，部分已被后来的决定修改 |
| [历史资料](docs/history/README.md) | 追溯 | 过去的计划、验证记录和交接文档 |

## 开发快速开始

```sh
npm ci
npm run build
npm test

# 用一个临时空账本启动浏览器开发界面：http://127.0.0.1:5173/
XX_FINANCE_DATA_DIR="$(mktemp -d)/ledger" npm run dev
```

更多（桌面版、OCR、打包）见 [开发指南](docs/DEVELOPMENT.md)。**开发和测试只用临时数据，不要碰真实账本。**
