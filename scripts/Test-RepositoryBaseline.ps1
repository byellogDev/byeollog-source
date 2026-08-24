[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location $repositoryRoot

$agentRoot = Join-Path $repositoryRoot 'BYEOLLOG_AGENT_DEV_v07022'
$serverRoot = Join-Path $repositoryRoot 'BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX'

$requiredPaths = @(
    (Join-Path $agentRoot 'HurogiCollector.csproj'),
    (Join-Path $agentRoot 'AgentStoreTests\AgentStoreTests.csproj'),
    (Join-Path $serverRoot 'package.json'),
    (Join-Path $serverRoot 'SOURCE_FILE_SHA256SUMS.txt'),
    (Join-Path $serverRoot 'test\security-hardening.test.mjs')
)

foreach ($path in $requiredPaths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw 'Canonical source layout is incomplete. Use the approved Agent and server source trees.'
    }
}

# Do not print paths: a protected filename can itself reveal sensitive context.
$trackedPaths = @(& git ls-files)
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to read the Git index for the repository boundary check.'
}

$protectedPathPattern = '(?i)(^|/)(\.env(?:\.|$)|node_modules/|\.vercel/|bin/|obj/|artifacts/|ci-artifacts/|dist/|publish[^/]*/|downloads/|supabase/\.temp/|__pycache__/|\.tmp[^/]*/|tmp/|release_[^/]*/|\.release-[^/]*/|\.deploy_[^/]*/|\.obsolete_[^/]*/)|\.(pfx|p12|pem|key|dpapi|protected|zip|7z|rar|exe|msi|msix|msixbundle|appx|appxbundle|nupkg|snupkg|sqlite|sqlite-shm|sqlite-wal)$'
$protectedTrackedCount = @($trackedPaths | Where-Object { $_ -match $protectedPathPattern }).Count
if ($protectedTrackedCount -gt 0) {
    throw "Git index contains $protectedTrackedCount protected path(s). Remove them from the index before publishing."
}

# Exercise ignore policy with synthetic names only. This neither reads nor names
# any local credential/key files.
$ignoreCandidates = @(
    '.env',
    'nested/.env.local',
    'nested/release-signing.pfx',
    'nested/device.dpapi',
    'BYEOLLOG_AGENT_DEV_v07022/bin/Release/net8.0/byeollog.exe',
    'BYEOLLOG_AGENT_DEV_v07022/ci-artifacts/agent/byeollog.exe',
    'BYEOLLOG_AGENT_DEV_v07022/publish_candidate/byeollog.exe',
    'BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX/node_modules/example/index.js',
    'BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX/.vercel/output/config.json',
    'BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX/supabase/.temp/project-ref',
    'BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX/tools/__pycache__/helper.pyc',
    '.tmp_ci_preview/result.zip',
    'RELEASE_v999/package.zip'
)

foreach ($candidate in $ignoreCandidates) {
    & git check-ignore -q --no-index -- $candidate
    if ($LASTEXITCODE -ne 0) {
        throw 'The root .gitignore no longer protects a required generated or secret path category.'
    }
}

# Static-only Supabase audit. It never connects to a project, runs no SQL, and
# reports counts rather than function names or source text.
$migrationRoots = @(
    (Join-Path $agentRoot 'supabase\migrations'),
    (Join-Path $serverRoot 'supabase\migrations')
)
$migrationFiles = @($migrationRoots | ForEach-Object {
    if (Test-Path -LiteralPath $_ -PathType Container) {
        Get-ChildItem -LiteralPath $_ -Filter '*.sql' -File -Recurse
    }
})
if ($migrationFiles.Count -eq 0) {
    throw 'No Supabase migration files were found for the static security audit.'
}

$securityDefinerCount = 0
$missingSearchPathCount = 0
$publicExecutionGrantCount = 0
foreach ($migration in $migrationFiles) {
    $sql = Get-Content -LiteralPath $migration.FullName -Raw
    # Comments often describe SECURITY DEFINER routines; audit executable SQL
    # only so prose cannot create a false failing result.
    $executableSql = [regex]::Replace($sql, '(?s)/\*.*?\*/|--[^\r\n]*', '')
    $definerMatches = [regex]::Matches($executableSql, '(?is)security\s+definer')
    $securityDefinerCount += $definerMatches.Count
    foreach ($match in $definerMatches) {
        $following = $executableSql.Substring($match.Index, [Math]::Min(320, $executableSql.Length - $match.Index))
        if ($following -notmatch "(?is)set\s+search_path\s*=\s*''") {
            $missingSearchPathCount++
        }
    }
    $publicExecutionGrantCount += [regex]::Matches(
        $executableSql,
        '(?is)grant\s+execute\s+on\s+function(?:(?!;).)*\bto\s+(?:public|anon)\b'
    ).Count
}

if ($missingSearchPathCount -gt 0) {
    throw "Static Supabase audit found $missingSearchPathCount SECURITY DEFINER declaration(s) without a nearby empty search_path."
}
if ($publicExecutionGrantCount -gt 0) {
    throw "Static Supabase audit found $publicExecutionGrantCount direct EXECUTE grant(s) to PUBLIC or anon. Review with a live ACL snapshot before deployment."
}

Write-Host "Repository boundary check passed: canonical layout, ignored protected paths, and $securityDefinerCount SECURITY DEFINER declarations audited."
