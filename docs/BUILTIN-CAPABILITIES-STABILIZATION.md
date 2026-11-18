# Built-in Capabilities 收尾验证报告

> 本页保留内置能力专项当时的基线和结果。下文 `.runtime/` 路径为本地证据，未随仓库公开。当前操作从[用户指南](README.md#用户指南)进入。

## 基线与环境

本轮工作在 `main` 的 `258576cbcf27ae8985bdb4dfae59bb52f34fefc0` 上进行，跟踪 `origin/main`。开工时暂存区为空，工作区已经包含上一轮的 Built-in Capabilities 实现、资源和测试。Task2 的 Session 激活、快照与生命周期代码已存在。本轮保留这些本地改动，在其基础上修复。初始状态、分支、HEAD、最近八个提交和暂存区检查见 Git 开工记录 `.runtime/built-in-stabilization/git-start.txt`（本地）。

| 组件 | 实测版本 |
| --- | --- |
| Windows | Windows 10 Pro for Workstations 22H2，19045.6466，x64 |
| DSH Desktop | `0.2.1-rc.3`，内置 CLI 启动隔离 Web Profile |
| DSH 宿主 | Electron `44.7.0`，Node `24.21.0`，win32 x64 |
| 命令行工具 | Node `24.19.0` x64，npm `11.17.0`，Go `1.26.0`，构建目标 `windows/amd64` |
| 浏览器 | Chrome `157.0.8103.51`，Playwright `1.62.1` |

## 浏览器故障

### 会话编辑

历史日志里被拼接的两段正文都来自 Session B。当另一个客户端只更新某节点的元数据时，Canvas 的回读会让当前编辑器重渲染。受控复现中，正文保持一致，焦点仍在 B 的文本框。React 对未受控 `textarea.defaultValue` 的同值写入将选区从 `[0,23]` 折叠为 `[0,0]`，随后 Chromium 的 `beforeinput insertText` 把新正文插到旧正文前。显式保存前，API 回读和持久化正文仍是原值。受控顺序三次均复现，另一次 DOM setter 探针确认了发生点。

同页切换的专项验收另发现，DSH 重新挂载 Canvas 时会丢失尚未保存的本地草稿。修复使用受控正文、保留编辑中的文本选区，并把已有 note/script 节点的脏表单及原 revision 保留在原生 Canvas 标签的浏览器生命周期内。标签、Session、Canvas 和节点身份共同限定恢复范围。Canvas 仍会正常卸载，保存走原有版本校验。取消清理草稿，刷新或重启后从 SQLite 读已保存的正文。

新增受控 A/B 用例使用各自节点和唯一标记，覆盖运行前后编辑锁、两轮 Agent 活动、同页切换、原始保存请求、SQLite、页面刷新和实际 Host 重启。它也检查未提交前的数据库原值。问题归类为已复现并修复的前端选择区与草稿生命周期缺陷。 选区 setter 诊断 `.runtime/session-stabilization/form-race-defaultvalue.log`（本地） · 切换及重启复验 `.runtime/session-stabilization/session-controlled-final.log`（本地）

最终夹具和集成工件的原人工 CRUD 用例 **10/10 PASS**，新增 A/B 草稿用例 **10/10 PASS**。另验证同一草稿跨 Session 重挂载后保留旧 revision，提交时按原契约返回 409，显式取消后清除该草稿。中间测试的 9/10 系列中，唯一失败发生在 Preview Notice 拦截点击，未到达 Canvas。 原用例 10 次日志 `.runtime/built-in-stabilization/session/human-crud-exact-repeat.log`（本地） · 新用例 10 次日志 `.runtime/built-in-stabilization/session/session-exact-repeat.log`（本地） · 版本冲突和取消诊断 `.runtime/built-in-stabilization/session/session-cas.log`（本地）

首次全量复验为 15 PASS、4 FAIL、1 NOT RUN。三个旧用例的失败栈和截图显示，DSH 首次启动的 Preview Notice 遮罩在测试尝试打开会话时拦截了点击。新增重启用例则等待折叠工作区内尚未渲染的子会话行。相应调整恢复首次启动等待 Continue，重启后由新认证浏览器回读相同 Session 的 Canvas API 和 SQLite。页面刷新仍逐个核对浏览器中显示的卡片。原有产品断言保留，旧用例的定向复验均通过。 首次全量日志 `.runtime/built-in-stabilization/web-full.log`（本地） · 两项定向 `.runtime/backspace-stabilization/additional-integrated.log`（本地） · 素材引用定向 `.runtime/backspace-stabilization/additional-asset-mentions.log`（本地）

### 提示词退格

旧构建串行测量中，10 次均到达该删除步骤，4 次出现退格未生效。一次记录显示 Chrome 已在末尾（DOM offset 40），ProseMirror 的选择仍在位置 1；按键回调先返回 `defaultPrevented`，随后没有 `beforeinput`、文本变化或保存请求。约 14 毫秒后才收到 `selectionchange`，编辑器位置随即更新为 41。当时浏览器和编辑器的 IME 标记均为 false，焦点一直在可编辑提示词框。取消发生在事件到达 Canvas 之前。刻意延迟选区通知，用同一既有退格断言稳定复现。

修复在 Backspace 进入编辑器的删除命令前，通过 ProseMirror 将当前 DOM 内选区同步到模型。标准删除链和 Canvas 键盘事件处理保持原有行为。专项补充展开、紧凑、节点切换和多次删除检查，并回读编辑器模型及实际保存正文。

修复后的独立 Chrome 与真实 DSH Host 串行复测为 **10/10 PASS**，两次额外并行启动为 **2/2 PASS**，集成工件定向执行为 **1/1 PASS**。修复前在串行环境即可复现，因此无需并行执行触发。修复前 6 次退格本身成功，其中 5 次随后被诊断探针在旧编辑器卸载后报错。这些探针错误只纳入诊断记录。 事件顺序 `.runtime/backspace-stabilization/baseline-repro-event-order.tsv`（本地） · 受控修复前 `.runtime/backspace-stabilization/baseline-deterministic.log`（本地） · 受控修复后 `.runtime/backspace-stabilization/fixed-deterministic.log`（本地） · 复测汇总 `.runtime/backspace-stabilization/repeat-summary.tsv`（本地）

## Skill 附属资源

`resources/manifest.json` 的 schemaVersion 仍为 1，保留 14 个主资产并加入 3 个 `skill-resource`。每个附属文件必须用同一阶段 Skill 目录的相对路径声明，`source` 与 `target` 相等。

```text
skills/drama-storyboard/
  SKILL.md
  references/shot-sizes.md
  templates/storyboard.md
  scripts/check.js
```

三个附属文件和主文件共同进入同一本 `managed-assets.json` SHA-256 账本。附属文件按字节写入和验证，脚本在装填期间只作为普通文件处理。清单验证阻止目录穿越、Windows 路径别名、重复目标和 Junction 跳转。已修改的受管文件、已有异版用户文件、用户自行添加的文件和新版已撤下的旧文件均予以保留。对于同路径异版，面板显示 User Owned 并说明冲突；无法读取或无法装填的必需文件会报告准确路径，并阻止相应阶段的新激活。

真实 DSH Registry 将 `resourceBase` 指向装填后的 Skill 目录。专项通过原生 `read` 读取 Markdown 参考、模板和 JS 脚本，包含独立 Profile 中的 `drama-test-resources` 映射用例。后续 Agent 回合从磁盘读到了修改后的 reference，原激活的 snapshotId、主 Skill Hash 和 Harness Hash 保持固定。一个激活因此可能读到不同版本的附属资源。版本必须随激活冻结的关键规则与必要模板可放入这两份正文。 真实 DSH 日志 `.runtime/built-in-stabilization/built-in-assets-host.log`（本地）

## Bootstrap 恢复

| 情形 | 结果 | 验证 |
| --- | --- | --- |
| 文件已替换，账本仍为旧版本 | PASS | Windows 共享限制让账本原子替换失败。目标已写成包内字节。解除限制再启动，只更新账本，目标 mtime 不变。具有第三种 Hash 的用户内容仍保留 |
| 账本有效，目标缺失或内容不完整 | PASS | 删除的目标恢复且无重复记录。未知或截断内容保留原字节，报告 User Modified |
| 活进程持锁和持锁进程被强制终止 | PASS | 子进程执行实际 Bootstrap 并在拿锁后停住。并发 Bootstrap 被阻塞且账本不变。强制终止后，Windows 自动释放同一 Home 的命名管道，新进程能重试 |
| 上一版本留下无主信息的空锁文件 | PASS | 新版显式报错并保留旧锁。隔离测试确认旧 Host 全部退出后，清理该旧锁即可恢复 |
| Manifest 读失败、普通资产替换失败、目录不可写、账本写失败 | PASS | 实际 Windows 文件共享限制和临时目录 ACL 验证了原因与目标路径。正式文件保持完整，解除限制后恢复 |
| 装填异常时原生普通聊天 | PASS | 真实 Host 分别使用损坏的账本、冲突的附属目标和拒绝写入的 Windows ACL 启动。受影响阶段返回错误，普通会话通过本地模型夹具完成。ACL 对应的正式文件保持缺失，冲突目录的用户内容完整 |

新版串行锁是由当前 Host 持有的 Windows 命名管道，按 DSH Home 的真实路径区分。升级前先退出同一 Home 的旧版 Host。资产文件与账本仍分别原子替换，重启时凭明确的当前包字节匹配补记。没有新增事务日志、服务、数据库或依赖。

## 本轮修改清单

| 文件 | 函数或配置 | 目的 |
| --- | --- | --- |
| `src/capability-assets.js` | `readBundle`、`ownership`、`lockAssets`、`ensureBuiltInAssets`、`skillResourceStatuses` | 验证并同步附属文件，修复中断对账、自动释放锁，提供具体资源状态 |
| `src/workflow.js`、`src/workflow-panel.jsx` | `loadCapabilities`、`get`、`CapabilityStatus` | 原阶段入口读取附属文件状态，面板显示异版保留与具体错误 |
| `src/client.jsx`、`src/canvas.jsx`、`src/node-card.jsx` | `DramaCanvasTab`、`SessionPanel`、`CanvasViewport`、`NodeEditor` | 在隔离的标签生命周期保留编辑草稿及版本，防止异步回读折叠选区 |
| `src/prompt-editor.jsx` | `PromptEditor` 的 `editorProps.handleKeyDown` | 在 Backspace 删除链消费选区之前同步 ProseMirror |
| `resources/manifest.json`、`resources/skills/drama-storyboard/SKILL.md` | `skill-resource` 条目和相对引用 | 声明三份附属样例及其路径 |
| `resources/skills/drama-storyboard/references/shot-sizes.md`、`templates/storyboard.md`、`scripts/check.js` | 新增资源 | 提供小型参考、模板及结构校验样例 |
| `tests/built-in-assets.mjs` | 本地 Node 夹具 | 附属资源复用账本、路径约束、脚本不执行、活锁及中断恢复 |
| `tests/built-in-assets-host.mjs` | 原生 Host 夹具和 `--pack` | 原生相对读、动态 reference 与快照、用户保护和真实解包验证 |
| `tests/web.mjs` | 会话草稿专项、上传及编辑专项 | 受控复现、两次构建差异、保存/刷新/重启回读 |
| `docs/LOCAL-DEVELOPMENT.md`、`docs/WORKFLOW.md`、本报告 | 装填、相对资源、两类快照边界与复验 | 开发、升级、回归证据 |

现有 `package.json` 的 `files` 已包含 `resources`，本轮沿用。Go 持久化、DSH 原生核心和视频执行内核未改动。

## npm 实包

最终产物为 `dsh-my-drama-studio-0.1.0.tgz`，10,136,135 字节。SHA-256 为 `e4e86868ddf213af190d48bc7ff5d3d5e82c99c684d339b9794316a5afc6adc6`。dry-run 与 `tar.exe -tf` 的 25 个条目一致。其中 18 个条目在 `resources/`，包括清单、七个主 Skill、七个 Harness 和三份附属文件。Host、浏览器入口和 AMD64 工件齐全。

实包解到 Git 工作树之外的独立 DSH Profile。`ctx.pluginPackages` 回读实际临时包根，进程工作目录与包根不同。17 个装填目标与包内字节及账本 Hash 一致，七个阶段全部使用原生 `user-dsh`。三份附属文件均由原生工具读出，真实 Agent 管线收到读取结果。 实包 `.runtime/built-in-stabilization/dsh-my-drama-studio-0.1.0.tgz`（本地） · dry-run `.runtime/built-in-stabilization/npm-pack-dry-run.json`（本地） · 实际打包输出 `.runtime/built-in-stabilization/npm-pack.json`（本地） · tar 列表 `.runtime/built-in-stabilization/archive-list.txt`（本地） · 原生 JSON 证据 `.runtime/built-in-stabilization/pack-host-evidence.json`（本地）

## 回归矩阵

| 测试 | 执行命令 | 结果 | 真实 DSH / 本地 fixture | 日志 |
| --- | --- | --- | --- | --- |
| npm 构建 | `npm.cmd run build` | PASS | 否 / 无 | 日志 `.runtime/built-in-stabilization/npm-build.log`（本地） |
| Windows AMD64 工件 | `go build -trimpath -o dist/studio.exe ./cmd/studio` | PASS，PE Machine `0x8664` | 否 / 无 | 日志 `.runtime/built-in-stabilization/go-build.log`（本地） |
| Go 全量 | `go test -count=1 ./...` | PASS | 否 / 是 | 日志 `.runtime/built-in-stabilization/go-test.log`（本地） |
| 文件同步与恢复 | `node --test tests/built-in-assets.mjs` | 9 PASS | 否 / 是，实际 Windows 进程终止、权限和共享限制 | 日志 `.runtime/built-in-stabilization/built-in-assets.log`（本地） |
| Host 原生集成 | `node tests/built-in-assets-host.mjs` | PASS | 是 / 本地模型和临时文件 | 日志 `.runtime/built-in-stabilization/built-in-assets-host.log`（本地） |
| Workflow 生命周期 | `node tests/workflow-lifecycle.mjs` | PASS，wire 和 restart | 是 / 本地 SSE 模型 | 日志 `.runtime/built-in-stabilization/workflow-lifecycle.log`（本地） |
| Agent 原生工具 | `node tests/agent-fixture.mjs` | PASS，初始 20 次与重启后 2 次 | 是 / 本地模型 | 日志 `.runtime/built-in-stabilization/agent-fixture.log`（本地） |
| Canvas 布局 | `node --test tests/canvas-layout.mjs` | 3 PASS | 否 / 本地布局数据 | 日志 `.runtime/built-in-stabilization/canvas-layout.log`（本地） |
| Canvas 人工 CRUD 原用例 | `node --test --test-name-pattern '^Native human CRUD' tests/web.mjs` | 10/10 PASS | 是 / 本地 Agent | 日志 `.runtime/built-in-stabilization/session/human-crud-exact-repeat.log`（本地） |
| Session 草稿与重启 | `node --test --test-name-pattern '^Native Session editors' tests/web.mjs` | 10/10 PASS | 是 / 本地 Agent 和临时 SQLite | 日志 `.runtime/built-in-stabilization/session/session-exact-repeat.log`（本地） |
| 提示词退格专项 | `node --test --test-name-pattern '^Native canvas uploads media' tests/web.mjs` | 串行 10/10 PASS，额外并行 2/2 PASS，集成定向 1/1 PASS | 是 / 本地媒体与 HTTP 供应商夹具 | 汇总及原始日志名 `.runtime/backspace-stabilization/repeat-summary.tsv`（本地） |
| 浏览器全量 | `node --test tests/web.mjs` | 19 PASS、0 FAIL、1 NOT RUN，退出码 0 | 是 / 本地模型、媒体及供应商夹具 | 最终日志 `.runtime/built-in-stabilization/web-final.log`（本地） · 运行输入 Hash `.runtime/built-in-stabilization/web-final-inputs.csv`（本地） |
| npm dry-run、实包、独立 Host | `npm.cmd pack --dry-run`、`npm.cmd pack --pack-destination <TEMP>`、`tar.exe -tf <TARBALL>`、`node tests/built-in-assets-host.mjs --pack <TARBALL>` | PASS，25 归档条目，17 目标字节与账本一致 | 是 / 本地模型和临时包 | 日志 `.runtime/built-in-stabilization/pack-host.log`（本地） |
| 真实 DeepSeek 浏览器用例 | `node --test tests/web.mjs` 内的真实模型专用用例 | NOT RUN，按本轮范围跳过 | 无 | 全量浏览器日志 `.runtime/built-in-stabilization/web-final.log`（本地） |

Go 构建和回归使用 `GOOS=windows`、`GOARCH=amd64`、`CGO_ENABLED=0`。浏览器用例使用标准 `DRAMA_UIUX_STUDIO_EXE` 指向本次 `dist/studio.exe`，`DRAMA_REAL_WORKFLOW` 为空。测试使用本地 PNG、MP4 和模型或供应商夹具。esbuild 的父目录读取、Go 的 Windows DPAPI 和原生 Agent 的路径读取曾被默认沙箱阻挡，在隔离目录经审批复验通过。 默认沙箱 Go 日志 `.runtime/built-in-stabilization/go-test-sandbox.log`（本地）

Workflow 回归覆盖普通聊天无阶段正文、点击激活、连续多轮、切换与运行期保护、Skill 和 Harness 快照、Host 重启、Session/Workspace 隔离及显式交接。Canvas 回归覆盖人工 CRUD、Agent 追加、媒体连线、素材引用、正文与提示词编辑、键盘操作和生成授权，视频请求由本地夹具提供。

## 最终 Git 与遗留

HEAD 保持 `258576c`，分支仍为 `main`，暂存区为空。完整工作区补丁含上一轮未提交改动和本轮新增文件。本轮增量补丁以开工工作区为基线。两份补丁均用 `git apply --check --reverse` 核对结束时文件。 最终 Git 状态与 Diff 统计 `.runtime/built-in-stabilization/git-final.txt`（本地） · 本轮修改文件 `.runtime/built-in-stabilization/modified-files.txt`（本地） · 本轮增量补丁 `.runtime/built-in-stabilization/stabilization.patch`（本地） · 完整工作区补丁 `.runtime/built-in-stabilization/worktree-vs-head.patch`（本地）

- **P0**　未发现跨 Session 错误写入或装填覆盖用户异版文件。
- **P1**　两个历史浏览器问题已复现、定位并修复，最终定向与全量运行均没有再出现对应失败。真实 LLM 和付费视频供应商验证留待另行安排。
- **P2**　旧版遗留的无主锁文件仍按文档安全清理。需要完整附属资源版本重现时，可另行设计按阶段固定实际被引用的文件版本。当前快照继续固定主 Skill 与 Harness。

测试均使用隔离 Home。代码停留在工作区，等待人工验收。
