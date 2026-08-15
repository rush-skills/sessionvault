# SessionVault installer for Windows.
#
#   irm https://raw.githubusercontent.com/rush-skills/sessionvault/main/install.ps1 | iex
#
# It installs the CLI with npm, then points you at the guided setup.

$ErrorActionPreference = 'Stop'

Write-Host "SessionVault" -ForegroundColor White -NoNewline
Write-Host " - back up every AI agent session on this machine"
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "x Node is not installed. Install Node 18 or later from https://nodejs.org" -ForegroundColor Red
  exit 1
}

$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) {
  Write-Host "x Node $major is too old. SessionVault needs Node 18 or later." -ForegroundColor Red
  exit 1
}
Write-Host "+ Node $(node -v)" -ForegroundColor Green

Write-Host "> Installing sessionvault..."
npm install -g sessionvault | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "x npm could not install sessionvault." -ForegroundColor Red
  exit 1
}
Write-Host "+ Installed sessionvault" -ForegroundColor Green

if (Get-Command wrangler -ErrorAction SilentlyContinue) {
  Write-Host "+ Wrangler is already installed" -ForegroundColor Green
} else {
  Write-Host "> Installing wrangler, which SessionVault uses to reach R2..."
  npm install -g wrangler | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "+ Installed wrangler" -ForegroundColor Green }
  else { Write-Host "  Install it later with: npm install -g wrangler" }
}

Write-Host ""
Write-Host "Next" -ForegroundColor White
Write-Host "  1. wrangler login      # once, if you have no Cloudflare login yet"
Write-Host "  2. sessionvault init   # creates the bucket and runs the first backup"
Write-Host ""
Write-Host "On a second machine, point it at the same bucket:"
Write-Host "  sessionvault init --bucket ai-sessions --yes"
