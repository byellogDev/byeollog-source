[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Sign", "Verify")]
    [string]$Mode,

    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [string]$CertificateThumbprint = $env:BYEOLLOG_CODE_SIGN_CERT_THUMBPRINT,

    [ValidateSet("CurrentUser", "LocalMachine")]
    [string]$CertificateStoreLocation = "CurrentUser",

    [string]$TimestampServer = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-RequiredFile([string]$Path) {
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    $item = Get-Item -LiteralPath $resolved.Path -Force
    if (-not $item.PSIsContainer -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) {
        return $item
    }
    throw "A regular, non-reparse-point release file is required."
}

function Assert-ValidSignature([IO.FileInfo]$File, [string]$ExpectedThumbprint) {
    $signature = Get-AuthenticodeSignature -LiteralPath $File.FullName
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
        throw "Public release signature is not trusted and valid: $($signature.Status)."
    }
    if ($null -eq $signature.SignerCertificate) {
        throw "Public release signature has no signer certificate."
    }
    $actualThumbprint = ($signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
    if ($ExpectedThumbprint -and $actualThumbprint -ne $ExpectedThumbprint) {
        throw "Public release signer certificate does not match the approved thumbprint."
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw "Public release signature has no trusted timestamp."
    }
    return $signature
}

$file = Get-RequiredFile $FilePath
$normalizedThumbprint = if ([string]::IsNullOrWhiteSpace($CertificateThumbprint)) {
    ""
} else {
    ($CertificateThumbprint -replace '\s', '').ToUpperInvariant()
}

if ($Mode -eq "Sign") {
    if ([string]::IsNullOrWhiteSpace($normalizedThumbprint)) {
        throw "BYEOLLOG_CODE_SIGN_CERT_THUMBPRINT is required. Unsigned public releases are blocked."
    }

    $certificatePath = "Cert:\$CertificateStoreLocation\My\$normalizedThumbprint"
    $certificate = Get-Item -LiteralPath $certificatePath -ErrorAction Stop
    if (-not $certificate.HasPrivateKey) {
        throw "The approved code-signing certificate has no accessible private key."
    }
    $now = Get-Date
    if ($certificate.NotBefore -gt $now -or $certificate.NotAfter -le $now) {
        throw "The approved code-signing certificate is not currently valid."
    }
    $codeSigningOid = "1.3.6.1.5.5.7.3.3"
    $hasCodeSigningEku = @($certificate.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId.Value }) -contains $codeSigningOid
    if (-not $hasCodeSigningEku) {
        throw "The approved certificate is not valid for code signing."
    }

    $result = Set-AuthenticodeSignature `
        -LiteralPath $file.FullName `
        -Certificate $certificate `
        -HashAlgorithm SHA256 `
        -TimestampServer $TimestampServer
    if ($result.Status -ne [Management.Automation.SignatureStatus]::Valid) {
        throw "Signing did not produce a trusted valid signature: $($result.Status)."
    }
}

$verified = Assert-ValidSignature $file $normalizedThumbprint
[pscustomobject]@{
    status = "PASS"
    mode = $Mode
    file = $file.Name
    signatureStatus = [string]$verified.Status
    signerThumbprint = $verified.SignerCertificate.Thumbprint
    timestamped = $null -ne $verified.TimeStamperCertificate
} | ConvertTo-Json -Depth 3
