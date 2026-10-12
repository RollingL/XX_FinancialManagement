---
name: 本地报销台账
description: 阶段 0 已实现浅色本地工具界面的视觉记录
colors:
  accent: "#216653"
  accent-hover: "#194f40"
  text: "#24332f"
  muted: "#626e69"
  background: "#f4f6f5"
  surface: "#fff"
  soft: "#eef3f0"
  line: "#dce3df"
  danger: "#a6422e"
  nav-active: "#dce9e1"
  nav-text: "#194f3d"
  status-bg: "#eef1ef"
  status-text: "#59665e"
  partial-bg: "#fbf0da"
  partial-text: "#7f5816"
  done-bg: "#e7f3ea"
  done-text: "#2c6140"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\", \"PingFang SC\", sans-serif"
    fontSize: "26px"
    fontWeight: 650
    letterSpacing: "-0.02em"
  panel-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\", \"PingFang SC\", sans-serif"
    fontSize: "20px"
    fontWeight: 700
  section-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\", \"PingFang SC\", sans-serif"
    fontSize: "15px"
    fontWeight: 650
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\", \"PingFang SC\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
  table-body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\", \"PingFang SC\", sans-serif"
    fontSize: "13px"
    fontWeight: 400
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\", \"PingFang SC\", sans-serif"
    fontSize: "12px"
    fontWeight: 550
  status:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\", \"PingFang SC\", sans-serif"
    fontSize: "11px"
    fontWeight: 400
  summary-amount:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\", \"PingFang SC\", sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.02em"
rounded:
  status: "4px"
  field: "5px"
  control: "6px"
  container: "8px"
spacing:
  control-gap: "10px"
  inset: "18px"
  panel-inline: "26px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    padding: "9px 11px"
  status:
    backgroundColor: "{colors.status-bg}"
    textColor: "{colors.status-text}"
    rounded: "{rounded.status}"
    padding: "4px 7px"
  navigation-active:
    backgroundColor: "{colors.nav-active}"
    textColor: "{colors.nav-text}"
    rounded: "{rounded.control}"
    padding: "12px"
  workspace:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.container}"
---

# Design System: 本地报销台账

