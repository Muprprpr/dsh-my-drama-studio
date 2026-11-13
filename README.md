# dsh-my-drama-studio

**My Drama Studio · 短剧工作台**运行于 DeepSeek Harness 的原生 Workspace 和 Session。项目文件夹保存一张共享画布，Session 分别控制连接和自动生成许可。

## 安装与启动

Windows x64。已验证 DeepSeek Harness Desktop **0.2.1-rc.3**、Node.js 24、Go 1.26。Go 模块要求 1.25 或更新版本。

在仓库根目录执行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1
```

构建生成 Host、Browser bundle 和 Windows AMD64 的 `dist/studio.exe`。首次运行 `dev.ps1` 会在当前 DSH Home 的 `web` Profile 注册本地插件，后续启动复用同一 Profile。脚本会显示实际 Home、Profile 和端口，未设置 `DSH_HOME` 时使用 `~/.dsh`。默认端口为 3080。用 `-Port 3081` 改端口，或用 `-Launcher <dsh.cmd>` 指定启动程序。切换到已有 Web Profile 用 `-Profile <name>`，切换插件的本地 checkout 时用 `-Install` 重新链接。

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
3. 从来源的输出端口拖至目标输入端口，即可保存引用。编辑区也可按用途选择画布节点、项目资产或本地文件。图片生成可读取文本上下文和模型支持的参考图。视频草稿可先接入图片、视频和音频，生成前再补全节点内的提示词。
4. 在画布焦点下用 **Ctrl+C / Ctrl+V** 复制粘贴，**Ctrl+D** 复制实例，**Ctrl+A** 全选，**Delete / Backspace** 删除节点或引用，**Ctrl+Z / Ctrl+Shift+Z** 撤销或重做。按住空格拖拽平移画布。
5. 保存后点击 **生成…**，检查模式和预设并确认。**任务** 显示进度、失败和已下载的历史结果。可继续查询超时任务或取消尚未提交的排队任务。
6. 从输入栏 **Drama** 的下拉菜单控制该 Session 的自动生成许可。重启后许可关闭。断开连接会保留项目数据和已提交任务。

画布交互参考 ComfyUI 和 InvokeAI 的节点库、端口和工作流检查器。 [ComfyUI Nodes](https://docs.comfy.org/basic-concepts/nodes) · [InvokeAI Workflow Editor](https://invoke.ai/features/workflows/adding-nodes/)

Harness 运行时会保护本轮通过 Studio 工具读取或引用的节点及其依赖。生成队列也会保护运行中任务及其输入。其余节点仍可编辑，并可新增节点和上传素材。删除节点会移除画布引用，项目素材文件和历史任务继续保留。

Agent 工具有 `drama_context`、`drama_query`、`drama_append`、`drama_submit` 和 `drama_tasks`。Agent 对画布内容始终只读和追加。项目数据保存在 `.drama-studio/studio.db`。

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
