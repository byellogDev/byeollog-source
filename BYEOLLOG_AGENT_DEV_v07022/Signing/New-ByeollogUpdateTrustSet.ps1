[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BackupRoot,
    [Parameter(Mandatory = $true)][string]$OperationalRoot,
    [Parameter(Mandatory = $true)][string]$PasswordRecoveryFile,
    [DateTimeOffset]$NotAfterUtc = [DateTimeOffset]::UtcNow.AddYears(10)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-FullSafePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A required path is empty.' }
    return [IO.Path]::GetFullPath($Path)
}

function New-StrongPassword {
    $bytes = New-Object byte[] 48
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-KeyIdentity([Security.Cryptography.RSA]$Rsa) {
    $parameters = $Rsa.ExportParameters($false)
    $fingerprintInput = New-Object byte[] ($parameters.Modulus.Length + $parameters.Exponent.Length)
    [Array]::Copy($parameters.Modulus, 0, $fingerprintInput, 0, $parameters.Modulus.Length)
    [Array]::Copy($parameters.Exponent, 0, $fingerprintInput, $parameters.Modulus.Length, $parameters.Exponent.Length)
    $fingerprintBytes = [Security.Cryptography.SHA256]::HashData($fingerprintInput)
    $fingerprint = [Convert]::ToHexString($fingerprintBytes).ToLowerInvariant()
    return [ordered]@{
        keyId = 'rsa3072-' + $fingerprint.Substring(0, 16)
        modulusBase64 = [Convert]::ToBase64String($parameters.Modulus)
        exponentBase64 = [Convert]::ToBase64String($parameters.Exponent)
        spkiSha256 = $fingerprint
    }
}

function New-TrustCertificate([string]$Role, [string]$Subject, [string]$Password) {
    $rsa = [Security.Cryptography.RSA]::Create(3072)
    try {
        $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
            $Subject,
            $rsa,
            [Security.Cryptography.HashAlgorithmName]::SHA256,
            [Security.Cryptography.RSASignaturePadding]::Pkcs1)
        $request.CertificateExtensions.Add(
            [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
                [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
                $true))
        $request.CertificateExtensions.Add(
            [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
        $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), $NotAfterUtc)
        try {
            $identity = Get-KeyIdentity $rsa
            $selfTestMessage = "byeollog-agent-update-trust-self-test-v2:$($identity.keyId)"
            $selfTestSignature = $rsa.SignData(
                [Text.Encoding]::ASCII.GetBytes($selfTestMessage),
                [Security.Cryptography.HashAlgorithmName]::SHA256,
                [Security.Cryptography.RSASignaturePadding]::Pss)
            $pfxBytes = $certificate.Export(
                [Security.Cryptography.X509Certificates.X509ContentType]::Pfx,
                $Password)
            return [ordered]@{
                role = $Role
                subject = $certificate.Subject
                thumbprint = $certificate.Thumbprint
                notBeforeUtc = $certificate.NotBefore.ToUniversalTime().ToString('O')
                notAfterUtc = $certificate.NotAfter.ToUniversalTime().ToString('O')
                keyId = $identity.keyId
                modulusBase64 = $identity.modulusBase64
                exponentBase64 = $identity.exponentBase64
                spkiSha256 = $identity.spkiSha256
                selfTestMessage = $selfTestMessage
                selfTestSignatureBase64 = [Convert]::ToBase64String($selfTestSignature)
                certificateBase64 = [Convert]::ToBase64String($certificate.Export(
                    [Security.Cryptography.X509Certificates.X509ContentType]::Cert))
                pfxBytes = $pfxBytes
            }
        }
        finally { $certificate.Dispose() }
    }
    finally { $rsa.Dispose() }
}

function Write-ExclusiveBytes([string]$Path, [byte[]]$Bytes) {
    $stream = [IO.FileStream]::new(
        $Path,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None,
        4096,
        [IO.FileOptions]::WriteThrough)
    try {
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    }
    finally { $stream.Dispose() }
}

function Protect-Password([string]$Password) {
    return [Security.Cryptography.ProtectedData]::Protect(
        $utf8NoBom.GetBytes($Password),
        $utf8NoBom.GetBytes('byeollog-update-signing-primary-v2'),
        [Security.Cryptography.DataProtectionScope]::CurrentUser)
}

function Set-CurrentUserOnlyAcl([string]$Path) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.Access)) {
        [void]$acl.RemoveAccessRuleAll($existingRule)
    }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
        $identity,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

$backup = Get-FullSafePath $BackupRoot
$operational = Get-FullSafePath $OperationalRoot
$passwordFile = Get-FullSafePath $PasswordRecoveryFile
foreach ($path in @($backup, $operational, $passwordFile)) {
    if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite existing signing material: $path" }
}
if ($NotAfterUtc -le [DateTimeOffset]::UtcNow.AddYears(5)) {
    throw 'The update trust set must remain valid for more than five years.'
}

$primaryPassword = New-StrongPassword
$recoveryPassword = New-StrongPassword
$primary = New-TrustCertificate 'primary' 'CN=Byeollog Agent Update Primary 2026' $primaryPassword
$recovery = New-TrustCertificate 'recovery' 'CN=Byeollog Agent Update Recovery 2026' $recoveryPassword
if ($primary.keyId -eq $recovery.keyId) { throw 'Generated trust keys unexpectedly collide.' }

