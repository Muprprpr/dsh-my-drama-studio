param(
    [string]$Launcher,
    [string]$Profile = 'web',
    [int]$Port = 3080,
    [switch]$NoOpen,
    [switch]$Install
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (!$Launcher) {
    $command = Get-Command dsh -ErrorAction SilentlyContinue
    if ($command) { $Launcher = $command.Source }
    else { $Launcher = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd' }
}
if (!(Test-Path -LiteralPath $Launcher)) { throw 'Install DeepSeek Harness or supply its dsh.cmd with -Launcher.' }
$hostEntry = Join-Path $root 'dist/host.js'
foreach ($artifact in @($hostEntry, (Join-Path $root 'dist/client.js'), (Join-Path $root 'dist/studio.exe'))) {
    if (!(Test-Path -LiteralPath $artifact)) { throw 'Run scripts/build.ps1 first.' }
}
if ([string]::IsNullOrWhiteSpace($Profile) -or $Profile -match '[\\/:]' -or $Profile -in @('.', '..', 'node_modules')) {
    throw "Invalid DSH Profile name: $Profile"
}
$dshRoot = $env:DSH_HOME
if ([string]::IsNullOrWhiteSpace($dshRoot)) {
    $dshRoot = Join-Path $env:USERPROFILE '.dsh'
} elseif ($dshRoot -eq '~') {
    $dshRoot = $env:USERPROFILE
} elseif ($dshRoot -match '^~[\\/]') {
    $dshRoot = Join-Path $env:USERPROFILE $dshRoot.Substring(2)
}
$dshRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($dshRoot)
$profileRoot = Join-Path (Join-Path $dshRoot 'profiles') $Profile
$manifestPath = Join-Path $profileRoot 'package.json'
$pluginName = 'dsh-my-drama-studio'
$hasBundle = $false
if (Test-Path -LiteralPath $manifestPath) {
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.dsh.profile.bundles -notcontains '@deepseek-ai/dsh-web-app') {
        throw "The DSH Profile '$Profile' does not contain the Web bundle: $manifestPath"
    }
    $hasBundle = $manifest.dsh.profile.bundles -contains $pluginName
} elseif ($Profile -ne 'web') {
    throw "The DSH Web Profile '$Profile' does not exist: $manifestPath"
}

Write-Host "DSH Home: $dshRoot | Profile: $Profile | Port: $Port"
if ($Install -or !$hasBundle) {
    & $Launcher plugin --profile $Profile add "link:$root"
    if ($LASTEXITCODE -ne 0) { throw "DSH profile install exited with code $LASTEXITCODE" }
}
$installedRoot = Join-Path $profileRoot "node_modules/$pluginName"
node -e 'const fs = require("node:fs"); const paths = process.argv.slice(1); process.exit(paths.every(path => fs.existsSync(path)) && fs.realpathSync(paths[0]).toLowerCase() === fs.realpathSync(paths[1]).toLowerCase() ? 0 : 1)' $installedRoot $root
if ($LASTEXITCODE -ne 0) {
    throw "Drama Studio is not linked to this checkout in '$Profile'. Run scripts/dev.ps1 -Install to relink it."
}
$flags = @('--profile', $Profile, '--host', '127.0.0.1', '--port', "$Port")
if ($NoOpen) { $flags += '--no-open' }
& $Launcher @flags
if ($LASTEXITCODE -ne 0) { throw "DSH exited with code $LASTEXITCODE" }
