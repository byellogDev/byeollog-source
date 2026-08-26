[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$ApprovedExePath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9A-Fa-f]{64}$')]
    [string]$ExpectedExeSha256,

    [Parameter(Mandatory = $true)]
    [string]$DeploymentBaseUrl,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9A-Fa-f]{40}$')]
    [string]$CertificateThumbprint,

    [Parameter(Mandatory = $true)]
    [string]$TimestampUrl,

    [ValidatePattern('^\d+\.\d+\.\d+\.\d+$')]
    [string]$Version = '0.7.0.99',

    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist\clickonce')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedHttpsBaseUri {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) {
        throw 'DeploymentBaseUrl must be an absolute URI.'
    }

    if ($uri.Scheme -cne [Uri]::UriSchemeHttps) {
        throw 'DeploymentBaseUrl must use HTTPS.'
    }

    if ($uri.IsLoopback -or [string]::IsNullOrWhiteSpace($uri.Host)) {
        throw 'DeploymentBaseUrl must identify a non-loopback host.'
    }

    if (-not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw 'DeploymentBaseUrl cannot contain user information, a query, or a fragment.'
    }

    $builder = [UriBuilder]::new($uri)
    if (-not $builder.Path.EndsWith('/', [StringComparison]::Ordinal)) {
        $builder.Path += '/'
    }

    return $builder.Uri
}

function Get-RequiredHttpsUri {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value,

        [Parameter(Mandatory = $true)]
        [string]$ParameterName
    )

    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -cne [Uri]::UriSchemeHttps -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw "$ParameterName must be an absolute HTTPS URI without user information or a fragment."
    }

    return $uri
}

