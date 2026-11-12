# Drama Studio 视频生成改造

## 本次交付验收

按 2026-11-12 用户确认的范围，真实 API 验收覆盖秘塔原生 T2V、I2V、R2V，以及 OpenAI 兼容和 Custom REST 的 T2V。五条真实任务均完成提交、查询、下载和画布播放。New API Task 和 V2V 的真实渠道测试移出本次验收，相关实现和自动化覆盖已交付。

## Phase 0 · 现状审计

审计基线为插件 `6033968` 及开工时的工作树。保留工作树中已有的测试和文档修改。Windows 桌面安装版内置 CLI 实测为 `0.2.1-rc.3`。契约以相邻 DSH 源码标签 `dsh-v0.2.1-rc.3`（`1f81c047fc48fa190a683e469daa699857e9afe8`）为准。

| 审计项 | 判定 | 现状与变更依据 |
| --- | --- | --- |
| 原生 Settings | 缺失，必须新增 | `src/client.jsx` 从画布菜单打开 `ProviderSettings`。插件清单未依赖 Settings 模块，未注册 `settings.section`。目标版本提供根作用域 `settings.section`，以原生 Settings UI 包承载页面。 |
| 设置和凭据存储 | 已实现但需要调整 | `src/host.js` 的供应商路由已经限制为认证的 Browser Owner。现有 Go 子进程把预设、默认项和密钥写入 DSH Home 下的 `providers.dpapi`，同一 Home 的 Profile 会共享。DSH 的 `settings` 通过活动 Profile 的 Cordis patch 持久化 volatile 配置，`credentials` 服务提供单独的密钥记录及脱敏状态。 |
| 视频渠道与预设 | 已实现但需要调整 | `studio/providers.go` 的 `ProviderProfile` 将每个预设固定为一个供应商和一个模式，密钥按固定供应商共用，默认项按模式选择。缺少独立渠道、Base URL、多模式预设、参数范围及全局生成默认值。 |
| T2V | 已实现但需要调整 | 方舟、BytePlus、Replicate 适配器实际执行提交和轮询。预设选择和输入有夹具覆盖，真实生成仍待验。 |
| I2V | 已实现但需要调整 | 现有提交只接收一张首帧图片。方舟有本地文件编码，Replicate 有本地上传。需要按模型能力校验可选尾帧。 |
| R2V | 已实现但需要调整 | 现有适配器使用有序图片参考。画布和请求层缺少可配置的视频、音频及分类数量限制。 |
| V2V | 缺失，必须新增 | `studio/tasks.go` 拒绝视频参考，`studio/nodes.go` 和画布模式列表均未实现 V2V。 |
| HTTP 适配器与连接测试 | 已实现但需要调整 | `studio/ark.go`、`studio/replicate.go` 共用 Provider 契约，有各自的提交、查询、下载和只读凭据检查。缺少 New API、OpenAI 兼容视频、Custom REST。旧只读检查只返回 `verified`，无法证明模型调用和生成。 |
| 任务记录与恢复 | 已实现但需要调整 | `studio/tasks.go`、`studio/worker.go`、`studio/store.go` 已用项目 SQLite 保存请求快照和上游 ID，并从已知 ID 恢复。未知提交进入 `uncertain`，避免重复计费。缺少全局并发上限、明确超时与永久错误处理、取消、完成时间和可直接读取的输出路径。 |
| 下载、结果节点和画布预览 | 已实现且可复用 | `studio/worker.go` 在项目下写入临时文件并原子更名，以事务提交任务完成及结果节点。已认证的 SSE 通知画布，`src/media.js` 提供项目内资产和 Range 读取。 |
| 节点提示词与媒体限制 | 已实现且可复用 | `studio/nodes.go` 检查内联提示词、空 `textList`、`mixedListOrder` 与媒体边一致。保留这些约束、历史正文和成片，并扩展新模式需要的媒体类型。 |
| 画布设置界面和重复请求代码 | 重复或无用，建议删除 | 原生设置接管配置后移除画布内的独立设置面板和对应样式。新协议共用请求、响应和下载逻辑。保留旧供应商已验证的独有请求格式和同一个任务队列。 |

当前插件由 JavaScript/JSX DSH 插件和已有 Go 子进程组成。原生设置和客户端继续走 DSH 插件扩展，视频任务沿用现有子进程、SQLite 与资产路径。本次自动化测试中的供应商响应来自夹具。真实验收状态见下文。

## Phase 1 · 原生设置验收

