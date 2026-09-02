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
    (Join-Path $serverRoot 'test\security-hardening.test.mjs'),
    (Join-Path $repositoryRoot 'BYEOLLOG_TTS_SERVICE\requirements.txt'),
    (Join-Path $repositoryRoot 'BYEOLLOG_TTS_RELAY\package-lock.json')
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

$protectedPathPattern = '(?i)(^|/)(\.env(?:\.|$)|node_modules/|\.vercel/|bin/|obj/|artifacts/|ci-artifacts/|dist/|publish(?!profiles(?:/|$))[^/]*/|downloads/|supabase/\.temp/|__pycache__/|\.tmp[^/]*/|tmp/|release_[^/]*/|\.release-[^/]*/|\.deploy_[^/]*/|\.obsolete_[^/]*/)|\.(pfx|p12|pem|key|dpapi|protected|zip|7z|rar|exe|msi|msix|msixbundle|appx|appxbundle|nupkg|snupkg|sqlite|sqlite-shm|sqlite-wal)$'
$boundaryPatternFixtures = @{
    'BYEOLLOG_AGENT_DEV_v07022/Properties/PublishProfiles/ByeollogBetaClickOnce.pubxml' = $false
    'BYEOLLOG_AGENT_DEV_v07022/publish_candidate/byeollog.exe' = $true
    'BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX/publish/app.js' = $true
}
foreach ($fixture in $boundaryPatternFixtures.GetEnumerator()) {
    if (($fixture.Key -match $protectedPathPattern) -ne $fixture.Value) {
        throw 'Repository boundary pattern fixture failed.'
    }
}
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
    # Six immutable historical migrations used explicit trusted-schema paths.
    # The current migration must harden all three affected live routines, and
    # any newly introduced non-empty declaration must still fail this gate.
    if ($missingSearchPathCount -ne 6) {
        throw "Static Supabase audit found $missingSearchPathCount SECURITY DEFINER declaration(s) without an empty search_path."
    }
    $remediationFiles = @(Get-ChildItem -LiteralPath (Join-Path $serverRoot 'supabase\migrations') `
        -Filter '*_harden_web_sessions_without_hot_path_latency.sql' -File)
    if ($remediationFiles.Count -ne 1) {
        throw 'The historical SECURITY DEFINER search_path remediation migration is missing or ambiguous.'
    }
    $remediationSql = Get-Content -LiteralPath $remediationFiles[0].FullName -Raw
    $requiredRemediations = @(
        '(?is)alter\s+function\s+public\.ensure_soop_runtime_controls_v1\s*\(\s*\)\s+set\s+search_path\s*=\s*''''',
        '(?is)alter\s+function\s+private\.notify_soop_gateway_incident_v1\s*\(\s*text\s*,\s*uuid\s*,\s*uuid\s*,\s*timestamptz\s*\)\s+set\s+search_path\s*=\s*''''',
        '(?is)alter\s+function\s+private\.check_soop_gateway_heartbeats_v1\s*\(\s*\)\s+set\s+search_path\s*=\s*'''''
    )
    foreach ($requiredRemediation in $requiredRemediations) {
        if ($remediationSql -notmatch $requiredRemediation) {
            throw 'The historical SECURITY DEFINER search_path remediation is incomplete.'
        }
    }
}
if ($publicExecutionGrantCount -gt 0) {
    throw "Static Supabase audit found $publicExecutionGrantCount direct EXECUTE grant(s) to PUBLIC or anon. Review with a live ACL snapshot before deployment."
}

Write-Host "Repository boundary check passed: canonical layout, ignored protected paths, and $securityDefinerCount SECURITY DEFINER declarations audited."
