# Windows 启动故障：2026-10-15

状态：已确认二次报错来源，修复启动诊断缺失和退出码漏报；首次闪退根因及 Windows 10 运行恢复尚未确认。没有删除锁、改账本或停掉任何已有实例；没有推送、构建 Windows、运行 Actions 或发布。

## 截图和版本证据

已从用户指定 Library 文件 `libfile_779b5f5fa38081918c89658bb3c14ff7` 取回 PNG 并实际查看。截图原文：

> 本地试用启动失败：账本正在使用或有残留锁，请先正常关闭原实例；不会自动抢锁
>
> Stopped. Do not delete existing data or disable security software. Report this message.

此处是“账本”，不是 OCR 提取结果中的“账号”。截图未显示首次退出码、进程列表或崩溃模块。

GitHub 只读查询确认：run `38379683352` 成功，artifact `11802847123` 未过期，对应源码 `3155f9d938adaf03c744a9088ad56c3f49b6dfaa`，分支 `codex/windows10-offline-acceptance`。artifact 外层 digest 为 `sha256:1ed7c7aabe8da6c1f7831c563970d2ff02de09e1c39eb7bd46c05a9f54ac377d`，它不等同于内层便携 ZIP 的 SHA256。本轮未重新下载整包或核验用户电脑上的字节。

本机开始时是干净的 `codex/ui-mist-lavender-v2` / `0033a4c`。故障包相对它有 Windows 备份文件可写句柄 flush、恢复回执测试及构建范围修订；没有改变两个启动文件。远端和本机修改前 Git blob 相同：

- `spike/main.cjs`: `2ba825648e2a9f8546fcc64d9350d404301df99e`
- `spike/prepare-windows-portable.cjs`: `62fa59a758f61467f818eb51cbf3e3d85893d954`

如后续构建，须在 `3155f9d` 或它的后继版本上应用本轮补丁，保留上述 Windows 修订；不能从旧 UI 分支直接覆盖 Windows 分支。原有已验收文档中“没有新 Windows 包”的话描述 10 月 13 日较早的收尾时点，不适用于此后单独构建的 `3155f9d`。

## 已确认与尚未确认

1. `managed-ledger.cjs` 的 `acquireManagedLock()` 用排他创建 `.writer-lock` 拒绝第二个写入者。该目录存在时得到 `EEXIST`，输出截图中的提示。锚点账本与恢复后的活动根都可能持锁。
2. 正常退出会停止 OCR、等待待完成账本操作、关闭 SQLite，再释放本进程拥有的锁。锁的所有者或内容变化、连接关闭无法确认时会保留锁。异常退出后残留锁、另一个仍在运行的实例，均能产生同一提示；截图不能区分它们。
3. 原生主窗口直接 `loadFile(dist/index.html)`，不启动 HTTP 服务；正式启动脚本未指定调试端口。因此不能把此截图归因为 5173/5190 等端口占用，也没有理由停掉这些服务。
4. OCR worker 在识别／图片验证请求时才启动，打开主窗口并不会启动 Python OCR。SQLite 打开和持锁在窗口创建前。若用户看到的是主应用窗口，则它曾经过该阶段；若只看见黑色命令窗口，不能作此推断。
5. 原启动脚本无持久化主进程输出、Chromium 日志和启动阶段记录；`if errorlevel 1` 也无法完整覆盖负数崩溃退出码。后者是源码可确认的漏报风险，不是已测得的用户退出码。

没有从截图推断显卡故障、缺 DLL、杀毒拦截或账本损坏。没有更换 Electron、禁用沙箱／显卡、删除锁或加入自动抢锁。

## 本轮修订

