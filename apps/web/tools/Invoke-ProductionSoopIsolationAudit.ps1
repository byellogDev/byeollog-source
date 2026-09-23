[CmdletBinding()]
param(
  [switch]$FullHistory
)

$ErrorActionPreference='Stop'
$AuditSqlName=if($FullHistory){'audit_soop_workspace_isolation_full_history.sql'}else{'audit_soop_workspace_isolation.sql'}
$AuditSqlPath=Join-Path $PSScriptRoot "sql\$AuditSqlName"
if(-not (Test-Path -LiteralPath $AuditSqlPath -PathType Leaf)){
  throw "SOOP isolation audit SQL is missing: $AuditSqlPath"
}

& npm exec --yes --package=supabase@latest -- supabase db query --linked --file $AuditSqlPath --output-format json
if($LASTEXITCODE -ne 0){throw 'Production SOOP workspace isolation audit failed'}
