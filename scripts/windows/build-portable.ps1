#Requires -Version 7.0
# CI preparation only. This does not install anything on the offline target computer.
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ARCH -ne 'X64' -or
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64' -or
    [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -ne 'X64') {
    throw 'Run only in an authorized GitHub-hosted Windows x64 Actions job; local execution is refused.'
}
if (!$env:GITHUB_WORKSPACE -or !$env:RUNNER_TEMP -or !$env:GITHUB_RUN_ID -or !$env:GITHUB_RUN_ATTEMPT -or
    $env:GITHUB_RUN_ID -notmatch '^\d+$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d+$' -or
    $env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$') {
    throw 'GitHub Actions workspace, runner temp, commit and numeric run identity are required.'
}
$workspace = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).ProviderPath.TrimEnd('\')
$cwd = (Get-Location).ProviderPath.TrimEnd('\')
$scriptRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).ProviderPath.TrimEnd('\')
if (![StringComparer]::OrdinalIgnoreCase.Equals($cwd, $workspace) -or
    ![StringComparer]::OrdinalIgnoreCase.Equals($scriptRoot, $workspace)) {
    throw 'Run this checked-out script from the exact GITHUB_WORKSPACE root.'
}
if ((Get-Item -LiteralPath $workspace).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'A redirected workspace root is not supported.'
}

# npm ci, Vite and Forge may replace their outputs. Only fresh roots are allowed.
$freshPaths = @('node_modules', 'dist', 'out', '.local-data')
foreach ($relative in $freshPaths) {
    if (Test-Path -LiteralPath (Join-Path $workspace $relative)) {
        throw "Refusing an existing build/data path: $relative. Use a fresh CI checkout; nothing was deleted."
    }
}
foreach ($relative in @('package-lock.json', 'scripts/windows/prepare-portable.cjs', 'scripts/windows/package-check.cjs',
    'scripts/windows/launcher.cpp', 'tests/fixtures/windows-launcher-child.cpp', 'tests/windows-gui-smoke.cjs',
    'tests/fixtures/synthetic-payment.png', 'docs/WINDOWS_OFFLINE_TRIAL.md')) {
    if (!(Test-Path -LiteralPath (Join-Path $workspace $relative) -PathType Leaf)) {
        throw "Missing required build input: $relative"
    }
}
foreach ($setting in Get-ChildItem Env:) {
    if ($setting.Name -match '^(ELECTRON_MIRROR|ELECTRON_CUSTOM_|ELECTRON_OVERRIDE_DIST_PATH|electron_use_remote_checksums|npm_config_electron_)' -and $setting.Value) {
        throw "Remove Electron mirror/checksum/path override from this CI job: $($setting.Name)"
    }
}
$logRoot = Join-Path $workspace "evidence/windows-ci-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
if (Test-Path -LiteralPath $logRoot) { throw 'The CI log directory already exists; refusing to overwrite it.' }
[void](New-Item -ItemType Directory -Path $logRoot)
Start-Transcript -LiteralPath (Join-Path $logRoot 'build.log') -NoClobber | Out-Null

function Invoke-Native {
    param([Parameter(Mandatory)][string]$File, [string[]]$Arguments = @())
    Write-Host "Running: $File $($Arguments -join ' ')"
    & $File @Arguments
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "Native command failed with exit code ${code}: $File" }
}
function Assert-RegularFile {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer -or $item.Length -eq 0 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Expected a nonempty ordinary file: $Path"
    }
}

