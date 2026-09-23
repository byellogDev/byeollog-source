[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackagePath,
    [Parameter(Mandatory = $true)][string]$PackageUrl,
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$DisplayVersion,
    [Parameter(Mandatory = $true)][long]$ReleaseSequence,
    [ValidateSet('Primary', 'Recovery')][string]$SigningRole = 'Primary',
    [string]$TrustAnchorsPath = '',
    [Parameter(Mandatory = $true)][string]$BackupManifestPath,
    [string]$CertificatePfxPath = '',
    [string]$PasswordDpapiPath = '',
    [string]$PasswordRecoveryFile = '',
    [string]$CertificateThumbprint = '',
    [switch]$AllowRecoverySigning,
    [string]$Summary = "별록 에이전트 안정화 업데이트",
    [DateTimeOffset]$PublishedAtUtc = [DateTimeOffset]::UtcNow,
    [DateTimeOffset]$ExpiresAtUtc = [DateTimeOffset]::UtcNow.AddDays(180)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "Update version is invalid." }
if ($DisplayVersion.Length -le 0 -or $DisplayVersion.Length -gt 96) { throw "Display version is invalid." }
if ($ReleaseSequence -le 0 -or $ReleaseSequence -gt 9999999999) { throw "Release sequence is invalid." }
if ($Summary.Length -gt 512) { throw "Release summary is too long." }
if ($PublishedAtUtc -eq [DateTimeOffset]::MinValue -or
    $ExpiresAtUtc -le $PublishedAtUtc -or
    ($ExpiresAtUtc - $PublishedAtUtc).TotalDays -gt 370) {
    throw "Catalog validity window is invalid."
}

