[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("ArtifactSigning", "CertificateStore")]
    [string]$Provider,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]]$TargetPath,

    [ValidateSet("Required", "Development")]
    [string]$Policy = "Required",

    [ValidateSet("Production", "Development")]
    [string]$ReleaseChannel = "Production",

    [string]$ReleaseVersion = "",

    [string]$ExpectedPublisher = "",

    [string]$SignToolPath = "",

    [string]$ExpectedSignToolSha256 = "",

    [string]$ArtifactSigningDlibPath = "",

    [string]$ExpectedArtifactSigningDlibSha256 = "",

    [string]$ArtifactSigningMetadataPath = "",

    [string]$ArtifactSigningEndpoint = "",

    [string]$ArtifactSigningAccountName = "",

    [string]$ArtifactSigningCertificateProfileName = "",

    [string]$CertificateThumbprint = "",

    [ValidateSet("CurrentUser", "LocalMachine")]
    [string]$CertificateStoreLocation = "CurrentUser",

    [ValidatePattern('^[A-Za-z0-9]+$')]
    [string]$CertificateStoreName = "My",

    [string[]]$ApprovedPublicRootThumbprint = @(),

    [string]$AuditReportPath = "",

    [switch]$SkipSigning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Artifact Signing documents this RFC 3161 endpoint for public Authenticode
# releases. Keeping it fixed prevents a release command from silently drifting
# to an unreviewed timestamp authority or to an Authenticode v1 timestamp.
$script:RequiredTimestampServer = "http://timestamp.acs.microsoft.com/"
$script:CodeSigningEkuOid = "1.3.6.1.5.5.7.3.3"
$script:ArtifactPublicTrustEkuOid = "1.3.6.1.4.1.311.97.1.0"
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Get-RegularFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    $item = Get-Item -LiteralPath $resolved.Path -Force
    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw "$Label must be a regular, non-reparse-point file."
    }
    if ($item.Length -le 0) {
        throw "$Label cannot be empty."
    }
    return $item
}

function Get-ReleaseTarget {
    param([Parameter(Mandatory = $true)][string]$Path)

    $item = Get-RegularFile -Path $Path -Label "Signing target"
    $allowedExtensions = @(".exe", ".dll", ".msi", ".msix", ".msixbundle")
    if ($allowedExtensions -notcontains $item.Extension.ToLowerInvariant()) {
        throw "Signing target has an unsupported release extension: $($item.Extension)"
    }
    return $item
}