try {
    New-Item -ItemType Directory -Path $backup | Out-Null
    New-Item -ItemType Directory -Path $operational | Out-Null
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($passwordFile)) -Force | Out-Null

    $primaryBackupPfx = Join-Path $backup 'byeollog-update-primary-2026.pfx'
    $recoveryBackupPfx = Join-Path $backup 'byeollog-update-recovery-2026.pfx'
    $primaryOperationalPfx = Join-Path $operational 'byeollog-update-primary-2026.pfx'
    $primaryDpapi = Join-Path $operational 'byeollog-update-primary-2026.password.dpapi'
    $anchorsPath = Join-Path $backup 'update-trust-anchors.json'
    $manifestPath = Join-Path $backup 'BACKUP_MANIFEST.json'

    Write-ExclusiveBytes $primaryBackupPfx $primary.pfxBytes
    Write-ExclusiveBytes $recoveryBackupPfx $recovery.pfxBytes
    Write-ExclusiveBytes $primaryOperationalPfx $primary.pfxBytes
    Write-ExclusiveBytes $primaryDpapi (Protect-Password $primaryPassword)

    $publicAnchors = [ordered]@{
        schemaVersion = 1
        generatedAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
        keys = @(
            [ordered]@{
                role = $primary.role
                keyId = $primary.keyId
                subject = $primary.subject
                thumbprint = $primary.thumbprint
                notAfterUtc = $primary.notAfterUtc
                modulusBase64 = $primary.modulusBase64
                exponentBase64 = $primary.exponentBase64
                spkiSha256 = $primary.spkiSha256
                selfTestMessage = $primary.selfTestMessage
                selfTestSignatureBase64 = $primary.selfTestSignatureBase64
                certificateBase64 = $primary.certificateBase64
            },
            [ordered]@{
                role = $recovery.role
                keyId = $recovery.keyId
                subject = $recovery.subject
                thumbprint = $recovery.thumbprint
                notAfterUtc = $recovery.notAfterUtc
                modulusBase64 = $recovery.modulusBase64
                exponentBase64 = $recovery.exponentBase64
                spkiSha256 = $recovery.spkiSha256
                selfTestMessage = $recovery.selfTestMessage
                selfTestSignatureBase64 = $recovery.selfTestSignatureBase64
                certificateBase64 = $recovery.certificateBase64
            }
        )
    }
    Write-ExclusiveBytes $anchorsPath ($utf8NoBom.GetBytes(($publicAnchors | ConvertTo-Json -Depth 8)))

    $passwordText = @"
별록 자동 업데이트 서명키 복구 암호 - 외부 비밀번호 관리자에 즉시 옮기세요.
이 파일과 PFX 백업을 같은 저장매체에만 두지 마세요.

Primary key ID: $($primary.keyId)
Primary PFX password: $primaryPassword

Recovery key ID: $($recovery.keyId)
Recovery PFX password: $recoveryPassword
"@
    Write-ExclusiveBytes $passwordFile ($utf8NoBom.GetBytes($passwordText))

    foreach ($path in @($primaryBackupPfx, $recoveryBackupPfx, $primaryOperationalPfx, $primaryDpapi, $passwordFile)) {
        Set-CurrentUserOnlyAcl $path
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        createdAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
        primaryKeyId = $primary.keyId
        recoveryKeyId = $recovery.keyId
        publicAnchorsSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $anchorsPath).Hash.ToLowerInvariant()
        primaryPfxSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $primaryBackupPfx).Hash.ToLowerInvariant()
        recoveryPfxSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $recoveryBackupPfx).Hash.ToLowerInvariant()
        operationalPrimaryPfxSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $primaryOperationalPfx).Hash.ToLowerInvariant()
        passwordRecoveryFile = $passwordFile
        note = 'Private keys are outside the source tree. Keep the password recovery file on a separate secure medium.'
    }
    Write-ExclusiveBytes $manifestPath ($utf8NoBom.GetBytes(($manifest | ConvertTo-Json -Depth 6)))

    foreach ($entry in @(
        @{ Pfx = $primaryBackupPfx; Password = $primaryPassword; Expected = $primary.keyId },
        @{ Pfx = $recoveryBackupPfx; Password = $recoveryPassword; Expected = $recovery.keyId }
    )) {
        $loaded = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
            $entry.Pfx,
            $entry.Password,
            [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
        try {
            $loadedRsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($loaded)
            try {
                $loadedIdentity = Get-KeyIdentity $loadedRsa
                if ($loadedIdentity.keyId -cne $entry.Expected -or -not $loaded.HasPrivateKey) {
                    throw "PFX recovery verification failed for $($entry.Expected)."
                }
            }
            finally { $loadedRsa.Dispose() }
        }
        finally { $loaded.Dispose() }
    }

    [PSCustomObject]@{
        Status = 'PASS'
        PrimaryKeyId = $primary.keyId
        RecoveryKeyId = $recovery.keyId
        BackupRoot = $backup
        OperationalRoot = $operational
        PasswordRecoveryFile = $passwordFile
        PublicAnchors = $anchorsPath
    } | Format-List
}
catch {
    throw
}
finally {
    $primaryPassword = $null
    $recoveryPassword = $null
    if ($null -ne $primary.pfxBytes) { [Array]::Clear($primary.pfxBytes, 0, $primary.pfxBytes.Length) }
    if ($null -ne $recovery.pfxBytes) { [Array]::Clear($recovery.pfxBytes, 0, $recovery.pfxBytes.Length) }
}
