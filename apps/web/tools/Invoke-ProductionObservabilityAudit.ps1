[CmdletBinding()]
param()

$ErrorActionPreference='Stop'
$AuditSqlPath=Join-Path $PSScriptRoot 'sql\audit_operational_observability.sql'
if(-not (Test-Path -LiteralPath $AuditSqlPath -PathType Leaf)){
  throw "Operational observability audit SQL is missing: $AuditSqlPath"
}

& npm exec --yes --package=supabase@latest -- supabase db query --linked --file $AuditSqlPath --output-format json
if($LASTEXITCODE -ne 0){throw 'Production operational observability audit failed'}
