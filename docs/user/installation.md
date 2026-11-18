# 安装与启动

[文档总览](../README.md) · [完成第一个项目](first-project.md)

<img src="../assets/mascot/welcome.webp" alt="Q 版鲸鱼娘从片场幕布后挥手" width="320">

## 准备安装包和宿主

插件面向 Windows 10/11 x64。本轮在 Windows 10 x64 实际复验，核对的启动器为 **DeepSeek Harness Desktop 0.2.1-rc.3** 随安装提供的 `dsh.cmd`，工作台通过它启动 **DSH Web** 并在浏览器中使用。其他宿主版本的兼容情况需另行验证。

- 请向维护者获取已核对的插件候选包 **`dsh-my-drama-studio-0.1.0.tgz`**。2026-11-18 核对时，GitHub Releases 没有公开包。本地候选包的来源和验收状态见[本轮验收](../DOCS-REVAMP-VERIFICATION.md#安装包与下载状态)。
- GitHub 的 **Source code (.zip / .tar.gz)** 是仓库源代码。插件 `.tgz` 包含同次构建的 Host、网页界面和 Windows 内核。用源码构建时请按[本地开发指南](../LOCAL-DEVELOPMENT.md)准备 Node.js、npm 和 Go。
- 如需安装宿主，可从官方页面获取 Windows 版。下载页提供的版本可能更新，安装后先用下面的命令检查版本。从完整的 DeepSeek Harness 安装目录使用启动器。安装插件包无需自行编译。讨论和镜头生成所需的模型账户在[模型与视频渠道](models-and-providers.md)配置。 [DeepSeek 官方下载](https://www.deepseek.com/download/)

## 用 PowerShell 安装并打开

1. 打开存放 `dsh-my-drama-studio-0.1.0.tgz` 的文件夹。在资源管理器地址栏输入 `powershell` 并回车，终端就会在这个目录打开。用下面的命令找到 Desktop 自带的启动器并显示版本。如果 Desktop 安装在自定义位置，把第一行换成对应的 `dsh.cmd` 完整路径。

   ```powershell
   $dsh = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
   & $dsh --version
   ```

2. 安装到 Web 工作台的运行配置（Profile）。`$PWD` 代表刚才打开的目录。如果 PowerShell 已能直接运行 `dsh --version`，下面命令开头的 `& $dsh` 可以简写成 `dsh`。

   ```powershell
   & $dsh plugin --profile web add "$PWD\dsh-my-drama-studio-0.1.0.tgz"
   ```

3. 看到终端列出 `dsh-my-drama-studio 0.1.0` 并成功结束后，在**同一个 PowerShell 窗口**启动工作台。

   ```powershell
   & $dsh web --host 127.0.0.1 --port 3080
   ```

   安装和启动使用同一个 DSH Home（设置目录）。默认目录是 `$HOME\.dsh`，这次安装的插件在其中的 `profiles\web` 下。要隔离验收，可按[候选包验收步骤](../LOCAL-DEVELOPMENT.md#构建候选安装包)单独指定目录。

4. 保留 PowerShell 窗口。浏览器没有自动弹出时，从终端复制完整启动地址到本机浏览器，地址可能含本地访问令牌。若看到预览提示，点 **Continue**。若端口已被占用，把命令里的 `3080` 改为 `3081`。
5. 在左侧 **Workspaces** 选项目文件夹，再点 **New Session**。输入栏出现 **Drama**，点开后右侧显示 **Drama Canvas**，说明工作台已就绪。左下角账户菜单的 **Settings** 里也应出现 **Drama Studio**。 [完成第一个项目](first-project.md)

## 使用 HTTPS 包链接

当前宿主支持**直接从 HTTPS 链接安装插件包**。等维护者在 GitHub 发布候选包后，到对应版本的 **Assets** 区，右键扩展名为 `.tgz` 的文件并复制链接。在已经设置好 `$dsh` 的 PowerShell 中运行下面一行，按提示粘贴完整链接。安装完成后照上面的第 3 步启动。 [项目 Releases](https://github.com/Muprprpr/dsh-my-drama-studio/releases)

```powershell
& $dsh plugin --profile web add (Read-Host '粘贴插件 .tgz 文件的 HTTPS 链接')
```

链接应指向**具体版本的插件附件**。`releases` 列表、版本说明页和自动生成的源码压缩包各有其他用途。2026-11-18 核对时，此仓库公开 Releases 列表为空。上述命令的 HTTPS 下载、重定向及安装已在本机隔离服务验证。 [验收记录](../DOCS-REVAMP-VERIFICATION.md#宣传手册与直链安装复验)

## 更新和卸载

- **更新。** 先检查画布「任务」中是否有待完成的任务，保存编辑并退出，回到启动 DSH Web 的终端按 **Ctrl+C**。在同一 DSH Home 和 `web` Profile 上用新版 `.tgz` 重跑安装命令，再启动 Web。回到原 Workspace 核对 **Drama**、阶段产物、素材及设置。
- **卸载。** 用相同方式结束 DSH Web。在同一个 Home 的 PowerShell 运行 `& $dsh plugin --profile web remove dsh-my-drama-studio`。重新启动后检查 **Drama** 入口是否消失。项目文件夹中的 `.drama-studio` 和 `assets` 可以保留，搬移或备份时一起复制。内置资源、Profile 配置和密钥有各自的存放位置，卸载命令只用于移除插件；详见[装填与设置说明](../WORKFLOW.md)。

遇到问题可查[看不到 Drama](faq.md#安装后看不到-drama)。
