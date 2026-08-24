[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadRoot,

    [Parameter(Mandatory = $true)]
    [string]$EmbeddedVersion,

    [Parameter(Mandatory = $true)]
    [string]$ResultPath,

    [Parameter(Mandatory = $true)]
    [string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# NSIS starts Windows PowerShell from a 32-bit bootstrapper. Some Windows
# configurations do not expose Microsoft.PowerShell.Utility to that child
# process, even though the normal interactive host has it. The sealed install
# engine uses Get-FileHash, so provide the same narrow SHA-256 contract with
# inbox .NET APIs when module auto-loading is unavailable.
if ($null -eq (Get-Command Get-FileHash -CommandType Cmdlet -ErrorAction SilentlyContinue)) {
    function Get-FileHash {
        [CmdletBinding()]
        param(
            [ValidateSet("SHA256")]
            [string]$Algorithm = "SHA256",

            [Parameter(Mandatory = $true)]
            [string]$LiteralPath
        )

        $resolved = (Resolve-Path -LiteralPath $LiteralPath -ErrorAction Stop).Path
        $stream = $null
        $hasher = $null
        try {
            $stream = [IO.File]::Open(
                $resolved,
                [IO.FileMode]::Open,
                [IO.FileAccess]::Read,
                [IO.FileShare]::Read)
            $hasher = [Security.Cryptography.SHA256]::Create()
            $bytes = $hasher.ComputeHash($stream)
            $hex = ([BitConverter]::ToString($bytes)).Replace("-", "")
            New-Object PSObject -Property @{
                Algorithm = "SHA256"
                Hash = $hex
                Path = $resolved
            }
        }
        finally {
            if ($null -ne $hasher) { $hasher.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
        }
    }
}

$installRoot = Join-Path $env:LOCALAPPDATA "Programs\ByeollogCollector"
$currentPath = Join-Path $installRoot "current.json"
$versionPattern = '^\d+\.\d+\.\d+\.\d+$'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-SetupLog {
    param([string]$Code, [string]$Message)
    try {
        $parent = Split-Path -Parent $LogPath
        if (-not [string]::IsNullOrWhiteSpace($parent)) {
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
        }
        $safeMessage = ([string]$Message -replace '[\r\n]+', ' ').Trim()
        [IO.File]::AppendAllText(
            $LogPath,
            (([DateTimeOffset]::UtcNow.ToString("O")) + " [" + $Code + "] " + $safeMessage + [Environment]::NewLine),
            $utf8NoBom)
    }
    catch {
        # Logging must never replace the actual install result.
    }
}

function Exit-WithResult {
    param([int]$ExitCode, [string]$Code, [string]$Message, [string]$Version)
    if (-not [string]::IsNullOrWhiteSpace($Version)) {
        $resultParent = Split-Path -Parent $ResultPath
        if (-not [string]::IsNullOrWhiteSpace($resultParent)) {
            New-Item -ItemType Directory -Force -Path $resultParent | Out-Null
        }
        [IO.File]::WriteAllText($ResultPath, $Version, $utf8NoBom)
    }
    Write-SetupLog -Code $Code -Message $Message
    exit $ExitCode
}

function Assert-SafeLeaf {
    param([string]$Path, [int64]$MaximumBytes, [string]$Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label file is missing."
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $item.Length -le 0 -or $item.Length -gt $MaximumBytes) {
        throw "$Label file is unsafe."
    }
    return $item
}

function Read-InstalledPointerVersion {
    param([string]$Name, [bool]$Required = $false)
    $path = Join-Path $installRoot $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        if ($Required) { throw "Installed version pointer is missing: $Name" }
        return $null
    }
    Assert-SafeLeaf -Path $path -MaximumBytes 65536 -Label "Installed pointer $Name" | Out-Null
    $pointer = Get-Content -Raw -LiteralPath $path -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $pointer -or
        $pointer.PSObject.Properties.Name -notcontains "schemaVersion" -or
        $pointer.PSObject.Properties.Name -notcontains "version" -or
        [int]$pointer.schemaVersion -ne 1) {
        throw "Installed version pointer schema is invalid: $Name"
    }
    $value = [string]$pointer.version
    if ($value -notmatch $versionPattern) { throw "Installed version is invalid." }
    return $value
}

function Read-CurrentVersion {
    return (Read-InstalledPointerVersion -Name "current.json" -Required $false)
}

function Test-InstallLockAvailable {
    if (-not (Test-Path -LiteralPath $installRoot -PathType Container)) { return $true }
    $rootItem = Get-Item -LiteralPath $installRoot -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Install root cannot be a reparse point."
    }
    $lockPath = Join-Path $installRoot ".install.lock"
    $stream = $null
    try {
        $stream = [IO.File]::Open(
            $lockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None)
        return $true
    }
    catch [IO.IOException] {
        return $false
    }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

try {
    if ($EmbeddedVersion -notmatch $versionPattern) {
        throw "Embedded version is invalid."
    }
    $payloadItem = Get-Item -LiteralPath $PayloadRoot -Force -ErrorAction Stop
    if (-not $payloadItem.PSIsContainer -or
        ($payloadItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Embedded payload root is unsafe."
    }

    $embeddedEngine = Join-Path $payloadItem.FullName "Install-Byeollog.ps1"
    Assert-SafeLeaf -Path $embeddedEngine -MaximumBytes 4194304 -Label "Embedded install engine" | Out-Null

    $currentVersion = Read-CurrentVersion
    if ($null -ne $currentVersion -and ([version]$currentVersion -gt [version]$EmbeddedVersion)) {
        if (-not (Test-InstallLockAvailable)) {
            Exit-WithResult -ExitCode 21 -Code "install_locked" -Message "A newer installation is currently being updated." -Version $null
        }

        # A newer verified installation is never replaced by this older setup.
        # Only installer metadata and shortcuts are repaired by the NSIS layer.
        # Verify through the sealed embedded engine. Never execute a mutable
        # script from the existing installation just because its size looks
        # plausible. A future schema unknown to this old Setup fails safely.
        & $embeddedEngine -Mode Verify *> $null
        Exit-WithResult -ExitCode 10 -Code "newer_version_preserved" -Message "Newer version $currentVersion was verified; repair-only setup completed." -Version $currentVersion
    }

    if (@(Get-Process -Name "byeollog" -ErrorAction SilentlyContinue).Count -gt 0) {
        Exit-WithResult -ExitCode 20 -Code "agent_running" -Message "The running agent was not stopped by setup." -Version $null
    }
    if (-not (Test-InstallLockAvailable)) {
        Exit-WithResult -ExitCode 21 -Code "install_locked" -Message "Another install or update owns the install lock." -Version $null
    }

    # This is the same manifest/hash-verifying engine used by the sealed flat
    # package. It rejects altered or incomplete payloads before it writes the
    # fixed per-user installation root.
    & $embeddedEngine -Mode Install *> $null
    $installedVersion = Read-CurrentVersion
    if ([string]::IsNullOrWhiteSpace($installedVersion)) {
        throw "Install engine did not create a current version pointer."
    }
    if ([version]$installedVersion -lt [version]$EmbeddedVersion) {
        throw "Installed version is older than the verified payload."
    }

    # Close the only downgrade race that can exist with the immutable v32
    # install engine: an updater may have committed a newer release after our
    # initial check but before the engine acquired .install.lock. In that case
    # the engine records that newer version in previous.json before switching
    # to the embedded version. Immediately verify and roll back to it.
    if ([version]$installedVersion -eq [version]$EmbeddedVersion) {
        $previousVersion = Read-InstalledPointerVersion -Name "previous.json" -Required $false
        if ($null -ne $previousVersion -and [version]$previousVersion -gt [version]$EmbeddedVersion) {
            & $embeddedEngine -Mode Rollback *> $null
            $restoredVersion = Read-CurrentVersion
            if (-not [string]::Equals($restoredVersion, $previousVersion, [StringComparison]::Ordinal)) {
                throw "A concurrent newer version could not be restored safely."
            }
            Exit-WithResult -ExitCode 10 -Code "concurrent_newer_version_restored" -Message "Concurrent newer version $restoredVersion was restored; older payload was not selected." -Version $restoredVersion
        }
    }

    Exit-WithResult -ExitCode 0 -Code "install_ok" -Message "Installed or repaired version $installedVersion." -Version $installedVersion
}
catch {
    Write-SetupLog -Code "install_failed" -Message $_.Exception.Message
    exit 40
}
