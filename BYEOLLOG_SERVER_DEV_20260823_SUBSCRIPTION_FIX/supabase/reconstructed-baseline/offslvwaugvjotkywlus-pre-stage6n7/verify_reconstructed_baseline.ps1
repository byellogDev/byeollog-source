[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$here = [IO.Path]::GetFullPath($PSScriptRoot)
$bootstrap = Join-Path $here 'reconstructed_pre_stage6n7_bootstrap.sql'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $here '..\..\..'))
$reference = Join-Path $projectRoot 'supabase\reference-migrations\offslvwaugvjotkywlus-20260830\migrations'

if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) {
  throw "bootstrap missing: $bootstrap"
}
if (-not (Test-Path -LiteralPath $reference -PathType Container)) {
  throw "reference migration directory missing: $reference"
}

$sql = Get-Content -LiteralPath $bootstrap -Raw
$expectedTables = @(
  'bangsel_collector_logs','bangsel_collector_staging','bangsel_donations',
  'bangsel_fan_stations','bangsel_fans','bangsel_roulette_invalidations',
  'bangsel_roulette_rules','bangsel_task_import_items','bangsel_tasks',
  'byeollog_audit_log','byeollog_collector_devices','byeollog_dashboard_handoffs',
  'byeollog_inquiries','byeollog_signup_applications','byeollog_workspace_members',
  'byeollog_workspace_settings','byeollog_workspaces'
)

foreach ($table in $expectedTables) {
  $createPattern = "(?im)^create\s+table\s+public\.$([regex]::Escape($table))\s*\("
  if ([regex]::Matches($sql, $createPattern).Count -ne 1) {
    throw "expected exactly one CREATE TABLE for public.$table"
  }
  $rlsPattern = "(?im)^alter\s+table\s+public\.$([regex]::Escape($table))\s+enable\s+row\s+level\s+security\s*;"
  if ([regex]::Matches($sql, $rlsPattern).Count -ne 1) {
    throw "expected exactly one RLS enable statement for public.$table"
  }
}

$createTableCount = [regex]::Matches($sql, '(?im)^create\s+table\s+public\.').Count
if ($createTableCount -ne $expectedTables.Count) {
  throw "unexpected public CREATE TABLE count: $createTableCount"
}

$requiredFunctions = @(
  'get_public_workspace','get_public_bangsel','byeollog_approve_signup_application',
  'byeollog_bind_workspace_owner','bangsel_void_roulette_ws',
  'set_updated_at','set_fan_station_updated_at','set_bangsel_fans_updated_at',
  'set_bangsel_roulette_rules_updated_at'
)
foreach ($function in $requiredFunctions) {
  if ($sql -notmatch "(?im)^create\s+or\s+replace\s+function\s+public\.$([regex]::Escape($function))\s*\(") {
    throw "required bootstrap function missing: public.$function"
  }
}

if ($sql -match '(?im)^create\s+or\s+replace\s+function\s+public\.byeollog_withdraw_account\s*\(') {
  throw 'withdraw_account must be created by the first remote migration, not the bootstrap'
}

$signupBlock = [regex]::Match(
  $sql,
  '(?is)create\s+table\s+public\.byeollog_signup_applications\s*\((.*?)\n\);'
).Groups[1].Value
foreach ($column in @(
  'provisioning_state','setup_email_sent_at','setup_email_last_attempt_at',
  'setup_email_last_error','setup_email_attempts','status_token_issued_at'
)) {
  if ($signupBlock -match "(?im)^\s*$([regex]::Escape($column))\s+") {
    throw "Stage 6N8 signup column leaked into bootstrap: $column"
  }
}

$logBlock = [regex]::Match(
  $sql,
  '(?is)create\s+table\s+public\.bangsel_collector_logs\s*\((.*?)\n\);'
).Groups[1].Value
foreach ($column in @('workspace_id','device_id','retained_until')) {
  if ($logBlock -match "(?im)^\s*$([regex]::Escape($column))\s+") {
    throw "Stage 6N8 collector-log column leaked into bootstrap: $column"
  }
}

$migrations = @(Get-ChildItem -LiteralPath $reference -Filter '*.sql' -File | Sort-Object Name)
if ($migrations.Count -ne 79) {
  throw "expected 79 reference migrations, found $($migrations.Count)"
}
$expectedFirst = @(
  '20260814121415_p0_withdraw_transaction.sql',
  '20260814130048_stage6n7_existing_schema_baseline.sql',
  '20260814130058_p1_p2_account_security.sql',
  '20260814130408_p1_p2_collector_log_device_index.sql'
)
for ($i = 0; $i -lt $expectedFirst.Count; $i++) {
  if ($migrations[$i].Name -ne $expectedFirst[$i]) {
    throw "unexpected migration at position $($i + 1): $($migrations[$i].Name)"
  }
}

[pscustomobject]@{
  Status = 'PASS'
  BootstrapTables = $createTableCount
  RlsTables = $expectedTables.Count
  BootstrapFunctions = $requiredFunctions.Count
  ReferenceMigrations = $migrations.Count
  Boundary = 'pre-20260814121415'
} | Format-List
