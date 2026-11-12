param([string]$Launcher, [int]$Port = 3080, [switch]$NoOpen)
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
$patch = New-TemporaryFile
try {
    $entry = (Resolve-Path -LiteralPath $hostEntry).Path.Replace('\','/')
    $template = Get-Content -Raw -LiteralPath (Join-Path $root 'dsh.bundle.patch')
    $overlay = $template.Replace('name: dsh-my-drama-studio', "name: $($entry | ConvertTo-Json -Compress)")
    [IO.File]::WriteAllText($patch.FullName, $overlay)
    $flags = @('web', '--patch', $patch.FullName, '--host', '127.0.0.1', '--port', "$Port")
    if ($NoOpen) { $flags += '--no-open' }
    & $Launcher @flags
    if ($LASTEXITCODE -ne 0) { throw "DSH exited with code $LASTEXITCODE" }
} finally { Remove-Item -LiteralPath $patch.FullName }
