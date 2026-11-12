# dsh-my-drama-studio

**My Drama Studio · 短剧工作台**运行于 DeepSeek Harness 的原生 Workspace 和 Session。项目文件夹保存一张共享画布，Session 分别控制连接和自动生成许可。

## 安装与启动

Windows x64。已验证 DeepSeek Harness Desktop **0.2.1-rc.3**、Node.js 24、Go 1.26。Go 模块要求 1.25 或更新版本。

在仓库根目录执行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1
```

构建生成 Host、Browser bundle 和 Windows AMD64 的 `dist/studio.exe`。启动脚本通过已安装的 DSH Web 加载插件，Host 自动启动 Go。默认端口 3080。可用 `-Port 3081` 改端口，或用 `-Launcher <dsh.cmd>` 指定安装位置。

## 设置供应商

在 DSH 打开项目和原生 Session，从输入栏点击 **Drama · 连接画布**。打开原生 **Drama Canvas** 右栏后，点击顶栏 **⋯ → 生成服务设置 → 从模板创建**，填入相应账户的 API 密钥并保存。可以为每种生成方式指定一个默认预设，也可以在视频节点上固定一个预设，或在确认生成时手动选择。**测试密钥**只执行账户或任务列表读取。

| 供应商 | 内置模型模板 | 方式 |
| --- | --- | --- |
| 火山方舟 | Seedance 2.0，支持填写模型 ID 或已部署的 Endpoint ID | T2V、I2V、R2V |
| BytePlus ModelArk | Seedance 2.0，使用独立的新加坡接口和密钥 | T2V、I2V、R2V |
| Replicate | Wan 2.7、Veo 3.1、Kling 3.0 Omni、Hailuo 2.3、FLUX Schnell | Wan/Veo/Kling 支持三种视频方式，Hailuo 支持 T2V/I2V，FLUX 支持 T2I |

Replicate 还可以按官方模型 schema 配置 `owner/name` 或固定版本，I2V/R2V 需明确填写该模型的图片输入字段。填写时长、比例和其他参数前请核对模型文档。Veo 3.1 的 R2V 使用 1–3 张参考图、8 秒、16:9。Kling 3.0 Omni 的适配器把 `@图片1` 转成该模型原生的 `<<<image_1>>>`。模型的套餐和账户访问权限由供应商校验。 [火山方舟视频生成](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh) · [BytePlus ModelArk](https://docs.byteplus.com/en/docs/ModelArk/create-video-generation-task-api) · [Replicate HTTP](https://replicate.com/docs/reference/http) · [Kling](https://replicate.com/kwaivgi/kling-v3-omni-video) · [Hailuo](https://replicate.com/minimax/hailuo-2.3/api/schema)

预设及密钥由 Windows DPAPI 保护，存放在 `DSH_HOME/my-drama-studio/providers.dpapi`，未设置 `DSH_HOME` 时使用 `~/.dsh`。更换 Windows 用户时需要重新配置。项目数据库和任务快照不保存密钥。删除预设后，旧任务仍用已保存的模型快照和该供应商当前密钥查询。

## 手工搭建镜头画布

1. 点击画布浮动工具条的 **新增**，或在空白处右键、双击或按 **Shift+A**。选类型后直接在画布上的未保存卡片填写字段。
2. T2V 填完整提示词。I2V 选一张首帧图。R2V 按顺序选择至少一张参考图。可从检查器搜索其他画布分页里的图片。图片可用项目 `assets/images/` 内的文件或公网 URL。项目本地图片由对应适配器传给供应商。
3. 从图片输出端口拖到视频素材输入端口，进入带该素材的版本编辑。保存时节点、完整提示词、素材顺序和媒体边一起写入。对旧节点的内容变更通过 **另存为新版本** 完成，原版本可回看。V2V 留待后续。
4. 可在检查器定位上下游、预览媒体和复制节点。画布支持多选、整理布局、缩放定位和缩略地图。
5. 保存生成节点后，在该卡片点 **生成…**，检查模式和模型预设后确认。卡片显示后端状态，画布工具条的 **任务** 按需展开列表并定位结果。
6. 从输入栏 **Drama** 的下拉菜单控制该 Session 的自动生成许可。重启后许可关闭。断开连接会保留项目数据和已提交任务。

画布交互参考 ComfyUI 和 InvokeAI 的节点库、端口和工作流检查器。 [ComfyUI Nodes](https://docs.comfy.org/basic-concepts/nodes) · [InvokeAI Workflow Editor](https://invoke.ai/features/workflows/adding-nodes/)

Agent 工具有 `drama_context`、`drama_query`、`drama_append`、`drama_submit` 和 `drama_tasks`。项目数据保存在 `.drama-studio/studio.db`。

## 卸载

结束 `scripts/dev.ps1` 启动的 DSH Web 进程，再按日常方式启动 DSH。启动脚本使用进程级 overlay，项目的 `.drama-studio` 和 `assets` 目录可继续保留。

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

[DSH 契约](docs/DSH-CONTRACT.md) · [架构](docs/ARCHITECTURE.md) · [0.1.0 验收记录](docs/VERIFICATION.md) · [UI/UX V2 验收与截图](docs/UIUX-V2.md)
