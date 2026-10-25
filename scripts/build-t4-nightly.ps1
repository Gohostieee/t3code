param([string]$Version)
# Windows PowerShell reports native progress on stderr as non-terminating errors.
$ErrorActionPreference = "Continue"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $stamp = Get-Date
  $baseVersion = (Get-Content -LiteralPath (Join-Path $repoRoot "apps/desktop/package.json") -Raw -ErrorAction Stop | ConvertFrom-Json).version
  $revision = [int]$stamp.TimeOfDay.TotalSeconds
  $Version = "$baseVersion-nightly.$($stamp.ToString('yyyyMMdd')).$revision"
}
${previousReuseMonitor} = $env:T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR
Push-Location -LiteralPath $repoRoot
try {
  & cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target x86_64-pc-windows-msvc
  if ($LASTEXITCODE -ne 0) { throw "Resource helper build failed (exit $LASTEXITCODE)." }
  $env:T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR = "true"
  & vp run dist:desktop:win:x64 --build-version $Version --output-dir release/t4code
  if ($LASTEXITCODE -ne 0) { throw "T4 Code build failed (exit $LASTEXITCODE)." }
} finally {
  $env:T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR = $previousReuseMonitor
  Pop-Location
}
