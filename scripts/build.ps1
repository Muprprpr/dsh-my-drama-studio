$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
$previousArch = $env:GOARCH
$previousOS = $env:GOOS
$previousCGO = $env:CGO_ENABLED
try {
    npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    go build -trimpath -o dist/studio.exe ./cmd/studio
    if ($LASTEXITCODE -ne 0) { throw 'Go build failed' }
} finally {
    $env:GOARCH = $previousArch
    $env:GOOS = $previousOS
    $env:CGO_ENABLED = $previousCGO
    Pop-Location
}
