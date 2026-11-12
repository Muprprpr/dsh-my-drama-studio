# Drama Canvas UI/UX V2

## U0 实际审计

DSH Desktop launcher 的 `--version` 为 `0.2.1-rc.3`，React Flow 实装为 `@xyflow/react 12.11.0`。核对 rc.3 tag 的 `ui-primitives`、`ui-model-selection`、`ui-workspace`、`ui-sidebar-right` 和 `web/src/platform.ts`。原生 Web 共享模块表提供 `@deepseek-ai/dsh-client-ui-primitives`，插件构建应外置该包。CSS 在当前 esbuild 构建中明确按文本导入，构建前后可正常加载。

| 原组件 / 文件 | 根因 | V2 归属 |
| --- | --- | --- |
| `SessionCanvasControl`，`src/client.jsx` | 原生 HTML button 和 details 放在 DSH 输入栏，画布的 scoped CSS 不覆盖该插槽。授权文字、入口和菜单分开占位 | 复用宿主 Button、Menu、Switch 的一组紧凑控件 |
| `SessionPanel`、`TaskStrip`，`src/client.jsx` | 设置、确认、任务常驻块在 React Flow 之外串成纵向页面 | 窄顶栏保留 Workspace 和菜单。任务入口移进画布，提交确认属于当前节点 |
| `CanvasViewport`，`src/canvas.jsx`、`src/canvas.css` | Grid 为各控件和正文分配行，`overflow:auto` 让面板滚动，`47vh` clamp 把画布截成页面的一段 | React Flow 占剩余空间，工具和筛选按需浮出 |
| `GraphNode`、`NodeEditor`、`NodeInspector`，`src/canvas-node.jsx` | GraphNode 只画 170px 摘要卡。编辑和媒体在 Flow、分页之后单独渲染 | 六种实际节点都在 Flow 里显示内容。草稿也是 Flow 节点，保存追加版本 |
| `ProviderSettings`，`src/provider-settings.jsx` | 自定义原生表单使用单独 CSS，顶部独立按钮占位 | 顶栏更多菜单进入原生风格设置，保留供应商保存、删除和只读检查 |
| `scripts/build.mjs` | CSS loader 正常，问题由 DOM 归属及裸控件引起 | 保持现有构建，外置宿主原生 primitives，不新增前端框架 |

真实基准在安装版 DSH Web 记录，含现有 Composer、六种实际节点、画布外编辑表单与任务区域，以及项目中的真实图片和视频。基准测试退出码 0，`outsideReactFlow=true`。

- [原输入栏](uiux-v2/00-before-composer.png)
- [原画布](uiux-v2/01-before-canvas.png)
- [原画布外编辑器与任务区](uiux-v2/02-before-outside-editor.png)
- [原图片预览](uiux-v2/03-before-image.png)
- [原视频预览](uiux-v2/04-before-video.png)