- `npm.cmd run build` 与 Windows AMD64 `go test -count=1 ./...` 通过。DPAPI 和 esbuild 在默认沙箱中受系统权限限制，复测使用 Windows 当前用户上下文。
- `node --test --test-name-pattern='U1 native' tests/web.mjs` 在实际安装的 DSH 0.2.1-rc.3 上通过。浏览器从原生账户菜单进入 Settings，验证渠道增删改、一个渠道下的两个模型、保存默认参数、切换项目后重新载入，以及密钥在回读和 Profile patch 中均未出现。
- 使用隔离 Profile 离线安装本地 bundle 并执行 `--dump-config`，回读存在 `my-drama-studio` 条目。开发启动切换为原生 Profile 安装。仅在命令行 overlay 中插入插件时，Profile 的设置编辑器无法持久化该条目。
- 修复普通 `build → dev` 的首次启动。旧的临时挂载未在默认 Profile 留下插件注册，脚本现在会在当前 Home 的 Web Profile 自动补装本地 bundle。已在默认 `~/.dsh` 的 `web` Profile 验证 3080 实例显示 6 个已有工作区，并能打开原生 Drama Studio 的视频渠道页面。

## Phase 2–4 · 协议、输入与执行

| 阶段 | Windows x64 自动化结果 |
| --- | --- |
| Phase 2 协议 | New API Video、New API Task 产物、OpenAI 兼容、Custom REST、秘塔 H3 和旧内置适配器的 HTTP 夹具通过。覆盖实际任务 ID 字段、查询状态、下载、认证检查、永久错误和响应脱敏。 |
| Phase 3 统一入口 | T2V、首尾帧 I2V、混合素材 R2V、源视频 V2V 的节点与执行入口通过。错误模式在入队前被拒绝，节点覆盖保存在任务快照，全局设置无变更。 |
| Phase 4 任务内核 | 跨工作区并发上限 1／2、超时暂停、重启按同一上游 ID 继续、永久错误停止和自定义产物路径通过。旧 SQLite 任务保留原结果节点和文件路径。 |

复用了原项目的 Go 子进程、Provider 契约、SQLite 项目数据、工作区恢复、DSH Browser Owner 认证、SSE 与资产流。移除了画布设置弹窗、旧 DPAPI 写入与供应商设置操作、按图片数量判断显式视频模式的重复校验。旧文件仍可用于一次导入，原画布与成片继续从原数据库读取。

## Phase 5 · 画布与原生回归

- 在 Windows 安装版 DSH 0.2.1-rc.3 与 Chromium 上运行 `node --test tests/web.mjs`，使用本地合成 PNG 和 MP4，5 项通过，耗时 48.05 秒。覆盖原生设置、跨会话画布刷新、节点内容与布局、任务下载播放，以及 I2V 首尾帧、R2V 图片／视频／音频顺序和 V2V 源视频。回读检查视频节点提示词、`mixedListOrder` 和上游边，验证 `textList` 为空或不存在。
- 原生 DSH 浏览器任务夹具验证了设置中的模型默认时长为 4 秒，画布节点覆盖为 8 秒，实际 HTTP 提交使用 8 秒。关闭画布后仍能轮询完成，重新打开时可解码播放 `assets/native-results/` 下的本地 MP4。
- `node --test tests/canvas-layout.mjs` 通过 3 项。 `node tests/agent-fixture.mjs` 在 DSH 0.2.1-rc.3 上通过启动和重启两轮，分别验证 18 次和 2 次原生工具调用。重启保留项目绑定，旧会话票据失效。
- Windows AMD64 构建、`go test -count=1 ./...`、`go vet ./...` 和 npm 打包预检通过。包内包括 Host、Browser、Windows x64 内核和原生 bundle patch。

## 秘塔 H3 真实验收

2026-11-12，在 Windows x64 安装版 DSH `0.2.1-rc.3`、默认 DSH Home `~/.dsh`、`web` Profile、端口 3080 完成验收。该实例加载原有工作区，在其中新增独立的 `Drama Studio H3` 验收工作区。用户在原生 Settings → Drama Studio 填入秘塔渠道密钥，模型预设为 `MiniMax-H3`。首次只读测试报告配置有效、鉴权通过，模型调用和任务成功仍待验证。三条任务完成后复测，四项均通过。

三条真实任务由验收脚本调用画布确认按钮使用的 DSH `operation` 接口提交。另在浏览器逐条打开确认面板，核对预设、4 秒、768P、16:9 和可用的提交按钮，随后取消确认，避免重复生成。节点提示词完整内联，I2V 和 R2V 各连接一张合成 PNG，画布回读确认无文本边且 `textList` 为空或不存在。

