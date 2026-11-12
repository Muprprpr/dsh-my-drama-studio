# dsh-my-drama-studio 0.1.0

DSH 原生 Web 负责 Workspace、Session、对话和侧栏生命周期。一个双端插件注册输入栏控件与 `Drama Canvas` 页类型。Client 使用插槽注入的 Session ID 获取工作区状态，异步回调打开 Tab 前核对当前原生挂载的 Session。每个 Session 持有独立的侧栏视图。

所有工作区创作数据由一个 Go 子进程管理。Host 用经过 DSH Connection 认证的 Owner Peer 处理 UI 请求，并通过原生 Workspace Registry 解析 Session 归属。Agent 调用使用 DSH 工具执行上下文中的 Session。二者使用同一 Go 写入入口。Go HTTP 绑定随机回环端口，仅 Host 持有进程级授权。Host 结束后，Go 随其 stdin 管道关闭而退出。

一个规范化目录对应一个 `.drama-studio/studio.db`。Canvas UUID 与项目一起保存。SQLite WAL 保存会话绑定、不可变节点、不可变引用、幂等操作结果、增量事件和任务。会话布局属于视图。已提交的节点与边和事件一起提交，浏览器通过经 DSH 认证的 SSE 恢复或刷新快照。

自动生成许可独立于持久绑定，按 Session 存在于服务内存。人工确认与 Agent 自动提交在服务端分别检查，使用同一个生成任务入口。Studio 权限覆盖 Studio 任务入口，DSH 的其他工具遵循各自的权限和凭据规则。

任务只在选择了与节点模式匹配的已配置预设时入队。内部 Provider 契约负责提交、查询和文件传输，任务快照保存完整提示词、有序媒体引用和供应商模型预设，不保存密钥。项目图片按供应商契约在提交前上传或编码。单进程 worker 在提交前写入 submitting，收到任务 ID 后持久化再轮询。服务重启时 Host 从 DSH Workspace Registry 发起恢复，任务与页面或 Session 的连接状态无关。缺少供应商 ID 的不确定提交进入 uncertain，需先核查供应商侧记录。下载文件限制在项目资产目录，结果节点与任务完成状态事务提交。供应商设置只接受已认证的 DSH Browser Owner Peer 请求，Host 通过私有通道交给 Go。密钥与预设保存在当前 Windows 用户的 DPAPI 文件，Worker 取任务时按快照中的供应商查找当前密钥。已有任务继续沿用原模型和参数。
