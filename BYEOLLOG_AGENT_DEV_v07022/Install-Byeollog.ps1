[CmdletBinding()]
param(
    [ValidateSet("Install", "Rollback", "Verify", "VerifyPackage", "RestoreState")]
    [string]$Mode = "Install"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$installRoot = Join-Path $env:LOCALAPPDATA "Programs\ByeollogCollector"
$dataRoot = Join-Path $env:LOCALAPPDATA "ByeollogAgent"
$versionPattern = '^\d+\.\d+\.\d+\.\d+$'
$manifestName = "release-manifest.json"
$checksumsName = "SHA256SUMS.txt"
$maximumPackageBytes = [int64]805306368

$allowedPackageFiles = [ordered]@{
    "byeollog.exe" = "app"
    "WebView2Loader.dll" = "app"
    "LAUNCH_BYEOLLOG.cmd" = "install_root"
    "Byeollog-Launcher.ps1" = "install_root"
    "Install-Byeollog.ps1" = "install_root"
    "ROLLBACK_LAST_VERSION.cmd" = "install_root"
    "VERIFY_INSTALL.cmd" = "install_root"
    "RESTORE_PREUPDATE_STATE.cmd" = "install_root"
    "CREATE_SUPPORT_BUNDLE.cmd" = "install_root"
    "RUN_REPLAY_CANDIDATE_CHECK.cmd" = "install_root"
    "Collect-SupportBundle.ps1" = "install_root"
    "INSTALL_OR_UPDATE.cmd" = "package_tool"
    "INSTALL_AND_CHECK.cmd" = "package_tool"
    "RUN_G4_CANARY_PREP.cmd" = "package_tool"
    "RUN_TESTER_READINESS.cmd" = "package_tool"
    "Test-TesterEnvironment.ps1" = "package_tool"
    "README_TESTER_v070_RC2_KO.txt" = "documentation"
    "G4_CANARY_v070_RC2_KO.md" = "documentation"
    "RELEASE_v07017_AUTOMATION_UI_OVERLAY_KO.txt" = "documentation"
    "RELEASE_v07019_UNIFIED_UI_IMAGES_KO.txt" = "documentation"
    "RELEASE_v07020_BYEOLLOG_ACTION_TEST_ACCUMULATION_KO.txt" = "documentation"
    "RELEASE_v07021_BYEOLLOG_ACTION_TEST_ACCUMULATION_KO.txt" = "documentation"
    "RELEASE_v07022_SAFETY_GATES_KO.txt" = "documentation"
    "RELEASE_v07032_AUTO_UPDATE_BOOTSTRAP_KO.txt" = "documentation"
}
$requiredPackageFiles = @(
    "byeollog.exe",
    "LAUNCH_BYEOLLOG.cmd",
    "Byeollog-Launcher.ps1",
    "Install-Byeollog.ps1",
    "ROLLBACK_LAST_VERSION.cmd",
    "VERIFY_INSTALL.cmd",
    "RESTORE_PREUPDATE_STATE.cmd",
    "CREATE_SUPPORT_BUNDLE.cmd",
    "RUN_REPLAY_CANDIDATE_CHECK.cmd",
    "Collect-SupportBundle.ps1",
    "INSTALL_OR_UPDATE.cmd",
    "INSTALL_AND_CHECK.cmd",
    "RUN_G4_CANARY_PREP.cmd",
    "RUN_TESTER_READINESS.cmd",
    "Test-TesterEnvironment.ps1",
    "README_TESTER_v070_RC2_KO.txt",
    "G4_CANARY_v070_RC2_KO.md",
    "RELEASE_v07032_AUTO_UPDATE_BOOTSTRAP_KO.txt"
)

function Assert-HasProperty {
    param([object]$Value, [string]$Name)
    if ($null -eq $Value -or $Value.PSObject.Properties.Name -notcontains $Name) {
        throw "Required manifest property is missing: $Name"
    }
}

function Assert-NotReparsePoint {
    param([string]$Path, [string]$Label)
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label cannot be a reparse point."
    }
}

function Get-ContainedPath {
    param([string]$Root, [string]$Relative)
    if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative)) {
        throw "A package path is not relative."
    }
    $segments = @($Relative -split '[\\/]')
    if ($segments.Count -eq 0) { throw "A package path is empty." }
    foreach ($segment in $segments) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq "." -or $segment -eq ".." -or
            $segment.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
            throw "A package path contains an unsafe segment."
        }
    }
    $rootFull = (Get-Item -LiteralPath $Root -Force).FullName.TrimEnd('\', '/')
    return (Join-Path $rootFull ($segments -join [IO.Path]::DirectorySeparatorChar))
}

