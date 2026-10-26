param([switch]$SkipInstall)

# Native tools may write progress on stderr; check their exit codes explicitly.
$ErrorActionPreference = "Continue"
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $repoRoot ".t3/nightly"
$logDir = Join-Path $stateDir "logs"
New-Item -ItemType Directory -Path $logDir -Force -ErrorAction Stop | Out-Null
$toolsFile = Join-Path $stateDir "tool-paths.json"
if (Test-Path -LiteralPath $toolsFile) {
  $toolPaths = Get-Content -LiteralPath $toolsFile -Raw -ErrorAction Stop | ConvertFrom-Json
  $env:Path = (@($toolPaths) + @($env:Path)) -join [IO.Path]::PathSeparator
}
$logPath = Join-Path $logDir "$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')).log"
Start-Transcript -LiteralPath $logPath -ErrorAction Stop | Out-Null
Push-Location -LiteralPath $repoRoot
try {
  $dirty = & git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw "Cannot inspect the nightly checkout." }
  if ($dirty) { throw "The nightly checkout has uncommitted changes; refusing to update it." }
  & git fetch origin main
  if ($LASTEXITCODE -ne 0) { throw "Cannot fetch the nightly source." }
  & git merge --ff-only FETCH_HEAD
  if ($LASTEXITCODE -ne 0) { throw "The nightly checkout has diverged from main; refusing to overwrite it." }
  $commit = & git rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw "Cannot identify the nightly source." }
  $mainCommit = & git rev-parse FETCH_HEAD
  if ($LASTEXITCODE -ne 0 -or $commit -ne $mainCommit) {
    throw "The nightly checkout contains commits outside the fork's main branch."
  }
  & gh api user --jq .login
  if ($LASTEXITCODE -ne 0) { throw "Sign in to GitHub CLI as the scheduled task's Windows user." }
  if (-not $SkipInstall) {
    & vp install --frozen-lockfile -- --side-effects-cache=false --yes
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
  }
  & vp run --filter '@t3tools/desktop' ensure:electron
  if ($LASTEXITCODE -ne 0) { throw "Cannot prepare the Electron runtime." }
  $stamp = (Get-Date).ToUniversalTime()
  $baseVersion = (Get-Content -LiteralPath apps/desktop/package.json -Raw -ErrorAction Stop | ConvertFrom-Json).version
  $revision = [int][Math]::Floor($stamp.TimeOfDay.TotalSeconds)
  $version = "$baseVersion-nightly.$($stamp.ToString('yyyyMMdd')).$revision"
  & "$PSScriptRoot/build-t4-nightly.ps1" -Version $version

  $outputDir = Join-Path $repoRoot "release/t4code"
  $installerName = "T4-Code-$version-x64.exe"
  $assetNames = @($installerName, "$installerName.blockmap", "nightly.yml", "SOURCE.txt", "SHA256SUMS.txt")
  $assets = $assetNames | ForEach-Object { Join-Path $outputDir $_ }
  foreach ($asset in $assets) {
    if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) { throw "Missing release asset: $asset" }
  }
  $tag = "v$version"
  $notesPath = Join-Path $stateDir "release-notes.md"
  @(
    "Windows x64 nightly build of T4 Code.",
    "",
    "Download and run ``$installerName``. This unsigned nightly has its own app identity and data directory, and checks this repository for nightly updates.",
    "",
    "Source: https://github.com/Gohostieee/t3code/commit/$commit",
    "Built on the Windows nightly build PC. ``SHA256SUMS.txt`` and ``SOURCE.txt`` identify the files and source."
  ) | Set-Content -LiteralPath $notesPath -Encoding ascii -ErrorAction Stop
  & gh release create $tag @assets --repo Gohostieee/t3code --target $commit --title "T4 Code Nightly $version" --notes-file $notesPath --prerelease --draft --latest=false
  if ($LASTEXITCODE -ne 0) { throw "Failed to upload the nightly release." }
  & gh release edit $tag --repo Gohostieee/t3code --draft=false
  if ($LASTEXITCODE -ne 0) { throw "Failed to publish the nightly release." }

  Get-ChildItem -LiteralPath $outputDir -File | Where-Object {
    $_.Name -like 'T4-Code-*-x64.exe*' -and $_.Name -notin $assetNames
  } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -ErrorAction Stop }
  Get-ChildItem -LiteralPath $logDir -Filter '*.log' -File | Sort-Object Name -Descending |
    Select-Object -Skip 30 | ForEach-Object { Remove-Item -LiteralPath $_.FullName -ErrorAction Stop }
  Write-Output "Published https://github.com/Gohostieee/t3code/releases/tag/$tag"
} catch {
  Write-Error $_
  exit 1
} finally {
  Pop-Location
  Stop-Transcript | Out-Null
}
