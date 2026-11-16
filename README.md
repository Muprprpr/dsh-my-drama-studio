# dsh-my-drama-studio

**My Drama Studio · 短剧工作台**运行于 DeepSeek Harness 的原生 Workspace 和 Session。项目文件夹保存一张共享画布，Session 分别控制连接和自动生成许可。

## 安装与启动

Windows x64。本文使用 DeepSeek Harness **0.2.1-rc.3**。本地开发可使用仓库内的 npm 版 DSH，或使用已安装的 Desktop。按[本地开发指南](docs/LOCAL-DEVELOPMENT.md)首次准备运行时、构建插件并链接共享依赖。

使用 npm 版 DSH 时，在仓库根目录的同一个 PowerShell 窗口中运行下列命令。

```powershell
$runtimeBin = (Resolve-Path -LiteralPath '.\.runtime\dsh-rc3\node_modules\.bin').Path
$env:Path = "$runtimeBin;$env:Path"
$env:pnpm_config_store_dir = Join-Path $PWD.Path '.runtime\pnpm-store'
$env:DSH_HOME = Join-Path $PWD.Path '.runtime\dev-home'
$env:DSH_AGENTS_HOME = Join-Path $PWD.Path '.runtime\dev-agents'
$dsh = Join-Path $runtimeBin 'dsh.cmd'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 -Launcher $dsh
```

首次启动会把当前 checkout 链接到开发环境的 `web` Profile。DSH 默认打开浏览器。使用 `-NoOpen` 时，将终端输出的完整启动地址复制到浏览器。进入 Workspace 下的 Session 后，可在输入栏使用 **Drama**。默认端口为 3080，端口被占用时可在启动命令末尾加 `-Port 3081`。

## 原生 Settings → Drama Studio

1. 从 DSH 左下角账户菜单打开 **Settings → Drama Studio → 视频渠道**。新增渠道、选择协议并填写 API Key。内置供应商使用固定地址，New API、OpenAI 兼容和 Custom REST 需要填写 Base URL。**测试连接**显示配置、鉴权、模型和生成的证据状态。模型列表命中显示「目录可见」，真实任务完成下载后才记录生成成功。
2. 在 **模型预设** 填模型显示名称、API Model ID 和支持的方式，并绑定渠道。一个渠道可绑定多个预设。选择合适的内置模板可直接带入相应模型参数。填写所支持的参数范围，或给该参数填写模型默认值。R2V 需填写各参考素材类型的数量限制。
3. 在 **生成设置** 选默认视频模型，配置默认时长、分辨率、画幅、并发和结果目录。并发默认 2。结果目录默认 `assets/videos`，可以改为项目内 `assets/` 下的其他目录。有效参数按节点覆盖、模型默认、全局默认的顺序取值，未获模型和协议支持的全局参数会被跳过。

| 协议 | 配置与方式 |
| --- | --- |
| 秘塔 MiniMax H3 | 新增固定渠道后，从模板创建 `MiniMax-H3`，支持 T2V、首尾帧 I2V 和混合素材 R2V。I2V 继承首帧画幅。R2V 中使用视频参考仍属于 R2V。 |
| New API | Base URL 支持带或省略末尾 `/v1`。默认使用 Video Generations 接口，支持 T2V、首帧 I2V。选用 Task 插件时在高级区域填写插件键，`xai` 支持 T2V、I2V 和图片／音频 R2V，通用插件路径支持 T2V。 |
| OpenAI 兼容视频 | 使用提供 `/v1/videos` 创建、查询和内容下载的网关，支持 T2V 和首帧 I2V。分辨率用 `1280x720`，或用 `720p` 并指定画幅。 |
| Custom REST | 在高级区域声明提交、查询、鉴权及字段映射。按映射启用 T2V、I2V、R2V 和 V2V。 |
| 火山方舟、BytePlus、Replicate | 保留原有内置适配器和模型模板。Replicate 还支持原有 T2I，视频 I2V/R2V 需要填写模型声明的图片输入字段。 |