> 本文与 `.impeccable/design.json` 是既有 UI 的实现记录，不是新的视觉批准。2026-10-12 用户明确反馈视觉不满意，新偏好尚待确认；后续评审范围见 [PROTOTYPE_DIRECTION](docs/PROTOTYPE_DIRECTION.md)，唯一当前状态见 [STAGE0_STATUS 顶部](docs/STAGE0_STATUS.md#当前状态)。本轮不改样式、布局或交互代码。

## Overview

**Creative North Star: "清楚的本地工作账本"**

浅色本地工具界面，以清楚的中文、横向金额比较和右侧操作面板组织工作。低饱和绿色标识主要操作，白色工作区与浅灰绿色背景分层，状态同时使用文字。

本记录从阶段 0 原型代码提取，尚不代表完整桌面产品的视觉验收。系统中文字体是用户明确要求，保留为工具界面字体，不建立装饰性展示字体或新品牌。

来源：`prototype/src/style.css`、`prototype/src/main.tsx`、`prototype/src/ExpenseScreenshot.tsx` 和 `prototype/src/ocr.ts`；产品边界见 `PRODUCT.md`，历史方向与新反馈见 `docs/PROTOTYPE_DIRECTION.md`，操作边界见 `docs/OCR_REVIEW_UI.md`。此处记录实际代码，不扩展阶段范围。

**Key Characteristics:**
- 列表优先，金额右对齐并使用等宽数字。
- 右侧面板承载录入、详情和分配，减少页面跳转。
- 紧凑表格配合可见焦点与文字状态。

## Colors

浅灰绿色底色、白色工作区和克制的深绿主操作组成工具界面。

### Primary
- `accent` 用于主要按钮、选中控件和文字链接；`accent-hover` 为主按钮悬停。
- `nav-active` 与 `nav-text` 是当前导航的浅底与深色文字。

### Neutral
- `background` 承载整体画布，`surface` 承载表格和面板，`soft` 承载金额计算提示。
- `text` 是正文，`muted` 是次要说明，`line` 划分区域。
- `danger` 标识负余额；部分报销与完成状态分别使用 `partial-*` 和 `done-*`。

**The Text State Rule.** 状态以文字表达，颜色仅帮助区分。

## Typography

所有层级共享前述系统字体栈；Windows 与 Mac 的具体字形不同，尚未据此宣称 Windows 已验收。没有独立展示字体。

标题使用 `headline`；面板标题使用 `panel-title`；区块标题使用 `section-title`。默认正文为 `body`，表格正文为 `table-body`，说明及表单标签通常为 12px，状态和表头为 11px。汇总金额使用 `summary-amount`；录入金额为 26px，详情金额为 32px。这是实用角色层级，不是等比字阶。段落行高 1.65，帮助文本行高 1.8。

**The Comparable Amounts Rule.** 金额右对齐并使用 tabular-nums；金额角色不等同于装饰标题。

## Layout

桌面是固定宽 208px 的左导航加弹性内容区。内容区最大宽 1700px，内边距为上 35px、左右 34px、下 22px。汇总区为三列，比例 1.15:1:0.8；筛选栏可换行，费用表格保留横向滚动。表格单元格默认纵向 20px、横向 15px；分配表缩为 13px 和 10px。

右侧面板固定在视口右侧，高度 100dvh，普通宽 480px，分配面板宽 840px，最大宽度 100vw；页脚粘在底部。普通面板正文内边距 24px 26px。

1100px 以下导航缩为 176px，内容内边距 26px 22px，汇总金额缩为 26px。760px 以下导航为 140px、隐藏文字方块标记，汇总改为单列，汇总金额为 24px，页面标题为 22px，双列表单改为单列。此为实际原型适配，不推导手机应用导航规范。

支付截图上传置于“记一笔费用”的普通 480px 右侧面板内，上传、原图、费用字段上下排列，沿用既有面板断点，不设独立 OCR 双栏布局。上传区底部分隔线与 20px 留白分开后续字段；字段区顶部间距 24px。原图容器最大高度 360px，可独立滚动，默认适应宽度，可切换原尺寸；录入和详情附件共用该预览。图片操作按钮可换行，间距 8px。

## Elevation & Depth

工作区和汇总容器均不使用阴影，靠边框和浅底色区分。覆盖式右侧面板使用柔和左侧阴影 `-12px 0 45px #1e37221c`，背景遮罩为 `#1f302e32`。无硬偏移阴影。

**The Flat Workspace Rule.** 工作区依靠底色和边框分层，阴影仅用于覆盖主界面的右侧面板。

## Shapes

容器、按钮、表单和状态使用 frontmatter 中的轻度圆角层级；右侧面板保持直边。边框大多为 1px。复选框为 16px 正方形，沿用平台控件和主色。不要把一处品牌文字方块扩展为新的图标系统。

## Components

### Buttons

主按钮使用深绿底与白字；次按钮白底，边框 `#ced8d2`，悬停底色 `#f0f5f2`。按钮最小高度 38px，禁用态浅灰绿色，鼠标指针表示不可操作。文字链接无边框。所有交互焦点为 3px 实线 `#89b5a5`，偏移 2px。

### Chips

紧凑的报销状态标签使用文字加底色，仅展示派生状态；未报销、部分报销和已报销分别使用中性、暖黄及浅绿色。标签不是切换按钮。

### Cards / Containers

白色、细边框、轻圆角的汇总和工作区为主要容器。计算提示采用浅灰绿色底与 18px 内边距。无需给每行费用套独立卡片。

### Inputs / Fields

白底、细边框 `#c6d1ca`、最小高度 38px，沿用统一焦点样式。金额字段使用数字键盘提示和等宽数字；错误以可读文字和浅红底表达。标签与输入间距 9px，字段底部间距 22px。

### Navigation

左侧纵向文本按钮，当前栏目浅绿底、深绿字和 650 字重，数量以较小字号显示。后续阶段条目仅显示说明，不伪装成已实现入口。

### Right-side panel

使用原生模态 dialog 与关闭按钮，保持标题、正文、底部操作的层次。面板开启动画仅在用户未要求减少动态时使用：180ms ease-out，从右侧偏移 20px、透明度 0.7 到原位及不透明。静态容器不附加动画。

### Expense screenshot and attachment

截图上传复用现有录入面板，费用字段依次为实际支出金额、日期和商户／采购摘要，沿用统一输入样式。能够确定的值自动填写，不确定值留空，允许手动补充或修正；上传新图先清空旧识别字段。识别说明使用既有 12px 帮助文本，不新增逐字段来源标签。识别期间禁用费用字段与保存，显示文字进度和“停止识别，手动填写”按钮，不显示虚构百分比；失败时保留原图供手工填写。

余额、退款金额和原始识别文字放在“查看识别参考信息”折叠区，余额与退款不填入支出，也不自动冲减支出。原始文字以 12px 等宽字体、1.6 行高显示，自动换行，最高 180px 后滚动。

底部“确认并保存费用”是唯一提交入口；成功提示费用已存入本地试用账本，并在有截图时说明附件已保留。上传与识别本身不入账，取消不保存。已保存截图在费用详情中以“支付截图附件”标题和相同预览控件呈现，带读取状态、失败提示与放大按钮。本轮属于阶段 0 小范围试用保存，不代表阶段 1 或生产账本验收。

本轮视觉记录对应 `evidence/stage0/expense-ocr-2026-10-12/` 的录入、窄窗口、附件和列表截图；核对了 `entry-top-1024.png` 与 `attachment-desktop.png`。这些前端证据不证明识别泛化准确率或 Windows 桌面验收。

## Do's and Don'ts

### Do:
- Do 使用已确认的系统中文字体和本地资源。
- Do 保持金额右对齐、文字状态及可见键盘焦点。
- Do 在窄窗口保持表格横向滚动和面板视口宽度约束。

### Don't:
- Don't 以手动状态标签替代真实报销分配。
- Don't 为该工具增加装饰性大标题、远程字体或无关图库素材。
- Don't 把原型截图记录当作 Windows 字体、缩放或桌面验收。

未固化为规范：当前原型用文字 `i` 与全角加号模拟图标，以及导航上方的小型分组引导文字；这些不作为未来图标或装饰性眉题规则。系统字体是用户明确指定的工具文字策略，不提升为装饰展示字体。本次仅记录，不修复界面。
