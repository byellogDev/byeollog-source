[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackageRoot,

    [ValidateSet("Install", "VerifyPackage")]
    [string]$Mode = "Install",
    [string]$ResultPath,
    [switch]$DesktopShortcut
)

$ErrorActionPreference = "Stop"

try {
    $utilityManifest = Join-Path $PSHOME "Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1"
    if (Test-Path -LiteralPath $utilityManifest -PathType Leaf) {
        Import-Module -Name $utilityManifest -Force -ErrorAction Stop
    }
    else {
        Import-Module -Name Microsoft.PowerShell.Utility -Force -ErrorAction Stop
    }

    $installer = Join-Path $PackageRoot "Install-Byeollog.ps1"
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
        throw "Agent package installer is missing."
    }

    $effectiveMode = $Mode
    if ($Mode -eq 'Install') {
        # A maintenance setup may repair the current release, but must never
        # replace a newer installed release with its older embedded package.
        & $installer -Mode VerifyPackage
        $incoming = Get-Content -LiteralPath (Join-Path $PackageRoot 'release-manifest.json') -Raw | ConvertFrom-Json
        $pointerPath = Join-Path $env:LOCALAPPDATA 'Programs\ByeollogCollector\current.json'
        if (Test-Path -LiteralPath $pointerPath -PathType Leaf) {
            $existing = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json
            if ([string]$existing.version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Installed version is invalid.' }
            if ([version]$existing.version -gt [version]$incoming.version) { $effectiveMode = 'Verify' }
        }
    }
    & $installer -Mode $effectiveMode
    if (-not $?) {
        throw "Agent package installer returned a failure."
    }
    if ($Mode -eq 'Install') {
        $installedRoot = Join-Path $env:LOCALAPPDATA 'Programs\ByeollogCollector'
        $pointer = Get-Content -LiteralPath (Join-Path $installedRoot 'current.json') -Raw | ConvertFrom-Json
        $installedVersion = [string]$pointer.version
        if ($installedVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Installed version is invalid.' }
        $installedExe = Join-Path $installedRoot "versions\$installedVersion\byeollog.exe"
        if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) { throw 'Installed executable is missing.' }
        if ($DesktopShortcut) {
            $desktopPath = [Environment]::GetFolderPath('DesktopDirectory')
            $shortcutPath = Join-Path $desktopPath '별록 풍벽지.lnk'
            $shell = New-Object -ComObject WScript.Shell
            if (Test-Path -LiteralPath $shortcutPath) {
                $existingShortcut = $shell.CreateShortcut($shortcutPath)
                $existingTarget = [IO.Path]::GetFullPath([string]$existingShortcut.TargetPath)
                if (-not $existingTarget.StartsWith($installedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
                    $shortcutIndex = 1
                    do {
                        $shortcutPath = Join-Path $desktopPath ('별록 풍벽지 ' + $installedVersion + ' (' + $shortcutIndex + ').lnk')
                        $shortcutIndex++
                    } while (Test-Path -LiteralPath $shortcutPath)
                }
            }
            $shortcut = $shell.CreateShortcut($shortcutPath)
            $shortcut.TargetPath = $installedExe
            $shortcut.WorkingDirectory = Split-Path -Parent $installedExe
            $shortcut.IconLocation = $installedExe + ',0'
            $shortcut.Description = '별록 풍벽지 실행'
            $shortcut.Save()
        }
        if ($ResultPath) { [IO.File]::WriteAllText($ResultPath,$installedExe,[Text.Encoding]::Unicode) }
    }
}
catch {
    Write-Error $_
    exit 1
}

exit 0
