# 阶段 0：离线 OCR 金额字段验证

> **历史记录（只读）**：本文反映写作当时的情况，其中的“当前”“本轮”“下一步”都指当时。现行规则见 [业务规则](../BUSINESS_RULES.md)，现状见 [STATUS](../STATUS.md)。

> 历史报告：记录 2026-10-12 金额字段探针时点的结果，保留原样本和失败项。后续商户／日期解析、费用内置截图及试用保存见 [OCR_REVIEW_UI](OCR_REVIEW_UI.md)；唯一当前状态见 [STAGE0_STATUS 顶部](STAGE0_STATUS.md#当前状态)。本次基础整理未重跑此报告的命令；本机 `evidence/` 不纳入 Git。

日期：2026-10-12。用户反馈费用录入与报销分配基本可用，本轮仅继续阶段 0；未进入阶段 1。

## 结论
Mac arm64 上在系统级禁止网络连接的环境中，实际运行了 **30 张合成图片 → RapidOCR → 金额解析**。
**29/30 个样本的状态、三类金额和支出建议全部符合预期；0 个错误支出建议；1 个安全留空。**
这是针对固定合成样本的结果，不是实际票据准确率。在本报告所述探针时点，真实脱敏截图、Windows 实测均未验证；后续四张用户截图的匹配记录不能推广为通用准确率。

17 项解析器单元测试通过。端到端验证命令退出码为 1，因为全角金额样本未精确提取；未将安全留空改记为准确提取成功，也未修改预期来让测试变绿。

## 核心规则
- 从明确标签及受限的邻近文字框提取金额，保留原始文本、坐标和 OCR 置信度。不选最大金额，不把余额当备用支付额。
- 支付成功标题与邻近纯金额可作为付款候选；仅凭金额大小、颜色或发票合计不确认付款。
- actual_paid 是按标签识别的**支付金额候选**，不是已付款事实；待付款/未知状态的候选也保留供人工核对，只有 suggested_expense_cents 才表示建议填写的支出金额。
- 退款、退款处理中、退款失败、部分退款均标为 refund_related；保留退款候选及原支付额，不建议新支出，不自动计算净额或记退款到账。
- 待付款、付款失败、收款、仅发票、状态未知、金额冲突、重复支付额、外币、零付款、未解析标签、低置信度时不生成支出建议。
- 原价、优惠、税额、票面合计单独分类，不从实付再扣一次优惠；发票日期不处理为付款日期。
- 字符串转换为整数分，校验分组、精度和安全整数上限。全角字符做 Unicode 规范化；不修复 O/0、·/. 等金额猜测。
- 全部结果 requires_confirmation=true、auto_bookkeeping=false。解析器及测试脚本不导入数据库模块，也不修改余额、报销或正式费用。
- 当前置信度阈值 0.90 是未经真实数据校准的保守门槛，并非正确概率。高置信度仍可能错字。

## 已发现的失败样本
[全角金额图片](../../spike/fixtures/ocr-fields/21_fullwidth.png) 的原文是“128．50”和“900．00”，OCR 输出为“128·50”和“900·00”，置信度分别为 0.99173、0.98676。
解析器拒绝非法金额，支付金额与余额均留空，并给出 unresolved_amount_label 警告；没有将其误记为 12850 元或替换小数点。
最小处理：保留原图和 OCR 文本，要求人工填写/核对金额。以后可评估局部重识别，但本轮不引入自动纠字猜测。

## 实测范围
30 张图包含支付与余额干扰、全/部分/处理中/失败退款、支付退款混合、待付款/失败/关闭、仅余额、无标签、优惠、税额、发票、收款、冲突/重复金额、一分钱/零元、全角/千分位、分栏/分行、暗色、小尺寸、轻微模糊和 JPEG 压缩。
均由本项目绘制，没有真实公司/账户数据。预期标注在 OCR 执行前生成，manifest 哈希见 summary.json。各图共用少量布局和字体，不能代表真实支付软件的版式分布。
字段有值样本的精确提取：支付候选 17/18；账户余额 23/24；退款候选 6/6。空值不计入这三个分母。

## 逐样本结果
金额单位：元；“支出建议”仍必须人工确认；— 表示无此预期字段。

|样本与原图|付款状态|支付候选|账户余额|退款候选|支出建议|结果|
|---|---|---:|---:|---:|---:|---|
|[01_paid_balance](../../spike/fixtures/ocr-fields/01_paid_balance.png)|已付款线索|128.50|9,800.00|留空|128.50|符合预期|
|[02_balance_smaller](../../spike/fixtures/ocr-fields/02_balance_smaller.png)|已付款线索|1,500.00|20.00|留空|1,500.00|符合预期|
|[03_refund](../../spike/fixtures/ocr-fields/03_refund.png)|退款相关|留空|9,800.00|128.50|留空|符合预期|
|[04_partial_refund](../../spike/fixtures/ocr-fields/04_partial_refund.png)|退款相关|留空|900.00|100.00|留空|符合预期|
|[05_refund_pending](../../spike/fixtures/ocr-fields/05_refund_pending.png)|退款相关|留空|留空|80.00|留空|符合预期|
|[06_refund_failed](../../spike/fixtures/ocr-fields/06_refund_failed.png)|退款相关|留空|留空|88.00|留空|符合预期|
|[07_mixed_payment_refund](../../spike/fixtures/ocr-fields/07_mixed_payment_refund.png)|退款相关|100.00|1,000.00|20.00|留空|符合预期|
|[08_waiting](../../spike/fixtures/ocr-fields/08_waiting.png)|未付款|128.50|5,000.00|留空|留空|符合预期|
|[09_failed_payment](../../spike/fixtures/ocr-fields/09_failed_payment.png)|未付款|80.00|900.00|留空|留空|符合预期|
|[10_closed](../../spike/fixtures/ocr-fields/10_closed.png)|未付款|留空|900.00|留空|留空|符合预期|
|[11_only_balance](../../spike/fixtures/ocr-fields/11_only_balance.png)|已付款线索|留空|8,000.00|留空|留空|符合预期|
|[12_only_unlabelled](../../spike/fixtures/ocr-fields/12_only_unlabelled.png)|未知|留空|留空|留空|留空|符合预期|
|[13_discount](../../spike/fixtures/ocr-fields/13_discount.png)|已付款线索|90.00|900.00|留空|90.00|符合预期|
|[14_tax](../../spike/fixtures/ocr-fields/14_tax.png)|已付款线索|106.00|3,000.00|留空|106.00|符合预期|
|[15_invoice](../../spike/fixtures/ocr-fields/15_invoice.png)|发票|留空|留空|留空|留空|符合预期|
|[16_incoming](../../spike/fixtures/ocr-fields/16_incoming.png)|收款相关|留空|900.00|留空|留空|符合预期|
|[17_conflict](../../spike/fixtures/ocr-fields/17_conflict.png)|已付款线索|留空|2,000.00|留空|留空|符合预期|
|[18_repeated](../../spike/fixtures/ocr-fields/18_repeated.png)|已付款线索|留空|留空|留空|留空|符合预期|
|[19_one_cent](../../spike/fixtures/ocr-fields/19_one_cent.png)|已付款线索|0.01|100.00|留空|0.01|符合预期|
|[20_zero](../../spike/fixtures/ocr-fields/20_zero.png)|已付款线索|0.00|100.00|留空|留空|符合预期|
|[21_fullwidth](../../spike/fixtures/ocr-fields/21_fullwidth.png)|已付款线索|留空|留空|留空|留空|未精确提取，安全留空|
|[22_grouped](../../spike/fixtures/ocr-fields/22_grouped.png)|已付款线索|1,280.50|98,000.00|留空|1,280.50|符合预期|
|[23_split_columns](../../spike/fixtures/ocr-fields/23_split_columns.png)|已付款线索|128.50|8,000.00|留空|128.50|符合预期|
|[24_split_rows](../../spike/fixtures/ocr-fields/24_split_rows.png)|已付款线索|128.50|8,000.00|留空|128.50|符合预期|
|[25_unknown_status](../../spike/fixtures/ocr-fields/25_unknown_status.png)|未知|128.50|8,000.00|留空|留空|符合预期|
|[26_foreign_currency](../../spike/fixtures/ocr-fields/26_foreign_currency.png)|已付款线索|128.50|留空|留空|留空|符合预期|
|[27_dark](../../spike/fixtures/ocr-fields/27_dark.png)|已付款线索|66.60|9,900.00|留空|66.60|符合预期|
|[28_small](../../spike/fixtures/ocr-fields/28_small.png)|已付款线索|66.60|9,900.00|留空|66.60|符合预期|
|[29_blur](../../spike/fixtures/ocr-fields/29_blur.png)|已付款线索|66.60|9,900.00|留空|66.60|符合预期|
|[30_jpeg](../../spike/fixtures/ocr-fields/30_jpeg.jpg)|退款相关|留空|1,600.00|40.00|留空|符合预期|

## 复现命令
项目根目录，沿用已有 .venv-ocr、固定依赖及本地模型，无需重新下载：

```sh
.venv-ocr/bin/python -m unittest discover -s tests -p 'test_ocr_fields.py' -v
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)' \
  .venv-ocr/bin/python spike/validate_ocr_fields.py
```

validate_ocr_fields.py 会按固定清单重跑，覆盖同名本轮结果文件；保留中点失败时退出 1 是预期的严格验收结果。
如需重新生成同一组图片，运行 `.venv-ocr/bin/python spike/build_ocr_field_fixtures.py`；生成器使用 Mac 系统 STHeiti 字体，Windows 不应直接用该字体路径，而应复用已保存 PNG/JPEG。

单图（JSON 输出）：

```sh
.venv-ocr/bin/python spike/ocr_probe.py spike/fixtures/ocr-fields/04_partial_refund.png
```

## 独立打包程序回归
PyInstaller 重建后，在系统禁网下实际运行 3 个样本，每个重复识别两次：
- 支付样本：建议支付 128.50 元，余额 9800.00 元，两者独立。
- 部分退款：原支付额 500.00 元、退款候选 100.00 元、余额 900.00 元；无新支出建议，不算净额。
- 原始样本：支付成功标题下的金额 1280.50 元、余额 8000.00 元，旧入口兼容。
以上字段断言通过，进程退出 0；[回归记录与程序哈希](../../evidence/stage0/ocr-fields-2026-10-12/bundled-checks.json)。这证明本轮字段解析已进入 Mac 独立辅助程序，不等于 Windows 安装包验证。

## 证据与边界
- [逐图原始 OCR、坐标、置信度、字段及差异](../../evidence/stage0/ocr-fields-2026-10-12/results.json)
- [汇总及模型/清单哈希](../../evidence/stage0/ocr-fields-2026-10-12/summary.json)
- [实际禁网运行日志](../../evidence/stage0/ocr-fields-validation.log)
- [17 项单元测试](../../evidence/stage0/ocr-fields-unit.log)
- [PyInstaller 重建日志](../../evidence/stage0/ocr-fields-build.log)

在本报告所述时点，仅解析金额候选及粗粒度交易状态；商户、日期、UI 导入确认等尚未接入。随后先增加独立不入账核对面板，再被费用内置截图、商户／日期辅助填写、人工确认保存及附件流程替代，详见 [OCR_REVIEW_UI](OCR_REVIEW_UI.md)。
交易号／票号通用结构化提取、PDF、复杂列表／多交易截图、金额单位换算、真实退款处理和 Windows 首次离线安装仍未完成或未验证；最新范围以 STAGE0_STATUS 顶部为准。
