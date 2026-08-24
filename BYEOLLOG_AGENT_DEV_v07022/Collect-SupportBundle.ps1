[CmdletBinding()]
param(
    [string]$OutputDirectory = "",
    [switch]$Confirmed
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$installRoot = Join-Path $env:LOCALAPPDATA "Programs\ByeollogCollector"
$dataRoot = Join-Path $env:LOCALAPPDATA "ByeollogAgent"
$versionPattern = '^\d+\.\d+\.\d+(?:\.\d+)?$'

if (-not $Confirmed) {
    Write-Host ""
    Write-Host "별록 지원 ZIP은 원문 후원·닉네임·메시지·계정·토큰·OBS 비밀번호를 포함하지 않습니다."
    Write-Host "설치 무결성, 익명 상태 파일 메타데이터, 오류 종류별 건수만 수집합니다."
    $answer = Read-Host "동의하고 만들려면 SUPPORT 입력"
    if ($answer -cne "SUPPORT") { throw "Support bundle creation was canceled." }
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $dataRoot "support-bundles"
}
$outputRoot = $OutputDirectory
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$outputRootItem = Get-Item -LiteralPath $outputRoot -Force
if (($outputRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Support bundle output directory cannot be a reparse point."
}
$staging = Join-Path ([IO.Path]::GetTempPath()) ("byeollog-support-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $staging | Out-Null

function Read-SmallJson {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $item = Get-Item -LiteralPath $Path
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -le 0 -or $item.Length -gt 1MB) { return $null }
    try { return (Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json) }
    catch { return $null }
}

function Get-FileMetadata {
    param([string]$Name)
    $path = Join-Path $dataRoot $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return [ordered]@{ name = $Name; present = $false }
    }
    $item = Get-Item -LiteralPath $path
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        return [ordered]@{ name = $Name; present = $true; safe = $false; reason = "reparse_point" }
    }
    return [ordered]@{
        name = $Name
        present = $true
        safe = $true
        byteSize = [int64]$item.Length
        ageMinutes = [Math]::Max(0, [Math]::Floor(([DateTime]::UtcNow - $item.LastWriteTimeUtc).TotalMinutes))
    }
}

function Get-SafeLogCategoryCounts {
    $result = [ordered]@{
        state_guard = 0
        webview_boundary = 0
        agent_reconnect = 0
        device_auth = 0
        overlay_sync = 0
        obs_transport = 0
        upload_retry = 0
        unclassified = 0
    }
    $path = Join-Path $dataRoot "collector.log"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $result }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -gt 64MB) { return $result }
    foreach ($line in @(Get-Content -LiteralPath $path -Encoding UTF8 -Tail 5000 -ErrorAction SilentlyContinue)) {
        if ($line -match 'state|snapshot|복구|스키마') { $result.state_guard++; continue }
        if ($line -match 'WebView|navigation|message_blocked|popup|permission|download') { $result.webview_boundary++; continue }
        if ($line -match '재연결|연결 대기|Agent.*대기') { $result.agent_reconnect++; continue }
        if ($line -match '장치 인증|장치 등록|device_auth|device_enrollment') { $result.device_auth++; continue }
        if ($line -match '이미지.*동기화|overlay|manifest') { $result.overlay_sync++; continue }
        if ($line -match 'OBS|WebSocket') { $result.obs_transport++; continue }
        if ($line -match '업로드|재시도|retry') { $result.upload_retry++; continue }
        $result.unclassified++
    }
    return $result
}

function Get-InstalledIntegrity {
    $result = [ordered]@{ state = "not_installed" }
    try {
        $pointer = Read-SmallJson (Join-Path $installRoot "current.json")
        if ($null -eq $pointer) { return $result }
        $version = [string]$pointer.version
        if ($version -notmatch $versionPattern) { return [ordered]@{ state = "invalid_pointer" } }
        $root = Join-Path (Join-Path $installRoot "versions") $version
        $manifestPath = Join-Path $root "release-manifest.json"
        $manifest = Read-SmallJson $manifestPath
        if ($null -eq $manifest) { return [ordered]@{ state = "missing_manifest"; version = $version } }
        if ([string]$manifest.product -ne "byeollog-collector" -or [string]$manifest.version -ne $version) {
            return [ordered]@{ state = "invalid_manifest_identity"; version = $version }
        }
        $schema = [int]$manifest.schemaVersion
        # Keep one-file releases as an array under StrictMode. Conditional
        # pipeline output is otherwise unwrapped to a scalar.
        $appEntries = @(
            if ($schema -eq 1) {
                $manifest.files
            }
            elseif ($schema -eq 2) {
                $manifest.files | Where-Object { [string]$_.role -eq "app" }
            }
        )
        if ($appEntries.Count -lt 1 -or $appEntries.Count -gt 2) {
            return [ordered]@{ state = "invalid_app_file_set"; version = $version; manifestSchema = $schema }
        }
        $ok = $true
        $hasExe = $false
        foreach ($entry in $appEntries) {
            $name = [string]$entry.path
            if (@("byeollog.exe", "WebView2Loader.dll") -notcontains $name) { $ok = $false; continue }
            if ($name -eq "byeollog.exe") { $hasExe = $true }
            $path = Join-Path $root $name
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $ok = $false; continue }
            $item = Get-Item -LiteralPath $path -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $ok = $false; continue }
            $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
            if ($actualHash -ne ([string]$entry.sha256).ToLowerInvariant() -or $item.Length -ne [int64]$entry.byteSize) { $ok = $false }
        }
        if (-not $hasExe) { $ok = $false }
        $authenticityMode = if ($schema -eq 2 -and $manifest.PSObject.Properties.Name -contains "authenticity") {
            [string]$manifest.authenticity.mode
        }
        else { "legacy_manifest_v1" }
        return [ordered]@{
            state = $(if ($ok) { "verified" } else { "mismatch" })
            version = $version
            manifestSchema = $schema
            authenticityMode = $authenticityMode
        }
    }
    catch { return [ordered]@{ state = "integrity_check_error" } }
}