$package = [IO.Path]::GetFullPath($PackagePath)
$output = [IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath $package -PathType Leaf)) { throw "Update package is missing." }
$packageItem = Get-Item -LiteralPath $package -Force
if (($packageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    $packageItem.Length -le 0 -or $packageItem.Length -gt 268435456) {
    throw "Update package file is unsafe or too large."
}
if (Test-Path -LiteralPath $output) { throw "immutable-output-conflict: update catalog already exists." }

$uri = $null
if (-not [Uri]::TryCreate($PackageUrl, [UriKind]::Absolute, [ref]$uri) -or
    $uri.Scheme -ne 'https' -or
    $uri.IdnHost -ne 'byeollog.com' -or
    -not $uri.IsDefaultPort -or
    -not [string]::IsNullOrEmpty($uri.UserInfo) -or
    -not [string]::IsNullOrEmpty($uri.Query) -or
    -not [string]::IsNullOrEmpty($uri.Fragment) -or
    -not $uri.AbsolutePath.StartsWith('/agent-updates/releases/', [StringComparison]::Ordinal) -or
    -not $uri.AbsolutePath.EndsWith('.zip', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Update package URL is outside the fixed Byeollog release origin."
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
& (Join-Path $PSScriptRoot 'Test-AgentPackagePreflight.ps1') -PackagePath $package -Version $Version | Out-Null
$archive = [IO.Compression.ZipFile]::OpenRead($package)
try {
    $manifestEntries = @($archive.Entries | Where-Object { $_.FullName -eq 'release-manifest.json' })
    if ($manifestEntries.Count -ne 1 -or $manifestEntries[0].Length -le 0 -or $manifestEntries[0].Length -gt 4194304) {
        throw "Update package must contain one bounded release-manifest.json."
    }
    $manifestStream = $manifestEntries[0].Open()
    try {
        $memory = New-Object IO.MemoryStream
        try {
            $manifestStream.CopyTo($memory)
            $manifestBytes = $memory.ToArray()
        }
        finally { $memory.Dispose() }
    }
    finally { $manifestStream.Dispose() }
}
finally { $archive.Dispose() }

$manifest = $utf8NoBom.GetString($manifestBytes) | ConvertFrom-Json
if ([int]$manifest.schemaVersion -ne 2 -or
    [string]$manifest.product -ne 'byeollog-collector' -or
    [string]$manifest.platform -ne 'win-x64' -or
    [string]$manifest.version -ne $Version -or
    [string]$manifest.packageLayout -ne 'flat_v1' -or
    [int]$manifest.fileCount -ne @($manifest.files).Count -or
    [string]$manifest.authenticity.mode -ne 'trusted_channel_internal' -or
    [string]$manifest.authenticity.scope -ne 'package_integrity_only' -or
    $null -ne $manifest.authenticity.signerThumbprint) {
    throw "Inner release manifest does not match the requested update."
}

$anchorsFile = if ([string]::IsNullOrWhiteSpace($TrustAnchorsPath)) {
    Join-Path $PSScriptRoot 'Signing\update-trust-anchors.public.json'
} else {
    [IO.Path]::GetFullPath($TrustAnchorsPath)
}
if (-not (Test-Path -LiteralPath $anchorsFile -PathType Leaf)) {
    throw 'The public update trust anchors are missing.'
}
$anchors = Get-Content -LiteralPath $anchorsFile -Raw | ConvertFrom-Json
$roleName = $SigningRole.ToLowerInvariant()
$selectedAnchors = @($anchors.keys | Where-Object { [string]$_.role -ceq $roleName })
if ([int]$anchors.schemaVersion -ne 1 -or $selectedAnchors.Count -ne 1) {
    throw 'The requested update signing role is not uniquely pinned.'
}
$selectedAnchor = $selectedAnchors[0]
if ($SigningRole -eq 'Recovery' -and -not $AllowRecoverySigning.IsPresent) {
    throw 'Recovery signing requires the explicit -AllowRecoverySigning switch.'
}

$backupManifestFile = [IO.Path]::GetFullPath($BackupManifestPath)
if (-not (Test-Path -LiteralPath $backupManifestFile -PathType Leaf)) {
    throw 'The update signing backup manifest is missing.'
}
$backupManifest = Get-Content -LiteralPath $backupManifestFile -Raw | ConvertFrom-Json
$backupDirectory = Split-Path -Parent $backupManifestFile
$backupAnchorsPath = Join-Path $backupDirectory 'update-trust-anchors.json'
$backupPrimaryPfx = Join-Path $backupDirectory 'byeollog-update-primary-2026.pfx'
$backupRecoveryPfx = Join-Path $backupDirectory 'byeollog-update-recovery-2026.pfx'
foreach ($path in @($backupAnchorsPath, $backupPrimaryPfx, $backupRecoveryPfx)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "The update signing recovery set is incomplete: $path"
    }
}
$sourcePrimaryAnchor = @($anchors.keys | Where-Object role -eq 'primary')
$sourceRecoveryAnchor = @($anchors.keys | Where-Object role -eq 'recovery')
if ($sourcePrimaryAnchor.Count -ne 1 -or $sourceRecoveryAnchor.Count -ne 1) {
    throw 'The source trust set must contain one primary and one recovery key.'
}
if ([int]$backupManifest.schemaVersion -ne 1 -or
    [string]$backupManifest.primaryKeyId -cne [string]$sourcePrimaryAnchor[0].keyId -or
    [string]$backupManifest.recoveryKeyId -cne [string]$sourceRecoveryAnchor[0].keyId -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $backupAnchorsPath).Hash.ToLowerInvariant() -cne [string]$backupManifest.publicAnchorsSha256 -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $backupPrimaryPfx).Hash.ToLowerInvariant() -cne [string]$backupManifest.primaryPfxSha256 -or
    (Get-FileHash -Algorithm SHA256 -LiteralPath $backupRecoveryPfx).Hash.ToLowerInvariant() -cne [string]$backupManifest.recoveryPfxSha256) {
    throw 'The update signing recovery set failed its sealed backup manifest.'
}
$backupAnchors = Get-Content -LiteralPath $backupAnchorsPath -Raw | ConvertFrom-Json
foreach ($role in @('primary', 'recovery')) {
    $sourceEntry = @($anchors.keys | Where-Object role -eq $role)
    $backupEntry = @($backupAnchors.keys | Where-Object role -eq $role)
    if ($sourceEntry.Count -ne 1 -or $backupEntry.Count -ne 1 -or
        [string]$sourceEntry[0].keyId -cne [string]$backupEntry[0].keyId -or
        [string]$sourceEntry[0].modulusBase64 -cne [string]$backupEntry[0].modulusBase64 -or
        [string]$sourceEntry[0].exponentBase64 -cne [string]$backupEntry[0].exponentBase64) {
        throw "Source and backup public trust anchors differ for $role."
    }
}

