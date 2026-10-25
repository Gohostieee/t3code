param([string]$Version)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $stamp = Get-Date
  $baseVersion = (Get-Content -LiteralPath (Join-Path $repoRoot "apps/desktop/package.json") -Raw | ConvertFrom-Json).version
  $revision = [int]$stamp.TimeOfDay.TotalSeconds
  $Version = "$baseVersion-nightly.$($stamp.ToString('yyyyMMdd')).$revision"
}
Push-Location -LiteralPath $repoRoot
try {
  & vp run dist:desktop:win:x64 --build-version $Version --output-dir release/t4code
  if ($LASTEXITCODE -ne 0) { throw "T4 Code build failed (exit $LASTEXITCODE)." }
} finally {
  Pop-Location
}
