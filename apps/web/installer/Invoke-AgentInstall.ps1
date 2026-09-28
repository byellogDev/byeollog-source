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

function Initialize-AgentShellLink {
    if ('Byeollog.InstallerShellLink' -as [type]) { return }
    # Use the Unicode Shell Link interface for both filenames and target paths.
    # WScript.Shell.Save loses Korean filenames on non-Korean Windows locales.
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
namespace Byeollog {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    internal class ShellLinkObject { }
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size, IntPtr findData, uint flags);
        void GetIDList(out IntPtr value);
        void SetIDList(IntPtr value);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetHotkey(out short value);
        void SetHotkey(short value);
        void GetShowCmd(out int value);
        void SetShowCmd(int value);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int size, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string value, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string value, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string value);
    }
    public static class InstallerShellLink {
        public static void Save(string filename, string target, string description) {
            object instance = new ShellLinkObject();
            try {
                var link = (IShellLinkW)instance;
                link.SetPath(Path.GetFullPath(target));
                link.SetWorkingDirectory(Path.GetDirectoryName(Path.GetFullPath(target)));
                link.SetIconLocation(Path.GetFullPath(target), 0);
                link.SetDescription(description);
                ((IPersistFile)instance).Save(Path.GetFullPath(filename), true);
            } finally { Marshal.FinalReleaseComObject(instance); }
        }
        public static string ReadTarget(string filename) {
            object instance = new ShellLinkObject();
            try {
                ((IPersistFile)instance).Load(Path.GetFullPath(filename), 0);
                var target = new StringBuilder(32768);
                ((IShellLinkW)instance).GetPath(target, target.Capacity, IntPtr.Zero, 4);
                return target.ToString();
            } finally { Marshal.FinalReleaseComObject(instance); }
        }
    }
}
'@
}

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
            Initialize-AgentShellLink
            if (Test-Path -LiteralPath $shortcutPath) {
                $existingTarget = [IO.Path]::GetFullPath([Byeollog.InstallerShellLink]::ReadTarget($shortcutPath))
                if (-not $existingTarget.StartsWith($installedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
                    $shortcutIndex = 1
                    do {
                        $shortcutPath = Join-Path $desktopPath ('별록 풍벽지 ' + $installedVersion + ' (' + $shortcutIndex + ').lnk')
                        $shortcutIndex++
                    } while (Test-Path -LiteralPath $shortcutPath)
                }
            }
            [Byeollog.InstallerShellLink]::Save($shortcutPath, $installedExe, '별록 풍벽지 실행')
        }
        # Inno Setup LoadStringsFromFile expects UTF-8, not UTF-16LE.
        # Include a BOM so non-ASCII Windows profile paths round-trip explicitly.
        if ($ResultPath) { [IO.File]::WriteAllText($ResultPath,$installedExe,(New-Object Text.UTF8Encoding($true))) }
    }
}
catch {
    Write-Error $_
    exit 1
}

exit 0
