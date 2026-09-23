[CmdletBinding()]
param()

$ErrorActionPreference='Stop'
$AuditSqlPath=Join-Path $PSScriptRoot 'sql\audit_workspace_asset_integrity_full_history.sql'
if(-not (Test-Path -LiteralPath $AuditSqlPath -PathType Leaf)){
  throw "Workspace asset audit SQL is missing: $AuditSqlPath"
}

& npm exec --yes --package=supabase@latest -- supabase db query --linked --file $AuditSqlPath --output-format json
if($LASTEXITCODE -ne 0){throw 'Production workspace asset integrity audit failed'}
