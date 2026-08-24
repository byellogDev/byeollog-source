[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PayloadPath,

    [string]$MakeNsisPath,

    [string]$OutputPath = (Join-Path $PSScriptRoot "dist\ByeollogAgentSetup-v0.7.0.32.exe"),

    [ValidatePattern('^\d+\.\d+\.\d+\.\d+$')]
    [string]$ProductVersion = "0.7.0.32",

    [ValidatePattern('^\d+\.\d+\.\d+\.\d+$')]
    [string]$EmbeddedVersion = "0.7.0.32",

    [string]$ProductName = "별록 에이전트",

    [string]$Publisher = "별록",

    [uri]$Website = "https://byeollog.com",

    [string]$AppIconPath = (Join-Path (Split-Path -Parent $PSScriptRoot) "Assets\byeollog_app.ico"),

    [hashtable]$NsisProperties = @{},

    [string]$SignCommandPath,

    [string[]]$SignCommandArguments = @(),

    [string]$UninstallerSignCommandPath,

    [string[]]$UninstallerSignCommandArguments = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-Leaf {
    param([string]$Path, [string]$Label)
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $item = Get-Item -LiteralPath $resolved -Force
    if (-not ($item -is [IO.FileInfo]) -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $item.Length -le 0) {
        throw "$Label must be a non-empty regular file."
    }
    return $item.FullName
}

function Resolve-MakeNsis {
    param([string]$Requested)
    if (-not [string]::IsNullOrWhiteSpace($Requested)) {
        return (Resolve-Leaf -Path $Requested -Label "makensis.exe")
    }
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} "NSIS\makensis.exe")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += (Join-Path $env:ProgramFiles "NSIS\makensis.exe")
    }
    $command = Get-Command "makensis.exe" -ErrorAction SilentlyContinue
    if ($null -ne $command) { $candidates += $command.Source }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Leaf -Path $candidate -Label "makensis.exe")
        }
    }
    throw "NSIS 3 makensis.exe was not found. Install NSIS 3 or pass -MakeNsisPath."
}

function Convert-ToNsisDefineValue {
    param([object]$Value, [string]$Name)
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text) -or $text.Contains('"') -or $text.Contains("`r") -or $text.Contains("`n")) {
        throw "NSIS property $Name contains an unsupported value."
    }
    return $text
}

function Invoke-NsisCompile {
    param(
        [string]$Compiler,
        [string]$Source,
        [System.Collections.IDictionary]$Defines
    )
    $compileArguments = @("/V2", "/WX", "/INPUTCHARSET", "UTF8")
    foreach ($entry in $Defines.GetEnumerator()) {
        $value = Convert-ToNsisDefineValue -Value $entry.Value -Name $entry.Key
        $compileArguments += "/D$($entry.Key)=$value"
    }
    $compileArguments += $Source
    & $Compiler @compileArguments
    if ($LASTEXITCODE -ne 0) {
        throw "makensis.exe failed with exit code $LASTEXITCODE."
    }
}

