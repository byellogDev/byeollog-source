param(
  [int]$Hours=24,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
$repository=Split-Path -Parent $PSScriptRoot
$node=(Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$stdout=Join-Path $OutputDirectory 'runner.stdout.log'
$stderr=Join-Path $OutputDirectory 'runner.stderr.log'
Set-Location -LiteralPath $repository
& $node 'tools/Run-SoopGatewaySoak.mjs' '--hours' ([string]$Hours) '--output' $OutputDirectory 1>>$stdout 2>>$stderr
exit $LASTEXITCODE
