# Windows 本地开发

## 首次准备

使用 Windows x64、Node.js 24 或更新版本及其 npm、Go 1.25 或更新版本。首次安装运行时和构建依赖需要访问 npm registry。项目本地使用 DSH `0.2.1-rc.3` 和 pnpm `11.25.0`。DSH 在首次链接插件时会调用 pnpm。

在仓库根目录执行以下命令。两个工具都安装到当前 checkout 的 `.runtime/dsh-rc3`。

```powershell
node --version
npm.cmd --version
go version

npm.cmd install --prefix .\.runtime\dsh-rc3 --save-exact '@deepseek-ai/dsh@0.2.1-rc.3' 'pnpm@11.25.0'
if ($LASTEXITCODE -ne 0) { throw '运行时安装失败，请检查上方 npm 日志。' }

$runtimeBin = (Resolve-Path -LiteralPath '.\.runtime\dsh-rc3\node_modules\.bin').Path
$dsh = Join-Path $runtimeBin 'dsh.cmd'
$dshVersion = & $dsh --version
if ($LASTEXITCODE -ne 0 -or $dshVersion -ne '0.2.1-rc.3') { throw "DSH 版本异常：$dshVersion" }
$dshVersion
& (Join-Path $runtimeBin 'pnpm.cmd') --version
```

pnpm 应输出 `11.25.0`。当前 registry 缺少包时，可以在安装命令末尾添加 `--registry=https://registry.npmjs.org/`。`.runtime/` 由 Git 忽略，每个新 checkout 单独准备运行时，日常启动复用已装好的版本。

## 构建与运行

在仓库根目录构建插件。构建产物为 `dist/host.js`、`dist/client.js` 和 Windows AMD64 的 `dist/studio.exe`，Go 内核由插件 Host 启动。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build.ps1
```

使用 npm 版 DSH 时，构建完成后将运行时提供的 `@deepseek-ai/schemastery` 链接到插件的 Node 模块目录。在仓库根目录执行下列命令。`build.ps1` 会通过 `npm ci` 重建 `node_modules`，因此每次构建后都要重新执行这一步。

```powershell
$schemaSource = (Resolve-Path -LiteralPath '.\.runtime\dsh-rc3\node_modules\@deepseek-ai\schemastery').Path
$schemaLink = Join-Path $PWD.Path 'node_modules\@deepseek-ai\schemastery'
if (!(Test-Path -LiteralPath $schemaLink)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $schemaLink) -Force | Out-Null
    New-Item -ItemType Junction -Path $schemaLink -Target $schemaSource -ErrorAction Stop | Out-Null
}
```

下面的环境变量和启动命令在同一个 PowerShell 窗口执行。把本地工具放在当前进程的 `PATH` 前面，让 DSH 用到本地 pnpm，并把 pnpm store 指向当前 checkout。`dev-home` 保存 Web Profile，`dev-agents` 保存 Agent 数据。日常启动复用这两个目录及已有的开发设置和会话。

```powershell
$runtimeBin = (Resolve-Path -LiteralPath '.\.runtime\dsh-rc3\node_modules\.bin').Path
$env:Path = "$runtimeBin;$env:Path"
$env:pnpm_config_store_dir = Join-Path $PWD.Path '.runtime\pnpm-store'
$env:DSH_HOME = Join-Path $PWD.Path '.runtime\dev-home'
$env:DSH_AGENTS_HOME = Join-Path $PWD.Path '.runtime\dev-agents'
$dsh = Join-Path $runtimeBin 'dsh.cmd'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\dev.ps1 -Launcher $dsh
```

首次启动时，脚本把当前 checkout 链接到 `web` Profile。看到 `My Drama Studio Host loaded` 表示插件 Host 已加载。DSH 默认监听 `127.0.0.1:3080` 并打开浏览器。使用 `-NoOpen` 时，将终端输出的完整启动地址复制到浏览器。地址可能带有本地访问令牌，请勿将完整地址贴入共享日志或聊天。

在 DSH 中打开 Workspace 并建立原生 Session，再确认输入栏的 **Drama** 和 **Settings → Drama Studio**。用 `Ctrl+C` 从启动终端结束 Web 进程。

如果当前 checkout 已准备好 `.runtime/dev-local.ps1`，可用下面的本地快捷命令。它会补齐共享依赖链接，使用当前 checkout 的运行时和开发目录，接受 `-Port`、`-NoOpen` 和 `-Install`。新 checkout 可执行前面的手动准备和启动步骤。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\.runtime\dev-local.ps1
```

## 使用 Desktop

已安装 DeepSeek Harness Desktop **0.2.1-rc.3** 时，可从安装目录内的 `resources\runtime\cli\bin\dsh.cmd` 启动。`dev.ps1` 在省略 `-Launcher` 时先查找 `dsh`，再检查 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。自定义安装目录可传入绝对路径，并先用 `& $dsh --version` 确认版本。Desktop 的 `dsh.cmd` 要从完整安装目录中使用。未设置 `DSH_HOME` 时，启动脚本使用 `~/.dsh`。 [DSH 契约](DSH-CONTRACT.md)

## 排查启动问题

| 提示或现象 | 处理方法 |
| --- | --- |
| `Install DeepSeek Harness or supply its dsh.cmd with -Launcher.` | 检查 `-Launcher` 指向的文件能否执行 `--version`。省略这个参数时，默认发现逻辑只查 `dsh` 命令和 Desktop 标准路径。使用仓库内的 npm 版 DSH 时，按上面的命令显式传入 `-Launcher $dsh`。 |
| `Run scripts/build.ps1 first.` | 运行构建脚本，确认 `dist` 下有上述三个产物。 |
| `DSH profile install exited with code …` | 查看上一条 pnpm 输出。用 `pnpm.cmd --version` 确认当前终端找到 `11.25.0`。如果报 `store-operation` 锁目录的访问错误，检查本地运行时的 `node_modules/.bin` 是否在当前终端 `PATH` 前面，以及 `pnpm_config_store_dir` 是否指向 `.runtime/pnpm-store`。 |
| `ERR_MODULE_NOT_FOUND`，找不到 `@deepseek-ai/schemastery` | 构建完成后重新运行上面的共享依赖链接命令。 |
| `Drama Studio is not linked to this checkout` | 确认终端显示的是预期 DSH Home 和 Profile，再在启动命令末尾加 `-Install` 重链。 |
| `Port 127.0.0.1:3080 is already in use` | 在原终端结束占用该端口的 DSH Web，或在启动命令末尾加 `-Port 3081`。 |
| 浏览器能打开，输入栏没有 **Drama** | 先进入一个 Workspace 的原生 Session。需要更换 Profile 时，传入已包含 Web bundle 的 `-Profile <name>`。 |
