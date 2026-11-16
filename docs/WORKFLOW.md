# 固定生产流程

## 阶段和会话

项目会话在原生聊天输入框上方显示固定流程。点击阶段时，Studio 读取对应的全局 Harness 和 Skill，并在当前 Session 的新激活记录中固定版本。随后使用原生聊天框讨论、修改和生成草稿。阶段回合执行期间，当前 Session 可以查看产物，切换和退出返回 409。回合结算后恢复操作，其他 Session 仍可独立工作。

新 Workspace 首次打开工作流时选择 **短剧生产** 或 **短视频生产**。模式和定义版本保存在 Workspace SQLite，同一 Workspace 的 Session 共享模式和正式交接。短视频按表中的八个阶段推进。短剧从拍摄脚本制作开始，共六个阶段。两种模式的后续阶段均以前一阶段的正式交接为前置条件。已有 Workspace 保留从内容分析开始的七阶段 Legacy 流程。

| 阶段 ID | 名称 | 默认 Skill | Harness 相对工作流目录 |
| --- | --- | --- | --- |
| `topic-selection` | 选题策划 | `drama-topic-selection` | `stages/topic-selection/harness.md` |
| `content-analysis` | 内容分析 | `drama-content-analysis` | `stages/content-analysis/harness.md` |
| `shooting-script` | 拍摄脚本制作 | `drama-shooting-script` | `stages/shooting-script/harness.md` |
| `storyboard` | 分镜制作 | `drama-storyboard` | `stages/storyboard/harness.md` |
| `asset-binding` | 素材抽卡与绑定 | `drama-asset-binding` | `stages/asset-binding/harness.md` |
| `video-deployment` | 视频节点部署 | `drama-video-deployment` | `stages/video-deployment/harness.md` |
| `video-generation` | 视频生成 | `drama-video-generation` | `stages/video-generation/harness.md` |
| `final-review` | 成片验收 | `drama-final-review` | `stages/final-review/harness.md` |

### 全局装填

仓库和 npm 包用 `resources/manifest.json` 分发 `resources/skills/` 及 `resources/workflows/` 中的官方文件。Host 加载插件时，使用原生 Profile 上下文解析出的 Home 装填。全局文件按 Home 共享，Workspace 记录各自的进度、产物、交接和会话。

```text
DSH_HOME/skills/drama-<stage-id>/SKILL.md
DSH_HOME/drama-studio/workflows/drama-production/stages/<stage-id>/harness.md
```

`DSH_HOME/drama-studio/managed-assets.json` 保存插件版本和文件 SHA-256。每次 Host 加载时检查缺失文件并恢复官方内容。与包内内容一致的现有文件可直接登记。仍与上一次安装 Hash 一致的受管文件可随插件升级，用户编辑过的受管文件和初次装填前已有的异版文件均会保留。Workflow Panel 显示当前 Skill、原生来源、Harness、Hash 和具体文件问题。装填失败时，普通 DSH 聊天仍可使用。

清单中的 `skill-resource` 使用同一本账本。比如 `drama-storyboard` 的 `references/`、`templates/` 和 `scripts/` 按原有目录结构装填，从 Skill 的原生 `resourceBase` 读取。已存在的同路径异版文件以 User Owned 显示，现有文件继续可用。更新后的目标已经与当前包逐字节一致、但账本仍记录旧 Hash 时，下次启动只补记账本。差异无法以旧 Hash 或当前包确认时，保留当前文件。

`SKILL.md` 使用 DSH 原生 frontmatter。内置文件设置 `user-invocable: true`，让 Studio 通过原生目录读取正文，并用 `disable-model-invocation: true` 从模型的普通 Skill 目录和工具中排除。Studio 查询当前预设下的原生 Skill 目录，要求来源是 `user-dsh`，且真实路径匹配全局 `skills/<name>/SKILL.md`。查询省略 Workspace 路径，因此项目同名 Skill 不会改变阶段绑定。快照支持最大 512 KiB 的 UTF-8 Skill 源文件。Harness 需为非空 UTF-8 文本，大小上限为 64 KiB。

### Skills Library 与阶段绑定

在 DSH 的全局 Settings 打开 **Skills Library**。导入含 `SKILL.md` 的本地目录时，目录名须与 frontmatter 的 `name` 一致，`description` 须非空。Studio 将整个目录复制到当前 `DSH_HOME/skills/`，保留附属文件相对路径。可打开目录或复制完整路径，外部编辑后点击刷新。用 **复制为自定义 Skill** 派生官方 Skill 时填写新的名称，Studio 复制目录并更新副本的 frontmatter。

在 **Workflow Skill Bindings** 选择生产模式和阶段，再选择通过 DSH 原生 Registry 全局来源验证的 Skill。Harness 由 Studio 固定。全局 `DSH_HOME/drama-studio/workflows/stage-bindings.json` 记录用户覆盖项。**恢复官方默认** 删除该阶段的覆盖项，下一次激活读取 Profile 的默认映射。