function Test-SameNormalizedWindowsPath {
    param([string]$Candidate, [string]$Expected)
    try {
        if ([string]::IsNullOrWhiteSpace($Candidate) -or [string]::IsNullOrWhiteSpace($Expected)) { return $false }
        $candidateExpanded = [Environment]::ExpandEnvironmentVariables($Candidate.Trim())
        $expectedExpanded = [Environment]::ExpandEnvironmentVariables($Expected.Trim())
        if (-not [IO.Path]::IsPathRooted($candidateExpanded) -or -not [IO.Path]::IsPathRooted($expectedExpanded)) {
            return $false
        }
        $candidateFull = [IO.Path]::GetFullPath($candidateExpanded).TrimEnd('\', '/')
        $expectedFull = [IO.Path]::GetFullPath($expectedExpanded).TrimEnd('\', '/')
        return [string]::Equals($candidateFull, $expectedFull, [StringComparison]::OrdinalIgnoreCase)
    }
    catch { return $false }
}

function Read-JsonObject {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Required JSON file is missing: $Path" }
    Assert-NotReparsePoint -Path $Path -Label "JSON file"
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -le 0 -or $item.Length -gt 4MB) { throw "JSON file size is invalid: $Path" }
    return (Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json)
}

function Test-VersionValue {
    param([string]$Version)
    if ($Version -notmatch $versionPattern) { throw "Release version is invalid." }
    return $Version
}

function Get-MaximumFileBytes {
    param([string]$Name)
    if ($Name -eq "byeollog.exe") { return [int64]536870912 }
    if ($Name -eq "WebView2Loader.dll") { return [int64]33554432 }
    if ($Name.EndsWith(".cmd", [StringComparison]::OrdinalIgnoreCase)) { return [int64]1048576 }
    return [int64]4194304
}

function Test-HashEntry {
    param([string]$Root, [object]$Entry)
    foreach ($property in @("path", "byteSize", "sha256")) { Assert-HasProperty -Value $Entry -Name $property }
    $relative = [string]$Entry.path
    $path = Get-ContainedPath -Root $Root -Relative $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Manifest file is missing: $relative" }
    Assert-NotReparsePoint -Path $path -Label "Manifest file"
    $item = Get-Item -LiteralPath $path
    $maximum = Get-MaximumFileBytes -Name $relative
    if ($item.Length -le 0 -or $item.Length -gt $maximum) { throw "Manifest file size exceeds its safety limit: $relative" }
    if ([int64]$Entry.byteSize -ne $item.Length) { throw "File size does not match: $relative" }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    $expected = ([string]$Entry.sha256).ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$' -or $actual -ne $expected) {
        throw "File hash does not match: $relative"
    }
}

function Test-ManifestAuthenticity {
    param([object]$Manifest, [string]$Root)
    Assert-HasProperty -Value $Manifest -Name "authenticity"
    Assert-HasProperty -Value $Manifest.authenticity -Name "mode"
    $mode = [string]$Manifest.authenticity.mode
    if ($mode -eq "trusted_channel_internal") { return $mode }
    if ($mode -ne "authenticode_pinned") { throw "Release authenticity mode is unsupported." }

    Assert-HasProperty -Value $Manifest.authenticity -Name "signerThumbprint"
    $expected = ([string]$Manifest.authenticity.signerThumbprint -replace '\s', '').ToUpperInvariant()
    if ($expected -notmatch '^[0-9A-F]{40}$') { throw "Release signer thumbprint is invalid." }
    $exe = Get-ContainedPath -Root $Root -Relative "byeollog.exe"
    $signature = Get-AuthenticodeSignature -LiteralPath $exe
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) {
        throw "byeollog.exe Authenticode signature is not valid."
    }
    $actual = ([string]$signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
    if ($actual -ne $expected) { throw "byeollog.exe publisher does not match the pinned signer." }
    return $mode
}

