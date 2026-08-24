[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BackupRoot,
    [Parameter(Mandatory = $true)][string]$OperationalRoot,
    [Parameter(Mandatory = $true)][string]$PasswordRecoveryFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-KeyId([Security.Cryptography.RSA]$Rsa) {
    $parameters = $Rsa.ExportParameters($false)
    $inputBytes = New-Object byte[] ($parameters.Modulus.Length + $parameters.Exponent.Length)
    [Array]::Copy($parameters.Modulus, 0, $inputBytes, 0, $parameters.Modulus.Length)
    [Array]::Copy($parameters.Exponent, 0, $inputBytes, $parameters.Modulus.Length, $parameters.Exponent.Length)
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($inputBytes)).ToLowerInvariant()
    return 'rsa3072-' + $hash.Substring(0, 16)
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
        [Security.AccessControl.InheritanceFlags]::None,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
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

$backup = [IO.Path]::GetFullPath($BackupRoot)
$operational = [IO.Path]::GetFullPath($OperationalRoot)
$passwordFile = [IO.Path]::GetFullPath($PasswordRecoveryFile)
$primaryBackupPfx = Join-Path $backup 'byeollog-update-primary-2026.pfx'
$recoveryBackupPfx = Join-Path $backup 'byeollog-update-recovery-2026.pfx'
$primaryOperationalPfx = Join-Path $operational 'byeollog-update-primary-2026.pfx'
$primaryDpapi = Join-Path $operational 'byeollog-update-primary-2026.password.dpapi'
$anchorsPath = Join-Path $backup 'update-trust-anchors.json'
$manifestPath = Join-Path $backup 'BACKUP_MANIFEST.json'

foreach ($path in @(
    $primaryBackupPfx,
    $recoveryBackupPfx,
    $primaryOperationalPfx,
    $primaryDpapi,
    $anchorsPath,
    $passwordFile
)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Incomplete signing trust set: $path"
    }
}
if (Test-Path -LiteralPath $manifestPath) {
    throw "Refusing to overwrite an existing backup manifest: $manifestPath"
}

$passwordText = [IO.File]::ReadAllText($passwordFile, $utf8NoBom)
$primaryMatch = [regex]::Match($passwordText, '(?m)^Primary PFX password: (?<value>\S+)$')
$recoveryMatch = [regex]::Match($passwordText, '(?m)^Recovery PFX password: (?<value>\S+)$')
if (-not $primaryMatch.Success -or -not $recoveryMatch.Success) {
    throw 'The password recovery file is malformed.'
}
$primaryPassword = $primaryMatch.Groups['value'].Value
$recoveryPassword = $recoveryMatch.Groups['value'].Value
$anchors = Get-Content -LiteralPath $anchorsPath -Raw | ConvertFrom-Json
if ([int]$anchors.schemaVersion -ne 1 -or @($anchors.keys).Count -ne 2) {
    throw 'The public trust anchors are malformed.'
}

try {
    $verified = @{}
    foreach ($entry in @(
        @{ Role = 'primary'; Pfx = $primaryBackupPfx; Password = $primaryPassword },
        @{ Role = 'recovery'; Pfx = $recoveryBackupPfx; Password = $recoveryPassword }
    )) {
        $expected = @($anchors.keys | Where-Object role -eq $entry.Role)
        if ($expected.Count -ne 1) { throw "Missing public anchor: $($entry.Role)" }
        $loaded = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
            $entry.Pfx,
            $entry.Password,
            [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
        try {
            if (-not $loaded.HasPrivateKey) { throw "PFX has no private key: $($entry.Role)" }
            $privateRsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($loaded)
            $publicRsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($loaded)
            try {
                $keyId = Get-KeyId $publicRsa
                if ($keyId -cne [string]$expected[0].keyId -or $publicRsa.KeySize -ne 3072) {
                    throw "PFX public key mismatch: $($entry.Role)"
                }
                $challenge = [Security.Cryptography.RandomNumberGenerator]::GetBytes(64)
                $signature = $privateRsa.SignData(
                    $challenge,
                    [Security.Cryptography.HashAlgorithmName]::SHA256,
                    [Security.Cryptography.RSASignaturePadding]::Pss)
                if (-not $publicRsa.VerifyData(
                    $challenge,
                    $signature,
                    [Security.Cryptography.HashAlgorithmName]::SHA256,
                    [Security.Cryptography.RSASignaturePadding]::Pss)) {
                    throw "PFX signing check failed: $($entry.Role)"
                }
                $verified[$entry.Role] = $keyId
            }
            finally {
                $privateRsa.Dispose()
                $publicRsa.Dispose()
            }
        }
        finally { $loaded.Dispose() }
    }

    $dpapiPassword = $utf8NoBom.GetString(
        [Security.Cryptography.ProtectedData]::Unprotect(
            [IO.File]::ReadAllBytes($primaryDpapi),
            $utf8NoBom.GetBytes('byeollog-update-signing-primary-v2'),
            [Security.Cryptography.DataProtectionScope]::CurrentUser))
    if ($dpapiPassword -cne $primaryPassword) {
        throw 'Operational DPAPI password does not match the primary backup.'
    }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $primaryBackupPfx).Hash -cne
        (Get-FileHash -Algorithm SHA256 -LiteralPath $primaryOperationalPfx).Hash) {
        throw 'Operational primary PFX differs from the backup PFX.'
    }

    foreach ($path in @($primaryBackupPfx, $recoveryBackupPfx, $primaryOperationalPfx, $primaryDpapi, $passwordFile)) {
        Set-CurrentUserOnlyAcl $path
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        completedAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
        primaryKeyId = $verified.primary
        recoveryKeyId = $verified.recovery
        publicAnchorsSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $anchorsPath).Hash.ToLowerInvariant()
        primaryPfxSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $primaryBackupPfx).Hash.ToLowerInvariant()
        recoveryPfxSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $recoveryBackupPfx).Hash.ToLowerInvariant()
        operationalPrimaryPfxSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $primaryOperationalPfx).Hash.ToLowerInvariant()
        passwordRecoveryFile = $passwordFile
        aclMode = 'current-user-only'
        recoveryValidation = 'both-private-keys-sign-and-verify'
    }
    Write-ExclusiveBytes $manifestPath ($utf8NoBom.GetBytes(($manifest | ConvertTo-Json -Depth 6)))

    [PSCustomObject]@{
        Status = 'PASS'
        PrimaryKeyId = $verified.primary
        RecoveryKeyId = $verified.recovery
        BackupManifest = $manifestPath
        PasswordRecoveryFile = $passwordFile
    } | Format-List
}
finally {
    $primaryPassword = $null
    $recoveryPassword = $null
    $passwordText = $null
}
