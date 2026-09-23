[CmdletBinding()]
param(
  [ValidateRange(1024,65535)]
  [int]$Port = 17261,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$entryPoint = Join-Path $PSScriptRoot 'Run-NativeRouletteDigitalTwin.mjs'
$healthUrl = "http://127.0.0.1:$Port/api/health"
$controllerUrl = "http://127.0.0.1:$Port/"

function Test-TwinHealth {
  try {
    $response = Invoke-RestMethod -Method Get -Uri $healthUrl -TimeoutSec 1
    return $response.ok -eq $true -and $response.mode -eq 'local-digital-twin'
  } catch {
    return $false
  }
}

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
  throw '별록 디지털 트윈 실행 파일을 찾지 못했습니다.'
}

if (-not (Test-TwinHealth)) {
  $node = Get-Command node -ErrorAction Stop
  Start-Process -FilePath $node.Source `
    -ArgumentList @("`"$entryPoint`"",'--port',[string]$Port) `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden | Out-Null

  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 125
    if (Test-TwinHealth) { $ready = $true; break }
  }
  if (-not $ready) {
    throw '로컬 디지털 트윈 서버가 제한 시간 안에 준비되지 않았습니다.'
  }
}

if (-not $NoBrowser) {
  Start-Process $controllerUrl | Out-Null
}
