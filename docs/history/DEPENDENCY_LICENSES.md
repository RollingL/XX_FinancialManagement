# 阶段 0 许可记录

> **历史记录（只读）**：本文是 OCR 时期的许可记录。OCR（RapidOCR、模型、Python 运行时）已于 2026-11-27 移除，这些许可不再适用。正式发布前仍需另做一次依赖许可整理。现状见 [STATUS](../STATUS.md)。

这是依赖验证记录，不代表正式发布所需的全量传递依赖审计完成。

- RapidOCR 3.10.0 包中提供 Apache-2.0 LICENSE 与单独 MODEL_LICENSES.md，当时复制到 spike/licenses/ 并随应用资源打包（已删除）。
- 模型声明单独列明 det small、rec small、legacy cls 三个文件及 SHA256。prepare_models.py 与实测 JSON 均按相同哈希核验，不仅按文件名认定。
- 代码归属 RapidOCR Authors；模型上游归属 Baidu/PaddleOCR，具体原始声明和来源见保留文件。不把代码许可直接套给全部模型。
- 字典来源是识别 ONNX 内嵌 character 元数据，随同该模型核对。
- PyInstaller 输出携带其收集到的依赖许可证；全量依赖 NOTICE、运行库、签名以及 Windows 再分发仍为发布前未完成项。
- 合成 OCR 图片由本项目绘制，无真实公司/账户数据；系统字体仅用于生成测试图片，未复制字体文件进应用。
