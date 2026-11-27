# 钱来 · 本地报销台账
<!-- impeccable:product-schema 1 -->
## Platform
web（Electron 桌面应用内的本地页面）
## Stack
Electron + React + TypeScript + SQLite。目标为 Windows 10 Intel x64 离线便携版，Mac 用于开发。
## Users
一个人在本机登记接待和办公费用、公司预支到账和报销进度。负责人是编程新手。
## Product Purpose
快速记录实际收支，随时清楚“预支还剩多少 / 本人垫付多少”和“还有多少费用没报销”。
## Capabilities and Constraints
公司拨款统一记预支；余额 = 预支 − 费用，允许负数；报销只记进度、不改余额，按费用多对多分配。费用手动填写，可附一张截图作为凭证。支持纠错、误填删除、开票提醒、CSV、完整备份恢复和清空。完全离线，不上传任何数据。详见 [业务规则](docs/BUSINESS_RULES.md) 和 [现状](docs/STATUS.md)。
## Brand Commitments
浅色、列表优先、右侧模态面板录入和查看详情、少字段、中文、金额右对齐、克制的紫色强调（雾紫白 v2）。见 [DESIGN](DESIGN.md)。
## Evidence on Hand
原始需求 [v1.1](expense_bookkeeping_spec_v1.1.md)；现行规则 [BUSINESS_RULES](docs/BUSINESS_RULES.md)；接手审查 [REVIEW_2026-11-27](docs/REVIEW_2026-11-27.md)。测试和演示只用合成数据。
## Accessibility & Inclusion
键盘可操作、状态有文字说明、焦点可见；Windows 显示缩放和中文输入法仍需在真机检查。
