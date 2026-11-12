# DSH 契约审计

- 目标仓库只有 README、LICENSE 和本地任务书，未发现插件骨架、Go 模块或启动脚本。保留原有 `.gitignore` 的 `/task` 规则。
- 实际 Windows launcher 为 DeepSeek Harness 安装目录下的 `resources/runtime/cli/bin/dsh.cmd`。`--version` 返回 `0.2.1-rc.3`。该脚本通过 Electron 的 Node 模式启动安装包内 `@deepseek-ai/dsh-desktop-host/lib/cli.js`。相邻源码仓库 HEAD 是 `fcc0ad4621`，已合并 0.2.2-rc.1。源码核查固定在 `dsh-v0.2.1-rc.3` 标签。
- Web 入口使用 `dsh web --patch <patch> --host 127.0.0.1 --port <port>`。外部绝对路径 overlay 以已安装 CLI 启动。Host ESM 导出 `apply(ctx)`，Browser 由 `exports["./client"]` 和 `dsh.client.platform=web` 声明，工件调用 `window.__ModuleLoader__.load({id,factory(require)})`。React、React JSX Runtime 和 React DOM 使用壳内共享实例。参见同版本 `docs/subsystems/client-modules.md`、`packages/client/modules/README.md`、`apps/web/tests/fixtures/plugins/fixture-input-extension`。
- `conversation.input.left` 是 Session 作用域 list slot，声明无 owner props。`sidebar.right.pane.tab` 是 Session 作用域 keyed slot，key 等于页类型定义的 `id`，注入 `hooks.tabInfo`。`ctx.sidebarRightTabs.register({id,kind,title})` 和 `ctx.sidebarRight.openTab(kind)` 注册并导航原生页类型。来源是同版本 `packages/client/ui-conversation/src/client/contract/slots.ts`、`packages/client/ui-sidebar-right/src/client/contract/slots.ts` 和 `tab-registry.ts`。


## 会话、工作区与认证

- rc.3 标签对象提交为 `1f81c047fc48fa190a683e469daa699857e9afe8`。安装包 `app.asar` 中的对应包版本一致。包清单声明 `lib/types/*.d.ts`，安装工件未附这些文件，类型签名据同版本 TypeScript 定义核对，再用安装版运行验证。
- 插槽本身没有 owner props。`PropsRuntime<'conversation.input.left'>` 通过 `ui-session` 的 Session scope 注入 `sessionId`、`useSession`、`useProjection`、`useAccess`。右侧 Tab 使用相同 Session scope 以及 `hooks.tabInfo`。原生 `SidebarRightController` 提供 `mounted.getSnapshot()`、`tabsIn(sessionId)`、`focus(tabId)`、`isExpanded()`、`toggleExpanded()` 和 `openTab(kind)`。原生页类型按目标 pane 去重，所以打开前先查当前 Session 的全部 Tabs。
- Host 的 `ctx.workspaceRegistry.list()` 提供 Workspace 对象，其 `sessionIds` 来自 DSH 持久化会话归属，`path` 已规范化，`status()` 为 `ok` 或 `missing-dir`。每次业务操作重新核对归属。定义位于 `packages/workspace/workspace/src/index.ts` 和 `types.ts`。
- `ctx.webServer.register({kind,path,handler})` 接收 Node `IncomingMessage`、`ServerResponse`，返回 disposer。其 carrier 不负责鉴权。用 `ctx.connection.admit(req)` 校验 Host、Origin、凭据与 Peer，并要求 `peer.principal.kind === 'owner'`。同版本 `packages/client/connection/src/rpc.ts`、`rpc-host.ts` 和 `packages/host/webserver/src/index.ts` 定义以上契约。
- rc.3 的 Web owner Peer 在浏览器连接间共享。Owner 可以按 DSH 原生规则选择任一真实 Session，Host 无法识别物理前台 Tab。Studio 在首次选择时通过原生 Workspace Registry 核实会话，后续请求使用与 Owner Peer、Session、Workspace 绑定的能力凭据，每次重新检查归属。业务操作拒绝调用端替换身份、路径或 Canvas。
- `defineTool({parameters,output,execute(args,exec)})` 经 `ctx.tools.register()` 注册，可信 Session 来自 `exec.agent.session.id`，取消信号来自 `exec.signal`。同版本 `packages/core/tools/src/index.ts` 和 `packages/core/agent-loop/src/tool-calls.ts` 提供实际定义。隐式参数根仍允许额外属性，工具执行层须显式拒绝未声明字段。