$certificate = $null
$certificatePassword = $null
$disposeCertificate = $false
if (-not [string]::IsNullOrWhiteSpace($CertificatePfxPath)) {
    $pfxPath = [IO.Path]::GetFullPath($CertificatePfxPath)
    $sourcePrefix = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($pfxPath.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Private update signing material must remain outside the source tree.'
    }
    if (-not (Test-Path -LiteralPath $pfxPath -PathType Leaf)) { throw 'Update signing PFX is missing.' }
    $pfxItem = Get-Item -LiteralPath $pfxPath -Force
    if (($pfxItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Update signing PFX cannot be a reparse point.'
    }
    $selectedPfxHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $pfxPath).Hash.ToLowerInvariant()
    if (($SigningRole -eq 'Primary' -and $selectedPfxHash -cne [string]$backupManifest.operationalPrimaryPfxSha256) -or
        ($SigningRole -eq 'Recovery' -and $selectedPfxHash -cne [string]$backupManifest.recoveryPfxSha256)) {
        throw 'Selected signing PFX is not sealed by the recovery manifest.'
    }
    if ($SigningRole -eq 'Primary') {
        $dpapiPath = [IO.Path]::GetFullPath($PasswordDpapiPath)
        if (-not (Test-Path -LiteralPath $dpapiPath -PathType Leaf)) {
            throw 'The DPAPI-protected primary PFX password is missing.'
        }
        $certificatePassword = $utf8NoBom.GetString(
            [Security.Cryptography.ProtectedData]::Unprotect(
                [IO.File]::ReadAllBytes($dpapiPath),
                $utf8NoBom.GetBytes('byeollog-update-signing-primary-v2'),
                [Security.Cryptography.DataProtectionScope]::CurrentUser))
    } else {
        $passwordPath = [IO.Path]::GetFullPath($PasswordRecoveryFile)
        if (-not (Test-Path -LiteralPath $passwordPath -PathType Leaf)) {
            throw 'The recovery password file is missing.'
        }
        $passwordText = [IO.File]::ReadAllText($passwordPath, $utf8NoBom)
        $passwordMatch = [regex]::Match($passwordText, '(?m)^Recovery PFX password: (?<value>\S+)$')
        if (-not $passwordMatch.Success) { throw 'The recovery password file is malformed.' }
        $certificatePassword = $passwordMatch.Groups['value'].Value
        $passwordText = $null
    }
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
        $pfxPath,
        $certificatePassword,
        [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
    $disposeCertificate = $true
} else {
    $thumbprint = ($CertificateThumbprint -replace '\s', '').ToUpperInvariant()
    if ($thumbprint -notmatch '^[0-9A-F]{40}$') { throw 'Certificate thumbprint is invalid.' }
    $certificates = @(Get-ChildItem -Path Cert:\CurrentUser\My | Where-Object {
        $_.Thumbprint -eq $thumbprint -and $_.HasPrivateKey
    })
    if ($certificates.Count -ne 1) {
        throw 'Exactly one update signing certificate with a private key is required.'
    }
    $certificate = $certificates[0]
}
if (-not $certificate.HasPrivateKey -or $certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow) {
    throw 'The update signing certificate is missing a current private key.'
}
if ($certificate.Subject -cne [string]$selectedAnchor.subject -or
    $certificate.Thumbprint -cne [string]$selectedAnchor.thumbprint) {
    throw 'Update signing certificate identity does not match the selected trust anchor.'
}

# A matching subject is not enough: a different certificate with the same
# subject would produce a catalog that every released Agent rejects.  Bind the
# signer to the exact RSA public key pinned in AgentUpdateCore.cs before the
# private key is ever used.
$expectedKeyId = [string]$selectedAnchor.keyId
$expectedModulus = [string]$selectedAnchor.modulusBase64
$expectedExponent = [string]$selectedAnchor.exponentBase64
$publicRsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
if ($null -eq $publicRsa -or $publicRsa.KeySize -lt 3072) {
    if ($null -ne $publicRsa) { $publicRsa.Dispose() }
    throw "Update signing certificate must contain the pinned RSA-3072 public key."
}
try {
    $parameters = $publicRsa.ExportParameters($false)
    $actualModulus = [Convert]::ToBase64String($parameters.Modulus)
    $actualExponent = [Convert]::ToBase64String($parameters.Exponent)
    $fingerprintInput = New-Object byte[] ($parameters.Modulus.Length + $parameters.Exponent.Length)
    [Array]::Copy($parameters.Modulus, 0, $fingerprintInput, 0, $parameters.Modulus.Length)
    [Array]::Copy($parameters.Exponent, 0, $fingerprintInput, $parameters.Modulus.Length, $parameters.Exponent.Length)
    $fingerprint = ([BitConverter]::ToString(
        [Security.Cryptography.SHA256]::Create().ComputeHash($fingerprintInput)
    )).Replace('-', '').ToLowerInvariant()
    $actualKeyId = 'rsa3072-' + $fingerprint.Substring(0, 16)
    if ($actualModulus -cne $expectedModulus -or
        $actualExponent -cne $expectedExponent -or
        $actualKeyId -cne $expectedKeyId) {
        throw "Update signing certificate does not match the public key pinned in the Agent."
    }
}
finally { $publicRsa.Dispose() }

$packageSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $package).Hash.ToLowerInvariant()
$manifestSha256 = ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($manifestBytes))).Replace('-', '').ToLowerInvariant()
$payload = [ordered]@{
    schemaVersion = 1
    product = 'byeollog-collector'
    channel = 'stable'
    platform = 'win-x64'
    releaseSequence = $ReleaseSequence
    version = $Version
    displayVersion = $DisplayVersion
    publishedAtUtc = $PublishedAtUtc.ToUniversalTime().ToString('O')
    expiresAtUtc = $ExpiresAtUtc.ToUniversalTime().ToString('O')
    minimumUpdaterProtocol = 1
    mandatory = $false
    package = [ordered]@{
        url = $uri.AbsoluteUri
        byteSize = [int64]$packageItem.Length
        sha256 = $packageSha256
        innerManifestSha256 = $manifestSha256
    }
    summary = $Summary
}
$payloadBytes = $utf8NoBom.GetBytes(($payload | ConvertTo-Json -Depth 10 -Compress))
$rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
if ($null -eq $rsa -or $rsa.KeySize -lt 3072) { throw "Update signing key must be RSA-3072 or stronger." }
try {
    $signatureBytes = $rsa.SignData(
        $payloadBytes,
        [Security.Cryptography.HashAlgorithmName]::SHA256,
        [Security.Cryptography.RSASignaturePadding]::Pss)
    $publicRsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
    try {
        if (-not $publicRsa.VerifyData(
            $payloadBytes,
            $signatureBytes,
            [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.RSASignaturePadding]::Pss)) {
            throw "Update signature self-verification failed."
        }
    }
    finally { if ($null -ne $publicRsa) { $publicRsa.Dispose() } }
}
finally { $rsa.Dispose() }