function Read-PackageV2Manifest {
    param([string]$Root)
    $manifest = Read-JsonObject (Join-Path $Root $manifestName)
    foreach ($property in @("schemaVersion", "product", "version", "platform", "packageLayout", "fileCount", "totalByteSize", "authenticity", "files")) {
        Assert-HasProperty -Value $manifest -Name $property
    }
    if ([int]$manifest.schemaVersion -ne 2 -or
        [string]$manifest.product -ne "byeollog-collector" -or
        [string]$manifest.platform -ne "win-x64" -or
        [string]$manifest.packageLayout -ne "flat_v1") {
        throw "Release manifest identity is invalid."
    }
    Test-VersionValue ([string]$manifest.version) | Out-Null

    $entries = @($manifest.files)
    if ($entries.Count -ne [int]$manifest.fileCount -or $entries.Count -lt 18 -or $entries.Count -gt 19) {
        throw "Release manifest file count is invalid."
    }
    $names = @{}
    $totalBytes = [int64]0
    foreach ($entry in $entries) {
        foreach ($property in @("path", "role", "byteSize", "sha256")) { Assert-HasProperty -Value $entry -Name $property }
        $name = [string]$entry.path
        if ($names.ContainsKey($name)) { throw "Release manifest has a duplicate path." }
        if (-not $allowedPackageFiles.Contains($name)) { throw "Release manifest contains an unapproved path: $name" }
        if ([string]$entry.role -ne [string]$allowedPackageFiles[$name]) { throw "Release manifest file role is invalid: $name" }
        if ([int64]$entry.byteSize -le 0 -or [int64]$entry.byteSize -gt (Get-MaximumFileBytes -Name $name)) {
            throw "Release manifest file size is invalid: $name"
        }
        $names[$name] = $true
        $totalBytes += [int64]$entry.byteSize
        if ($totalBytes -gt $maximumPackageBytes) { throw "Release manifest payload exceeds the safety limit." }
    }
    foreach ($required in $requiredPackageFiles) {
        if (-not $names.ContainsKey($required)) { throw "Release manifest is missing a required file: $required" }
    }
    if ([int64]$manifest.totalByteSize -ne $totalBytes) { throw "Release manifest total size is invalid." }
    return $manifest
}

function Read-CompatibleInstalledV2Manifest {
    param([string]$Root)
    $manifest = Read-JsonObject (Join-Path $Root $manifestName)
    foreach ($property in @("schemaVersion", "product", "version", "platform", "packageLayout", "fileCount", "totalByteSize", "authenticity", "files")) {
        Assert-HasProperty -Value $manifest -Name $property
    }
    if ([int]$manifest.schemaVersion -ne 2 -or
        [string]$manifest.product -ne "byeollog-collector" -or
        [string]$manifest.platform -ne "win-x64" -or
        [string]$manifest.packageLayout -ne "flat_v1") {
        throw "Installed release manifest identity is invalid."
    }
    Test-VersionValue ([string]$manifest.version) | Out-Null

    # Installed v2 manifests retain the complete package inventory that existed
    # when that version shipped. Validate its structure without applying the
    # current package's version-specific documentation allowlist, otherwise a
    # A verified historical v2 install must remain selectable for rollback.
    $entries = @($manifest.files)
    if ($entries.Count -ne [int]$manifest.fileCount -or $entries.Count -lt 1 -or $entries.Count -gt 256) {
        throw "Installed release manifest file count is invalid."
    }
    $names = @{}
    $appNames = @{}
    $totalBytes = [int64]0
    foreach ($entry in $entries) {
        foreach ($property in @("path", "role", "byteSize", "sha256")) { Assert-HasProperty -Value $entry -Name $property }
        $name = [string]$entry.path
        $role = [string]$entry.role
        if ($name -notmatch '^[A-Za-z0-9_.-]+$' -or $name -eq "." -or $name -eq ".." -or $names.ContainsKey($name)) {
            throw "Installed release manifest contains an unsafe or duplicate path."
        }
        if (@("app", "install_root", "package_tool", "documentation") -notcontains $role) {
            throw "Installed release manifest file role is invalid: $name"
        }
        if ([int64]$entry.byteSize -le 0 -or [int64]$entry.byteSize -gt (Get-MaximumFileBytes -Name $name)) {
            throw "Installed release manifest file size is invalid: $name"
        }
        if (([string]$entry.sha256).ToLowerInvariant() -notmatch '^[0-9a-f]{64}$') {
            throw "Installed release manifest file hash is invalid: $name"
        }
        if ($role -eq "app") {
            if (@("byeollog.exe", "WebView2Loader.dll") -notcontains $name) {
                throw "Installed release manifest app file is invalid: $name"
            }
            $appNames[$name] = $true
        }
        $names[$name] = $true
        $totalBytes += [int64]$entry.byteSize
        if ($totalBytes -gt $maximumPackageBytes) { throw "Installed release manifest payload exceeds the safety limit." }
    }
    if (-not $appNames.ContainsKey("byeollog.exe") -or $appNames.Count -gt 2) {
        throw "Installed release manifest app file set is invalid."
    }
    if ([int64]$manifest.totalByteSize -ne $totalBytes) { throw "Installed release manifest total size is invalid." }
    return $manifest
}

