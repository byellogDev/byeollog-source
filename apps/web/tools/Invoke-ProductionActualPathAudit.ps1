[CmdletBinding()]
param()

$ErrorActionPreference='Stop'
$AuditSqlPath=Join-Path $PSScriptRoot 'sql\audit_actual_product_path_last24h.sql'
if(-not (Test-Path -LiteralPath $AuditSqlPath -PathType Leaf)){
  throw "Actual product path audit SQL is missing: $AuditSqlPath"
}

& npm exec --yes --package=supabase@latest -- supabase db query --linked --file $AuditSqlPath --output-format json
if($LASTEXITCODE -ne 0){throw 'Production actual product path audit failed'}
