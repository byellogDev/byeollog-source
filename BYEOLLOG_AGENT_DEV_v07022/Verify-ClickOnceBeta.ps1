[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
    [string]$PackageRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9A-Fa-f]{64}$')]
    [string]$ExpectedExeSha256,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+\.\d+$')]
    [string]$ExpectedVersion,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedDeploymentBaseUrl,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9A-Fa-f]{40}$')]
    [string]$ExpectedCertificateThumbprint,

    [switch]$ProbeHostedFiles
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedHttpsBaseUri {
    param([Parameter(Mandatory = $true)][string]$Value)

    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -cne [Uri]::UriSchemeHttps -or
        $uri.IsLoopback -or
        [string]::IsNullOrWhiteSpace($uri.Host) -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw 'ExpectedDeploymentBaseUrl must be a non-loopback HTTPS base URI without user information, query, or fragment.'
    }

    $builder = [UriBuilder]::new($uri)
    if (-not $builder.Path.EndsWith('/', [StringComparison]::Ordinal)) {
        $builder.Path += '/'
    }
    return $builder.Uri
}

function Read-SafeXml {
    param([Parameter(Mandatory = $true)][string]$Path)

    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create($Path, $settings)
    try {
        $document = [Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.Load($reader)
        return $document
    }
    finally {
        $reader.Dispose()
    }
}

function Invoke-DotNetChecked {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Description
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

function Invoke-MageVerify {
    param([Parameter(Mandatory = $true)][string]$ManifestPath)

    Invoke-DotNetChecked -Description "dotnet-mage verification for $ManifestPath" -Arguments @(
        'tool', 'run', 'dotnet-mage', '--', '-Verify', $ManifestPath
    )
}

function Assert-ManifestCertificate {
    param(
        [Parameter(Mandatory = $true)][Xml.XmlDocument]$Document,
        [Parameter(Mandatory = $true)][string]$ExpectedThumbprint,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $certificateNode = $Document.SelectSingleNode("//*[local-name()='X509Certificate']")
    if ($null -eq $certificateNode -or [string]::IsNullOrWhiteSpace($certificateNode.InnerText)) {
        throw "$Label does not contain an embedded signing certificate."
    }

    try {
        $rawCertificate = [Convert]::FromBase64String($certificateNode.InnerText.Trim())
        $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($rawCertificate)
        $actualThumbprint = $certificate.Thumbprint.Replace(' ', '').ToUpperInvariant()
    }
    catch {
        throw "$Label contains an invalid signing certificate: $($_.Exception.Message)"
    }

    if ($actualThumbprint -cne $ExpectedThumbprint) {
        throw "$Label certificate mismatch. Expected $ExpectedThumbprint, got $actualThumbprint."
    }
}

$null = Get-Command dotnet -ErrorAction Stop
$root = (Resolve-Path -LiteralPath $PackageRoot).Path
$baseUri = Get-NormalizedHttpsBaseUri -Value $ExpectedDeploymentBaseUrl
$expectedProvider = [Uri]::new($baseUri, 'byeollog.application').AbsoluteUri
$expectedHash = $ExpectedExeSha256.ToUpperInvariant()
$expectedThumbprint = $ExpectedCertificateThumbprint.ToUpperInvariant()
$versionFolderName = 'byeollog_' + $ExpectedVersion.Replace('.', '_')
$versionRoot = Join-Path (Join-Path $root 'Application Files') $versionFolderName
$approvedExe = Join-Path $versionRoot 'byeollog.exe'
$launcherExe = Join-Path $versionRoot 'Launcher.exe'
$applicationManifest = Join-Path $versionRoot 'byeollog.exe.manifest'
$deploymentManifest = Join-Path $root 'byeollog.application'
$metadataPath = Join-Path $root 'CLICKONCE_BUILD_METADATA.json'
$digestPath = Join-Path $root 'APPROVED_EXE_SHA256.txt'

foreach ($requiredFile in @(
    $approvedExe,
    $launcherExe,
    $applicationManifest,
    $deploymentManifest,
    $metadataPath,
    $digestPath
)) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "ClickOnce package is missing required file: $requiredFile"
    }
}

$forbiddenExtensions = @('.pfx', '.p12', '.pem', '.key', '.snk')
$forbiddenFiles = @(Get-ChildItem -LiteralPath $root -File -Recurse | Where-Object {
    $forbiddenExtensions -contains $_.Extension.ToLowerInvariant() -or
    $_.Name -match '(?i)(password|secret|credential)'
})
if ($forbiddenFiles.Count -ne 0) {
    throw "ClickOnce package contains forbidden secret material: $($forbiddenFiles.FullName -join ', ')"
}

$approvedExecutables = @(Get-ChildItem -LiteralPath (Join-Path $root 'Application Files') -File -Recurse |
    Where-Object { $_.Name -ceq 'byeollog.exe' })
if ($approvedExecutables.Count -ne 1 -or $approvedExecutables[0].FullName -cne $approvedExe) {
    throw 'ClickOnce package must contain exactly one approved byeollog.exe at the versioned path.'
}

$actualHash = (Get-FileHash -LiteralPath $approvedExe -Algorithm SHA256).Hash.ToUpperInvariant()
if ($actualHash -cne $expectedHash) {
    throw "Approved EXE hash mismatch. Expected $expectedHash, got $actualHash."
}

$digestText = (Get-Content -LiteralPath $digestPath -Raw).Trim()
$expectedDigestText = "$expectedHash  Application Files/$versionFolderName/byeollog.exe"
if ($digestText -cne $expectedDigestText) {
    throw 'APPROVED_EXE_SHA256.txt does not describe the approved payload exactly.'
}

$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
if ([int]$metadata.schemaVersion -ne 1 -or
    [string]$metadata.packageType -cne 'clickonce-manual-approved-exe-v1' -or
    [string]$metadata.version -cne $ExpectedVersion -or
    [string]$metadata.deploymentProvider -cne $expectedProvider -or
    [string]$metadata.certificateThumbprint -cne $expectedThumbprint -or
    [string]$metadata.approvedExe.sha256 -cne $expectedHash -or
    [int64]$metadata.approvedExe.byteSize -ne (Get-Item -LiteralPath $approvedExe).Length) {
    throw 'CLICKONCE_BUILD_METADATA.json does not match the verification parameters or payload.'
}

$toolManifest = Join-Path $PSScriptRoot '.config\dotnet-tools.json'
Invoke-DotNetChecked -Description 'dotnet tool restore' -Arguments @(
    'tool', 'restore', '--tool-manifest', $toolManifest
)
Invoke-MageVerify -ManifestPath $applicationManifest
Invoke-MageVerify -ManifestPath $deploymentManifest

$applicationXml = Read-SafeXml -Path $applicationManifest
$deploymentXml = Read-SafeXml -Path $deploymentManifest

$applicationIdentity = $applicationXml.SelectSingleNode("/*[local-name()='assembly']/*[local-name()='assemblyIdentity']")
$deploymentIdentity = $deploymentXml.SelectSingleNode("/*[local-name()='assembly']/*[local-name()='assemblyIdentity']")
if ($null -eq $applicationIdentity -or $applicationIdentity.GetAttribute('version') -cne $ExpectedVersion) {
    throw 'Application manifest identity version does not match ExpectedVersion.'
}
if ($null -eq $deploymentIdentity -or $deploymentIdentity.GetAttribute('version') -cne $ExpectedVersion) {
    throw 'Deployment manifest identity version does not match ExpectedVersion.'
}

$provider = $deploymentXml.SelectSingleNode("//*[local-name()='deploymentProvider']")
if ($null -eq $provider -or $provider.GetAttribute('codebase') -cne $expectedProvider) {
    throw "Deployment provider must be exactly $expectedProvider"
}

$applicationReference = $deploymentXml.SelectSingleNode("//*[local-name()='dependentAssembly'][@dependencyType='install']")
$expectedApplicationCodebase = "Application Files/$versionFolderName/byeollog.exe.manifest"
if ($null -eq $applicationReference) {
    throw 'Deployment manifest does not reference an installable application manifest.'
}
$actualApplicationCodebase = [Uri]::UnescapeDataString($applicationReference.GetAttribute('codebase')).Replace('\', '/')
if ($actualApplicationCodebase -cne $expectedApplicationCodebase) {
    throw "Application manifest codebase mismatch. Expected $expectedApplicationCodebase, got $actualApplicationCodebase."
}

$approvedPayloadReference = @($applicationXml.SelectNodes("//*[@codebase]") | Where-Object {
    [IO.Path]::GetFileName(([Uri]::UnescapeDataString($_.GetAttribute('codebase')).Replace('/', '\'))) -ceq 'byeollog.exe'
})
if ($approvedPayloadReference.Count -ne 1) {
    throw 'Application manifest must contain exactly one hashed reference to byeollog.exe.'
}

Assert-ManifestCertificate -Document $applicationXml -ExpectedThumbprint $expectedThumbprint -Label 'Application manifest'
Assert-ManifestCertificate -Document $deploymentXml -ExpectedThumbprint $expectedThumbprint -Label 'Deployment manifest'

if ($ProbeHostedFiles) {
    $remoteFiles = @(
        [pscustomobject]@{ Path = 'byeollog.application'; ContentType = 'application/x-ms-application'; Length = $null },
        [pscustomobject]@{ Path = "Application Files/$versionFolderName/byeollog.exe.manifest"; ContentType = 'application/x-ms-manifest'; Length = $null },
        [pscustomobject]@{ Path = "Application Files/$versionFolderName/byeollog.exe"; ContentType = 'application/octet-stream'; Length = (Get-Item -LiteralPath $approvedExe).Length }
    )
    foreach ($remoteFile in $remoteFiles) {
        $remoteUri = [Uri]::new($baseUri, $remoteFile.Path.Replace(' ', '%20'))
        $response = Invoke-WebRequest -Uri $remoteUri.AbsoluteUri -Method Head -MaximumRedirection 0 -UseBasicParsing
        if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
            throw "Hosted ClickOnce file did not return success: $($remoteUri.AbsoluteUri)"
        }
        $actualContentType = [string]$response.Headers['Content-Type']
        if (-not $actualContentType.StartsWith($remoteFile.ContentType, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Hosted ClickOnce file has the wrong content type. Expected $($remoteFile.ContentType), got $actualContentType."
        }
        if ($null -ne $remoteFile.Length) {
            $actualLength = [int64]$response.Headers['Content-Length']
            if ($actualLength -ne [int64]$remoteFile.Length) {
                throw "Hosted approved EXE length mismatch. Expected $($remoteFile.Length), got $actualLength."
            }
        }
    }
}

Write-Host "PASS: ClickOnce manifests, HTTPS provider, signer, and approved EXE hash verified."
Write-Host "Package: $root"
Write-Host "Version: $ExpectedVersion"
Write-Host "Approved EXE SHA-256: $expectedHash"