function Test-ChecksumIndex {
    param([string]$Root, [string[]]$ExpectedNames)
    $path = Join-Path $Root $checksumsName
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "SHA256SUMS.txt is missing." }
    Assert-NotReparsePoint -Path $path -Label "Checksum index"
    $item = Get-Item -LiteralPath $path
    if ($item.Length -le 0 -or $item.Length -gt 131072) { throw "SHA256SUMS.txt size is invalid." }

    $expectedSet = @{}
    foreach ($name in $ExpectedNames) { $expectedSet[$name] = $true }
    $seen = @{}
    foreach ($line in @(Get-Content -LiteralPath $path -Encoding ASCII)) {
        if ($line -notmatch '^([0-9a-fA-F]{64})  ([A-Za-z0-9_.-]+)$') { throw "SHA256SUMS.txt contains an invalid line." }
        $hash = $Matches[1].ToLowerInvariant()
        $name = $Matches[2]
        if (-not $expectedSet.ContainsKey($name) -or $seen.ContainsKey($name)) { throw "SHA256SUMS.txt file set is invalid." }
        $target = Get-ContainedPath -Root $Root -Relative $name
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Checksum target is missing: $name" }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash.ToLowerInvariant()
        if ($actual -ne $hash) { throw "Checksum index does not match: $name" }
        $seen[$name] = $true
    }
    if ($seen.Count -ne $expectedSet.Count) { throw "SHA256SUMS.txt does not cover the complete package." }
}

function Test-PackageRelease {
    param([string]$Root)
    $package = $Root
    if (-not (Test-Path -LiteralPath $package -PathType Container)) { throw "Tester package directory is missing." }
    Assert-NotReparsePoint -Path $package -Label "Tester package directory"

    $manifest = Read-PackageV2Manifest -Root $package
    $entries = @($manifest.files)
    $expectedActual = @{}
    foreach ($entry in $entries) { $expectedActual[[string]$entry.path] = $true }
    $expectedActual[$manifestName] = $true
    $expectedActual[$checksumsName] = $true

    $actualItems = @(Get-ChildItem -LiteralPath $package -Force)
    foreach ($item in $actualItems) {
        if ($item.PSIsContainer) { throw "Tester package cannot contain directories: $($item.Name)" }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Tester package cannot contain reparse points: $($item.Name)" }
        if (-not $expectedActual.ContainsKey($item.Name)) { throw "Tester package contains an unexpected file: $($item.Name)" }
    }
    if ($actualItems.Count -ne $expectedActual.Count) { throw "Tester package file set is incomplete." }

    foreach ($entry in $entries) { Test-HashEntry -Root $package -Entry $entry }
    Test-ManifestAuthenticity -Manifest $manifest -Root $package | Out-Null
    $checksumNames = @($entries | ForEach-Object { [string]$_.path }) + @($manifestName)
    Test-ChecksumIndex -Root $package -ExpectedNames $checksumNames
    return $manifest
}

function Test-LegacyInstalledRelease {
    param([string]$Root, [object]$Manifest)
    if ([string]$Manifest.product -ne "byeollog-collector") { throw "Legacy installed release identity is invalid." }
    $version = Test-VersionValue ([string]$Manifest.version)
    $entries = @($Manifest.files)
    if ($entries.Count -lt 1 -or $entries.Count -gt 2) { throw "Legacy installed release file count is invalid." }
    $names = @{}
    foreach ($entry in $entries) {
        $name = [string]$entry.path
        if (@("byeollog.exe", "WebView2Loader.dll") -notcontains $name -or $names.ContainsKey($name)) {
            throw "Legacy installed release file set is invalid."
        }
        $names[$name] = $true
        Test-HashEntry -Root $Root -Entry $entry
    }
    if (-not $names.ContainsKey("byeollog.exe")) { throw "Legacy installed release does not contain byeollog.exe." }
    $actualNames = @(Get-ChildItem -LiteralPath $Root -File -Force | ForEach-Object { $_.Name })
    $expectedNames = @($names.Keys) + @($manifestName)
    if (@(Get-ChildItem -LiteralPath $Root -Directory -Force).Count -gt 0 -or $actualNames.Count -ne $expectedNames.Count) {
        throw "Legacy installed release directory contains unexpected files."
    }
    foreach ($name in $actualNames) { if ($expectedNames -notcontains $name) { throw "Legacy installed release contains an unexpected file." } }
    return $version
}

