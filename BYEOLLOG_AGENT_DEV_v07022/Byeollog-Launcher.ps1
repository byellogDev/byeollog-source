[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CollectorArgs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$installRoot = $PSScriptRoot.TrimEnd('\', '/')
$pointerPath = Join-Path $installRoot "current.json"

function Assert-SafeLeaf {
    param([string]$Path, [int64]$MaximumBytes, [string]$Message)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw $Message }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -le 0 -or $item.Length -gt $MaximumBytes) {
        throw $Message
    }
    return $item
}

function Get-ContainedPath {
    param([string]$Root, [string]$Relative)
    if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative)) {
        throw "별록 에이전트 파일 경로가 올바르지 않습니다."
    }
    $segments = @($Relative -split '[\\/]')
    if ($segments.Count -eq 0) { throw "별록 에이전트 파일 경로가 비어 있습니다." }
    foreach ($segment in $segments) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq "." -or $segment -eq ".." -or
            $segment.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
            throw "별록 에이전트 파일 경로가 안전하지 않습니다."
        }
    }
    $rootFull = (Get-Item -LiteralPath $Root -Force).FullName.TrimEnd('\', '/')
    return (Join-Path $rootFull ($segments -join [IO.Path]::DirectorySeparatorChar))
}

function Resolve-CollectorLaunchMode {
    param([object]$Arguments)

    # Build a real collection explicitly. Windows PowerShell 5.1 may expose a
    # remaining-arguments parameter as $null, a scalar, or an array depending
    # on whether the caller supplied zero, one, or several values.
    $values = [System.Collections.Generic.List[string]]::new()
    if ($null -ne $Arguments) {
        foreach ($argument in $Arguments) {
            $value = [string]$argument
            if ([string]::IsNullOrWhiteSpace($value)) {
                throw "별록 에이전트 실행 인수가 비어 있습니다."
            }
            [void]$values.Add($value)
        }
    }

    if ($values.Count -eq 0) { return "normal" }
    if ($values.Count -eq 1 -and [string]::Equals(
        $values[0],
        "--replay-candidate-check",
        [StringComparison]::Ordinal)) {
        return "replay_candidate_check"
    }
    throw "지원하지 않는 별록 에이전트 실행 인수입니다."
}

function Assert-LauncherArgumentContract {
    if ((Resolve-CollectorLaunchMode -Arguments $null) -ne "normal") {
        throw "별록 에이전트 무인수 실행 계약 검증에 실패했습니다."
    }
    if ((Resolve-CollectorLaunchMode -Arguments @("--replay-candidate-check")) -ne "replay_candidate_check") {
        throw "별록 에이전트 replay 실행 계약 검증에 실패했습니다."
    }

    $multipleRejected = $false
    try { Resolve-CollectorLaunchMode -Arguments @("one", "two") | Out-Null }
    catch { $multipleRejected = $true }
    if (-not $multipleRejected) {
        throw "별록 에이전트 다중 인수 거부 계약 검증에 실패했습니다."
    }

    $emptyRejected = $false
    try { Resolve-CollectorLaunchMode -Arguments @(" ") | Out-Null }
    catch { $emptyRejected = $true }
    if (-not $emptyRejected) {
        throw "별록 에이전트 빈 인수 거부 계약 검증에 실패했습니다."
    }
}

function Test-Entry {
    param([string]$Root, [object]$Entry)
    $name = [string]$Entry.path
    if (@("byeollog.exe", "WebView2Loader.dll") -notcontains $name) {
        throw "별록 에이전트 앱 파일 목록이 올바르지 않습니다."
    }
    $maximum = if ($name -eq "byeollog.exe") { [int64]536870912 } else { [int64]33554432 }
    $path = Get-ContainedPath -Root $Root -Relative $name
    $item = Assert-SafeLeaf -Path $path -MaximumBytes $maximum -Message "별록 에이전트 앱 파일이 없거나 안전하지 않습니다: $name"
    $expected = ([string]$Entry.sha256).ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$' -or $actual -ne $expected -or $item.Length -ne [int64]$Entry.byteSize) {
        throw "별록 에이전트 앱 파일 무결성 확인에 실패했습니다: $name"
    }
}

Assert-SafeLeaf -Path $pointerPath -MaximumBytes 65536 -Message "별록 에이전트 설치 정보가 없습니다. INSTALL_OR_UPDATE.cmd를 다시 실행해주세요." | Out-Null
$pointer = Get-Content -Raw -LiteralPath $pointerPath -Encoding UTF8 | ConvertFrom-Json
$pointerSchemaVersion = [int]$pointer.schemaVersion
if ($pointerSchemaVersion -ne 1) { throw "별록 에이전트 설치 포인터 형식을 지원하지 않습니다." }
$version = [string]$pointer.version
if ($version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "별록 에이전트 설치 버전 정보가 손상되었습니다." }