try {
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    $npm = (Get-Command npm.cmd -CommandType Application | Select-Object -First 1).Source
    Invoke-Native -File $node -Arguments @('-e', 'if(process.version!=="v26.10.0"||process.platform!=="win32"||process.arch!=="x64")throw Error("Expected Node 26.10.0 Windows x64");console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch}))')
    Invoke-Native -File $npm -Arguments @('--version')
    Invoke-Native -File $npm -Arguments @('ci', '--ignore-scripts', '--no-audit', '--no-fund')

    # Electron 44.7 exposes this explicit installer; no dependency lifecycle scripts run.
    Assert-RegularFile (Join-Path $workspace 'node_modules/electron/install.js')
    Assert-RegularFile (Join-Path $workspace 'node_modules/electron/checksums.json')
    $env:ELECTRON_INSTALL_PLATFORM = 'win32'
    $env:ELECTRON_INSTALL_ARCH = 'x64'
    Invoke-Native -File $node -Arguments @('node_modules/electron/install.js')
    Invoke-Native -File $node -Arguments @('-e', 'const fs=require("node:fs"),p=require("node:path"),v=require("./package.json").devDependencies.electron;const exe=require("electron");if(p.basename(exe)!=="electron.exe"||fs.readFileSync(p.join(p.dirname(exe),"version"),"utf8").trim().replace(/^v/,"")!==v)throw Error("Electron download/version mismatch");console.log("Electron binary checked: "+v)')

    # The launcher is compiled with the runner's Visual Studio 2022 C++ toolchain.
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    Assert-RegularFile $vswhere
    $vsRoots = @(Invoke-Native -File $vswhere -Arguments @('-latest', '-products', '*', '-version', '[17.0,18.0)', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'))
    if ($vsRoots.Count -ne 1 -or ![IO.Path]::IsPathFullyQualified($vsRoots[0])) {
        throw 'Cannot resolve one installed Visual Studio 2022 C++ toolchain.'
    }

    # Compile the console-free supervisor with the already-installed official toolchain.
    # /MT embeds the CRT; the offline computer receives no new runtime dependency.
    $devShell = Join-Path $vsRoots[0] 'Common7/Tools/Microsoft.VisualStudio.DevShell.dll'
    Assert-RegularFile $devShell
    Import-Module $devShell
    Enter-VsDevShell -VsInstallPath $vsRoots[0] -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64' | Out-Null
    $compiler = (Get-Command cl.exe -CommandType Application | Select-Object -First 1).Source
    $launcherRoot = Join-Path $workspace 'out/windows-launcher'
    [void](New-Item -ItemType Directory -Path $launcherRoot)
    $launcher = Join-Path $launcherRoot 'Qianlai.exe'
    $fixture = Join-Path $logRoot 'windows-launcher-child.exe'
    foreach ($build in @(
        @{ source='scripts/windows/launcher.cpp'; output=$launcher; object=(Join-Path $launcherRoot 'launcher.obj') },
        @{ source='tests/fixtures/windows-launcher-child.cpp'; output=$fixture; object=(Join-Path $logRoot 'launcher-child.obj') }
    )) {
        Invoke-Native -File $compiler -Arguments @('/nologo', '/std:c++17', '/EHsc', '/W4', '/WX', '/O2', '/MT', '/utf-8',
            '/DUNICODE', '/D_UNICODE', "/Fo$($build.object)", "/Fe$($build.output)", (Join-Path $workspace $build.source),
            'user32.lib', 'shell32.lib', '/link', '/SUBSYSTEM:WINDOWS', '/MACHINE:X64', '/DYNAMICBASE', '/NXCOMPAT')
        Assert-RegularFile $build.output
    }
    $dumpbin = (Get-Command dumpbin.exe -CommandType Application | Select-Object -First 1).Source
    $launcherImports = @(Invoke-Native -File $dumpbin -Arguments @('/nologo', '/dependents', $launcher))
    $launcherImports | Set-Content -LiteralPath (Join-Path $logRoot 'launcher-imports.txt') -Encoding utf8
    if (($launcherImports -join "`n") -match '(?i)(?:vcruntime|msvcp|ucrtbase|api-ms-win-crt)[^\s]*\.dll') {
        throw 'Launcher unexpectedly depends on a separately installed C/C++ runtime.'
    }
    $env:QIANLAI_TEST_LAUNCHER = $launcher
    $env:QIANLAI_TEST_LAUNCHER_CHILD = $fixture
    Invoke-Native -File $node -Arguments @('--test', 'tests/windows-launcher-native.test.cjs')
    Remove-Item Env:QIANLAI_TEST_LAUNCHER, Env:QIANLAI_TEST_LAUNCHER_CHILD

    Invoke-Native -File $node -Arguments @('--test', 'tests/windows-package-check.test.cjs', 'tests/electron-main.test.cjs',
        'tests/windows-portable.test.cjs', 'tests/image-check.test.cjs', 'tests/expense-export.test.ts', 'tests/expense-download.test.ts',
        'tests/windows-runtime.test.cjs', 'tests/ledger-lock.test.cjs', 'tests/managed-restore.test.cjs',
        'tests/record-backup.test.cjs', 'tests/record-crud.test.cjs', 'tests/invoice-reminder.test.cjs', 'tests/ledger-backup.test.cjs')
    Invoke-Native -File $node -Arguments @('-e', 'require("./scripts/windows/package-check.cjs").checkWindowsPackage(process.cwd(),"x64");console.log("Windows package inputs checked; target acceptance is still pending")')
    Invoke-Native -File $npm -Arguments @('run', 'package', '--', '--platform=win32', '--arch=x64')
    Invoke-Native -File $node -Arguments @('scripts/windows/prepare-portable.cjs')

    $candidateName = "Qianlai-Windows10-x64-$($env:GITHUB_SHA.Substring(0, 12))"
    $portableRoot = Join-Path $workspace 'out/windows-offline'
    $candidate = Join-Path $portableRoot $candidateName
    $outputs = @(Get-ChildItem -LiteralPath $portableRoot -Force)
    if ($outputs.Count -ne 1 -or !$outputs[0].PSIsContainer -or $outputs[0].Name -cne $candidateName) {
        throw 'Expected exactly one new portable candidate directory before archiving.'
    }
    $archive = Join-Path $portableRoot "$candidateName.zip"
    $checksumFile = Join-Path $portableRoot "$candidateName.sha256"
    Compress-Archive -LiteralPath $candidate -DestinationPath $archive -CompressionLevel Optimal
    Assert-RegularFile $archive
    $archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($checksumFile, "$archiveHash  $candidateName.zip`n", [Text.UTF8Encoding]::new($false))

    $runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).ProviderPath
    $extractRoot = Join-Path $runnerTemp ("钱来 解压验证 " + [guid]::NewGuid().ToString('N'))
    if (Test-Path -LiteralPath $extractRoot) { throw 'Extraction directory already exists; refusing reuse.' }
    [void](New-Item -ItemType Directory -Path $extractRoot)
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) {
        throw 'Portable archive checksum changed before extraction.'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot
    $extracted = Join-Path $extractRoot $candidateName
    Invoke-Native -File $node -Arguments @('scripts/windows/prepare-portable.cjs', '--verify-extracted', $extracted) |
        Tee-Object -FilePath (Join-Path $logRoot 'extracted-runner-probe.json')
    Invoke-Native -File $node -Arguments @('tests/windows-gui-smoke.cjs', $extracted) |
        Tee-Object -FilePath (Join-Path $logRoot 'extracted-runner-gui.json')
    Write-Host 'ZIP checksum, extracted inventory and Windows Server runner probes passed. Clean offline Windows 10 acceptance remains unverified.'
    Write-Host "Portable archive: $archive"
    Write-Host "Checksum: $checksumFile"
} finally {
    Stop-Transcript | Out-Null
}