function Invoke-ExternalSigner {
    param(
        [string]$CommandPath,
        [string[]]$Arguments,
        [string]$TargetPath,
        [string]$Label
    )
    $signer = Resolve-Leaf -Path $CommandPath -Label "$Label sign command"
    & $signer @Arguments $TargetPath
    if ($LASTEXITCODE -ne 0) {
        throw "$Label sign command failed with exit code $LASTEXITCODE."
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $TargetPath
    if ($null -eq $signature -or $signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "$Label sign command returned success but Authenticode verification is not Valid."
    }
}

$payload = (Resolve-Path -LiteralPath $PayloadPath -ErrorAction Stop).Path.TrimEnd('\', '/')
$payloadItem = Get-Item -LiteralPath $payload -Force
if (-not $payloadItem.PSIsContainer -or
    ($payloadItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "PayloadPath must be a regular directory."
}
$payloadChildren = @(Get-ChildItem -LiteralPath $payload -Force)
if ($payloadChildren.Count -eq 0 -or @($payloadChildren | Where-Object { $_.PSIsContainer }).Count -ne 0) {
    throw "The setup payload must be the exact flat package and cannot contain directories."
}
if (@($payloadChildren | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) {
    throw "The setup payload cannot contain reparse points."
}

$manifestPath = Resolve-Leaf -Path (Join-Path $payload "release-manifest.json") -Label "release-manifest.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
if ([int]$manifest.schemaVersion -ne 2 -or
    [string]$manifest.product -ne "byeollog-collector" -or
    [string]$manifest.platform -ne "win-x64" -or
    [string]$manifest.packageLayout -ne "flat_v1" -or
    [string]$manifest.version -ne $EmbeddedVersion) {
    throw "Payload manifest is not the exact requested win-x64 flat release $EmbeddedVersion."
}

$engine = Resolve-Leaf -Path (Join-Path $payload "Install-Byeollog.ps1") -Label "Install-Byeollog.ps1"
$windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
& $windowsPowerShell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File $engine -Mode VerifyPackage *> $null
$verifyExitCode = $LASTEXITCODE
if ($verifyExitCode -ne 0) {
    throw "The payload failed Install-Byeollog.ps1 -Mode VerifyPackage (exit $verifyExitCode)."
}

$nsis = Resolve-MakeNsis -Requested $MakeNsisPath
$script = Resolve-Leaf -Path (Join-Path $PSScriptRoot "ByeollogAgentSetup.nsi") -Label "NSIS setup source"
$driver = Resolve-Leaf -Path (Join-Path $PSScriptRoot "Invoke-OfficialInstall.ps1") -Label "official install driver"
$uninstallDriver = Resolve-Leaf -Path (Join-Path $PSScriptRoot "Invoke-OfficialUninstall.ps1") -Label "official uninstall driver"
$icon = Resolve-Leaf -Path $AppIconPath -Label "application icon"

$outputFull = [IO.Path]::GetFullPath($OutputPath)
$outputParent = Split-Path -Parent $outputFull
New-Item -ItemType Directory -Force -Path $outputParent | Out-Null
if (Test-Path -LiteralPath $outputFull) {
    throw "Output already exists. Remove it explicitly or choose a new -OutputPath: $outputFull"
}

$hasSetupSigner = -not [string]::IsNullOrWhiteSpace($SignCommandPath)
$hasUninstallerSigner = -not [string]::IsNullOrWhiteSpace($UninstallerSignCommandPath)
if ($hasSetupSigner -xor $hasUninstallerSigner) {
    throw "Public signing must sign both the embedded Uninstall.exe and the outer Setup.exe. Supply both sign commands or neither for a development build."
}

$estimatedKb = [Math]::Max(1, [Math]::Ceiling((($payloadChildren | Measure-Object -Property Length -Sum).Sum) / 1KB))
$defines = [ordered]@{
    PRODUCT_NAME = $ProductName
    PUBLISHER = $Publisher
    PRODUCT_VERSION = $ProductVersion
    EMBEDDED_VERSION = $EmbeddedVersion
    WEBSITE = $Website.AbsoluteUri
    ESTIMATED_SIZE_KB = [int64]$estimatedKb
    OUTPUT_FILE = $outputFull
    PAYLOAD_DIR = $payload
    INSTALL_DRIVER = $driver
    UNINSTALL_DRIVER = $uninstallDriver
    APP_ICON = $icon
}

$allowedOverrides = @("PRODUCT_NAME", "PUBLISHER", "WEBSITE")
foreach ($key in @($NsisProperties.Keys)) {
    $name = ([string]$key).ToUpperInvariant()
    if ($allowedOverrides -notcontains $name) {
        throw "Unsupported -NsisProperties key: $key. Allowed: $($allowedOverrides -join ', ')"
    }
    $defines[$name] = $NsisProperties[$key]
}

Write-Host "Building official per-user setup with NSIS 3..."
$buildTemp = Join-Path $outputParent (".byeollog-setup-build-" + [Guid]::NewGuid().ToString("N"))
$buildTempFull = [IO.Path]::GetFullPath($buildTemp)
$outputParentFull = [IO.Path]::GetFullPath($outputParent)
$outputPrefix = $outputParentFull.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $buildTempFull.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    -not ([IO.Path]::GetFileName($buildTempFull)).StartsWith(".byeollog-setup-build-", [StringComparison]::Ordinal)) {
    throw "Temporary setup build path escaped the output directory."
}

$uninstallerHash = $null
$uninstallerSignatureStatus = "NotChecked"
try {
    New-Item -ItemType Directory -Path $buildTempFull | Out-Null
    $exportSetup = Join-Path $buildTempFull "export-pass.exe"
    $exportedUninstaller = Join-Path $buildTempFull "Uninstall.exe"

    $exportDefines = [ordered]@{}
    foreach ($entry in $defines.GetEnumerator()) { $exportDefines[$entry.Key] = $entry.Value }
    $exportDefines["OUTPUT_FILE"] = $exportSetup
    $exportDefines["EXPORT_UNINSTALLER"] = "1"
    $exportDefines["EXPORTED_UNINSTALLER_PATH"] = $exportedUninstaller
    Invoke-NsisCompile -Compiler $nsis -Source $script -Defines $exportDefines
    Resolve-Leaf -Path $exportedUninstaller -Label "exported Uninstall.exe" | Out-Null

    if ($hasUninstallerSigner) {
        Invoke-ExternalSigner `
            -CommandPath $UninstallerSignCommandPath `
            -Arguments $UninstallerSignCommandArguments `
            -TargetPath $exportedUninstaller `
            -Label "Uninstaller"
    }
    $uninstallerSignatureStatus = [string](Get-AuthenticodeSignature -LiteralPath $exportedUninstaller).Status
    $uninstallerHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $exportedUninstaller).Hash.ToLowerInvariant()

    $importDefines = [ordered]@{}
    foreach ($entry in $defines.GetEnumerator()) { $importDefines[$entry.Key] = $entry.Value }
    $importDefines["OUTPUT_FILE"] = $outputFull
    $importDefines["IMPORT_UNINSTALLER"] = "1"
    $importDefines["SIGNED_UNINSTALLER_PATH"] = $exportedUninstaller
    Invoke-NsisCompile -Compiler $nsis -Source $script -Defines $importDefines
    Resolve-Leaf -Path $outputFull -Label "Setup.exe" | Out-Null

    if ($hasSetupSigner) {
        # The external signer receives the finished outer Setup.exe as its final
        # argument. Secrets and private keys remain outside this repository.
        Invoke-ExternalSigner `
            -CommandPath $SignCommandPath `
            -Arguments $SignCommandArguments `
            -TargetPath $outputFull `
            -Label "Setup"
    }
}
finally {
    if (Test-Path -LiteralPath $buildTempFull) {
        Remove-Item -LiteralPath $buildTempFull -Recurse -Force
    }
}

$setup = Get-Item -LiteralPath $outputFull
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputFull).Hash.ToLowerInvariant()
$setupSignatureStatus = [string](Get-AuthenticodeSignature -LiteralPath $outputFull).Status
$sidecar = $outputFull + ".sha256.txt"
[IO.File]::WriteAllText($sidecar, ($hash + "  " + $setup.Name + [Environment]::NewLine), (New-Object Text.UTF8Encoding($false)))

[PSCustomObject]@{
    SetupPath = $setup.FullName
    ByteSize = $setup.Length
    Sha256 = $hash
    PayloadVersion = $EmbeddedVersion
    Signed = ($setupSignatureStatus -eq "Valid" -and $uninstallerSignatureStatus -eq "Valid")
    SetupSignatureStatus = $setupSignatureStatus
    UninstallerSignatureStatus = $uninstallerSignatureStatus
    UninstallerSha256 = $uninstallerHash
    HashSidecar = $sidecar
} | Format-List