function Get-Sha256Lower {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $algorithm.ComputeHash($stream)
        return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Assert-ExpectedPublisher {
    param(
        [Parameter(Mandatory = $true)][Security.Cryptography.X509Certificates.X509Certificate2]$Certificate,
        [Parameter(Mandatory = $true)][string]$Expected
    )

    # Full X.500 Subject equality is intentional. A CN/display-name comparison
    # is not unique enough for a production publisher identity.
    if (-not [string]::Equals($Certificate.Subject.Trim(), $Expected.Trim(), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Authenticode signer full Subject does not match ExpectedPublisher."
    }
}

function Assert-CodeSigningEku {
    param([Parameter(Mandatory = $true)][Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)

    $ekuValues = @($Certificate.EnhancedKeyUsageList | ForEach-Object { [string]$_.ObjectId.Value })
    if ($ekuValues -notcontains $script:CodeSigningEkuOid) {
        throw "Signer certificate does not contain the Code Signing EKU."
    }
}

function Assert-ArtifactPublicTrustEku {
    param([Parameter(Mandatory = $true)][Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)

    $ekuValues = @($Certificate.EnhancedKeyUsageList | ForEach-Object { [string]$_.ObjectId.Value })
    if ($ekuValues -notcontains $script:ArtifactPublicTrustEkuOid) {
        throw "Artifact Signing certificate is not a Public Trust certificate."
    }
}

function Get-NormalizedRootAllowlist {
    param([string[]]$Thumbprints)

    $normalized = @()
    foreach ($value in @($Thumbprints)) {
        $thumbprint = ([string]$value -replace '\s', '').ToUpperInvariant()
        if ($thumbprint -notmatch '^[0-9A-F]{40}$') {
            throw "ApprovedPublicRootThumbprint contains an invalid SHA-1 certificate thumbprint."
        }
        if ($normalized -notcontains $thumbprint) {
            $normalized += $thumbprint
        }
    }
    if ($normalized.Count -eq 0) {
        throw "At least one approved public code-signing root thumbprint is required."
    }
    return $normalized
}

function Assert-WindowsTrustedCodeSigningChain {
    param(
        [Parameter(Mandatory = $true)][Security.Cryptography.X509Certificates.X509Certificate2]$Certificate,
        [Parameter(Mandatory = $true)][string[]]$ApprovedRootThumbprints
    )

    if ([string]::Equals($Certificate.Subject, $Certificate.Issuer, [StringComparison]::OrdinalIgnoreCase)) {
        throw "A self-signed certificate cannot be used for a public release."
    }

    $chain = New-Object Security.Cryptography.X509Certificates.X509Chain
    try {
        $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Online
        $chain.ChainPolicy.RevocationFlag = [Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot
        $chain.ChainPolicy.VerificationFlags = [Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
        $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(30)
        $chain.ChainPolicy.ApplicationPolicy.Add((New-Object Security.Cryptography.Oid($script:CodeSigningEkuOid)))
        if (-not $chain.Build($Certificate)) {
            $status = @($chain.ChainStatus | ForEach-Object { [string]$_.Status }) -join ","
            throw "Signer certificate does not build to a Windows-trusted code-signing chain: $status"
        }
        if ($chain.ChainElements.Count -lt 2) {
            throw "Signer certificate does not have a public trust chain."
        }
        $root = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
        if ([string]::Equals($root.Thumbprint, $Certificate.Thumbprint, [StringComparison]::OrdinalIgnoreCase)) {
            throw "The leaf signer cannot also be the trust root."
        }
        $rootThumbprint = ([string]$root.Thumbprint -replace '\s', '').ToUpperInvariant()
        if ($ApprovedRootThumbprints -notcontains $rootThumbprint) {
            throw "Signer chain root is not in ApprovedPublicRootThumbprint."
        }
        return $rootThumbprint
    }
    finally {
        $chain.Dispose()
    }
}

function Assert-ExpectedFileHash {
    param(
        [Parameter(Mandatory = $true)][IO.FileInfo]$File,
        [Parameter(Mandatory = $true)][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $normalized = ($ExpectedSha256 -replace '\s', '').ToLowerInvariant()
    if ($normalized -notmatch '^[0-9a-f]{64}$') {
        throw "$Label approved SHA-256 is required and invalid."
    }
    $actual = Get-Sha256Lower -Path $File.FullName
    if (-not [string]::Equals($actual, $normalized, [StringComparison]::Ordinal)) {
        throw "$Label SHA-256 does not match the approved tool hash."
    }
}

function Get-PeMachine {
    param(
        [Parameter(Mandatory = $true)][IO.FileInfo]$File,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $stream = [IO.File]::Open($File.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw "$Label is not a PE file." }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0x40 -or $peOffset -gt ($stream.Length - 6)) { throw "$Label PE header is invalid." }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw "$Label PE signature is invalid." }
        return $reader.ReadUInt16()
    }
    finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Assert-MatchingArtifactArchitecture {
    param(
        [Parameter(Mandatory = $true)][IO.FileInfo]$SignTool,
        [Parameter(Mandatory = $true)][IO.FileInfo]$Dlib
    )

    $signToolMachine = Get-PeMachine -File $SignTool -Label "SignTool"
    $dlibMachine = Get-PeMachine -File $Dlib -Label "Artifact Signing dlib"
    if ($signToolMachine -ne $dlibMachine) {
        throw "SignTool and Artifact Signing dlib architectures do not match."
    }
}

function Assert-MicrosoftSignedTool {
    param(
        [Parameter(Mandatory = $true)][IO.FileInfo]$File,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) {
        throw "$Label is not an Authenticode-valid Microsoft binary."
    }
    $subject = [string]$signature.SignerCertificate.Subject
    if ($subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
        throw "$Label publisher is not Microsoft Corporation."
    }
}

function Resolve-OfficialSignTool {
    param(
        [string]$RequestedPath,
        [switch]$RequireArtifactSigningMinimum
    )

    if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        $candidate = Get-RegularFile -Path $RequestedPath -Label "SignTool"
    }
    else {
        $candidate = $null
        $command = Get-Command "signtool.exe" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $command) {
            $candidate = Get-RegularFile -Path $command.Source -Label "SignTool"
        }
        if ($null -eq $candidate) {
            $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
            $sdkBin = Join-Path $programFilesX86 "Windows Kits\10\bin"
            if (Test-Path -LiteralPath $sdkBin -PathType Container) {
                foreach ($versionFolder in @(Get-ChildItem -LiteralPath $sdkBin -Directory -Force | Sort-Object Name -Descending)) {
                    $path = Join-Path $versionFolder.FullName "x64\signtool.exe"
                    if (Test-Path -LiteralPath $path -PathType Leaf) {
                        $candidate = Get-RegularFile -Path $path -Label "SignTool"
                        break
                    }
                }
            }
        }
    }

    if ($null -eq $candidate) {
        throw "Official Windows SDK SignTool was not found."
    }
    if (-not [string]::Equals($candidate.Name, "signtool.exe", [StringComparison]::OrdinalIgnoreCase)) {
        throw "The selected signing tool is not signtool.exe."
    }
    Assert-MicrosoftSignedTool -File $candidate -Label "SignTool"
    if ($RequireArtifactSigningMinimum) {
        $versionText = [string]$candidate.VersionInfo.FileVersion
        if ($versionText -notmatch '(?<version>\d+\.\d+\.\d+\.\d+)') {
            throw "SignTool file version could not be verified for Artifact Signing."
        }
        $minimum = [version]"10.0.2261.755"
        $actual = [version]$Matches["version"]
        if ($actual -lt $minimum) {
            throw "Artifact Signing requires SignTool 10.0.2261.755 or later."
        }
    }
    return $candidate
}

function Invoke-SignTool {
    param(
        [Parameter(Mandatory = $true)][IO.FileInfo]$Tool,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Operation
    )

    # Windows PowerShell 5.1 can promote a native stderr record to an exception
    # while the process still exits zero. Limit Continue to this invocation so
    # that the authoritative native exit code is always checked. Provider output
    # is deliberately discarded: it can contain tenant/authentication details.
    $previousErrorActionPreference = $ErrorActionPreference
    $exitCode = $null
    try {
        $ErrorActionPreference = "Continue"
        $null = @(& $Tool.FullName @Arguments 2>&1 | ForEach-Object { [string]$_ })
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    if ($null -eq $exitCode) {
        throw "SignTool ${Operation} did not produce an exit code."
    }
    if ($exitCode -ne 0) {
        throw "SignTool ${Operation} failed with exit code $exitCode."
    }
}

function Assert-ArtifactEndpoint {
    param([Parameter(Mandatory = $true)][string]$Value)

    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne "https" -or
        -not [string]::IsNullOrWhiteSpace($uri.UserInfo) -or
        -not [string]::IsNullOrWhiteSpace($uri.Query) -or
        -not [string]::IsNullOrWhiteSpace($uri.Fragment) -or
        $uri.AbsolutePath -ne "/" -or
        -not $uri.IdnHost.EndsWith(".codesigning.azure.net", [StringComparison]::OrdinalIgnoreCase)) {
        throw "ArtifactSigningEndpoint must be an HTTPS Artifact Signing regional endpoint."
    }
    return $uri.AbsoluteUri
}

function Assert-ArtifactPublicName {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,126}$') {
        throw "$Label is invalid."
    }
}

function Write-ArtifactMetadata {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Endpoint,
        [Parameter(Mandatory = $true)][string]$AccountName,
        [Parameter(Mandatory = $true)][string]$ProfileName,
        [Parameter(Mandatory = $true)][string]$CorrelationId
    )

    if ([string]::IsNullOrWhiteSpace($Path) -or [IO.Path]::GetExtension($Path) -ne ".json") {
        throw "ArtifactSigningMetadataPath must be a .json path."
    }
    $fullPath = [IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $fullPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "Artifact Signing metadata parent directory does not exist."
    }
    $parentItem = Get-Item -LiteralPath $parent -Force
    if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Artifact Signing metadata parent cannot be a reparse point."
    }
    if (Test-Path -LiteralPath $fullPath) {
        $existing = Get-Item -LiteralPath $fullPath -Force
        if ($existing.PSIsContainer -or (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw "Artifact Signing metadata path is not a regular file."
        }
    }

    # These are the complete metadata fields. Authentication is deliberately
    # delegated to the provider's DefaultAzureCredential flow; no token,
    # password, client secret, or private key is accepted or written here.
    $metadata = [ordered]@{
        Endpoint = $Endpoint
        CodeSigningAccountName = $AccountName
        CertificateProfileName = $ProfileName
        CorrelationId = $CorrelationId
    }
    $tempPath = Join-Path $parent ("." + [IO.Path]::GetFileName($fullPath) + "." + [Guid]::NewGuid().ToString("N") + ".tmp")
    try {
        [IO.File]::WriteAllText($tempPath, ($metadata | ConvertTo-Json -Depth 4), $script:Utf8NoBom)
        $roundTrip = Get-Content -LiteralPath $tempPath -Raw | ConvertFrom-Json
        $actualFields = @($roundTrip.PSObject.Properties.Name | Sort-Object)
        $allowedFields = @("CertificateProfileName", "CodeSigningAccountName", "CorrelationId", "Endpoint" | Sort-Object)
        if (($actualFields -join "|") -ne ($allowedFields -join "|")) {
            throw "Artifact Signing metadata contains an unexpected field."
        }
        Move-Item -LiteralPath $tempPath -Destination $fullPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $tempPath) {
            Remove-Item -LiteralPath $tempPath -Force
        }
    }
    return Get-RegularFile -Path $fullPath -Label "Artifact Signing metadata"
}

function Get-StoreCodeSigningCertificate {
    param(
        [Parameter(Mandatory = $true)][string]$Thumbprint,
        [Parameter(Mandatory = $true)][string]$StoreLocation,
        [Parameter(Mandatory = $true)][string]$StoreName,
        [Parameter(Mandatory = $true)][string]$Publisher,
        [Parameter(Mandatory = $true)][string[]]$ApprovedRootThumbprints
    )

    $normalized = ($Thumbprint -replace '\s', '').ToUpperInvariant()
    if ($normalized -notmatch '^[0-9A-F]{40,64}$') {
        throw "CertificateThumbprint is invalid."
    }
    $certificatePath = "Cert:\$StoreLocation\$StoreName\$normalized"
    $certificate = Get-Item -LiteralPath $certificatePath -ErrorAction Stop
    if (-not $certificate.HasPrivateKey) {
        throw "The public code-signing certificate has no accessible private key."
    }
    $now = Get-Date
    if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) {
        throw "The public code-signing certificate is not currently valid."
    }
    Assert-CodeSigningEku -Certificate $certificate
    Assert-ExpectedPublisher -Certificate $certificate -Expected $Publisher
    Assert-WindowsTrustedCodeSigningChain -Certificate $certificate -ApprovedRootThumbprints $ApprovedRootThumbprints | Out-Null
    return $certificate
}

