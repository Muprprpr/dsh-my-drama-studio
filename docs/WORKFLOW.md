# 固定生产流程

## 交互和阶段

工作流进度出现在 DSH 对话输入框上方，通过原生 `conversation.input.dock` 注入。横向步骤可查看各阶段的状态、执行记录和 Canvas 产物。当前阶段的按钮启动 Agent、验收或重试。独立编辑页已经移除，当前 Session 中恢复出的旧 Workflow 标签经原生导航接口关闭。右侧栏继续提供 Canvas，原有聊天输入和发送留在 DSH 原生组件中。同页进度条和 Canvas 共用当前 Session 的 Studio 事件连接。

Go 按下表顺序定义 `drama-production`。各阶段须经人工验收，前置关系取决于已确认的上游节点版本。

| 阶段 ID | 名称 |
| --- | --- |
| `content-analysis` | 内容分析 |
| `shooting-script` | 拍摄脚本制作 |
| `storyboard` | 分镜制作 |
| `asset-binding` | 素材抽卡与绑定 |
| `video-deployment` | 视频节点部署 |
| `video-generation` | 视频生成 |
| `final-review` | 成片验收 |

## 全局装填

在启动 Studio 的 DSH Host 所使用的 `DSH_HOME` 下装填一次。将 `<stage-id>` 替换为上表 ID。

```text
DSH_HOME/skills/drama-<stage-id>/SKILL.md
DSH_HOME/drama-studio/workflows/drama-production/stages/<stage-id>/harness.md
```

`SKILL.md` 使用 DSH 原生 frontmatter，`name` 为 `drama-<stage-id>`，并填写 `description`。正文描述专业工作方法。`harness.md` 写该阶段的目标、输入使用要求及交付约束，须为非空 UTF-8 文本且不超过 64 KiB。新运行读取当前文件，已开始的原生回合沿用当次指令。

Studio 从 `ctx.profileContext.home` 取得实际 DSH 用户目录。DSH Web rc.3 在会话预设中装载文件 Skill 提供器。Studio 用当前预设的作用域查找 `user-dsh` 来源，并省略 Workspace 路径，使项目同名文件不会覆盖本次阶段使用的全局文件。阶段沿用 DSH 原生加载、渲染及 `skill-invocation` 消息。 [DSH Skill 源码](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/skill)

DSH rc.3 的 `workflowEngine` 运行多 Agent JavaScript 编排脚本。这个原生能力的执行对象是子 Agent 脚本。Studio 的阶段规则通过单份 Markdown 装填，并沿用同一 Session 的原生 Agent 回合。 [DSH Workflow 源码](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.3/packages/workflow)

## 运行、授权和版本

- Host 用已认证的 Session 查找 Workspace。任意连接到该 Workspace 的 Session 可以验收或继续符合顺序的阶段。`workflow_reserve` 从项目 SQLite 读取已确认产物引用并预留运行。Host 将这些引用交给当前 Session 的 `sessionController.prompt`，通过原生 `rpcId` 关联尝试。原生 Agent 进入回合时调用 `workflow_running`，结束后调用 `workflow_finish`。同一项目的进度条经已有事件连接重新读取 SQLite，聊天记录始终由各 Session 持有。
- 启动时将 DSH 渲染后的 Skill 指令及 Harness 快照固定给当前回合。`skillSha256` 对实际注入的 DSH Skill 指令块计算，`harnessSha256` 对 Harness 文件原始字节计算。两者在进入 Running 时持久化。`workflow_runs` 的行记录阶段、Run、执行 Session 和状态，JSON 同时保留 Workspace ID、Canvas ID、定义版本、Skill/Harness 标识、输入、产物和验收。配置正文仍来自全局文件，执行指令按原生会话规则进入本次执行的聊天历史。
- 一般阶段通过 `drama_append` 在现有 Canvas 产生产物，Host 从本次原生工具结果取得节点 ID。SQLite 保存运行 Session、输入、输出、时间和验收版本。刷新和切换 Session 可重读同一 Workspace 的状态。Host 重启后保留历史与已确认阶段，中断的 Agent 尝试需要手动重试。
- 视频部署确认后，用户到原 Canvas 对已验收的视频草稿分别执行生成确认。工作流中的 Agent 依旧受 `drama_submit` 限制。视频生成阶段关联人工确认提交、草稿版本相符、节点来源一致且文件存在的任务结果。未变更的草稿可以复用同版本任务。对应 Skill 和 Harness 可用时，在工作流中点击 **核对生成结果**。成片验收阶段接收这些视频引用，可点击 **查看成片** 播放，最后由用户点击 **验收影片**。
- SQLite 继续使用 Workspace 的 `.drama-studio/studio.db` 和 `workflow_runs`。七阶段定义版本和阶段 ID 保持兼容。升级沿用先前的固定阶段状态、产物、验收与历史，缺少的新审计字段保留空值。更早的自定义流程记录继续留存。旧 Workspace 中的文件不会迁移到全局目录，用户可将选定的能力装填一次。
- 同一 Workspace 仍用 SQLite 事务、唯一活动约束和已有跨进程 Workspace 文件锁保护预留及运行。其他 Workspace 可独立启动。首次打开即展示七个初始状态，首次写入继续使用现有 Canvas 绑定及数据库流程。
- 节点版本更新后应重新验收上游，旧版下游结果继续保存并标记过期。步骤详情显示最近一次运行及该次运行的验收记录，过去的尝试仍保存在 SQLite 中。产物追踪覆盖节点 ID 和 revision，独立文件内容及原位编辑前的正文没有版本快照。升级前的任务缺少来源节点版本和确认标记，仍可在 Canvas 查看。

