[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$checks = @()
$package = $PSScriptRoot.TrimEnd('\', '/')

$reportRoot = Join-Path ([IO.Path]::GetTempPath()) "ByeollogAgent\tester-readiness"
$report = Join-Path $reportRoot "TESTER_READINESS_REPORT.json"

function Add-Check {
    param([string]$Id, [ValidateSet("pass", "warning", "blocked")][string]$State, [string]$Message)
    $script:checks += [ordered]@{ id = $Id; state = $State; message = $Message }
}

$isWindows = [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)
Add-Check "windows" $(if ($isWindows) { "pass" } else { "blocked" }) $(if ($isWindows) { "Windows 확인" } else { "Windows 10/11 x64가 필요합니다." })

$os64 = [Environment]::Is64BitOperatingSystem
Add-Check "x64_os" $(if ($os64) { "pass" } else { "blocked" }) $(if ($os64) { "64비트 OS 확인" } else { "64비트 Windows가 필요합니다." })

if ($isWindows) {
    $osVersion = [Environment]::OSVersion.Version
    $supportedWindows = $osVersion.Major -ge 10
    Add-Check "windows_version" $(if ($supportedWindows) { "pass" } else { "blocked" }) $(if ($supportedWindows) { "Windows 버전 $osVersion 확인" } else { "Windows 10 이상이 필요합니다." })
}
else { Add-Check "windows_version" "blocked" "Windows 버전을 확인할 수 없습니다." }

$psSupported = $PSVersionTable.PSVersion.Major -ge 5
Add-Check "powershell" $(if ($psSupported) { "pass" } else { "blocked" }) $(if ($psSupported) { "PowerShell $($PSVersionTable.PSVersion) 확인" } else { "PowerShell 5.1 이상이 필요합니다." })

try {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw "LOCALAPPDATA is unavailable." }
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:LOCALAPPDATA))
    $enough = $drive.AvailableFreeSpace -ge 500MB
    Add-Check "disk_space" $(if ($enough) { "pass" } else { "blocked" }) $(if ($enough) { "설치 여유 공간 500MB 이상 확인" } else { "최소 500MB의 여유 공간이 필요합니다." })
}
catch { Add-Check "disk_space" "warning" "설치 여유 공간을 자동 확인하지 못했습니다." }

# Microsoft documents this product ID and requires a non-empty pv value greater
# than 0.0.0.0 for Evergreen WebView2 Runtime detection.
$webViewVersion = $null
if ($isWindows) {
    foreach ($registryPath in @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    )) {
        try {
            $value = [string](Get-ItemPropertyValue -LiteralPath $registryPath -Name "pv" -ErrorAction Stop)
            $parsed = [Version]::new()
            if ([Version]::TryParse($value, [ref]$parsed) -and $parsed -gt [Version]"0.0.0.0") {
                $webViewVersion = $parsed.ToString()
                break
            }
        }
        catch { }
    }
}
Add-Check "webview2" $(if ($null -ne $webViewVersion) { "pass" } else { "blocked" }) $(if ($null -ne $webViewVersion) { "WebView2 Runtime $webViewVersion 확인" } else { "Microsoft Edge WebView2 Runtime 설치가 필요합니다." })

try {
    $installer = Join-Path $package "Install-Byeollog.ps1"
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Installer is missing." }
    & $installer -Mode VerifyPackage | Out-Null
    Add-Check "package_integrity" "pass" "Tester 패키지 manifest v2와 전체 파일 해시 확인"
}
catch { Add-Check "package_integrity" "blocked" "Tester 패키지 무결성 확인에 실패했습니다. ZIP을 다시 받으세요." }

$collectorRunning = @(Get-Process -Name "byeollog" -ErrorAction SilentlyContinue).Count -gt 0
Add-Check "collector_stopped" $(if ($collectorRunning) { "blocked" } else { "pass" }) $(if ($collectorRunning) { "업데이트 전 별록 에이전트를 트레이에서 완전히 종료하세요." } else { "별록 에이전트 종료 상태 확인" })

try {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 43120)
    $listener.Start()
    $listener.Stop()
    Add-Check "overlay_port" "pass" "고정 Browser Source 포트 43120 사용 가능"
}
catch { Add-Check "overlay_port" "blocked" "127.0.0.1:43120 포트를 다른 프로그램이 사용 중입니다." }

try {
    $obs = New-Object Net.Sockets.TcpClient
    try {
        $connection = $obs.ConnectAsync("127.0.0.1", 4455)
        if ($connection.Wait(800) -and $obs.Connected) {
            Add-Check "obs_websocket" "pass" "OBS WebSocket 4455 응답 확인"
        }
        else { Add-Check "obs_websocket" "warning" "OBS를 켜고 WebSocket 서버(기본 4455)를 확인하세요." }
    }
    finally { $obs.Dispose() }
}
catch { Add-Check "obs_websocket" "warning" "OBS를 켜고 WebSocket 서버(기본 4455)를 확인하세요." }

$blocked = @($checks | Where-Object { $_.state -eq "blocked" }).Count
$warnings = @($checks | Where-Object { $_.state -eq "warning" }).Count
$reportValue = [ordered]@{
    schemaVersion = 2
    generatedAtUtc = [DateTimeOffset]::UtcNow.ToString("O")
    collectorVersion = "0.7.0.32"
    overall = $(if ($blocked -gt 0) { "blocked" } elseif ($warnings -gt 0) { "ready_with_warnings" } else { "ready" })
    blockedCount = $blocked
    warningCount = $warnings
    checks = $checks
}
$reportDirectory = Split-Path -Parent $report
New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
[IO.File]::WriteAllText($report, ($reportValue | ConvertTo-Json -Depth 6), $utf8NoBom)

Write-Host ""
foreach ($check in $checks) { Write-Host ("[{0}] {1}" -f $check.state.ToUpperInvariant(), $check.message) }
Write-Host ""
Write-Host "결과: $($reportValue.overall)"
Write-Host "보고서: $report"
if ($blocked -gt 0) { exit 2 }