function Assert-SignedReleaseFile {
    param(
        [Parameter(Mandatory = $true)][IO.FileInfo]$File,
        [Parameter(Mandatory = $true)][IO.FileInfo]$Tool,
        [Parameter(Mandatory = $true)][string]$Publisher,
        [Parameter(Mandatory = $true)][string[]]$ApprovedRootThumbprints,
        [string]$ExpectedSignerThumbprint = "",
        [switch]$RequireArtifactPublicTrust
    )

    Invoke-SignTool -Tool $Tool -Operation "verify" -Arguments @(
        "verify", "/pa", "/all", "/v", $File.FullName
    )
    $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
        throw "Get-AuthenticodeSignature did not return Valid for the release file."
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "Release file has no signer certificate."
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw "Release file has no trusted RFC 3161 timestamp."
    }
    Assert-CodeSigningEku -Certificate $signature.SignerCertificate
    Assert-ExpectedPublisher -Certificate $signature.SignerCertificate -Expected $Publisher
    Assert-WindowsTrustedCodeSigningChain -Certificate $signature.SignerCertificate -ApprovedRootThumbprints $ApprovedRootThumbprints | Out-Null
    if ($RequireArtifactPublicTrust) {
        Assert-ArtifactPublicTrustEku -Certificate $signature.SignerCertificate
    }
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSignerThumbprint)) {
        $actualThumbprint = ([string]$signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
        if (-not [string]::Equals($actualThumbprint, $ExpectedSignerThumbprint, [StringComparison]::Ordinal)) {
            throw "Signed file certificate does not match the selected CertificateStore certificate."
        }
    }
    return $signature
}

