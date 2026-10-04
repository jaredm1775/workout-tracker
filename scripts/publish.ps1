$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $env:LOCALAPPDATA "dev-tools"
$env:PATH = "$(Join-Path $tools 'MinGit\cmd');$(Join-Path $tools 'bin');$(Join-Path $tools 'node-v22.20.0-win-x64');" + $env:PATH

Set-Location $root

gh auth status
if ($LASTEXITCODE -ne 0) {
  Write-Host "GitHub CLI is not logged in. Run:"
  Write-Host "  gh auth login --hostname github.com --git-protocol https --web"
  exit 1
}

$user = gh api user --jq .login
$repo = "workout-tracker"
$full = "$user/$repo"

if (gh repo view $full 2>$null) {
  $existing = git remote get-url origin 2>$null
  if (-not $existing) {
    git remote add origin "https://github.com/$full.git"
  }
  git push -u origin main
} else {
  gh repo create $repo --public --source=. --remote=origin --push
}

gh api -X POST "repos/$full/pages" -f build_type=workflow
if ($LASTEXITCODE -ne 0) {
  gh api -X PUT "repos/$full/pages" -f build_type=workflow
}

Write-Host ""
Write-Host "Repo: https://github.com/$full"
Write-Host "Live site after the Actions deploy finishes:"
Write-Host "  https://$user.github.io/workout-tracker/"
Write-Host ""
Write-Host "On your phone: open that URL once, then Add to Home Screen."
