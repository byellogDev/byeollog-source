[CmdletBinding()]
param(
  [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$ProjectRef = 'offslvwaugvjotkywlus',
  [string]$SnapshotDate = '20260830',
  [string]$SupabaseCliVersion = '2.116.0'
)

$ErrorActionPreference = 'Stop'

function Get-StringSha256 {
  param([Parameter(Mandatory)][string]$Value)

  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  return [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData($bytes)
  ).ToLowerInvariant()
}

function Get-SqlFingerprint {
  param(
    [Parameter(Mandatory)][string]$Path,
    [switch]$IgnoreFullLineComments
  )

  $text = [IO.File]::ReadAllText($Path)
  $text = $text.TrimStart([char]0xFEFF) -replace "`r`n?", "`n"

  if ($IgnoreFullLineComments) {
    $text = $text -replace '(?m)^\s*--[^\n]*(?:\n|$)', ''
  }

  # migration fetch separates history-table statement-array entries with a
  # semicolon. Some stored statements already end with one, producing `;;` in
  # the fetched file. Collapse only repeated statement separators so this CLI
  # serialization detail does not look like SQL drift.
  do {
    $previous = $text
    $text = $text -replace ';\s*;', ';'
  } while ($text -ne $previous)

  $normalized = ($text -replace '\s+', ' ').Trim()
  return Get-StringSha256 -Value $normalized
}

function Get-MigrationRows {
  param([Parameter(Mandatory)][string]$Directory)

  return @(
    Get-ChildItem -LiteralPath $Directory -File -Filter '*.sql' |
      Sort-Object Name |
      ForEach-Object {
        if ($_.Name -notmatch '^(\d{14})_(.+)\.sql$') {
          throw "Invalid migration filename: $($_.FullName)"
        }

        [PSCustomObject]@{
          File = $_.Name
          Version = $matches[1]
          Name = $matches[2]
          Bytes = $_.Length
          Sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
          SqlFingerprint = Get-SqlFingerprint -Path $_.FullName
          SqlFingerprintIgnoringFullLineComments = Get-SqlFingerprint -Path $_.FullName -IgnoreFullLineComments
        }
      }
  )
}

$repository = [IO.Path]::GetFullPath($RepositoryRoot)
$activeDirectory = [IO.Path]::GetFullPath((Join-Path $repository 'supabase\migrations'))
$referenceRoot = [IO.Path]::GetFullPath((Join-Path $repository "supabase\reference-migrations\$ProjectRef-$SnapshotDate"))
$referenceDirectory = [IO.Path]::GetFullPath((Join-Path $referenceRoot 'migrations'))
$repositoryPrefix = $repository.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

foreach ($path in @($activeDirectory, $referenceRoot, $referenceDirectory)) {
  if (-not $path.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Audit path escaped repository: $path"
  }
}

if (-not (Test-Path -LiteralPath $activeDirectory -PathType Container)) {
  throw "Active migration directory is missing: $activeDirectory"
}
if (-not (Test-Path -LiteralPath $referenceDirectory -PathType Container)) {
  throw "Reference migration directory is missing: $referenceDirectory"
}

$localRows = Get-MigrationRows -Directory $activeDirectory
$remoteRows = Get-MigrationRows -Directory $referenceDirectory

$duplicateRemoteVersions = @($remoteRows | Group-Object Version | Where-Object Count -gt 1)
if ($duplicateRemoteVersions.Count -ne 0) {
  throw "Reference contains duplicate migration versions: $($duplicateRemoteVersions.Name -join ', ')"
}

$comparison = @(
  foreach ($local in $localRows) {
    $byVersion = @($remoteRows | Where-Object Version -eq $local.Version)
    $byName = @($remoteRows | Where-Object Name -eq $local.Name)
    $bySql = @($remoteRows | Where-Object SqlFingerprint -eq $local.SqlFingerprint)
    $bySqlWithoutComments = @(
      $remoteRows |
        Where-Object SqlFingerprintIgnoringFullLineComments -eq $local.SqlFingerprintIgnoringFullLineComments
    )

    $remote = $null
    $classification = $null

    if ($byVersion.Count -eq 1) {
      $remote = $byVersion[0]
      if ($remote.SqlFingerprint -eq $local.SqlFingerprint) {
        $classification = 'exact_identity_and_sql'
      } elseif (
        $remote.SqlFingerprintIgnoringFullLineComments -eq
          $local.SqlFingerprintIgnoringFullLineComments
      ) {
        $classification = 'exact_identity_comments_only'
      } else {
        $classification = 'exact_version_sql_drift'
      }
    } elseif ($byName.Count -eq 1) {
      $remote = $byName[0]
      if ($remote.SqlFingerprint -eq $local.SqlFingerprint) {
        $classification = 'same_name_timestamp_only'
      } elseif (
        $remote.SqlFingerprintIgnoringFullLineComments -eq
          $local.SqlFingerprintIgnoringFullLineComments
      ) {
        $classification = 'same_name_comments_only'
      } else {
        $classification = 'same_name_sql_drift'
      }
    } elseif ($bySql.Count -eq 1) {
      $remote = $bySql[0]
      $classification = 'cross_name_exact_sql'
    } elseif ($bySqlWithoutComments.Count -eq 1) {
      $remote = $bySqlWithoutComments[0]
      $classification = 'cross_name_comments_only'
    } else {
      $classification = 'local_only_or_superseded'
    }

    [PSCustomObject]@{
      Classification = $classification
      LocalVersion = $local.Version
      LocalName = $local.Name
      LocalFile = $local.File
      LocalSha256 = $local.Sha256
      RemoteVersion = if ($null -ne $remote) { $remote.Version } else { '' }
      RemoteName = if ($null -ne $remote) { $remote.Name } else { '' }
      RemoteFile = if ($null -ne $remote) { $remote.File } else { '' }
      RemoteSha256 = if ($null -ne $remote) { $remote.Sha256 } else { '' }
    }
  }
)

$mappedRemoteFiles = @($comparison.RemoteFile | Where-Object { $_ } | Sort-Object -Unique)
$remoteOnly = @(
  $remoteRows |
    Where-Object File -notin $mappedRemoteFiles |
    Select-Object Version, Name, File, Bytes, Sha256
)

$classificationCounts = [ordered]@{}
foreach ($group in ($comparison | Group-Object Classification | Sort-Object Name)) {
  $classificationCounts[$group.Name] = $group.Count
}

$summary = [ordered]@{
  projectRef = $ProjectRef
  snapshotDate = $SnapshotDate
  supabaseCliVersion = $SupabaseCliVersion
  generatedAtUtc = [DateTime]::UtcNow.ToString('o')
  activeMigrationCount = $localRows.Count
  remoteReferenceMigrationCount = $remoteRows.Count
  remoteUniqueVersionCount = @($remoteRows.Version | Sort-Object -Unique).Count
  mappedRemoteMigrationCount = $mappedRemoteFiles.Count
  remoteOnlyMigrationCount = $remoteOnly.Count
  classificationCounts = $classificationCounts
  replayReadiness = [ordered]@{
    status = 'blocked_missing_pre_stage6n7_bootstrap'
    evidenceFile = 'migrations/20260814130048_stage6n7_existing_schema_baseline.sql'
    evidence = 'The remote history explicitly says this is not a bootstrap file for an empty database.'
  }
}

$comparison |
  Export-Csv -LiteralPath (Join-Path $referenceRoot 'LOCAL_TO_REMOTE_COMPARISON.csv') -NoTypeInformation -Encoding utf8
$remoteOnly |
  Export-Csv -LiteralPath (Join-Path $referenceRoot 'REMOTE_ONLY_MIGRATIONS.csv') -NoTypeInformation -Encoding utf8

$manifestLines = @(
  $remoteRows | ForEach-Object { '{0}  migrations/{1}' -f $_.Sha256, $_.File }
)
[IO.File]::WriteAllLines(
  (Join-Path $referenceRoot 'REMOTE_SHA256SUMS.txt'),
  $manifestLines,
  [Text.UTF8Encoding]::new($false)
)
[IO.File]::WriteAllText(
  (Join-Path $referenceRoot 'SUMMARY.json'),
  (($summary | ConvertTo-Json -Depth 8) + "`n"),
  [Text.UTF8Encoding]::new($false)
)

$summary
