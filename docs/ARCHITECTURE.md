# dsh-my-drama-studio 0.1.0

DSH 原生 Web 负责 Workspace、Session、对话和侧栏生命周期。一个双端插件注册输入栏控件与 `Drama Canvas` 页类型。Client 使用插槽注入的 Session ID 获取工作区状态，异步回调打开 Tab 前核对当前原生挂载的 Session。每个 Session 持有独立的侧栏视图。

所有工作区创作数据由一个 Go 子进程管理。Host 用经过 DSH Connection 认证的 Browser Owner Peer 处理 UI 请求，并通过原生 Workspace Registry 解析 Session 归属。Agent 调用使用 DSH 工具执行上下文中的 Session。二者共用 Go 进程。Go HTTP 绑定随机回环端口，仅父子进程持有进程级授权。Host 结束后，Go 随其 stdin 管道关闭而退出。

一个规范化目录对应一个 `.drama-studio/studio.db`。Canvas UUID 与项目一起保存。SQLite WAL 保存会话绑定、节点、引用、幂等操作结果、增量事件和任务。会话布局属于视图。节点和边的更改与事件一起提交，浏览器通过经 DSH 认证的 SSE 恢复或刷新快照。

人工改删和批量恢复请求由 Host 标记为 `human`。Go 在 SQLite 提交前检查活跃生成任务的输入，并将已绑定 Session ID 交给 Host。Host 从当前 Workspace 的原生 Agent 注册表判断是否有任一绑定会话正在运行。有活动 Agent 时，已有节点和连线的改删或恢复返回 423。新增节点和引用不受 Agent 活动限制，引用目标仍受活跃生成任务保护。SSE 同步同一工作区的 `aiRunning` 状态，最后一个绑定 Agent 结束后恢复编辑。

删除节点、移除关联引用及更新目标顺序在同一事务提交。删除后保留节点墓碑、素材文件和历史任务，撤销时按版本恢复引用顺序。上传保留原始字节和扩展名，按类型写入项目的 `assets/images/`、`assets/videos/` 或 `assets/audio/`。导入节点在项目数据库中保存 `assetId` 和相对路径，拖入节点同时保存初始画布坐标。预览 URL 使用当前 Session 的票据生成，资产列表按路径或 URL 合并实例。

自动生成许可独立于持久绑定，按 Session 存在于服务内存。人工确认与 Agent 自动提交在服务端分别检查，使用同一个生成任务入口。Studio 权限覆盖 Studio 任务入口，DSH 的其他工具遵循各自的权限和凭据规则。

## 视频生成输入

视频编辑器在确认生成前提交尚未保存的修改。手动提交带上这次保存得到的节点 revision，过期 revision 返回 409。人工确认、重新生成和 Agent 自动提交都进入 `project.submit`。服务端以短事务读取输入并检查权限与幂等记录，释放连接后校验素材并计算哈希。入队时再用短写事务核对相关节点、入边、结果版本、渠道配置和权限，保存冻结任务及操作记录。其他节点的修改不影响本次提交。

新任务的完整正文来自 `content.prompt`。`textList` 必须为空，视频卡片只允许连接图片、视频和音频。当前入边决定媒体集合，`mixedListOrder` 用于排序。连到生成草稿的边在入队前解析为一次具体产物，连到素材或具体产物节点的边固定使用该节点。来源失效、文件缺失、模式缺少必需媒体或超出模型能力时拒绝提交。零边 T2V 和未配齐媒体的草稿仍可保存。

`promptDoc` 的标签文本投影与正文逐字相同时，文档的素材原子才可按 ID 绑定到有效连线。旧文档投影与正文不同时，只保留正文。标记 `promptDocLinked` 的文档含素材原子且与正文不一致时，编辑器提供修复操作，服务端阻止生成。普通文本中的 `@` 和邮件地址按原文发送。引用失效后可重连、重选或显式转成普通文字。

快照保存正文、各槽位的来源与产物节点及 revision、素材地址和用途、模型、有效参数、渠道协议和结果目录。需要编号的适配器只替换冻结的结构化引用字节范围，其余正文逐字保留。Worker 读取快照及当前 Profile 的渠道密钥，使用快照中的具体媒体文件或 URL。项目内素材在入队时保存 SHA-256，适配器消费前校验同一打开的文件句柄。文件内容变化时停止提交。Custom REST 的提交 URL 允许路由参数，正文、媒体和生成参数只通过请求体字段映射写入。用 `TestVideoInputRulesReachMiniMaxHTTP`、`TestPromptMentionsReachMiniMaxR2VRequest` 和原生 Web 的 `Native video prompt mentions` 回归验证入边约束、草稿保存和最终请求。

### 已有任务

同一 Host 的所有工作区共享生成并发额度，默认 2。每个任务从提交到轮询及下载占用一个额度。Worker 在提交前持久化提交阶段，收到渠道 ID 后持有原任务锁，遇到短暂数据库竞争仅重试本地回执写入。回执落盘后才轮询。Host 重启时从 DSH Workspace Registry 恢复已知 ID。缺少 `videoInputContract` 的旧视频快照须从当前节点重新生成。下载落在项目资产目录，结果节点、完成时间和本地路径在同一事务提交，原有 SSE 事件触发画布刷新。

正常关闭时停止接收工作，为已知回执保留最多 8 秒的收尾时间。Go 进程的正常收尾预算为 10 秒，Host 在 12 秒后才强制结束子进程。回执在预算内仍无法写入时，日志记录本地及渠道任务 ID 供核对。渠道接单到首次本地持久化之间，断电或强制终止可能使回执缺失。无已知 ID 且提交状态不确定的任务保持 `uncertain`，等待与渠道核对。

浏览器通过 DSH 原生根作用域 `settings.section` 注册 Drama Studio。已认证的 DSH Browser Owner 可以读写设置。渠道和预设由 DSH Host Settings 写入当前 Profile 的 Cordis patch，凭据由 DSH credentials 服务按 Profile 和渠道寻址。旧 Web Profile 的 DPAPI 文件仅供读取和导入。