$versionsRoot = (Join-Path $installRoot "versions").TrimEnd('\', '/')
$versionRoot = Get-ContainedPath -Root $versionsRoot -Relative $version
if (-not (Test-Path -LiteralPath $versionRoot -PathType Container)) { throw "별록 에이전트 설치 버전 폴더가 없습니다." }
$versionRootItem = Get-Item -LiteralPath $versionRoot -Force
if (($versionRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "별록 에이전트 설치 버전 폴더가 안전하지 않습니다." }

$manifestPath = Join-Path $versionRoot "release-manifest.json"
Assert-SafeLeaf -Path $manifestPath -MaximumBytes 4MB -Message "별록 에이전트 릴리스 정보가 없습니다." | Out-Null
$manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
if ([string]$manifest.product -ne "byeollog-collector" -or [string]$manifest.version -ne $version) {
    throw "별록 에이전트 릴리스 정보가 설치 포인터와 일치하지 않습니다."
}

$schemaVersion = [int]$manifest.schemaVersion
if ($schemaVersion -eq 1) {
    # Read-only compatibility for a previously installed 0.5.6.7/0.5.6.8 release.
    $appEntries = @($manifest.files)
}
elseif ($schemaVersion -eq 2) {
    if ([string]$manifest.platform -ne "win-x64" -or [string]$manifest.packageLayout -ne "flat_v1") {
        throw "별록 에이전트 릴리스 형식이 올바르지 않습니다."
    }
    $appEntries = @($manifest.files | Where-Object { [string]$_.role -eq "app" })
}
else { throw "지원하지 않는 별록 에이전트 릴리스 형식입니다." }

if ($appEntries.Count -lt 1 -or $appEntries.Count -gt 2) { throw "별록 에이전트 앱 파일 수가 올바르지 않습니다." }
$seen = @{}
foreach ($entry in $appEntries) {
    $name = [string]$entry.path
    if ($seen.ContainsKey($name)) { throw "별록 에이전트 앱 파일 목록이 중복되었습니다." }
    $seen[$name] = $true
    Test-Entry -Root $versionRoot -Entry $entry
}
if (-not $seen.ContainsKey("byeollog.exe")) { throw "별록 에이전트 실행 파일 정보가 없습니다." }

$expectedItems = @($seen.Keys) + @("release-manifest.json")
$actualItems = @(Get-ChildItem -LiteralPath $versionRoot -Force)
if ($actualItems.Count -ne $expectedItems.Count) { throw "별록 에이전트 설치 폴더에 예상하지 못한 파일이 있습니다." }
foreach ($item in $actualItems) {
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $expectedItems -notcontains $item.Name) {
        throw "별록 에이전트 설치 폴더 구성이 올바르지 않습니다."
    }
}

if ($schemaVersion -eq 2) {
    $authenticityMode = [string]$manifest.authenticity.mode
    if ($authenticityMode -eq "authenticode_pinned") {
        $expectedThumbprint = ([string]$manifest.authenticity.signerThumbprint -replace '\s', '').ToUpperInvariant()
        if ($expectedThumbprint -notmatch '^[0-9A-F]{40}$') { throw "별록 에이전트 게시자 지문이 올바르지 않습니다." }
        $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $versionRoot "byeollog.exe")
        $actualThumbprint = if ($null -eq $signature.SignerCertificate) { "" } else { ([string]$signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant() }
        if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or $actualThumbprint -ne $expectedThumbprint) {
            throw "별록 에이전트 게시자 서명 확인에 실패했습니다."
        }
    }
    elseif ($authenticityMode -ne "trusted_channel_internal") {
        throw "별록 에이전트 인증 모드를 지원하지 않습니다."
    }
}

$exe = Join-Path $versionRoot "byeollog.exe"
Assert-LauncherArgumentContract
$launchMode = Resolve-CollectorLaunchMode -Arguments $CollectorArgs
if ($launchMode -eq "replay_candidate_check") {
    # The only supported argument is fixed here. A nullable or empty collection
    # can therefore never reach Start-Process -ArgumentList.
    $process = Start-Process -FilePath $exe -WorkingDirectory $versionRoot -ArgumentList "--replay-candidate-check" -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "별록 재생 기반 후보 검증이 차단되었습니다." }
}
else {
    # Normal launch deliberately omits -ArgumentList instead of passing an
    # empty collection. This is required by Windows PowerShell 5.1.
    Start-Process -FilePath $exe -WorkingDirectory $versionRoot
    # The updater runs as a separate, already-verified copy of the current
    # Agent. It only prepares a new immutable version folder and changes the
    # next-launch pointer; it never stops the running broadcast session.
    try {
        Start-Process -FilePath $exe -WorkingDirectory $versionRoot -ArgumentList "--update-check" -WindowStyle Hidden | Out-Null
    }
    catch {
        # Network/update failures are deliberately fail-open. The verified
        # current Agent remains running and the next launch retries later.
    }
}
