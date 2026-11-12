# 验收记录

以下 M0–M4 为原始 0.1.0 阶段的历史验收。供应商设置与手工画布的后续实测见文末。

## M0 — PASS

- 已安装 launcher 的 `--version` 为 `0.2.1-rc.3`，本地对应源码标签提交见 [DSH-CONTRACT.md](DSH-CONTRACT.md)。
- `npm.cmd run build` 成功。使用隔离 DSH Home 启动真实 `dsh web --patch`。
- Host 控制台出现 `[my-drama-studio] My Drama Studio Host loaded`。
- Chrome 加载原生 Workspace 下已建立的 Session，Web boot graph 中出现 `dsh-my-drama-studio`，原生输入栏可见 1 个 `Drama` 按钮，页面错误为 0。


## M1 — PASS

`node --test tests/web.mjs`，1 项通过，0 项失败。在已安装 DSH 0.2.1-rc.3 的 Web UI 中，两个原生 Session 分属两个 Workspace。测试点击原生输入栏按钮，检查右栏 Tab 与实际 Session/Workspace ID，折叠后重开，并检查重复点击后同一 Session 仅保留 1 个 Drama Canvas Tab。浏览器页面错误为 0。

## M2 — PASS

- `go test -count=2 -v ./...` 在 Windows AMD64 执行 3 个测试组两轮，6 次通过。覆盖 3 个 Session 的同目录唯一画布、跨目录隔离、目录复制保留 Canvas ID、Windows 大小写与 Unicode 路径、并发 2×50、重放幂等、事务回滚、不可变触发器、视频素材约束、事件补读、鉴权和重启恢复。
- `node --test tests/web.mjs` 真实 DSH、Go 与 Chrome 集成通过。三个原生 Session 共享 Canvas `2c2d0d30-344a-4bdd-8b1a-677b43cd283a`，独立 Workspace 使用 `30863677-2e60-46a9-8b72-90a06465f340`。两浏览器页通过 HTTP 200 的 SSE 观察到节点追加，并发 2×50 恰好 100，重放无重复，派生保留原文，刷新恢复原 Canvas ID。
- Windows AMD64 工件 `dist/studio.exe` 启动后只输出回环地址。关闭父进程 stdin 后退出码为 0。

## M3 — PASS

- `node tests/agent-fixture.mjs` 退出码 0。真实 DSH Agent 循环在脚本化测试模型边界下记录 18 对 `tool/call` 与 `tool/result`。重启后另记录 2 对。A、B 均可追加，A 的自动提交被 Go 拒绝。B 通过许可和节点校验，收到当前真实供应商未配置的 503。
- 原生浏览器实际点击许可开关，A 开关不影响 B。手工生成操作展示独立确认，并测试取消。Owner API Peer 与浏览器 Owner Peer 的 ID 不同，前者收到 403。
- 原生工具和 Browser 路径均拒绝替换 Session、Workspace 或 Canvas。解绑后旧节点保留。重启保留 Canvas 和绑定，回读许可为关闭，旧签名凭据被拒绝。
- 最终原生浏览器回归增加了异步切换、Host 不可用、项目内 PNG 解码、视频提示词及媒体顺序回读。

## M4 — BLOCKED

`go test -count=1 -v ./...` 中 3 项队列夹具测试通过。已验证提交前写入 submitting、收到供应商 ID 后先落盘再查询、重启按已知 ID 恢复、提交会话解绑后写入结果节点、文件落盘后重启安全恢复，以及超时和中断时进入 uncertain 且不重发。另验证回环引用与输出路径穿越被拒绝。这些测试只使用测试适配器。

正式 Go 工件通过 `studio.New(nil)` 运行，真实提交明确返回 503。审计缺少当前可验证的视频提交协议及可用凭据，也缺少图片供应商的固定协议与凭据。没有真实供应商任务 ID 或真实生成文件可用于 M4 验收。

## 最终 Windows 构建

- `pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1` 退出码 0。安装 26 个锁定的 npm 依赖，Host 与 Browser bundle 构建成功，`go version -m dist/studio.exe` 确认 `GOOS=windows`、`GOARCH=amd64`、`CGO_ENABLED=0`。
- `go test -count=1 -v ./...` 共 7 项通过、0 项失败。`go vet ./...` 退出码 0。
- `npm.cmd pack --dry-run --json --ignore-scripts` 确认包包含 7 个文件，包括两个 bundle、AMD64 可执行文件和 `dsh.bundle.patch`。

## 最终原生回归

- `node --test tests/web.mjs` 退出码 0，1 项通过、0 项失败。三个真实 Session 共享 `7c6d6b12-21d0-4e8a-a835-82526159052b`，另一项目为 `afeb78d5-8e30-4dde-8928-ac05ad088b76`。最终工件验证英文产品名、原生 Tab 去重、异步切换、两页 SSE、2×50、图片预览、视频媒体连线约束、刷新和实际 UI 授权隔离。
- `node tests/agent-fixture.mjs` 退出码 0，2 项通过、0 项失败。最终工件记录 18 次原生 Agent 工具调用，重启后再记录 2 次。所有测试未请求真实生成服务。

