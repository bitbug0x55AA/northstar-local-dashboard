param([switch]$Planner)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js is required. Install the LTS version from https://nodejs.org/" -ForegroundColor Yellow
  exit 1
}
if ($Planner) {
  $ollamaPath = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
  if (-not (Test-Path -LiteralPath $ollamaPath)) {
    Write-Host "Ollama is not installed in the current user profile." -ForegroundColor Yellow
    exit 1
  }
  $env:NORTHSTAR_PLANNER_ENABLED = 'true'
  if (-not $env:NORTHSTAR_LLM_URL) { $env:NORTHSTAR_LLM_URL = 'http://127.0.0.1:11434/api/chat' }
  if (-not $env:NORTHSTAR_LLM_MODEL) { $env:NORTHSTAR_LLM_MODEL = 'qwen2.5:3b' }
  try {
    Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/tags' -UseBasicParsing -TimeoutSec 2 | Out-Null
  } catch {
    Write-Host "Starting local Ollama API..." -ForegroundColor DarkGray
    Start-Process -FilePath $ollamaPath -ArgumentList 'serve' -WindowStyle Hidden
    Start-Sleep -Seconds 2
  }
  Write-Host "Planner enabled with local model: $env:NORTHSTAR_LLM_MODEL" -ForegroundColor Green
}
Write-Host "Starting Northstar at http://127.0.0.1:4173" -ForegroundColor Cyan
Start-Process "http://127.0.0.1:4173"
node server.js