上游请求使用 `https://metaso.cn/api/minimax`。三条任务均向 `POST /v2/video_generation` 提交 `model: MiniMax-H3`、`duration: 4`、`resolution: 768P` 和有序 `content`。T2V 与 R2V 发送 `ratio: 16:9`。I2V 继承首帧构图。I2V 与 R2V 先调用 `POST /v1/files/upload`，生成请求分别携带 `first_frame` 和 `reference_image`。提交响应的 `task_id` 持久化后，由 `GET /v2/query/video_generation/{taskId}` 查询 `task.status`。三条任务均返回 `succeeded` 和可下载的 `task.content.url`。记录省略鉴权头、素材地址和带签名的产物地址。 [秘塔客户端契约](https://github.com/meta-sota/ComfyUI-MiniMaxH3-API/blob/main/api_client.py) · [MiniMax H3 生成接口](https://platform.minimax.cn/docs/api-reference/video-generation-v2-create)

| 模式 | 上游 `task_id` | 提交 → 完成（北京时间） | 本地 `assets/videos/` 文件 | 大小（字节） |
| --- | --- | --- | --- | ---: |
| T2V | `2120802790691897344` | 16:56:01 → 16:56:18 | `7881d849-3199-4a76-a7db-248dd4f9a488.mp4` | 1,346,965 |
| I2V | `2120803248216145920` | 16:57:49 → 16:58:09 | `2984077e-0f6b-4f17-a62a-786cf6f1b9e5.mp4` | 2,542,174 |
| R2V | `2120803467417419776` | 16:58:42 → 16:58:57 | `99813e5f-2707-4620-9dff-1c0b15b70c30.mp4` | 2,139,371 |

三条记录均保存为 `completed`，带结果节点和本地文件路径。`ffprobe` 回读均为 1344×768、4.458 秒、H.264 视频和 AAC 音频。在 3080 的原生画布「任务 → 查看结果 → 打开视频预览」逐条播放，项目媒体路由返回 HTTP 206，Chromium 跳转到约 1 秒并解码出视频帧。

### OpenAI 兼容协议

在同一 DSH Profile 新增「秘塔 H3 · OpenAI 兼容验收」渠道，Base URL 为 `https://metaso.cn/api/openai/v1`。用户在原生设置保存秘塔密钥。提交前的只读模型目录检查验证鉴权通过，并找到 `MiniMax-H3`。

北京时间 17:05:36 通过画布确认按钮提交，17:05:51 完成。请求为 `POST /videos`，使用 `model: MiniMax-H3`、完整提示词、`seconds: "4"` 和 `size: "1280x720"`。上游返回任务 ID `2120805199069511680`，经 `GET /videos/{taskId}` 查询完成并从 `GET /videos/{taskId}/content` 下载。结果保存在 `assets/videos/38e3e2af-8973-484b-850e-7fd5491cd5a9.mp4`，共 1,599,414 字节。浏览器在原生画布解码出 1344×768、4.458 秒的本地视频并成功跳转播放。 [秘塔 OpenAI 兼容契约](https://metaso.cn/minimax-h3/new-api-guide)

### Custom REST 协议

用户在同一 Profile 的原生设置填入秘塔密钥。渠道 Base URL 为 `https://metaso.cn/api/openai`，提交 `POST /v1/videos`，查询 `GET /v1/videos/{taskId}`，下载模板为 `/v1/videos/{taskId}/content`。字段映射把时长和分辨率分别写入 `seconds`、`size`。响应 `id` 用作任务 ID，`status` 映射排队、处理中、完成、失败和取消。提交前复测确认鉴权，任务完成后复测同时确认模型可调用和真实任务成功。

北京时间 17:18:49 通过画布确认按钮提交，17:19:04 完成。请求使用 `model: MiniMax-H3`、完整提示词、数字 `seconds: 4` 和 `size: "1280x720"`。上游 ID 为 `2120808529093132288`。本地 `assets/videos/b52fd015-2fc8-49d5-b9d3-12e091261585.mp4` 为 1,722,209 字节、1344×768、4.458 秒，包含 H.264 视频和 AAC 音频。原生画布从本地资产路由取得 HTTP 206，跳转到约 1 秒并解码出视频帧。

下载模板改动后重新运行 Windows x64 `go test -count=1 ./...`、`go vet ./...`、布局测试、npm 构建及打包预检，均通过。修复 Custom REST 编辑表单后，DSH 原生浏览器回归 5 项通过，耗时 50.39 秒。

真实验收发现编辑已有 Custom REST 渠道时，表单会尝试对已保存的状态映射对象做字符串处理，导致密钥无法保存。已修复并在原生浏览器测试中覆盖新建渠道、重新编辑后只补填密钥、回读下载模板与状态映射。渠道验证提示是当前插件进程内的状态，任务记录与本地视频会跨重启保留。

## 后续配置参考

**New API Task / Video 已通过 HTTP 夹具。** 使用已有 New API 网关时，管理员激活 Hailuo 1.4.0，新增 Task Plugin（类型 61）渠道，绑定 `hailuo`。上游为 `https://metaso.cn/api/minimax`，模型为 `MiniMax-H3`，凭据为秘塔密钥。为该模型配置计费，并确认网关令牌可访问渠道所在分组和模型且额度足够。首次测试可按 5 秒、768P、零输入素材在网关核对计费。 [New API 渠道配置](https://docs.newapi.ai/en/docs/plugins/configuration) · [计费文档](https://docs.newapi.ai/en/docs/plugins/billing) · [Hailuo 官方插件](https://github.com/QuantumNous/new-api-plugins/blob/main/plugins/tasks/hailuo/1.4.0/plugin.js)

在 Drama Studio 的 New API Task / Video 渠道填实际网关地址、网关令牌和插件名 `hailuo`，创建 `MiniMax-H3` 的 T2V 预设，参数留空。插件提交 `POST /v1/tasks/hailuo`，网关应用 5 秒、768P、16:9 默认值。用网关返回的公开 ID 查询至成功，从产物列表取得视频键并下载，核对本地 MP4 和画布播放。 [New API 调用契约](https://docs.newapi.ai/en/docs/plugins/usage)

**V2V 已通过自动化。** H3 的视频参考属于 R2V。本次 H3 的 I2V 使用单首帧，R2V 使用单张参考图。首尾帧及视频、音频混合参考已有自动化覆盖。若使用具备 `grok-imagine-video` 权限的 xAI 渠道，可在原生设置按下表创建 Custom REST 并填 xAI 密钥。 [xAI 源视频编辑](https://docs.x.ai/developers/model-capabilities/video/editing) · [xAI 查询与结果](https://docs.x.ai/developers/model-capabilities/video/generation)

| Custom REST 字段 | xAI V2V 值 |
| --- | --- |
| Base URL、鉴权 | `https://api.x.ai`、Bearer Token |
| 提交、任务 ID 字段 | `POST /v1/videos/edits`、`request_id` |
| 查询、状态字段 | `GET /v1/videos/{taskId}`、`status` |
| 状态映射 | `pending` → 处理中、`done` → 成功、`failed` → 失败 |
| 下载地址字段路径 | `video.url` |
| 请求体字段映射 | 模型 `model`、提示词 `prompt`、源视频 `video.url` |
| 模型预设 | `grok-imagine-video`，只选 V2V，默认生成参数留空 |

测试源视频可使用本记录中的 H3 T2V 合成素材。它是 4.458 秒的 H.264 MP4，符合 xAI 的 8.7 秒源时长限制。V2V 节点只连接该视频，完整提示词填写在节点内。验证时核对真实任务 ID、源视频编辑结果和本地播放。

## 任务与参数回归

- 同一工作区可由两个 Windows 工作器打开。工作器为每条任务持有独立字节锁，直到本次提交、查询与下载退出。锁随进程退出释放。双工作器回归覆盖对方在提交和下载期间仍可处理其他任务，原任务只提交和下载一次，并保留上游 ID。并发上限由各宿主实例独立管理。
- 真实任务标记绑定发起提交时的渠道和密钥。更换密钥后，旧任务仍按保存的上游 ID 查询，完成后只更新任务记录和结果资产。进程重启恢复的任务同样保留持久化结果，渠道的真实任务标记来自当前进程发起且完成的任务。
- OpenAI 兼容和 New API Video 的预设会在保存时拒绝明确互相冲突的分辨率与画幅。H3 图生视频显示「继承首帧画幅」，请求快照省略画幅覆盖。方舟与 BytePlus 使用已知模型的完整 ID 或用户在高级预设中声明的部署系列，旧端点配置继续使用通用请求。

本轮 Windows x64 `go test -count=1 ./...`、`go vet ./...`、布局 3 项、打包预检与隔离 DSH 浏览器 5 项均通过，浏览器耗时 47.52 秒。浏览器测试从已完成的下载任务回读渠道验证状态。

随后在无运行中会话和生成任务时，将同一套已验收产物更新到本地 checkout，重启默认 3080 的 `web` Profile。重启后仍为 7 个工作区，3 条秘塔渠道的密钥状态均为已设置。五条真实任务和结果节点均保留，原生画布逐条读取 HTTP 206 本地媒体并跳转解码。H3 I2V 确认面板已显示「继承首帧画幅」。本轮重放沿用已下载文件。