## 供应商设置与手工画布回归

- Windows `scripts/build.ps1` 退出码 0，重新构建 DSH 双端和 AMD64 Go 工件。打包预检确认只包含预期的 7 个文件。
- Windows 用户上下文运行 `go test -count=1 -json ./...`，19 组通过、0 失败，`go vet ./...` 退出码 0。验证火山方舟及 BytePlus 三种视频方式、Replicate 文生图和三种视频方式、实际 DPAPI 加密存取、项目内图片传输、凭据不出现在设置回读或任务快照，以及预设更新后旧任务仍使用旧模型。
- `node tests/agent-fixture.mjs` 退出码 0，原生 Agent 18 次调用，重启后再 2 次。共享画布、身份边界和 Session 授权回归通过。
- 接口验证使用本地 HTTP 夹具。没有调用真实供应商或提交付费生成，真实账户下的生成验收尚未执行。
- `node --test tests/web.mjs` 在已安装 DSH 0.2.1-rc.3 上 1 项通过、0 失败，耗时 78.2 秒。小图中真实拖动图片端口至 T2V 草稿，打开保留原提示词的 R2V 派生版。整套流程验证了可搜索节点库、跨分页查找首帧、检查器派生和复制、缩略图、三 Session 共享、两页 SSE 及 2×50 并发。浏览器实测模板保存、重载后读取、夹具密钥写入和脱敏回读、删除预设。未点击真实供应商测试或生成。

## 人工编辑与 Harness 活动联动

Windows x64 安装版 DSH `0.2.1-rc.3`。运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1` 成功生成 Host、Browser 与 Windows AMD64 Go 工件。Web 测试使用 `scripts/dev.ps1` 启动隔离 DSH Home。

- `node --test tests/web.mjs` 9 项通过、0 失败、0 跳过，耗时 86.79 秒。随后新增菜单禁用和两个窗口的版本冲突断言，专项 `node --test --test-name-pattern '^Native human CRUD' tests/web.mjs` 1 项通过。
- `node tests/agent-fixture.mjs` 退出码 0。首轮记录 19 次原生工具调用，实际终止仍有运行轮次的 Host 后，用同一 DSH Home 重启并再记录 2 次。
- Windows 用户上下文的 `go test -count=1 -v ./...` 46 个顶层用例通过，`go vet ./...` 退出码 0。`node --test tests/canvas-layout.mjs` 3 项通过。

| # | 结果 | 实测证据 |
| --- | --- | --- |
| 1 | PASS | Session B 在原卡片保存 Session A 创建的节点。ID 和来源 Session 保持，`revision` 增加，A 页面通过 SSE 看到更新 |
| 2 | PASS | 从节点菜单确认删除，常规画布隐藏卡片。真实 React Flow 端口拖拽更换来源，右键可删除连线。被引用的来源仍能按 ID 读取 |
| 3 | PASS | 原生 Agent 持续运行时，通过画布新增并保存备注，另一会话读到新增 |
| 4 | PASS | Browser Owner 直接请求已有节点改删和连线改删均返回 423。同 ID 批量追加被拒绝，原节点版本不变。Go 专项验证事务最后一刻被拒绝时无新事件 |
| 5 | PASS | 原生 Agent 未注册人工改删工具。尝试用 `drama_append` 覆盖同一节点返回冲突，原生追加和派生仍可用 |
| 6 | PASS | A 运行时，已经打开同一 Canvas 的 B 显示「AI 工作中」，编辑和删除菜单禁用 |
| 7 | PASS | A 正常结束时 B 仍在运行，B 的未保存草稿仍无法提交 |
| 8 | PASS | 最后一个 Agent 停止后，B 页面无需刷新即可在原节点保存。未连接的 Session 运行不会锁住画布 |
| 9 | PASS | 原位草稿跨活动变化保持文本。另一窗口先保存时返回版本冲突，原草稿内容仍保留 |
| 10 | PASS | 原生取消、模型异常、Agent 释放均恢复编辑。结束带活跃轮次的 Host 后启动新进程，同一 Canvas 恢复人工保存 |
| 11 | PASS | A 正在运行时，另一 Workspace 仍可保存同 ID 节点 |
| 12 | PASS | 后台视频轮询期间可以编辑并删除源节点。真实 Go Worker 继续轮询，追加保留来源 ID 和提交时镜头分组的结果节点，原生 Web 播放结果。另实测媒体连线、完整内联提示词、有序素材与 Session 自动生成授权 |

Agent 活动来自安装版 Harness 的真实轮次。测试控制模型响应的开始与结束。视频回归在供应商 HTTP 边界使用隔离响应和已有 MP4，未提交新的外部付费任务。
