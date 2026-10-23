# Weekly update: run this after a new Triple Click episode is out (Thursdays).
#   Double-click "Update-OneMoreThings.bat" in the project folder, or run:  powershell -ExecutionPolicy Bypass -File scripts\weekly-update.ps1
#
# 1. gets the latest changes from GitHub      4. matches transcripts to picks (site/said.js)
# 2. pulls new picks from the feed            5. shows you what was added
# 3. transcribes new episodes (your GPU)      6. commits and pushes, which redeploys the site
$ErrorActionPreference = "Continue"   # git and python write progress to stderr; we check exit codes ourselves
Set-Location (Split-Path -Parent $PSScriptRoot)
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = "1"
$env:PYTHONIOENCODING = "utf-8"

function Step($n, $text) { Write-Host ""; Write-Host "[$n/6] $text" -ForegroundColor Cyan }
function Run([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "'$exe $($arguments -join ' ')' failed (exit code $LASTEXITCODE)." }
}

try {
  Step 1 "Getting the latest from GitHub"
  Run git @("pull", "--rebase", "--autostash")

  Step 2 "Pulling new picks from the feed"
  Run node @("scripts/build-data.mjs")

  Step 3 "Transcribing new episodes (a few minutes each; skips episodes already done)"
  Run python @("scripts/transcribe-all.py")

  Step 4 "Matching transcripts to picks"
  Run node @("scripts/attach-transcripts.mjs")

  Step 5 "What changed"
  Run node @("scripts/new-picks.mjs")
  if (Test-Path "data/transcripts/_review.txt") { Write-Host "(Episodes where the 'one more thing' section was hard to find are listed in data/transcripts/_review.txt)" -ForegroundColor DarkGray }

  Step 6 "Publishing"
  Run git @("add", "site/data.js", "site/said.js", "data/enrichment-cache.json", "data/curated.json", "data/overrides.json", "data/splits.json", "data/classified.json")
  & git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Nothing new to publish yet. If the episode just came out, try again in a little while." -ForegroundColor Yellow
  } else {
    Run git @("commit", "-m", "Weekly update: new picks and transcripts")
    & git pull --rebase
    if ($LASTEXITCODE -ne 0) {
      & git rebase --abort
      throw "GitHub changed the same files while this ran. Nothing was lost; run this script again."
    }
    Run git @("push")
    Write-Host "Pushed. GitHub will redeploy the site in about a minute." -ForegroundColor Green
  }
}
catch {
  Write-Host ""
  Write-Host "Stopped: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
