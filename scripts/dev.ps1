param(
    [string]$Launcher,
    [string]$Profile = 'web',
    [ValidateRange(0, 65535)][int]$Port = 3080,
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
if ($Port -ne 0) {
    $listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if ($listeners | Where-Object { $_.Port -eq $Port -and $_.Address.ToString() -in @('127.0.0.1', '0.0.0.0') }) {
        throw "Port 127.0.0.1:${Port} is already in use. To restart DSH Web on this port, stop the existing instance from its original terminal and retry."
    }
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
# Windows PowerShell strips embedded double quotes from native arguments.
node -e 'const fs = require(''node:fs''); const paths = process.argv.slice(1); process.exit(paths.every(path => fs.existsSync(path)) && fs.realpathSync(paths[0]).toLowerCase() === fs.realpathSync(paths[1]).toLowerCase() ? 0 : 2)' $installedRoot $root
$linkStatus = $LASTEXITCODE
if ($linkStatus -eq 2) {
    throw "Drama Studio is not linked to this checkout in '$Profile'. Run scripts/dev.ps1 -Install to relink it."
}
if ($linkStatus -ne 0) { throw "Drama Studio link check exited with code $linkStatus." }
$flags = @('--profile', $Profile, '--host', '127.0.0.1', '--port', "$Port")
if ($NoOpen) { $flags += '--no-open' }
& $Launcher @flags
if ($LASTEXITCODE -ne 0) { throw "DSH exited with code $LASTEXITCODE" }