function Write-AuditReport {
    param(
        [Parameter(Mandatory = $true)][object]$Value,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }
    $fullPath = [IO.Path]::GetFullPath($Path)
    if ([IO.Path]::GetExtension($fullPath) -ne ".json") {
        throw "AuditReportPath must use the .json extension."
    }
    $parent = Split-Path -Parent $fullPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        throw "Audit report parent directory does not exist."
    }
    $parentItem = Get-Item -LiteralPath $parent -Force
    if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Audit report parent cannot be a reparse point."
    }
    $tempPath = Join-Path $parent ("." + [IO.Path]::GetFileName($fullPath) + "." + [Guid]::NewGuid().ToString("N") + ".tmp")
    try {
        [IO.File]::WriteAllText($tempPath, ($Value | ConvertTo-Json -Depth 8), $script:Utf8NoBom)
        Get-Content -LiteralPath $tempPath -Raw | ConvertFrom-Json | Out-Null
        Move-Item -LiteralPath $tempPath -Destination $fullPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $tempPath) {
            Remove-Item -LiteralPath $tempPath -Force
        }
    }
}

$audit = [ordered]@{
    schemaVersion = 1
    tool = "ByeollogAuthenticodeSigning"
    releaseVersion = $ReleaseVersion
    releaseChannel = $ReleaseChannel
    policy = $Policy
    provider = $Provider
    timestampServer = $script:RequiredTimestampServer
    expectedPublisher = $ExpectedPublisher
    startedAtUtc = [DateTimeOffset]::UtcNow.ToString("O")
    completedAtUtc = $null
    result = "STARTED"
    productionEligible = $false
    error = $null
    targets = @()
}