```json
{
  "schemaVersion": 1,
  "profiles": {
    "short-drama": {
      "storyboard": "my-storyboard-rules"
    }
  }
}
```

旧 `workflows/drama-production/stage-skills.json` 的有效覆盖项迁入 `legacy-drama-production`，原文件保留。迁移记录保存旧配置相对路径和 SHA-256。配置错误或映射 Skill 无法通过全局来源及权限检查时，Workflow 会展示问题并阻止相应的新激活。

### 激活快照

激活快照保存生产模式 ID 和定义版本、阶段和 Skill ID、渲染后的完整 Skill、Harness 正文、相对路径、原始文件和渲染后 Skill 的 SHA-256。激活代数、时间及快照引用由 Workspace SQLite 保存。重复点击当前阶段继续用原来的快照。全局文件或绑定更新后，新激活采用新版本。Skills Library 的主文件 Hash 对应 `SKILL.md`，详情中每个附属文件有独立的 Hash。DSH 实际读取 references、templates、脚本和其他附属文件时，使用当时的磁盘内容。读取正文过程中发现文件变化时，激活失败并可重试。

Host 用 DSH 的 `system-prompt/assemble` 装填当前激活，`agent/pre-step` 请求新序列以替换活动系统指令。每轮落盘其激活代数、快照 ID 与 Hash。锁定完整提示词的预设会在激活时返回错误。

进入、切换或退出阶段时，SQLite 设置本次激活的过渡保护。首个新序列的实际模型回合成功后，Host 才能清除同一代数的保护。失败、取消或进程中断时保留待处理状态。等待期间，系统暂停自动压缩，并在用户执行 `/compact` 时提示先发送一条新阶段消息。原生追加日志、已有用户消息、回复、工具结果和旧摘要仍可保留。

Studio 管理的阶段 Skill 通过阶段激活进入模型请求。项目会话的原生斜杠和 `skill` 工具会拒绝直接加载这些阶段 Skill，并提示通过阶段按钮使用。其他 DSH Skills 继续按原生方式使用。Agent 可以使用已确认输入、查询素材和保存当前阶段的独立草稿。创作决策和制作约束随所选产物进入交接包。

## 草稿与正式交接

- 当前 Session 创建的草稿在本会话可见。产物侧栏可切换当前版本、历史版本和正式交接包，比较历史与最新版，并逐项选择交接版本。文档通过 `drama_save_artifact` 保存 Markdown 正文。媒体产物保存已有 Canvas 节点的版本快照。聊天消息继续显示在原生对话中。
- 交接文档可作为一项 Markdown 产物随其他选中版本交接。文档汇总下一阶段需要的内容、决策和约束，并列出对应产物的 ID 与版本。交接预览展示实际选择的版本和摘要，正式确认后这些版本成为下一阶段的输入。
- 每个 Workspace 的 SQLite 管理草稿、正式产物、交接包和进度。阶段状态依次由是否存在草稿、是否有正式交接以及该交接的上游版本决定。多个 Session 可以同时在同一阶段工作，共享正式交接结果。
- 点击 **生成交接预览** 后检查阶段关系、所选产物版本、摘要、创作决策和约束。确认时，SQLite 校验当前生产模式定义、来源 Session 的激活、同阶段正式交接、实际使用的上游交接，以及选中产物和相关 Canvas 引用。无关草稿和 Canvas 更新可以与交接并行。预览过期后，保留原预览和产物供核对，由用户重新生成。最后一个阶段通过 **生成成片验收包** 和 **确认最终验收** 固定最终结果。
- 正式确认首次提交后，Host 在同一原生 Session 请求下一阶段初始任务。下一阶段通过 `drama_workflow_artifact` 读取固定版本。重复确认返回同一个正式交接包。启动提交失败时，正式交接、目标激活和待启动记录仍然存在，用户可在界面重试。已开始但中断的原生回合可使用聊天框继续。
- 视频节点部署只准备 Canvas 草稿。用户在 Canvas 逐项独立确认生成，视频生成阶段根据人工授权、来源节点版本和实际文件核对结果。成片验收使用已正式交接的可播放视频结果。Agent 生成、修改和报告完成均不会产生正式交接。

## 升级与恢复

保持现有 `.drama-studio/studio.db` 和七阶段 ID。迁移保留已确认的交接、历史回合、产物、激活和已有 Hash。升级时缺少正文快照的旧激活需要退出并重新激活，所生成的快照仅用于新的激活。升级前结束旧 Host，并同时替换 Host、Browser 和 Go 工件。旧工件回滚会绕过新增守卫及快照语义。如需回到旧版行为，先结束新 Host 并保留迁移后的数据库副本。