- 每次启动和探针生成独立诊断目录，不覆盖前次日志；继续严格核对包的 trial marker，固定原数据及备份路径。
- 立即保存原生退出码并按“不等于 0”判失败，保留该码作为脚本退出码；错误后展示 stderr 和路径、暂停窗口。保持延迟变量展开关闭，避免含 `!` 的路径被破坏。
- 记录该应用映像的启动前／后进程列表、锁存在状态、时间和系统版本；不结束进程，不读取 SQLite、附件、报销内容或锁令牌。
- 开启 Electron 本地日志和崩溃栈输出。根据 [Electron 官方环境变量说明](https://www.electronjs.org/docs/latest/api/environment-variables) 设置日志文件及日志开关，不接入远程收集。
- 主进程在显式诊断环境变量下输出固定阶段、渲染／辅助进程退出原因和退出码、关闭收尾进度；不输出业务请求或 OCR 文本，不改变账本和关闭流程。探针 JSON 输出保持纯净。

本地旧包辅助文件：`evidence/stage0/windows-startup-2026-10-15/START-DIAGNOSTIC.cmd`、`CHECK-RUNTIME-DIAGNOSTIC.cmd`，固定到上述 artifact 的 build identity。它们可以调用旧 exe 并留存输出；旧 exe 没有本轮新增的主进程阶段事件。这是诊断补充文件，不是已重建或已验收的 Windows 修复包。

## 用户最小操作

1. 保留原解压目录和整个 `trial-data`。将 `START-DIAGNOSTIC.cmd` 放到该包 `START-TEST.cmd` 同一层，双击一次。黑色窗口不要手动关；如果应用正常打开，使用应用窗口的关闭按钮正常结束。脚本最终会显示 `Logs:` 路径和退出码。
2. 先提供该次目录的 `status.txt`、`stderr.txt`、`processes-before.txt`、`processes-after.txt`。如果首次仍闪退，再查看该目录 `chromium.log` 中最后的错误行。日志可能包含本机用户名／目录，发送前遮去个人路径；无需发送账本、原图或 crash dump。若应用消失但黑色窗口一直等候，保留窗口并记录任务管理器“详细信息”中的 `xx-finance-stage0.exe` PID；不要强制结束。
3. 若仍只有残留锁，原目录不再反复尝试。把同一原始 ZIP 完整解压到另一个**全新可写目录**，再放入诊断脚本，断网启动一次；仅用空账本，不复制旧 `trial-data`。这样可收集第一次启动的真正错误，同时保留原账本。若有安全策略提示，记录提示，不关闭保护。
4. 仅在应用已正常关闭、该程序没有残留进程后，才可运行 `CHECK-RUNTIME-DIAGNOSTIC.cmd`。其 `probe-*` 下 `stdout.txt` / `stderr.txt` 区分 SQLite 与随包 OCR 依赖失败；本机 CI 的历史成功不能替代这一步。另提供 `winver` 中版本／内部版本号；如日志空白，查看同次时间的 Windows 事件查看器 → Windows 日志 → 应用程序，仅抄“故障应用程序、模块、异常代码”。

如果新空目录运行正常而原目录仍提示锁，只能缩小到原目录状态／占用问题，不能直接删锁恢复。下一步需核对锁所有者 PID、进程是否仍活跃及完整账本保护方案后再处理；本轮没有提供自动解锁或数据迁移。

## 实际验证

- 修改前运行启动脚本定向测试：新增的日志／退出码保护及 build identity 校验两项失败，记录在 `launcher-before.log`；这是诊断缺陷测试，不是首次闪退复现。
- `node --test tests/windows-portable.test.cjs tests/electron-main.test.cjs`：23 通过、0 失败、1 Windows 专用 CMD 集成用例跳过。用例涵盖诊断开关、启动错误、异步关闭等待、探针输出不污染、进程退出原因白名单及脚本日志配置。
- `node --test --test-name-pattern='fresh root has|leftover lock' tests/managed-ledger.test.cjs`：2 通过；只用新合成临时根，重现同一锁报错并确认不抢锁、正常关闭后能重开。
- 两个修改后 CJS 的 `node --check` 与 `git diff --check` 通过。没有更改 UI、业务金额或 SQLite 模型，不重跑无关 OCR／业务全量回归。
- Windows 专用测试准备了真实 `cmd.exe` 执行生成脚本、中文／空格／`&`／`!` 路径、零／正／负退出码及日志不覆盖验证；本机为 Mac，明确未执行。未声称 Windows 脚本或新包真机通过。

证据仅在本机 `evidence/stage0/windows-startup-2026-10-15/`，不纳入 Git。本轮修改未提交、未推送。当前明确授权到启动故障本地排查修订；最新任务要求新包前明确权限，且验收基线说未来 Windows 新包需另行授权。因此未将历史构建授权当作这次自动触发 CI 的授权。先取旧包日志即可推进，无需先构建新包。