$envelope = [ordered]@{
    schemaVersion = 1
    payload = [Convert]::ToBase64String($payloadBytes)
    signature = [ordered]@{
        algorithm = 'rsa-pss-sha256'
        keyId = $expectedKeyId
        value = [Convert]::ToBase64String($signatureBytes)
    }
}
$outputDirectory = Split-Path -Parent $output
if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
}
$envelopeText = $envelope | ConvertTo-Json -Depth 10
$envelopeBytes = $utf8NoBom.GetBytes($envelopeText)
$temporaryOutput = Join-Path $outputDirectory ('.agent-update-catalog-' + [Guid]::NewGuid().ToString('N') + '.tmp')
try {
    $outputStream = New-Object IO.FileStream(
        $temporaryOutput,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None,
        4096,
        [IO.FileOptions]::WriteThrough)
    try {
        $outputStream.Write($envelopeBytes, 0, $envelopeBytes.Length)
        $outputStream.Flush($true)
    }
    finally { $outputStream.Dispose() }
    $writtenBytes = [IO.File]::ReadAllBytes($temporaryOutput)
    $expectedOutputHash = ([BitConverter]::ToString(
        [Security.Cryptography.SHA256]::Create().ComputeHash($envelopeBytes)
    )).Replace('-', '')
    $writtenOutputHash = ([BitConverter]::ToString(
        [Security.Cryptography.SHA256]::Create().ComputeHash($writtenBytes)
    )).Replace('-', '')
    if ($writtenBytes.Length -ne $envelopeBytes.Length -or
        $writtenOutputHash -cne $expectedOutputHash) {
        throw "Written update catalog failed its byte-for-byte self-check."
    }
    $writtenEnvelope = $utf8NoBom.GetString($writtenBytes) | ConvertFrom-Json
    if ([int]$writtenEnvelope.schemaVersion -ne 1 -or
        [string]$writtenEnvelope.signature.keyId -cne $expectedKeyId -or
        [string]$writtenEnvelope.signature.value -cne [Convert]::ToBase64String($signatureBytes)) {
        throw "Written update catalog failed its structure self-check."
    }
    Move-Item -LiteralPath $temporaryOutput -Destination $output
}
finally {
    if (Test-Path -LiteralPath $temporaryOutput) { Remove-Item -LiteralPath $temporaryOutput -Force }
}
Write-Host "Signed Agent update catalog created: $output"
Write-Host "Version: $Version / sequence: $ReleaseSequence / package SHA-256: $packageSha256"
if ($disposeCertificate -and $null -ne $certificate) { $certificate.Dispose() }
$certificatePassword = $null
