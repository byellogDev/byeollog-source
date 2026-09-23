[CmdletBinding()]
param(
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'SOURCE_FILE_SHA256SUMS.txt')
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($SourceRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$output = [IO.Path]::GetFullPath($OutputPath)
$prefix = $root + [IO.Path]::DirectorySeparatorChar
if (-not $output.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Manifest output must stay inside SourceRoot.'
}

$relativePaths = [Collections.Generic.List[string]]::new()
foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File) {
  $full = [IO.Path]::GetFullPath($file.FullName)
  if ($full.Equals($output, [StringComparison]::OrdinalIgnoreCase)) { continue }
  $relative = $full.Substring($prefix.Length).Replace('\', '/')
  if ($relative.StartsWith('.vercel/', [StringComparison]::OrdinalIgnoreCase)) { continue }
  if ($relative.StartsWith('node_modules/', [StringComparison]::OrdinalIgnoreCase)) { continue }
  if ($relative.StartsWith('.git/', [StringComparison]::OrdinalIgnoreCase)) { continue }
  if ($relative.StartsWith('.tmp', [StringComparison]::OrdinalIgnoreCase)) { continue }
  if ($relative.StartsWith('supabase/.temp/', [StringComparison]::OrdinalIgnoreCase)) { continue }
  if ($relative.Equals('.env', [StringComparison]::OrdinalIgnoreCase) -or
      $relative.StartsWith('.env.', [StringComparison]::OrdinalIgnoreCase)) { continue }
  $relativePaths.Add($relative)
}

$paths = $relativePaths.ToArray()
[Array]::Sort($paths, [StringComparer]::Ordinal)
$lines = foreach ($relative in $paths) {
  $full = Join-Path $root ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
  $hash = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
  "$hash  $relative"
}

[IO.File]::WriteAllText($output, (($lines -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
[PSCustomObject]@{ Output = $output; Files = $lines.Count }