try {
    $stateSchema = Read-SmallJson (Join-Path $dataRoot "state-schema.json")
    $backupCount = @(Get-ChildItem -LiteralPath (Join-Path $dataRoot "state-backups") -Directory -ErrorAction SilentlyContinue).Count
    $summary = [ordered]@{
        schemaVersion = 2
        generatedAtUtc = [DateTimeOffset]::UtcNow.ToString("O")
        collectionPolicy = "allowlisted_metadata_only_no_raw_logs"
        collectorRunning = @(Get-Process -Name "byeollog" -ErrorAction SilentlyContinue).Count -gt 0
        system = [ordered]@{
            osVersion = [Environment]::OSVersion.Version.ToString()
            osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
            processArchitecture = [Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
            powershellMajor = $PSVersionTable.PSVersion.Major
        }
        installedRelease = Get-InstalledIntegrity
        state = [ordered]@{
            schemaVersion = $(if ($null -eq $stateSchema) { $null } else { [int]$stateSchema.SchemaVersion })
            backupCount = $backupCount
            files = @(
                Get-FileMetadata "state-schema.json"
                Get-FileMetadata "vnext_agent.sqlite"
                Get-FileMetadata "vnext_agent_credentials.json"
                Get-FileMetadata "obs_settings.json"
                Get-FileMetadata "windows_capture_settings.json"
                Get-FileMetadata "collector.log"
                Get-FileMetadata "startup_trace.txt"
                Get-FileMetadata "login_startup_error.txt"
            )
        }
        logCategoryCounts = Get-SafeLogCategoryCounts
    }

    [IO.File]::WriteAllText(
        (Join-Path $staging "support-summary.json"),
        ($summary | ConvertTo-Json -Depth 10),
        $utf8NoBom)
    [IO.File]::WriteAllText(
        (Join-Path $staging "PRIVACY_NOTICE_KO.txt"),
        "별록 개인정보 최소화 지원 ZIP`r`n`r`n이 ZIP은 원문 로그, 파일 경로, 이메일 주소, 계정/장치/이벤트 ID, 후원자, 닉네임, 메시지, 규칙 내용, 비밀번호, access/refresh/device token을 포함하지 않습니다. 설치 무결성 판정, 상태 파일의 이름/크기/수정 경과, 오류 범주별 건수만 포함합니다. 별록 관리자에게만 전달하고 해결 뒤 삭제하세요.`r`n",
        $utf8NoBom)

    $scanPatterns = @(
        'sb_secret_[A-Za-z0-9_-]+',
        'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.',
        '(?i)bearer\s+[A-Za-z0-9._-]+',
        '[A-Za-z0-9.!#$%&''*+\/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
    )
    foreach ($file in @(Get-ChildItem -LiteralPath $staging -File)) {
        $text = Get-Content -Raw -LiteralPath $file.FullName -Encoding UTF8
        foreach ($pattern in $scanPatterns) {
            if ($text -match $pattern) { throw "Privacy scan rejected generated support content." }
        }
    }

    $manifestEntries = Get-ChildItem -LiteralPath $staging -File |
        Sort-Object Name |
        ForEach-Object {
            [ordered]@{
                path = $_.Name
                byteSize = [int64]$_.Length
                sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
            }
        }
    [IO.File]::WriteAllText(
        (Join-Path $staging "support-manifest.json"),
        (([ordered]@{ schemaVersion = 1; files = @($manifestEntries) }) | ConvertTo-Json -Depth 6),
        $utf8NoBom)

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
    $zip = Join-Path $outputRoot ("byeollog-support-" + $stamp + ".zip")
    Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip -CompressionLevel Optimal
    if (-not (Test-Path -LiteralPath $zip -PathType Leaf) -or (Get-Item -LiteralPath $zip).Length -le 0) {
        throw "Support ZIP was not created."
    }
    Write-Host ""
    Write-Host "지원 ZIP 생성 완료:"
    Write-Host $zip
}
finally {
    if (Test-Path -LiteralPath $staging -PathType Container) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}