function Test-InstalledRelease {
    param([string]$Root)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "Installed release directory is missing." }
    Assert-NotReparsePoint -Path $Root -Label "Installed release directory"
    $rawManifest = Read-JsonObject (Join-Path $Root $manifestName)
    Assert-HasProperty -Value $rawManifest -Name "schemaVersion"
    if ([int]$rawManifest.schemaVersion -eq 1) { return (Test-LegacyInstalledRelease -Root $Root -Manifest $rawManifest) }

    $manifest = Read-CompatibleInstalledV2Manifest -Root $Root
    $appEntries = @($manifest.files | Where-Object { [string]$_.role -eq "app" })
    if ($appEntries.Count -lt 1 -or $appEntries.Count -gt 2) { throw "Installed release app file count is invalid." }
    $expectedActual = @{}
    foreach ($entry in $appEntries) {
        $expectedActual[[string]$entry.path] = $true
        Test-HashEntry -Root $Root -Entry $entry
    }
    $expectedActual[$manifestName] = $true
    $actualItems = @(Get-ChildItem -LiteralPath $Root -Force)
    foreach ($item in $actualItems) {
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $expectedActual.ContainsKey($item.Name)) {
            throw "Installed release directory contains an unexpected item: $($item.Name)"
        }
    }
    if ($actualItems.Count -ne $expectedActual.Count) { throw "Installed release file set is incomplete." }
    Test-ManifestAuthenticity -Manifest $manifest -Root $Root | Out-Null
    return (Test-VersionValue ([string]$manifest.version))
}

function Assert-ImmutableVersionMatchesPackage {
    param([string]$Root, [object]$IncomingManifest)
    $installedManifest = Read-JsonObject (Join-Path $Root $manifestName)
    # Wrap the complete conditional pipeline. PowerShell otherwise unwraps a
    # single app entry into a scalar, and StrictMode rejects scalar .Count.
    $installedEntries = @(
        if ([int]$installedManifest.schemaVersion -eq 1) {
            $installedManifest.files
        }
        elseif ([int]$installedManifest.schemaVersion -eq 2) {
            $installedManifest.files | Where-Object { [string]$_.role -eq "app" }
        }
        else { throw "immutable-version-conflict: installed manifest schema is unsupported." }
    )
    $incomingEntries = @($IncomingManifest.files | Where-Object { [string]$_.role -eq "app" })

    if ($installedEntries.Count -ne $incomingEntries.Count) {
        throw "immutable-version-conflict: the installed app file set differs from this package. Use a new version number."
    }
    $incomingByName = @{}
    foreach ($entry in $incomingEntries) { $incomingByName[[string]$entry.path] = $entry }
    foreach ($installedEntry in $installedEntries) {
        $name = [string]$installedEntry.path
        if (-not $incomingByName.ContainsKey($name)) {
            throw "immutable-version-conflict: the installed app file set differs from this package. Use a new version number."
        }
        $incomingEntry = $incomingByName[$name]
        if ([int64]$installedEntry.byteSize -ne [int64]$incomingEntry.byteSize -or
            -not [string]::Equals(
                ([string]$installedEntry.sha256).ToLowerInvariant(),
                ([string]$incomingEntry.sha256).ToLowerInvariant(),
                [StringComparison]::Ordinal)) {
            throw "immutable-version-conflict: installed app bytes differ from this package. Use a new version number."
        }
    }
}

