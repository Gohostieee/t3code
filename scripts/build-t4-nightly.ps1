param([string]$Version)
# Windows PowerShell reports native progress on stderr as non-terminating errors.
$ErrorActionPreference = "Continue"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Version) {
  $stamp = (Get-Date).ToUniversalTime()
  $baseVersion = (Get-Content -LiteralPath (Join-Path $repoRoot "apps/desktop/package.json") -Raw -ErrorAction Stop | ConvertFrom-Json).version
  $revision = [int][Math]::Floor($stamp.TimeOfDay.TotalSeconds)
  $Version = "$baseVersion-nightly.$($stamp.ToString('yyyyMMdd')).$revision"
}
if ($Version -notmatch '^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$') {
  throw "Expected a nightly version such as 0.1.2-nightly.20261026.1234."
}
${previousReuseMonitor} = $env:T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR
${previousUpdateRepository} = $env:T4CODE_DESKTOP_UPDATE_REPOSITORY
Push-Location -LiteralPath $repoRoot
try {
  & cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml --target x86_64-pc-windows-msvc
  if ($LASTEXITCODE -ne 0) { throw "Resource helper build failed (exit $LASTEXITCODE)." }
  $env:T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR = "true"
  $env:T4CODE_DESKTOP_UPDATE_REPOSITORY = "Gohostieee/t3code"
  & vp run dist:desktop:win:x64 --build-version $Version --output-dir release/t4code
  if ($LASTEXITCODE -ne 0) { throw "T4 Code build failed (exit $LASTEXITCODE)." }

  $artifactDir = Join-Path $repoRoot "release/t4code"
  $installerName = "T4-Code-$Version-x64.exe"
  $artifactNames = @($installerName, "$installerName.blockmap", "nightly.yml")
  foreach ($name in $artifactNames) {
    if (-not (Test-Path -LiteralPath (Join-Path $artifactDir $name) -PathType Leaf)) {
      throw "The nightly build is missing $name."
    }
  }
  $commit = & git rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw "Cannot record the build's source commit." }
  @("Version: $Version", "Commit: $commit", "Repository: https://github.com/Gohostieee/t3code") |
    Set-Content -LiteralPath (Join-Path $artifactDir "SOURCE.txt") -Encoding ascii -ErrorAction Stop
  $artifactNames + @("SOURCE.txt") | ForEach-Object {
    $hash = (Get-FileHash -LiteralPath (Join-Path $artifactDir $_) -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    "$hash  $_"
  } | Set-Content -LiteralPath (Join-Path $artifactDir "SHA256SUMS.txt") -Encoding ascii -ErrorAction Stop
  Write-Output "T4 Code nightly $Version is ready in $artifactDir"
} finally {
  $env:T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR = $previousReuseMonitor
  $env:T4CODE_DESKTOP_UPDATE_REPOSITORY = $previousUpdateRepository
  Pop-Location
}