try {
    if ($ReleaseChannel -eq "Production" -and $Policy -ne "Required") {
        throw "Production releases require Policy=Required."
    }
    if ($SkipSigning -and ($Policy -ne "Development" -or $ReleaseChannel -ne "Development")) {
        throw "SkipSigning is permitted only for an explicitly Development policy and channel."
    }
    if ([string]::IsNullOrWhiteSpace($ReleaseVersion)) {
        throw "ReleaseVersion is required for the signing audit."
    }
    if ($ReleaseChannel -eq "Production" -and [string]::IsNullOrWhiteSpace($AuditReportPath)) {
        throw "Production releases require a persistent AuditReportPath."
    }

    $seenTargets = @{}
    $targetFiles = @()
    foreach ($path in $TargetPath) {
        $file = Get-ReleaseTarget -Path $path
        if ($seenTargets.ContainsKey($file.FullName)) {
            throw "Duplicate signing target is not allowed."
        }
        $seenTargets[$file.FullName] = $true
        $targetFiles += $file
        $audit.targets += [ordered]@{
            path = $file.FullName
            beforeSha256 = Get-Sha256Lower -Path $file.FullName
            afterSha256 = $null
            signatureStatus = $null
            signerSubject = $null
            signerThumbprint = $null
            timestampSubject = $null
        }
    }

    if ($SkipSigning) {
        foreach ($entry in $audit.targets) {
            $entry.afterSha256 = Get-Sha256Lower -Path ([string]$entry.path)
            if ($entry.afterSha256 -ne $entry.beforeSha256) {
                throw "Development unsigned target changed unexpectedly."
            }
            $entry.signatureStatus = "SkippedDevelopmentOnly"
        }
        $audit.result = "DEVELOPMENT_UNSIGNED"
        $audit.productionEligible = $false
        $audit.completedAtUtc = [DateTimeOffset]::UtcNow.ToString("O")
        Write-AuditReport -Value $audit -Path $AuditReportPath
        $audit | ConvertTo-Json -Depth 8
        return
    }

    if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
        throw "ExpectedPublisher is required whenever signing is not skipped."
    }

    $signTool = Resolve-OfficialSignTool `
        -RequestedPath $SignToolPath `
        -RequireArtifactSigningMinimum:($Provider -eq "ArtifactSigning")
    $approvedPublicRoots = Get-NormalizedRootAllowlist -Thumbprints $ApprovedPublicRootThumbprint
    if ($ReleaseChannel -eq "Production") {
        Assert-ExpectedFileHash -File $signTool -ExpectedSha256 $ExpectedSignToolSha256 -Label "SignTool"
    }
    $artifactMetadata = $null
    $storeCertificate = $null
    $normalizedStoreThumbprint = ""

    if ($Provider -eq "ArtifactSigning") {
        $dlib = Get-RegularFile -Path $ArtifactSigningDlibPath -Label "Artifact Signing dlib"
        Assert-MicrosoftSignedTool -File $dlib -Label "Artifact Signing dlib"
        Assert-MatchingArtifactArchitecture -SignTool $signTool -Dlib $dlib
        if ($ReleaseChannel -eq "Production") {
            Assert-ExpectedFileHash -File $dlib -ExpectedSha256 $ExpectedArtifactSigningDlibSha256 -Label "Artifact Signing dlib"
        }
        $endpoint = Assert-ArtifactEndpoint -Value $ArtifactSigningEndpoint
        Assert-ArtifactPublicName -Value $ArtifactSigningAccountName -Label "ArtifactSigningAccountName"
        Assert-ArtifactPublicName -Value $ArtifactSigningCertificateProfileName -Label "ArtifactSigningCertificateProfileName"
        $correlationId = "byeollog-" + ($ReleaseVersion -replace '[^A-Za-z0-9_.-]', '-')
        $artifactMetadata = Write-ArtifactMetadata `
            -Path $ArtifactSigningMetadataPath `
            -Endpoint $endpoint `
            -AccountName $ArtifactSigningAccountName `
            -ProfileName $ArtifactSigningCertificateProfileName `
            -CorrelationId $correlationId
    }
    else {
        $storeCertificate = Get-StoreCodeSigningCertificate `
            -Thumbprint $CertificateThumbprint `
            -StoreLocation $CertificateStoreLocation `
            -StoreName $CertificateStoreName `
            -Publisher $ExpectedPublisher `
            -ApprovedRootThumbprints $approvedPublicRoots
        $normalizedStoreThumbprint = ($storeCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
    }

    for ($index = 0; $index -lt $targetFiles.Count; $index++) {
        $file = $targetFiles[$index]
        if ($Provider -eq "ArtifactSigning") {
            Invoke-SignTool -Tool $signTool -Operation "Artifact Signing" -Arguments @(
                "sign", "/v",
                "/fd", "SHA256",
                "/tr", $script:RequiredTimestampServer,
                "/td", "SHA256",
                "/dlib", $dlib.FullName,
                "/dmdf", $artifactMetadata.FullName,
                $file.FullName
            )
        }
        else {
            $signArguments = @(
                "sign", "/v",
                "/fd", "SHA256",
                "/tr", $script:RequiredTimestampServer,
                "/td", "SHA256",
                "/sha1", $normalizedStoreThumbprint,
                "/s", $CertificateStoreName
            )
            if ($CertificateStoreLocation -eq "LocalMachine") {
                $signArguments += "/sm"
            }
            $signArguments += $file.FullName
            Invoke-SignTool -Tool $signTool -Operation "certificate-store signing" -Arguments $signArguments
        }

        $signature = Assert-SignedReleaseFile `
            -File $file `
            -Tool $signTool `
            -Publisher $ExpectedPublisher `
            -ApprovedRootThumbprints $approvedPublicRoots `
            -ExpectedSignerThumbprint $(if ($Provider -eq "CertificateStore") { $normalizedStoreThumbprint } else { "" }) `
            -RequireArtifactPublicTrust:($Provider -eq "ArtifactSigning")
        $audit.targets[$index].afterSha256 = Get-Sha256Lower -Path $file.FullName
        if ($audit.targets[$index].afterSha256 -eq $audit.targets[$index].beforeSha256) {
            throw "Signing did not change the target bytes."
        }
        $audit.targets[$index].signatureStatus = [string]$signature.Status
        $audit.targets[$index].signerSubject = [string]$signature.SignerCertificate.Subject
        $audit.targets[$index].signerThumbprint = ([string]$signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
        $audit.targets[$index].timestampSubject = [string]$signature.TimeStamperCertificate.Subject
    }

    $audit.result = "SIGNED_VERIFIED"
    $audit.productionEligible = ($ReleaseChannel -eq "Production" -and $Policy -eq "Required")
    $audit.completedAtUtc = [DateTimeOffset]::UtcNow.ToString("O")
    Write-AuditReport -Value $audit -Path $AuditReportPath
    $audit | ConvertTo-Json -Depth 8
}
catch {
    $failure = $_
    foreach ($entry in $audit.targets) {
        if ($null -eq $entry.afterSha256 -and (Test-Path -LiteralPath ([string]$entry.path) -PathType Leaf)) {
            $entry.afterSha256 = Get-Sha256Lower -Path ([string]$entry.path)
        }
    }
    $audit.result = "FAILED"
    $audit.productionEligible = $false
    $audit.error = [string]$failure.Exception.Message
    $audit.completedAtUtc = [DateTimeOffset]::UtcNow.ToString("O")
    if (-not [string]::IsNullOrWhiteSpace($AuditReportPath)) {
        try {
            Write-AuditReport -Value $audit -Path $AuditReportPath
        }
        catch {
            Write-Warning "The failure audit report could not be written."
        }
    }
    throw $failure
}