交互采用视口内新增、内容优先卡片、当前节点编辑和多会话共享参考。依照用户规则，执行提示词完整保存在视频节点，文本来源可保留派生关系，执行输入只接合规媒体。[小云雀画布手册](https://xyq.jianying.com/tutorials/creation-agent-canvas) · [LibTV](https://www.liblib.tv/) · [DSH Web 样式](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/web-styling.zh.md) · [React Flow 交互类](https://reactflow.dev/learn/customization/utility-classes)

现有调用沿用 `init`、`bind`、`query`、`append`、`events`、`permission`、`submit_manual`、`tasks` 与供应商设置。只在用户保存草稿时提交节点及允许的媒体边。已提交内容通过 `basedOn` 新增版本。Session 权限、工作区唯一性、任务状态和媒资认证继续由 Host 与 Go 提供。

U1 原生 Shell 检查通过。真实 DSH 测试检查 28px 原生按钮、门户菜单、绑定前禁用开关、绑定后原生工作区标题、React Flow 区域占主容器至少 85%、页面纵向无溢出，设置使用 DSH Modal。另测设置写入、密钥脱敏和删除均通过。

U2 安装版 DSH 独立烟测通过。测试在 React Flow 节点内检查名称框自动聚焦、保存前数据库为空、名称及集/场/镜头/正文准确写入，以及派生 V2 后 V1 内容不变。最初焦点测试捕获了 React Flow 测量期间隐藏节点的问题，草稿只在首字段可见后移交焦点。

U3 的后端改动仅扩展画布读查询。关键词现在匹配节点 ID、镜头号和内容，任务状态按源节点或结果节点最近一次任务过滤。保存、授权、SQLite 表结构和任务执行路径保持原契约。位置、折叠和候选选择属于当前浏览器视图。

## Windows 运行与验收

```powershell
Set-Location -LiteralPath 'C:\Users\Muprp\Desktop\dsh-x\dsh-my-drama-studio'
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1
```

`scripts/build.ps1` 退出码 0。26 个锁定的 npm 包安装成功，Host 和 Browser bundle 构建成功，Go 生成 Windows AMD64 工件。浏览器回归以 `scripts/dev.ps1 -Port <隔离端口> -NoOpen` 启动已安装 DSH Web，使用隔离 DSH Home 和真实原生 Session。

`$env:DRAMA_UIUX_CAPTURE='1'; node --test tests/web.mjs` 在 Windows 用户上下文退出码 0，共 4 项通过、0 失败、0 跳过，耗时 36.94 秒。原生设置回归验证方舟模板保存自动时长 `-1`、DPAPI 脱敏回读和删除。

`go test -count=1 -v ./...` 通过 20 个顶层用例，`go vet ./...` 退出码 0。布局测试通过 3 项，覆盖实测尺寸间距、循环关系和新增卡片避让。原生 Agent 回归记录 18 次工具调用，重启后再验证 2 次。

| 阶段 | 结果 | 实测 |
| --- | --- | --- |
| U0 | PASS | 原始控件和 DOM 审计。基准浏览器测试确认编辑器位于 React Flow 外，并解码原始素材 |
| U1 | PASS | 原生 Drama 输入栏、菜单、设置弹窗及满高画布。验证供应商预设保存、密钥脱敏和删除 |
| U2 | PASS | 镜头草稿在卡内填写及取消，提交才追加。另一 Session 派生 V2，V1 保持原文 |
| U3 | PASS | 三条手工新建路径、选中文字、快捷键、文本滚轮、节点拖动、空白平移、镜头筛选和折叠。图片连线保存为视频派生版本，文本连线被画布和 Host 拒绝 |
| U4 | PASS | 显式确认后进入真实 Go 队列。轮询中关闭抽屉和右栏，任务仍完成并追加结果节点。用隔离 Replicate 响应验证，返回素材为项目原有 MP4 |
| U5 | PASS | 同项目 3 个 Session 共享，同步接收人工和原生 Agent 新增，独立 Workspace 隔离。并发追加 100 个节点。实测 465px、785px、全屏、深浅主题、Chrome 125%、DPR 2 和原生侧栏开合 |

| 条目 | 状态 | 验证证据 |
| --- | --- | --- |
| A01 | PASS | Composer 原生 Drama 分组入口和权限菜单 |
| A02 | PASS | 画布和供应商设置复用 DSH 控件，无浏览器默认裸选择器 |
| A03 | PASS | React Flow 占主区域，节点内编辑，任务抽屉按需渲染 |
| A04 | PASS | 草稿自动聚焦，保存前数据库未新增。实测卡内保存与取消 |
| A05 | PASS | V2 以 `basedOn` 追加，V1 的原始正文保持一致 |
| A06 | PASS | `script`、`note`、`shot`、`prompt`、`image`、`video` 全部为内容卡片 |
| A07 | PASS | 解码实际 PNG 和 MP4，素材缺失显示空态 |
| A08 | PASS | 节点状态、轮询任务抽屉、关闭后恢复以及结果定位 |
| A09 | PASS | 文本拖选、Ctrl+A、Backspace、滚轮，与卡片拖动和画布平移分离 |
| A10 | PASS | 3 个原生 Session 独立授权，Host 拒绝未授权 Agent 提交 |
| A11 | PASS | 两个已打开的原生页面通过 SSE 看到新增及派生，原生 Agent 追加也无需刷新 |
| A12 | PASS | 深浅主题、窄宽侧栏、全屏、125%、DPR 2，窄栏草稿按钮可点击 |
| A13 | PASS | 真实 append、显式手动提交、后端轮询和结果节点，供应商 HTTP 采用隔离夹具 |
| A14 | PASS | 工具条、空白右键、节点输出侧加号，后继节点保存正确来源 |
| A15 | PASS | 镜头筛选、卡片/镜头组折叠、适配和按节点尺寸整理，保存内容不受影响 |
| A16 | PASS | 100 个并发新增节点可筛选、查找和整理。6 个视频卡打开前为 0 个播放器、0 个素材请求，点击后只装载所选视频 |

### 安装版 DSH Web 截图

- [原生 Drama 菜单](uiux-v2/10-after-composer-menu.png) · [生成服务设置](uiux-v2/11-after-settings.png)
- [新建镜头](uiux-v2/20-after-new-shot.png) · [派生镜头](uiux-v2/21-after-derived-shot.png) · [版本链](uiux-v2/22-after-version-chain.png) · [视频提示词](uiux-v2/23-after-prompt-editor.png) · [素材输入和派生线](uiux-v2/24-after-media-lineage.png)
- [真实图片卡片](uiux-v2/25-after-image-card.png) · [大图预览](uiux-v2/26-after-image-preview.png) · [实际视频播放](uiux-v2/27-after-video-card.png)
- [浅色](uiux-v2/28-after-light.png) · [深色](uiux-v2/29-after-dark.png) · [465px 侧栏](uiux-v2/30-after-narrow-465.png) · [785px 侧栏](uiux-v2/31-after-wide-785.png) · [全屏](uiux-v2/32-after-fullscreen.png) · [Chrome 125%](uiux-v2/24-after-chrome-125.png) · [DPR 2 与窄栏编辑](uiux-v2/34-after-high-dpi.png)
- [轮询中](uiux-v2/40-after-task-polling-fixture.png) · [后台完成后的结果](uiux-v2/41-after-task-result-fixture.png)

真实媒体预览 PASS。真实供应商付费 API 验收 BLOCKED，隔离测试中没有可用的真实供应商凭据，未产生外部供应商任务 ID。T2V、I2V 和图片 R2V 按当前供应商及模型预设支持，V2V 留待后续。