## 生成内核审计

目标仓库无生成内核。相邻 `ai-video/internal/minimax/client.go` 有 MetaSo MiniMax-H3 的历史 Go 传输，`dsh-bridge` 历史结果保留 9 条带 ID 的已完成查询记录，可确认查询使用 `task.id`、`task.status` 和 `task.content.url`。原始提交响应未留存，旧实现猜测多个响应字段并在轮询完成后才持久化 ID，不能直接作为当前固定协议和队列实现使用。审计范围未发现当前测试凭据或经确认的图片服务协议。原始 0.1.0 构建因此仅保留内部执行契约和任务持久化。后续供应商接入独立依据火山方舟、BytePlus 和 Replicate 官方文档，入口与模型表见 README。

- List slot 的贡献必须提供 `options.id`。实际 rc.3 浏览器启动曾报 `list slot "conversation.input.left" requires options.id`，补上稳定的 `drama-session-control` 后重验。右侧的定义仍使用 keyed slot 的 `key`，组件读取编译后的 `useTabInfo()` 属性。
- 绝对 overlay 模块中直接 bare import `@deepseek-ai/dsh-tools` 在安装版报 `ERR_MODULE_NOT_FOUND`。使用同一注册服务的原生 `ToolDefinition` 形状 `{name,description,parameters,output,execute}`，在 Host 与 Go 边界校验参数。已用隔离 Web profile 的原生 Agent 循环验证该注册方式和真实 `exec.agent.session.id`。
- rc.3 的原生 InputBar 仅在 `input` 和 `sessionId` 均存在时渲染该扩展槽。尚未建立 Session 的欢迎页不会渲染插件按钮，常规会话输入栏会渲染。

## 对照来源

- [rc.3 右侧栏](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/subsystems/sidebar-right.md)、[插槽](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/subsystems/slots.md)、[Client Modules](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/subsystems/client-modules.md)
- [rc.3 插件开发](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/user/develop/basic/index.md)、[工具注册](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/cookbook/adding-a-tool.md)、[Web Server](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/docs/subsystems/web-server.md)
- [NINKCH/dsh-infinite_canvas](https://github.com/NINKCH/dsh-infinite_canvas) 用作比较 Browser 工件注册机制的参考。

Browser manifest 的 `dsh.client.inject` 填 Web 模块包名 `@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-client-ui-sidebar-right`。Browser `export const inject` 填 Cordis 服务名 `slots`、`sidebarRight`、`sidebarRightTabs` 和 `locale`。Owner API Peer 的 kind 也可能为 owner，所以 Studio 的 Browser 路由还要求 Peer ID 与原生 `ctx.connection.browserPeer.id` 相同。安装版已验证 API Owner Peer 收到 403。

## Workspace Agent 活动

- 安装版仍为 `0.2.1-rc.3`，Desktop 内置 Node.js 为 `24.21.0`、Windows x64，Cordis 为 `4.0.5`。同版本 `packages/core/agent/src/index.ts` 提供注入服务 `ctx.agents` 和同步 `get(sessionId)`，只读取当前已加载的 Agent。已存在但未加载的 Session 无运行实例。
- `packages/core/agent-loop/src/agent.ts` 定义 `agent.status` 的 `idle` / `running`，切换时发送 `agent/status`，事件参数为 `{agent,status}`。`packages/core/agent/src/runtime-types.ts` 声明 `agent/disposed` 参数为 `{agent}`。释放时注册表先移除该 Agent，再通知观察者。
- Host 在浏览器初次读取、SSE 更新及 Go 事务准入时，用 DSH Workspace 成员与 SQLite 已连接会话取交集，再读取实时状态。事件用于刷新界面，准入直接读取原生注册表。新 Host 从实际注册表读取状态，无需恢复活动锁。
