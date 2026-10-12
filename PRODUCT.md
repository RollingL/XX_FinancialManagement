# 本地报销台账
<!-- impeccable:product-schema 1 -->
## Platform
web
## Stack
用户已确认 Electron + React + TypeScript + SQLite 路线；Windows 桌面交付，Mac 开发。当前仅阶段 0。
## Users
单人本地登记接待和办公费用、公司预支与报销进度。
## Product Purpose
快速记录实际收支，明确本人垫付与待报账分别是多少。
## Capabilities and Constraints
报销不改变余额；多对多真实分配；负余额允许。OCR 已接入费用录入，在 Mac 本机禁网下验证；Windows 离线安装仍未验证。阶段 0 小范围保存到独立 SQLite 试用账本，截图为费用附件，人工确认后才登记。
## Brand Commitments
既有实现方向：浅色、列表优先、右侧录入/详情面板、少字段、中文、克制强调色、金额右对齐。2026-10-12 用户表示视觉不满意，尚未给出新偏好；后续方向待评审，本轮不改 UI。见 [界面方向记录](docs/PROTOTYPE_DIRECTION.md)。
## Evidence on Hand
业务权威为 expense_bookkeeping_spec_v1.1.md；计划见 docs/IMPLEMENTATION_PLAN.md；唯一当前状态见 [STAGE0_STATUS 顶部](docs/STAGE0_STATUS.md#当前状态)。试用账本首次创建为空，重开保留。合成样本用于回归；用户授权的真实截图仅在隔离目录本机测试。
## Accessibility & Inclusion
键盘可用、文字状态、可见焦点；Windows 缩放与输入法须实测。
