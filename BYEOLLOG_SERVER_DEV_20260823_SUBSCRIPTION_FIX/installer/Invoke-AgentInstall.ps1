[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackageRoot,

    [ValidateSet("Install", "VerifyPackage")]
    [string]$Mode = "Install"
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

    & $installer -Mode $Mode
    if (-not $?) {
        throw "Agent package installer returned a failure."
    }
}
catch {
    Write-Error $_
    exit 1
}

exit 0

