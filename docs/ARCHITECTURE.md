# dsh-my-drama-studio 0.1.0

DSH 原生 Web 负责 Workspace、Session、对话和侧栏生命周期。一个双端插件注册输入栏控件与 `Drama Canvas` 页类型。Client 使用插槽注入的 Session ID 获取工作区状态，异步回调打开 Tab 前核对当前原生挂载的 Session。每个 Session 持有独立的侧栏视图。

所有工作区创作数据由一个 Go 子进程管理。Host 用经过 DSH Connection 认证的 Browser Owner Peer 处理 UI 请求，并通过原生 Workspace Registry 解析 Session 归属。Agent 调用使用 DSH 工具执行上下文中的 Session。二者共用 Go 进程。Go HTTP 绑定随机回环端口，仅父子进程持有进程级授权。Host 结束后，Go 随其 stdin 管道关闭而退出。

一个规范化目录对应一个 `.drama-studio/studio.db`。Canvas UUID 与项目一起保存。SQLite WAL 保存会话绑定、节点、引用、幂等操作结果、增量事件和任务。会话布局属于视图。节点和边的更改与事件一起提交，浏览器通过经 DSH 认证的 SSE 恢复或刷新快照。

人工改删请求由 Host 标记为 `human`。Go 在 SQLite 写事务里检查版本、引用和活跃生成任务的输入，再把改动涉及的节点与已连接 Session ID 交给 Host 核对。Host 通过原生 Agent 状态及本轮 Studio 工具访问的节点确定保护范围。操作与保护范围相交时返回 423，版本冲突返回 409。SSE 同步 Agent 活动和保护范围，Agent 结束或释放时清除本轮记录。

删除节点、移除关联引用及更新目标顺序在同一事务提交。删除后保留节点墓碑、素材文件和历史任务，撤销时按版本恢复引用顺序。上传保留原始字节和扩展名，按类型写入项目的 `assets/images/`、`assets/videos/` 或 `assets/audio/`。导入节点在项目数据库中保存 `assetId` 和相对路径，拖入节点同时保存初始画布坐标。预览 URL 使用当前 Session 的票据生成，资产列表按路径或 URL 合并实例。生成读取当前连接和 `mixedListOrder`，未产出素材的上游节点在生成前等待最近可用结果。

自动生成许可独立于持久绑定，按 Session 存在于服务内存。人工确认与 Agent 自动提交在服务端分别检查，使用同一个生成任务入口。Studio 权限覆盖 Studio 任务入口，DSH 的其他工具遵循各自的权限和凭据规则。

任务只在节点和所选模型通过模式、参数和素材校验后入队。四种视频方法复用同一个 Provider 契约、SQLite 队列与资产管理。任务快照保存内联提示词、有序媒体引用、模型、参数、渠道协议、结果目录和提交时的镜头分组。Worker 取任务时从当前 Profile 的内存配置查找密钥。

同一 Host 的所有工作区共享生成并发额度，默认 2。每个任务从提交到轮询及下载占用一个额度。Worker 在提交前持久化提交阶段，收到上游 ID 后先落盘再轮询。到达轮询期限后可继续查询，Host 重启时从 DSH Workspace Registry 恢复已知 ID。提交结果不确定且未收到 ID 时，记录待对账原因并停止自动执行。下载落在项目资产目录，结果节点、完成时间和本地路径在同一事务提交，原有 SSE 事件触发画布刷新。

浏览器通过 DSH 原生根作用域 `settings.section` 注册 Drama Studio。已认证的 DSH Browser Owner 可以读写设置。渠道和预设由 DSH Host Settings 写入当前 Profile 的 Cordis patch，凭据由 DSH credentials 服务按 Profile 和渠道寻址。旧 Web Profile 的 DPAPI 文件仅供读取和导入。