宿主及 CLI 测试基线为 DSH `0.2.1-rc.3`。Host、Browser 和 Go 工件需使用同次构建。 [原生 Session Controller 源码](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/api/session-controller/src/commands.ts)

这次升级将能力文件来源从 Workspace 改为全局，并在现有运行记录中添加审计元数据。SQLite 表结构沿用现有版本。当前固定定义仍为版本 1，旧运行可继续作为上游输入。未来改变阶段 ID 或依赖关系时，需要明确兼容或迁移规则。回滚旧工件会恢复其 Workspace 文件装填约定，旧工件的运行写入无法保留新审计字段。

## 验收报告

测试环境为 Windows x64、DSH CLI `0.2.1-rc.3`、Cordis `4.0.5`、系统 Node.js `25.8.0`、Go `1.27.2`、Chrome 和隔离临时项目。

| 命令 | 结果 |
| --- | --- |
| `npm.cmd run build`、`go build -trimpath -o dist/studio.exe ./cmd/studio` | 通过。 |
| `go test -count=1 ./...`、`go vet ./...` | 通过。覆盖固定阶段、带旧验收的版本缺省行继续执行、跨 Workspace 与跨 Session、并发预留和哈希不可覆盖。原有画布和视频内核测试一并通过。 |
| `node --test tests/canvas-layout.mjs` | 3 项通过。 |
| `node tests/agent-fixture.mjs` | 通过。重启前记录 19 次原生工具调用，重启后记录 2 次。中断阶段恢复为失败，原 Run、Workspace/Canvas/Session 归属和两个哈希保留。活动阶段固定使用启动时加载的同名 Skill，另一个 Session 仍可正常读取。模型响应为脚本。 |
| `DRAMA_REAL_WORKFLOW=1` 的三阶段浏览器专项 | 通过，退出码 0。原生 `deepseek-official` 直接请求 `api.deepseek.com`，实测 `deepseek-flash`。Session A 产生分析，Session B 验收并执行后续两阶段。两份原生轨迹核对了三次 Skill 注入、Harness 文本与哈希、各阶段前置引用及 `drama_query` / `drama_append` 调用。生成任务数为 0。 |
| `node --test --test-name-pattern '^Workflow dock' tests/web.mjs` | 4 项专项通过。同一套全局文件在两个 Workspace 生效。同一 Workspace 两个 Session 并发启动只有一个成功，第三个 Session 可见执行者。Workspace A 持有旧指令，Workspace B 可执行并读取新版本，项目同名 Skill 不覆盖全局快照。专项也验证原生聊天和 Canvas 独立视频授权，视频使用本地供应商夹具。 |
| `node --test tests/web.mjs` | 18 项中 17 项通过。Canvas 的媒体上传至视频端点用例在提示词编辑步骤失败。整套运行时退格未删除末字，单独复跑出现自动保存超时或相同的退格失败。未包含 Workflow 改动的基线两次单跑一过一败，失败时同样是退格未删除末字。Workflow 刷新持久化专项复跑通过。 |

测试可将 `DRAMA_DSH_CLI` 指到本地 DSH npm CLI 的 `lib/bin.js`。视频相关 Web 用例用 `DRAMA_UIUX_VIDEO` 指定本地样片，其余媒体相关回归沿用 `DRAMA_UIUX_IMAGE` 和 `DRAMA_UIUX_PROJECT_IMAGE`。真实模型测试在已向进程提供 `DEEPSEEK_API_KEY` 的终端运行。

```powershell
$env:DRAMA_REAL_WORKFLOW = '1'
node --test --test-name-pattern '^Workflow dock runs three' tests/web.mjs
```

## 修改清单

| 范围 | 文件 |
| --- | --- |
| 原生进度条与阶段详情 | `src/client.jsx`、`src/workflow-panel.jsx`、`src/workflow-panel.css` |
| 全局装填与原生执行 | `src/workflow.js` |
| 固定定义、项目运行状态和审计字段 | `studio/workflow.go` |
| 测试 | `studio/workflow_test.go`、`tests/web.mjs`、`tests/agent-fixture.mjs` |
| 使用说明和报告 | `README.md`、`docs/WORKFLOW.md` |
