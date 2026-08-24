[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot,

    [Parameter(Mandatory = $true)]
    [string]$ResultPath,

    [Parameter(Mandatory = $true)]
    [string]$LogPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object Text.UTF8Encoding($false)

function Write-UninstallLog {
    param([string]$Code, [string]$Message)
    try {
        $safe = ([string]$Message -replace '[\r\n]+', ' ').Trim()
        [IO.File]::AppendAllText(
            $LogPath,
            (([DateTimeOffset]::UtcNow.ToString("O")) + " [" + $Code + "] " + $safe + [Environment]::NewLine),
            $utf8NoBom)
    }
    catch { }
}

function Exit-WithUninstallResult {
    param([int]$ExitCode, [string]$Code, [string]$Message)
    try { [IO.File]::WriteAllText($ResultPath, $Code, $utf8NoBom) } catch { }
    Write-UninstallLog -Code $Code -Message $Message
    exit $ExitCode
}

function Remove-OwnedShortcut {
    param([string]$ShortcutPath, [string]$ExpectedRoot)
    if (-not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf)) { return }
    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($ShortcutPath)
        $target = [IO.Path]::GetFullPath([string]$shortcut.TargetPath)
        $rootPrefix = [IO.Path]::GetFullPath($ExpectedRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        $launcher = Join-Path $ExpectedRoot "Byeollog-Launcher.ps1"
        $arguments = [string]$shortcut.Arguments
        if ($target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            $arguments.IndexOf($launcher, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction Stop
        }
    }
    catch {
        Write-UninstallLog -Code "shortcut_cleanup_skipped" -Message $_.Exception.Message
    }
    finally {
        if ($null -ne $shortcut -and [Runtime.InteropServices.Marshal]::IsComObject($shortcut)) {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
        }
        if ($null -ne $shell -and [Runtime.InteropServices.Marshal]::IsComObject($shell)) {
            [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
        }
    }
}

try {
    $expectedRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "Programs\ByeollogCollector"))
    $requestedRoot = [IO.Path]::GetFullPath($InstallRoot)
    if (-not [string]::Equals($expectedRoot, $requestedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove an unexpected installation root."
    }

    if (@(Get-Process -Name "byeollog" -ErrorAction SilentlyContinue).Count -gt 0) {
        Exit-WithUninstallResult -ExitCode 20 -Code "agent_running" -Message "The running Agent was not terminated."
    }
    if (-not (Test-Path -LiteralPath $expectedRoot)) {
        Exit-WithUninstallResult -ExitCode 0 -Code "already_absent" -Message "The managed program root is already absent."
    }

    $rootItem = Get-Item -LiteralPath $expectedRoot -Force
    if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "The managed program root is unsafe."
    }

    $lockPath = Join-Path $expectedRoot ".install.lock"
    $lock = $null
    $quarantine = $null
    try {
        # FileShare.Delete keeps updater read/write opens excluded while allowing
        # the entire fixed root to be atomically renamed out of its live path.
        $lock = [IO.File]::Open(
            $lockPath,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::Delete)

        if (@(Get-Process -Name "byeollog" -ErrorAction SilentlyContinue).Count -gt 0) {
            Exit-WithUninstallResult -ExitCode 20 -Code "agent_running" -Message "The Agent started before removal and was not terminated."
        }

        foreach ($entry in @(Get-ChildItem -LiteralPath $expectedRoot -Recurse -Force -ErrorAction Stop)) {
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "The managed program root contains a reparse point."
            }
        }

        $parent = [IO.Path]::GetFullPath((Split-Path -Parent $expectedRoot))
        $quarantine = Join-Path $parent (".ByeollogCollector.uninstall-" + [Guid]::NewGuid().ToString("N"))
        $quarantineFull = [IO.Path]::GetFullPath($quarantine)
        $parentPrefix = $parent.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        if (-not $quarantineFull.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            -not ([IO.Path]::GetFileName($quarantineFull)).StartsWith(".ByeollogCollector.uninstall-", [StringComparison]::Ordinal)) {
            throw "The quarantine path is unsafe."
        }

        Move-Item -LiteralPath $expectedRoot -Destination $quarantineFull -ErrorAction Stop
    }
    finally {
        if ($null -ne $lock) { $lock.Dispose() }
    }

    # The live path is now absent, so a concurrently starting updater can only
    # create a fresh managed root; it cannot be deleted with this unique path.
    if ($null -ne $quarantine -and (Test-Path -LiteralPath $quarantine)) {
        Remove-Item -LiteralPath $quarantine -Recurse -Force -ErrorAction Stop
    }
    $programs = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs"
    $desktop = [Environment]::GetFolderPath("DesktopDirectory")
    foreach ($shortcut in @(
        (Join-Path $programs "별록.lnk"),
        (Join-Path $programs "별록 최신.lnk"),
        (Join-Path $programs "별록 에이전트.lnk"),
        (Join-Path $desktop "별록.lnk"),
        (Join-Path $desktop "별록 최신.lnk"),
        (Join-Path $desktop "별록 에이전트.lnk"))) {
        Remove-OwnedShortcut -ShortcutPath $shortcut -ExpectedRoot $expectedRoot
    }
    Exit-WithUninstallResult -ExitCode 0 -Code "uninstall_ok" -Message "Managed program files removed; user data preserved."
}
catch {
    Write-UninstallLog -Code "uninstall_failed" -Message $_.Exception.Message
    exit 40
}