function Invoke-DotNetChecked {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    Push-Location -LiteralPath $PSScriptRoot
    try {
        & dotnet @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$Description failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-Mage {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    Invoke-DotNetChecked -Description $Description -Arguments (@(
        'tool', 'run', 'dotnet-mage', '--'
    ) + $Arguments)
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'ClickOnce packaging must run on Windows.'
}

$null = Get-Command dotnet -ErrorAction Stop
$baseUri = Get-NormalizedHttpsBaseUri -Value $DeploymentBaseUrl
$timestampUri = Get-RequiredHttpsUri -Value $TimestampUrl -ParameterName 'TimestampUrl'
$providerUri = [Uri]::new($baseUri, 'byeollog.application')
$expectedHash = $ExpectedExeSha256.ToUpperInvariant()
$thumbprint = $CertificateThumbprint.ToUpperInvariant()

$sourceExe = (Resolve-Path -LiteralPath $ApprovedExePath).Path
$sourceHash = (Get-FileHash -LiteralPath $sourceExe -Algorithm SHA256).Hash.ToUpperInvariant()
if ($sourceHash -cne $expectedHash) {
    throw "Approved EXE hash mismatch before staging. Expected $expectedHash, got $sourceHash."
}

$certificatePath = "Cert:\CurrentUser\My\$thumbprint"
$certificate = Get-Item -LiteralPath $certificatePath -ErrorAction SilentlyContinue
if ($null -eq $certificate -or -not $certificate.HasPrivateKey) {
    throw "A signing certificate with a private key was not found at $certificatePath."
}

if ($certificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or
    $certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow) {
    throw 'The manifest signing certificate is not currently valid.'
}

$codeSigningOid = '1.3.6.1.5.5.7.3.3'
$ekuExtension = @($certificate.Extensions | Where-Object {
    $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]
}) | Select-Object -First 1
if ($null -ne $ekuExtension -and
    -not @($ekuExtension.EnhancedKeyUsages | ForEach-Object { $_.Value }).Contains($codeSigningOid)) {
    throw 'The manifest signing certificate does not permit code signing.'
}

$toolManifest = Join-Path $PSScriptRoot '.config\dotnet-tools.json'
if (-not (Test-Path -LiteralPath $toolManifest -PathType Leaf)) {
    throw "Pinned tool manifest is missing: $toolManifest"
}

$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
if ($outputRoot.TrimEnd('\') -ceq $sourceRoot.TrimEnd('\')) {
    throw 'OutputDirectory cannot be the source root.'
}

$finalRoot = Join-Path $outputRoot "ByeollogClickOnce-$Version"
if (Test-Path -LiteralPath $finalRoot) {
    throw "The immutable output already exists: $finalRoot"
}

$stagingRoot = Join-Path $outputRoot ('.clickonce-staging-' + [Guid]::NewGuid().ToString('N'))
$versionFolderName = 'byeollog_' + $Version.Replace('.', '_')
$applicationFilesRoot = Join-Path $stagingRoot 'Application Files'
$versionRoot = Join-Path $applicationFilesRoot $versionFolderName
$stagedExe = Join-Path $versionRoot 'byeollog.exe'
$applicationManifest = Join-Path $versionRoot 'byeollog.exe.manifest'
$deploymentManifest = Join-Path $stagingRoot 'byeollog.application'
$applicationManifestRelative = "Application Files/$versionFolderName/byeollog.exe.manifest"
$metadataPath = Join-Path $stagingRoot 'CLICKONCE_BUILD_METADATA.json'
$digestPath = Join-Path $stagingRoot 'APPROVED_EXE_SHA256.txt'
$completed = $false

try {
    $null = New-Item -ItemType Directory -Path $versionRoot -Force
    Copy-Item -LiteralPath $sourceExe -Destination $stagedExe

    $copiedHash = (Get-FileHash -LiteralPath $stagedExe -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($copiedHash -cne $expectedHash) {
        throw "Approved EXE hash mismatch after copy. Expected $expectedHash, got $copiedHash."
    }

    Invoke-DotNetChecked -Description 'dotnet tool restore' -Arguments @(
        'tool', 'restore', '--tool-manifest', $toolManifest
    )

    # Modern .NET ClickOnce needs a separate Launcher.exe. This operation must not alter byeollog.exe.
    Invoke-Mage -Description 'ClickOnce launcher generation' -Arguments @(
        '-AddLauncher', 'byeollog.exe',
        '-TargetDirectory', $versionRoot
    )

    $postLauncherHash = (Get-FileHash -LiteralPath $stagedExe -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($postLauncherHash -cne $expectedHash) {
        throw "dotnet-mage changed the approved EXE while adding the launcher. Expected $expectedHash, got $postLauncherHash."
    }

    Invoke-Mage -Description 'ClickOnce application manifest generation' -Arguments @(
        '-New', 'Application',
        '-ToFile', $applicationManifest,
        '-Name', '별록 에이전트',
        '-FromDirectory', $versionRoot,
        '-Version', $Version,
        '-Processor', 'amd64',
        '-TrustLevel', 'FullTrust',
        '-Algorithm', 'sha256RSA'
    )

    Invoke-Mage -Description 'ClickOnce application manifest signing' -Arguments @(
        '-Sign', $applicationManifest,
        '-CertHash', $thumbprint,
        '-TimestampUri', $timestampUri.AbsoluteUri,
        '-Algorithm', 'sha256RSA'
    )

    Invoke-Mage -Description 'ClickOnce deployment manifest generation' -Arguments @(
        '-New', 'Deployment',
        '-ToFile', $deploymentManifest,
        '-Name', '별록 에이전트',
        '-Publisher', '별록',
        '-Version', $Version,
        '-Processor', 'amd64',
        '-Install', 'true',
        '-AppManifest', $applicationManifest,
        '-AppCodeBase', $applicationManifestRelative,
        '-ProviderURL', $providerUri.AbsoluteUri,
        '-IncludeProviderURL', 'true',
        '-Algorithm', 'sha256RSA'
    )

    Invoke-Mage -Description 'ClickOnce deployment manifest signing' -Arguments @(
        '-Sign', $deploymentManifest,
        '-CertHash', $thumbprint,
        '-TimestampUri', $timestampUri.AbsoluteUri,
        '-Algorithm', 'sha256RSA'
    )

    $finalHash = (Get-FileHash -LiteralPath $stagedExe -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($finalHash -cne $expectedHash) {
        throw "Approved EXE hash mismatch after manifest generation. Expected $expectedHash, got $finalHash."
    }

    $metadata = [ordered]@{
        schemaVersion = 1
        packageType = 'clickonce-manual-approved-exe-v1'
        product = 'byeollog-collector'
        version = $Version
        deploymentManifest = 'byeollog.application'
        deploymentProvider = $providerUri.AbsoluteUri
        applicationManifest = $applicationManifestRelative
        certificateThumbprint = $thumbprint
        approvedExe = [ordered]@{
            relativePath = "Application Files/$versionFolderName/byeollog.exe"
            sha256 = $expectedHash
            byteSize = (Get-Item -LiteralPath $stagedExe).Length
        }
        createdUtc = [DateTime]::UtcNow.ToString('O')
    }
    $metadata | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $metadataPath -Encoding UTF8
    "$expectedHash  Application Files/$versionFolderName/byeollog.exe" |
        Set-Content -LiteralPath $digestPath -Encoding ASCII

    & (Join-Path $PSScriptRoot 'Verify-ClickOnceBeta.ps1') `
        -PackageRoot $stagingRoot `
        -ExpectedExeSha256 $expectedHash `
        -ExpectedVersion $Version `
        -ExpectedDeploymentBaseUrl $baseUri.AbsoluteUri `
        -ExpectedCertificateThumbprint $thumbprint
    if ($LASTEXITCODE -ne 0) {
        throw "ClickOnce verification failed with exit code $LASTEXITCODE."
    }

    Move-Item -LiteralPath $stagingRoot -Destination $finalRoot
    $completed = $true
    Write-Host "ClickOnce package created: $finalRoot"
    Write-Host "Approved EXE SHA-256 preserved: $expectedHash"
    Write-Host "Deployment provider: $($providerUri.AbsoluteUri)"
}
finally {
    if (-not $completed -and (Test-Path -LiteralPath $stagingRoot)) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