刷新、切换 Session 和重启 Host 后，SQLite 恢复阶段激活、草稿版本与正式交接。原生 Agent 中断时保留执行记录，确认状态保持在最后一次事务提交的位置。重启不会自动执行初始任务。

## 生命周期回归

`tests/workflow-lifecycle.mjs` 以独立的 Home、Profile 和 Workspace 启动 DSH Web Host。通过原生 DeepSeekAdapter 向本地 SSE 夹具发送请求，断言模型收到的 system、user 和 tool 内容。测试涵盖 `leading-only` 和 `in-history` 的系统提示更新、手动与压力触发压缩、取消和失败保留过渡保护、快照版本、受管 Skill 入口、多会话和 Host 重启。浏览器专项验证执行中的阶段按钮、产物查看和服务端 409。Go 测试验证操作并发、快照与激活事务回滚及旧库迁移。

使用同次构建的 `dist/host.js`、`dist/client.js` 和 `dist/studio.exe`。

```powershell
$env:DRAMA_DSH_CLI = (Resolve-Path -LiteralPath '.runtime/dsh-rc3/node_modules/@deepseek-ai/dsh/lib/bin.js').Path
go test -count=1 ./...
node tests/workflow-lifecycle.mjs
node --test --test-name-pattern '^Workflow dock' tests/web.mjs
node tests/agent-fixture.mjs
```

压缩守卫覆盖 rc.3 原生 `/compact` 与原生自动压力和溢出恢复入口。第三方插件直接调用低层 `compactRegion` 的组合需单独验证。过渡完成前，Studio 先保存已替换的原生 Session 表面，再按代数清除 SQLite 保护。

## 既有工作流验证记录

本次在 Windows x64、DSH `0.2.1-rc.3`、Go `1.27.2`、Node.js `25.8.0` 和 Chrome 上验证。

| 检查 | 覆盖 |
| --- | --- |
| Go 全量测试、`go vet ./...`、Windows x64 构建和 Web 工件构建 | SQLite 多 Session、并发确认、版本固定和下游过期、旧库迁移、退出与重启、人工视频授权。 |
| 原生浏览器 Workflow 专项 | 普通聊天、激活无启动、三版文档对比、同会话交接、跨会话与跨项目隔离、授权视频侧栏播放、最终验收。 |
| 原生 Agent 重启夹具 | 正式交接后中断下一阶段，重启保留正式结果、版本和激活，Agent 提交和阶段转换权限受限。 |
| 真实 DeepSeek Agent | `deepseek-official` 的 `deepseek-flash` 经原生输入框保存分镜 V1–V3，人工固定 V3，下一阶段读取固定版本并保存素材草稿。退出后原生系统指令恢复为普通聊天。 |

真实模型测试使用合成分镜。视频验收通过本地供应商夹具和可播放样片验证。

全量浏览器回归 17 项通过，真实模型用例单独运行通过。原有 Canvas 媒体上传用例在前一轮通过，最终全量和单项复跑均在提示词退格步骤失败。改动前的验收记录也记录了相同的间歇失败。

```powershell
$env:DRAMA_DSH_CLI = (Resolve-Path -LiteralPath '.runtime/dsh-rc3/node_modules/@deepseek-ai/dsh/lib/bin.js').Path
node --test --test-name-pattern '^Workflow dock' tests/web.mjs
node tests/agent-fixture.mjs
```

为视频专项设置 `DRAMA_UIUX_VIDEO` 指向本地 MP4。启用 `DRAMA_REAL_WORKFLOW=1` 并在测试进程提供 `DEEPSEEK_API_KEY` 可调用真实模型。设置 `DRAMA_WORKFLOW_REAL_EVIDENCE` 可输出精简轨迹，设置 `DRAMA_UIUX_CAPTURE=1` 与 `DRAMA_UIUX_CAPTURE_DIR` 可输出截图。

## 修改文件

| 范围 | 文件 |
| --- | --- |
| 原生输入区和产物侧栏 | `src/client.jsx`、`src/workflow-panel.jsx`、`src/workflow-panel.css`、`src/studio-api.js` |
| 原生 Session 指令、工具和交接启动 | `src/workflow.js`、`src/host.js`、`src/tools.js` |
| SQLite、版本及状态 | `studio/store.go`、`studio/workflow.go`、`studio/workflow_turn.go`、`studio/workflow_artifact.go`、`studio/workflow_handoff.go`、`studio/workflow_migration.go` |
| 视频授权和结果校验 | `studio/tasks.go`、`studio/workflow_generation.go` |
| 验收测试 | `studio/workflow_test.go`、`tests/web.mjs`、`tests/agent-fixture.mjs` |
| 使用说明 | `README.md`、`docs/WORKFLOW.md` |