function Write-JsonAtomic {
    param([string]$Path, [object]$Value)
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = $Path + ".tmp-" + [Guid]::NewGuid().ToString("N")
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 10), $utf8NoBom)
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Copy-FileAtomic {
    param([string]$Source, [string]$Destination)
    $directory = Split-Path -Parent $Destination
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = Join-Path $directory (".copy-" + [Guid]::NewGuid().ToString("N"))
    try {
        Copy-Item -LiteralPath $Source -Destination $temporary
        Move-Item -LiteralPath $temporary -Destination $Destination -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Read-PointerVersion {
    param([string]$Name, [bool]$Required)
    $path = Join-Path $installRoot $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        if ($Required) { throw "Installed version pointer is missing: $Name" }
        return $null
    }
    $pointer = Read-JsonObject $path
    return (Test-VersionValue ([string]$pointer.version))
}

function Write-PointerVersion {
    param([string]$Name, [string]$Version)
    Test-VersionValue $Version | Out-Null
    Write-JsonAtomic -Path (Join-Path $installRoot $Name) -Value ([ordered]@{
        schemaVersion = 1
        version = $Version
        updatedAtUtc = [DateTimeOffset]::UtcNow.ToString("O")
    })
}

function Assert-CollectorStopped {
    if (@(Get-Process -Name "byeollog" -ErrorAction SilentlyContinue).Count -gt 0) {
        throw "별록 에이전트가 실행 중입니다. 트레이에서 완전히 종료한 뒤 다시 실행해주세요."
    }
}

function Install-Release {
    param([object]$ValidatedManifest)
    Assert-CollectorStopped
    $sourceRoot = $PSScriptRoot
    $version = Test-VersionValue ([string]$ValidatedManifest.version)
    $versionsRoot = Join-Path $installRoot "versions"
    New-Item -ItemType Directory -Force -Path $versionsRoot | Out-Null
    Assert-NotReparsePoint -Path $versionsRoot -Label "Installed versions directory"
    $target = Get-ContainedPath -Root $versionsRoot -Relative $version

    if (Test-Path -LiteralPath $target -PathType Container) {
        $installedVersion = Test-InstalledRelease -Root $target
        if ($installedVersion -ne $version) { throw "Existing installed release identity is invalid." }
        Assert-ImmutableVersionMatchesPackage -Root $target -IncomingManifest $ValidatedManifest
    }
    else {
        $staging = Join-Path $versionsRoot (".staging-" + [Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $staging | Out-Null
        try {
            foreach ($entry in @($ValidatedManifest.files | Where-Object { [string]$_.role -eq "app" })) {
                $relative = [string]$entry.path
                $source = Get-ContainedPath -Root $sourceRoot -Relative $relative
                $destination = Get-ContainedPath -Root $staging -Relative $relative
                Copy-Item -LiteralPath $source -Destination $destination
            }
            Copy-Item -LiteralPath (Join-Path $sourceRoot $manifestName) -Destination $staging
            Test-InstalledRelease -Root $staging | Out-Null
            Move-Item -LiteralPath $staging -Destination $target
        }
        catch {
            if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
            throw
        }
    }

    foreach ($entry in @($ValidatedManifest.files | Where-Object { [string]$_.role -eq "install_root" })) {
        $relative = [string]$entry.path
        $source = Get-ContainedPath -Root $sourceRoot -Relative $relative
        $destination = Get-ContainedPath -Root $installRoot -Relative $relative
        Copy-FileAtomic -Source $source -Destination $destination
    }

    $current = Read-PointerVersion -Name "current.json" -Required $false
    if ($null -ne $current -and $current -ne $version) {
        Write-PointerVersion -Name "previous.json" -Version $current
    }
    Write-PointerVersion -Name "current.json" -Version $version

    try {
        $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
        if (-not [string]::IsNullOrWhiteSpace($programs)) {
            $shortcutPath = Join-Path $programs "별록 에이전트.lnk"
            $shell = New-Object -ComObject WScript.Shell
            $shortcut = $shell.CreateShortcut($shortcutPath)
            $installedExecutable = Join-Path $target "byeollog.exe"
            $shortcut.TargetPath = $installedExecutable
            $shortcut.WorkingDirectory = $target
            $shortcut.IconLocation = $installedExecutable + ",0"
            $shortcut.Save()
            $legacyShortcutPath = Join-Path $programs "별록 Collector.lnk"
            if (Test-Path -LiteralPath $legacyShortcutPath -PathType Leaf) {
                try {
                    $legacyShortcut = $shell.CreateShortcut($legacyShortcutPath)
                    $ownedLegacyTarget = Join-Path $installRoot "LAUNCH_BYEOLLOG.cmd"
                    if (Test-SameNormalizedWindowsPath -Candidate ([string]$legacyShortcut.TargetPath) -Expected $ownedLegacyTarget) {
                        Remove-Item -LiteralPath $legacyShortcutPath -Force
                    }
                    else {
                        Write-Host "기존 별록 Collector 바로가기는 portable 또는 다른 설치 대상을 가리켜 보존했습니다."
                    }
                }
                catch {
                    Write-Warning "기존 별록 Collector 바로가기를 안전하게 확인하지 못해 보존했습니다."
                }
            }
        }
    }
    catch { Write-Warning "시작 메뉴 바로가기를 만들지 못했습니다. 설치된 버전 폴더의 byeollog.exe를 사용하세요." }

    Write-Host ""
    Write-Host "설치/업데이트 완료: $version"
    Write-Host "설치된 앱 파일과 manifest 무결성 검사를 통과했습니다."
    Write-Host "사용자 설정 폴더는 변경하지 않았습니다: $dataRoot"
}

function Write-RollbackUpdateBlock {
    param([string]$Version)
    if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "Rollback block version is invalid." }
    if (Test-Path -LiteralPath $dataRoot) { Assert-NotReparsePoint -Path $dataRoot -Label "Agent data root" }
    $updatesRoot = Join-Path $dataRoot "updates"
    New-Item -ItemType Directory -Force -Path $updatesRoot | Out-Null
    Assert-NotReparsePoint -Path $updatesRoot -Label "Agent update state root"
    $statePath = Join-Path $updatesRoot "update-state.json"
    $highestSequence = [int64]0
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        Assert-NotReparsePoint -Path $statePath -Label "Agent update state"
        $stateItem = Get-Item -LiteralPath $statePath -Force
        if ($stateItem.Length -gt 0 -and $stateItem.Length -le 65536) {
            try {
                $existingState = Get-Content -Raw -LiteralPath $statePath -Encoding UTF8 | ConvertFrom-Json
                if ($existingState.PSObject.Properties.Name -contains "highestReleaseSequence" -and
                    [int64]$existingState.highestReleaseSequence -ge 0 -and
                    [int64]$existingState.highestReleaseSequence -le 9999999999) {
                    $highestSequence = [int64]$existingState.highestReleaseSequence
                }
            }
            catch { $highestSequence = [int64]0 }
        }
    }
    $now = [DateTimeOffset]::UtcNow.ToString("O")
    Write-JsonAtomic -Path $statePath -Value ([ordered]@{
        schemaVersion = 1
        lastCheckAtUtc = $now
        nextCheckAtUtc = $now
        highestReleaseSequence = $highestSequence
        lastStatus = "manual_rollback_blocked_version"
        lastErrorCode = $null
        availableVersion = $null
        blockedVersion = $Version
    })
}

function Switch-ToPreviousRelease {
    Assert-CollectorStopped
    $current = Read-PointerVersion -Name "current.json" -Required $true
    $previous = Read-PointerVersion -Name "previous.json" -Required $true
    if ($current -eq $previous) { throw "Current and previous versions are identical." }
    $previousRoot = Get-ContainedPath -Root (Join-Path $installRoot "versions") -Relative $previous
    Test-InstalledRelease -Root $previousRoot | Out-Null

    $confirmation = Read-Host "현재 $current 에서 $previous 로 롤백하려면 ROLLBACK 입력"
    if ($confirmation -cne "ROLLBACK") { throw "Rollback was canceled." }
    Write-PointerVersion -Name "current.json" -Version $previous
    Write-PointerVersion -Name "previous.json" -Version $current
    Write-RollbackUpdateBlock -Version $current
    Write-Host "앱 버전 롤백 완료: $previous"
    Write-Host "문제가 있었던 $current 버전은 더 높은 공개판이 나올 때까지 자동 재설치를 막았습니다."
    Write-Host "설정과 Agent DB는 변경하지 않았습니다."
}

function Verify-CurrentRelease {
    $current = Read-PointerVersion -Name "current.json" -Required $true
    $root = Get-ContainedPath -Root (Join-Path $installRoot "versions") -Relative $current
    $verified = Test-InstalledRelease -Root $root
    Write-Host "설치 무결성 확인 완료: $verified"
}

function Test-SnapshotFile {
    param([string]$SnapshotRoot, [object]$Entry)
    $relative = [string]$Entry.RelativePath
    $path = Get-ContainedPath -Root $SnapshotRoot -Relative $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Snapshot file is missing." }
    Assert-NotReparsePoint -Path $path -Label "Snapshot file"
    $item = Get-Item -LiteralPath $path
    if ($item.Length -le 0 -or $item.Length -gt 2147483648) { throw "Snapshot file size is invalid." }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    if ($item.Length -ne [int64]$Entry.ByteSize -or $hash -ne ([string]$Entry.Sha256).ToLowerInvariant()) {
        throw "Snapshot integrity check failed."
    }
}

function Restore-StateSnapshot {
    Assert-CollectorStopped
    $backupRoot = Join-Path $dataRoot "state-backups"
    $snapshots = @(Get-ChildItem -LiteralPath $backupRoot -Directory -ErrorAction Stop |
        Where-Object { $_.Name -like 'before-*' } |
        Sort-Object LastWriteTimeUtc -Descending)
    if ($snapshots.Count -eq 0) { throw "복구 가능한 설정 스냅샷이 없습니다." }
    $snapshot = $snapshots[0].FullName
    Assert-NotReparsePoint -Path $snapshot -Label "State snapshot"
    $manifest = Read-JsonObject (Join-Path $snapshot "snapshot-manifest.json")
    if ([int]$manifest.SchemaVersion -ne 1) { throw "Snapshot schema is unsupported." }
    $entries = @($manifest.Files)
    if ($entries.Count -eq 0 -or $entries.Count -gt 10000) { throw "Snapshot file count is invalid." }
    $snapshotBytes = [int64]0
    foreach ($entry in $entries) {
        $snapshotBytes += [int64]$entry.ByteSize
        if ($snapshotBytes -gt 4294967296) { throw "Snapshot total size is invalid." }
    }
    foreach ($entry in $entries) { Test-SnapshotFile -SnapshotRoot $snapshot -Entry $entry }

    Write-Host "복원 스냅샷: $($snapshots[0].Name)"
    Write-Host "현재 설정은 별도의 emergency 백업으로 먼저 보존됩니다."
    $confirmation = Read-Host "설정·규칙·Agent DB를 복원하려면 RESTORE 입력"
    if ($confirmation -cne "RESTORE") { throw "State restore was canceled." }

    $emergency = Join-Path $backupRoot ("emergency-before-restore-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
    New-Item -ItemType Directory -Path $emergency | Out-Null
    $emergencyEntries = @()
    foreach ($entry in $entries) {
        $relative = [string]$entry.RelativePath
        $current = Get-ContainedPath -Root $dataRoot -Relative $relative
        if (-not (Test-Path -LiteralPath $current -PathType Leaf)) { continue }
        Assert-NotReparsePoint -Path $current -Label "Current state file"
        $destination = Get-ContainedPath -Root $emergency -Relative $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $current -Destination $destination
        $item = Get-Item -LiteralPath $destination
        $emergencyEntries += [ordered]@{
            RelativePath = $relative
            ByteSize = $item.Length
            Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $destination).Hash.ToLowerInvariant()
        }
    }
    Write-JsonAtomic -Path (Join-Path $emergency "snapshot-manifest.json") -Value ([ordered]@{
        SchemaVersion = 1
        AppVersion = "emergency-before-restore"
        CreatedAtUtc = [DateTimeOffset]::UtcNow.ToString("O")
        Files = $emergencyEntries
    })

    foreach ($entry in $entries) {
        $relative = [string]$entry.RelativePath
        $source = Get-ContainedPath -Root $snapshot -Relative $relative
        $destination = Get-ContainedPath -Root $dataRoot -Relative $relative
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        $temporary = $destination + ".restore-" + [Guid]::NewGuid().ToString("N")
        Copy-Item -LiteralPath $source -Destination $temporary
        Move-Item -LiteralPath $temporary -Destination $destination -Force
    }
    Write-Host "설정 스냅샷 복원 완료. 현재 상태의 emergency 백업: $emergency"
}

# VerifyPackage and the pre-install validation are deliberately read-only. An
# invalid package therefore cannot create the install directory or lock file.
$validatedPackageManifest = $null
if ($Mode -eq "VerifyPackage" -or $Mode -eq "Install") {
    $validatedPackageManifest = Test-PackageRelease -Root $PSScriptRoot
    if ($Mode -eq "VerifyPackage") {
        Write-Host "Tester 패키지 전체 무결성 확인 완료: $($validatedPackageManifest.version)"
        Write-Host "인증 모드: $($validatedPackageManifest.authenticity.mode)"
        return
    }
}

New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
Assert-NotReparsePoint -Path $installRoot -Label "Install directory"
$lockPath = Join-Path $installRoot ".install.lock"
$lock = $null
try {
    $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    switch ($Mode) {
        "Install" { Install-Release -ValidatedManifest $validatedPackageManifest }
        "Rollback" { Switch-ToPreviousRelease }
        "Verify" { Verify-CurrentRelease }
        "RestoreState" { Restore-StateSnapshot }
    }
}
finally {
    if ($null -ne $lock) { $lock.Dispose() }
}