渠道和模型设置保存在当前 DSH Profile，供该 Profile 内所有项目共享。API Key 由 DSH 凭据服务保存，设置只显示是否已填。原 Web Profile 的旧 DPAPI 配置在首次读取时导入，已有任务保留提交时的模型和参数。 [New API Task 文档](https://github.com/QuantumNous/new-api-docs-v1/blob/main/content/docs/en/plugins/usage.mdx) · [秘塔 H3 接入指南](https://metaso.cn/minimax-h3/new-api-guide) · [MiniMax 原生接口](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create) · [OpenAI 兼容创建契约](https://developers.openai.com/api/reference/resources/videos/methods/create)

保存渠道、模型预设或生成设置后，DSH Host 通知当前 Profile 中已连接的 Canvas 读取最新配置。节点沿用所选模型预设，生成确认会显示该预设绑定的渠道与协议。新渠道须在模型预设中绑定后才会成为可选项。

生成确认使用 Host 发布的配置版本。配置更新后，已打开的确认需要重新打开。若保存与提交同时到达，配置已更新时，新提交返回冲突，重新读取配置后可再次确认。进入队列的任务继续使用已保存的渠道和参数快照。同一操作 ID 的重试返回已入队的任务。数据存储格式沿用现有版本，旧客户端提交仍可使用原有请求字段。升级时使用同次构建的 Host、Browser 和 Go 工件。回滚到旧工件会恢复旧的刷新和确认行为。

### Custom REST 配置示例

以下字段路径对应示例供应商返回的 JSON，按实际接口替换。任务查询和提交地址相对于 Base URL，亦可填写同源完整地址。状态值区分大小写。

| 配置项 | 示例 |
| --- | --- |
| 提交 | `POST /jobs` |
| 鉴权 | Bearer、自定义请求头或无需密钥 |
| 请求字段 | 模型 → `model`，提示词 → `input.prompt`，时长 → `input.seconds`，源视频 → `input.video` |
| 提交返回的任务 ID 路径 | `data.id` |
| 查询 | `GET /jobs/{taskId}` |
| 状态路径与映射 | `data.status`，`QUEUED` → 排队，`RUNNING` → 处理中，`DONE` → 成功，`ERROR` → 失败 |
| 输出地址路径 | `data.files.0.url` |

I2V 映射首帧和可选尾帧，R2V 将参考素材按连接顺序传为 `[{type,url}, …]`，V2V 映射源视频。本地媒体由适配器读取或上传，供应商需要支持其对应的文件或 Data URL 传输方式。若查询结果没有下载地址字段，可改填同源下载 URL，例如 `/jobs/{taskId}/content`。URL 需要包含 `{taskId}`。

## 手工搭建镜头画布

1. 点击 **新增**、在空白处右键或按 **Shift+A** 选择节点类型，节点会立即保存到项目并进入编辑状态。也可将本地媒体拖入画布、粘贴剪贴板图片，或从 **项目资产** 复用已有文件。
2. 新建时选择 **视频生成**，在节点编辑器里再选生成方式和模型。接入素材时会建议并填入兼容的方式，可在节点里切换。视频节点填写完整内联提示词，I2V 使用首帧与模型支持的尾帧，R2V 使用模型支持的有序媒体，V2V 使用一个源视频。
3. 从来源的输出端口拖至目标输入端口，即可保存引用。编辑区也可按用途选择画布节点、项目资产或本地文件。图片生成可读取文本上下文和模型支持的参考图。视频节点只连接实际所需的图、视频和音频，生成要求完整写在节点自己的提示词中。
4. 在画布焦点下用 **Ctrl+C / Ctrl+V** 复制粘贴，**Ctrl+D** 复制实例，**Ctrl+A** 全选，**Delete / Backspace** 删除节点或引用，**Ctrl+Z / Ctrl+Shift+Z** 撤销或重做。按住空格拖拽平移画布。
5. 保存后点击 **生成…**，检查模式和预设并确认。**任务** 显示进度、失败和已下载的历史结果。可继续查询超时任务或取消尚未提交的排队任务。
6. 从输入栏 **Drama** 的下拉菜单控制该 Session 的自动生成许可。重启后许可关闭。断开连接会保留项目数据和已提交任务。

画布交互参考 ComfyUI 和 InvokeAI 的节点库、端口和工作流检查器。 [ComfyUI Nodes](https://docs.comfy.org/basic-concepts/nodes) · [InvokeAI Workflow Editor](https://invoke.ai/features/workflows/adding-nodes/)

当前工作区任一已连接的 Agent 运行期间，可以查看画布和任务、新增节点和连接、上传素材。已有节点和连接的修改、删除及恢复会暂停，最后一个 Agent 结束后自动恢复。生成队列继续保护运行中任务及其输入。删除节点会移除画布引用，项目素材文件和历史任务继续保留。

Agent 工具有 `drama_context`、`drama_query`、`drama_append`、`drama_submit` 和 `drama_tasks`。Agent 对画布内容始终只读和追加。项目数据保存在 `.drama-studio/studio.db`。

## 项目工作流

进入项目会话后，输入框上方显示固定生产阶段。点击阶段仅激活当前 Session。继续使用原生聊天框进行讨论与迭代，打开 **阶段产物** 查看文档、媒体和历史版本。生成交接预览并确认后，Workspace 保存所选版本，当前 Session 启动下一阶段。视频生成由用户在 Canvas 中独立确认。

插件包在 `resources/` 内置七个阶段的 Skill 和 Harness。DSH Host 加载插件时会自动把缺失文件装填到当前 `DSH_HOME`。该 Home 下的 Workspace 共用这些文件。打开 Workflow Panel 可查看 **Workflow Capabilities Ready** 或展开问题详情。

可以编辑全局 Skill 或 Harness，也可在 `DSH_HOME/skills/` 添加自定义 Skill，通过全局 `stage-skills.json` 指定使用它的阶段。升级只更新与上次安装内容一致的受管文件，已有的自定义内容和修改过的文件会保留。新版本在下次阶段激活时读取，已经激活的 Session 继续使用快照。 [装填路径、自定义映射与交接规则](docs/WORKFLOW.md)

## 卸载

结束 Web 进程，然后运行 `dsh plugin --profile web remove dsh-my-drama-studio`。按实际 Profile 更换 `web`。项目的 `.drama-studio` 和 `assets` 可继续保留。

## 验证

```powershell
$env:GOARCH = 'amd64'
$env:CGO_ENABLED = '0'
go test -count=1 -v ./...
node --test tests/canvas-layout.mjs
node --test tests/web.mjs
node tests/agent-fixture.mjs
```

浏览器测试使用已安装的 Chrome 或 Edge 和隔离 DSH Home。可用 DRAMA_UIUX_IMAGE 与 DRAMA_UIUX_VIDEO 提供实际测试素材路径，设 DRAMA_UIUX_CAPTURE=1 可重拍验收图。Go 与 Web 的密钥存取测试需要能访问 Windows 用户的 DPAPI。测试用模拟 HTTP 响应和隔离设置验证适配器，未提交真实付费任务。

[本次视频改造审计与验收](docs/VIDEO-REFACTOR.md) · [DSH 契约](docs/DSH-CONTRACT.md) · [架构](docs/ARCHITECTURE.md) · [0.1.0 验收记录](docs/VERIFICATION.md) · [UI/UX V2 验收与截图](docs/UIUX-V2.md)
