param([switch]$Candidate)

$ErrorActionPreference = 'Stop'

function Invoke-BuildCommand {
    param([string]$Program, [string[]]$CommandArguments)

    & $Program @CommandArguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Program $($CommandArguments -join ' ') failed (exit $LASTEXITCODE)"
    }
}

function Get-CleanCommit {
    $commit = Invoke-BuildCommand 'git.exe' @('rev-parse', '--verify', 'HEAD')
    $changes = Invoke-BuildCommand 'git.exe' @('status', '--porcelain=v1', '--untracked-files=normal')
    if ($changes) {
        throw "Candidate requires a clean checkout. Use a separate checkout to preserve local changes.`n$($changes -join "`n")"
    }
    return $commit
}

function Assert-PlainDirectory {
    param([string]$Path)

    if (Test-Path -LiteralPath $Path) {
        $directory = Get-Item -LiteralPath $Path -Force
        if (!$directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Expected a dedicated build directory at $Path"
        }
    }
}

function Get-Sha256 {
    param([string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Confirm-CoreBuild {
    param([string[]]$CoreFiles, [string]$Commit)

    $hashes = [ordered]@{}
    foreach ($file in $CoreFiles) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -eq 0) {
            throw "The complete build did not produce $file"
        }
        $hashes[$file] = Get-Sha256 $file
    }

    $buildInfo = (Invoke-BuildCommand 'go.exe' @('version', '-m', 'dist/studio.exe')) -join "`n"
    foreach ($setting in @('GOOS=windows', 'GOARCH=amd64', 'CGO_ENABLED=0', "vcs.revision=$Commit", 'vcs.modified=false')) {
        if ($buildInfo -notmatch "(?m)^\s*build\s+$([regex]::Escape($setting))\s*$") {
            throw "Go binary does not carry expected build setting $setting"
        }
    }
    return $hashes
}

function New-VerifiedCandidate {
    param([string]$Commit, [System.Collections.IDictionary]$CoreHashes)

    $package = Get-Content -LiteralPath 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $resourceManifest = Get-Content -LiteralPath 'resources/manifest.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $expected = @('package.json', 'README.md', 'LICENSE') + @($CoreHashes.Keys) +
        @(Invoke-BuildCommand 'git.exe' (@('ls-files', '--') + $package.files))
    $expected = $expected | Sort-Object -Unique -CaseSensitive
    $required = @('dsh.bundle.patch', 'resources/manifest.json',
        'resources/workflow-profiles/legacy-drama-production.json',
        'resources/workflow-profiles/short-drama.json', 'resources/workflow-profiles/short-video.json') +
        @($resourceManifest.assets | ForEach-Object { 'resources/' + $_.source })
    foreach ($file in $required) {
        if ($file -cnotin $expected) { throw "Required resource is absent from package.json's file list or the checkout: $file" }
    }

    $candidateRoot = Join-Path (Get-Location).Path '.runtime/release-candidate'
    $candidateDir = Join-Path $candidateRoot $Commit
    foreach ($directory in @('.runtime', $candidateRoot, $candidateDir)) {
        Assert-PlainDirectory $directory
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $staging = (New-Item -ItemType Directory -Path (Join-Path $candidateRoot ('pack-' + [guid]::NewGuid()))).FullName
    try {
        $packOutput = Invoke-BuildCommand 'npm.cmd' @('pack', '--json', '--ignore-scripts', '--pack-destination', $staging)
        $packed = @(($packOutput -join "`n") | ConvertFrom-Json)
        if ($packed.Count -ne 1 -or $packed[0].name -cne $package.name -or $packed[0].version -cne $package.version) {
            throw 'npm pack did not return the expected package.'
        }
        $name = $packed[0].filename
        if (!$name -or $name -ne [IO.Path]::GetFileName($name) -or !$name.EndsWith('.tgz')) {
            throw 'npm pack did not report a tarball filename.'
        }
        $archive = Join-Path $staging $name
        $entries = @(Invoke-BuildCommand 'tar.exe' @('-tf', $archive))
        $members = @($expected | ForEach-Object { 'package/' + $_ })
        $difference = Compare-Object -ReferenceObject $members -DifferenceObject $entries -CaseSensitive
        if ($difference) {
            throw "Tarball entries did not match the npm file whitelist and tracked resources.`n$($difference | Out-String)"
        }

        $coreMembers = @($CoreHashes.Keys | ForEach-Object { 'package/' + $_ })
        Invoke-BuildCommand 'tar.exe' (@('-xf', $archive, '-C', $staging) + $coreMembers)
        foreach ($file in $CoreHashes.Keys) {
            $extracted = Join-Path $staging "package/$file"
            if ((Get-Sha256 $extracted) -cne $CoreHashes[$file]) {
                throw "Tarball hash does not match the complete build for $file"
            }
        }

        if ((Get-CleanCommit) -cne $Commit) { throw 'Candidate commit changed during build.' }
        $tarHash = Get-Sha256 $archive
        $packageDir = Join-Path $candidateDir $tarHash
        Assert-PlainDirectory $packageDir
        New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
        $tarball = Join-Path $packageDir $name
        $report = [ordered]@{
            gitCommit = $Commit
            packageName = $package.name
            packageVersion = $package.version
            toolchain = [ordered]@{
                node = Invoke-BuildCommand 'node.exe' @('--version')
                npm = Invoke-BuildCommand 'npm.cmd' @('--version')
                go = Invoke-BuildCommand 'go.exe' @('version')
            }
            tarball = [ordered]@{ name = $name; path = $tarball; sha256 = $tarHash }
            coreSha256 = $CoreHashes
        }
        if (Test-Path -LiteralPath $tarball) {
            if ((Get-Sha256 $tarball) -cne $report.tarball.sha256) {
                throw "Existing tarball is corrupted: $tarball"
            }
        } else {
            Copy-Item -LiteralPath $archive -Destination $tarball
        }
        $reportPath = Join-Path $candidateDir 'candidate.json'
        $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding UTF8
        Write-Host "Verified candidate: $tarball"
        Write-Host "Candidate report: $reportPath"
    } finally {
        $resolvedStaging = (Resolve-Path -LiteralPath $staging).ProviderPath
        $resolvedRoot = (Resolve-Path -LiteralPath $candidateRoot).ProviderPath
        if ((Split-Path -Parent $resolvedStaging) -ceq $resolvedRoot) {
            Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
        }
    }
}

Push-Location (Split-Path -Parent $PSScriptRoot)
$previousArch = $env:GOARCH
$previousOS = $env:GOOS
$previousCGO = $env:CGO_ENABLED
try {
    $coreFiles = @('dist/host.js', 'dist/client.js', 'dist/studio.exe')
    if ($Candidate) {
        $commit = Get-CleanCommit
        Assert-PlainDirectory 'dist'
        foreach ($file in $coreFiles) {
            if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
        }
    }
    Invoke-BuildCommand 'npm.cmd' @('ci', '--no-audit', '--no-fund')
    Invoke-BuildCommand 'npm.cmd' @('run', 'build')
    $env:GOOS = 'windows'
    $env:GOARCH = 'amd64'
    $env:CGO_ENABLED = '0'
    if ($Candidate) {
        Invoke-BuildCommand 'go.exe' @('build', '-trimpath', '-buildvcs=true', '-o', 'dist/studio.exe', './cmd/studio')
        if ((Get-CleanCommit) -cne $commit) { throw 'Candidate commit changed during build.' }
        New-VerifiedCandidate $commit (Confirm-CoreBuild $coreFiles $commit)
    } else {
        Invoke-BuildCommand 'go.exe' @('build', '-trimpath', '-o', 'dist/studio.exe', './cmd/studio')
    }
} finally {
    $env:GOARCH = $previousArch
    $env:GOOS = $previousOS
    $env:CGO_ENABLED = $previousCGO
    Pop-Location
}
