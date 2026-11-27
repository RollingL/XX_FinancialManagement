# 钱来 · 本地财务管理系统

单人、单账本、人民币。记录接待和办公支出、公司预支到账与报销进度。Windows 10 Intel x64 是离线使用目标，Mac 用于开发和验证。

## 当前功能

- 费用录入、查询、纠错及误填删除。单张 PNG/JPEG 可点击或拖入，离线 OCR 辅助填写实付金额、日期和商户，人工确认后保存费用和原图附件。
- 预支到账、查看、编辑、误填删除及可选截图。余额按全账本预支减实际支出计算，负数表示本人垫付。
- 报销按费用分配，支持部分报销、跨类别合并、撤销及误填批次删除。报销只改变进度，资金事实与余额保持一致。
- 费用详情可标记“是否已开票”。旧版的发票及关联保留在备份兼容层。费用 CSV 导出当前筛选命中的所有页。
- 受管账本支持完整备份、预览后恢复到新目录以及明确确认后的清空。

## Mac 开发

项目使用 Node `26.10.0`、Python `3.12` 和仓库锁定的依赖版本。安装依赖和首次构建需要网络。业务运行和 OCR 使用本机数据与模型。

```sh
npm ci
npm run build
npm test
```

本地开发界面使用固定端口 `127.0.0.1:5173`。先查看该端口是否空闲。用独立的合成数据目录启动，Vite 开发服务会打开或创建账本。

```sh
lsof -nP -iTCP:5173 -sTCP:LISTEN
qianlai_dev_root=$(mktemp -d "${TMPDIR:-/tmp}/qianlai-dev.XXXXXX")
XX_FINANCE_DATA_DIR="$qianlai_dev_root/ledger" npm run dev
```

打开 [本机开发界面](http://127.0.0.1:5173/)。端口已占用时，使用交接文档中的独立 Electron 入口。单独添加 `--port` 会与本机 API 的来源校验冲突。

测试 OCR 时，在项目中准备隔离 Python 环境和本地模型。已经配置 `.venv-ocr` 的工作区可直接使用；模型脚本从锁定的 RapidOCR wheel 复制三份模型并校验哈希。

```sh
python3.12 -m venv .venv-ocr
.venv-ocr/bin/python -m pip install -r spike/requirements.txt
.venv-ocr/bin/python spike/prepare_models.py
.venv-ocr/bin/python -B -m unittest discover -s tests -p 'test_*.py'
.venv-ocr/bin/python spike/ocr_probe.py spike/fixtures/ocr-sample.png
```

## 数据与交接

- 首次创建的账本从空开始。浏览器默认根为项目 `.local-data/`，Electron 开发默认使用 `app.getPath('userData')/stage0-trial/`。两者独立。执行开发或验收时优先使用显式隔离根。
- 完整备份包含 SQLite、受管附件及校验清单。恢复在原账本备份成功后发布新活动根。CSV 是费用列表输出。
- Windows 从完整解压目录的 `Qianlai.exe` 启动。最新历史候选由 Windows Server CI 构建并通过随包 GUI、SQLite 和 OCR 检查。目标 Windows 10 首次断网、真实账本升级及系统兼容性仍待验证。历史 CI 产物已过保留期，源码交接不生成新包。

| 入口 | 用途 |
| --- | --- |
| [Claude 接手入口](CLAUDE.md) · [开发交接](docs/HANDOFF.md) | 接手顺序、源码地图、安全启动与验证矩阵 |
| [当前状态](docs/STAGE0_STATUS.md#当前状态) | 当前功能、验收边界与历史决策 |
| [需求 v1.1](expense_bookkeeping_spec_v1.1.md) · [实施方案](docs/IMPLEMENTATION_PLAN.md) | 原始产品需求和分阶段设计，现行规则见状态页 |
| [Windows 离线候选](docs/WINDOWS_OFFLINE_TRIAL.md) · [验证矩阵](docs/WINDOWS_VALIDATION.md) | 完整解压、数据位置、构建和目标机验收 |
| [Mac 验收基线](docs/ACCEPTED_BASELINE_2026-10-13.md) · [界面规范](DESIGN.md) | 已验收历史版本及界面布局 |
