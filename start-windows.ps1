$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is required. Install the LTS version from https://nodejs.org/" -ForegroundColor Yellow
  exit 1
}
Write-Host "Starting Northstar at http://127.0.0.1:4173" -ForegroundColor Cyan
Start-Process "http://127.0.0.1:4173"
node server.js
