param([string]$At = "03:23")

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $repoRoot ".t3/nightly"
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$installCommitPath = Join-Path $stateDir "install-commit.txt"
if (-not (Test-Path -LiteralPath $installCommitPath)) {
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "node_modules/.modules.yaml"))) {
    throw "Run vp install --frozen-lockfile successfully in this checkout before registering the nightly task."
  }
  $installedCommit = & git -C $repoRoot rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw "Cannot identify the installed checkout." }
  $installedCommit | Set-Content -LiteralPath $installCommitPath -Encoding ascii
}
$toolPaths = @('git', 'gh', 'vp', 'cargo', 'node', 'python') | ForEach-Object {
  Split-Path -Parent (Get-Command $_ -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
} | Select-Object -Unique
ConvertTo-Json -InputObject @($toolPaths) | Set-Content -LiteralPath (Join-Path $stateDir "tool-paths.json") -Encoding utf8
$powershellPath = (Get-Command powershell.exe -CommandType Application).Source
$runnerPath = Join-Path $PSScriptRoot "run-t4-nightly.ps1"
$action = New-ScheduledTaskAction -Execute $powershellPath -WorkingDirectory $repoRoot -Argument (
  "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runnerPath`""
)
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2) -Hidden
Register-ScheduledTask -TaskName "T4 Code Nightly" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description (
  "Build T4 Code from the fork's main branch and publish a Windows nightly prerelease. Uses an isolated checkout and the signed-in user's GitHub CLI credentials."
) -Force | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName "T4 Code Nightly" | Select-Object NextRunTime, LastRunTime, LastTaskResult
