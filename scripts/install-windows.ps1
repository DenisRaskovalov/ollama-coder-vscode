# Build & install the Ollama Free Coder VS Code extension on Windows.
#
# What this does:
#   1. Ensures Node.js (>=18), the VS Code CLI, and Ollama are available
#      (uses winget when something is missing).
#   2. Starts the Ollama server in the background if it isn't already.
#   3. Pulls the default chat & completion models (failures are fatal).
#   4. Compiles, tests, packages a .vsix, and installs it.
#
# Usage (PowerShell 5.1+ or PowerShell 7+):
#   pwsh -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
#
# Optional environment variables (same names as the Linux/macOS scripts):
#   $env:CODE_BIN         = 'code'                    # or 'codium', 'code-insiders'
#   $env:CHAT_MODEL       = 'llama3.1:8b'
#   $env:COMPLETION_MODEL = 'qwen2.5-coder:1.5b-base'
#   $env:OLLAMA_HOST      = 'http://127.0.0.1:11434'
#   $env:EXTRA_MODELS     = 'qwen2.5:7b mistral:7b'
#   $env:SKIP_OLLAMA      = '1'
#   $env:SKIP_PULL        = '1'

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# Move to repo root (parent of /scripts).
$RootDir = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $RootDir

function Write-Log  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Warn ($m) { Write-Host "!!  $m" -ForegroundColor Yellow }
function Die       ($m) { Write-Host "xx  $m" -ForegroundColor Red; exit 1 }

# Defaults
$CODE_BIN         = if ($env:CODE_BIN)         { $env:CODE_BIN }         else { 'code' }
# Auto-pick chat & completion models based on system RAM, unless the user
# explicitly set $env:CHAT_MODEL / $env:COMPLETION_MODEL. See
# scripts/pick-models.ps1 for the tier table.
$_AUTO_CHAT = ''; $_AUTO_COMP = ''; $_AUTO_TIER = ''; $_AUTO_RAM_GB = ''
$_PickScript = Join-Path $PSScriptRoot "pick-models.ps1"
if (Test-Path $_PickScript) {
  try {
    $_PickOut = & pwsh -NoProfile -File $_PickScript 2>$null
    if (-not $_PickOut) { $_PickOut = & powershell -NoProfile -File $_PickScript 2>$null }
    foreach ($line in ($_PickOut -split "`r?`n")) {
      if     ($line -match '^CHAT_MODEL=(.+)$')       { $_AUTO_CHAT     = $matches[1] }
      elseif ($line -match '^COMPLETION_MODEL=(.+)$') { $_AUTO_COMP     = $matches[1] }
      elseif ($line -match '^TIER=(.+)$')             { $_AUTO_TIER     = $matches[1] }
      elseif ($line -match '^RAM_GB=(.+)$')           { $_AUTO_RAM_GB   = $matches[1] }
    }
  } catch { }
}
$CHAT_MODEL       = if ($env:CHAT_MODEL)       { $env:CHAT_MODEL }       elseif ($_AUTO_CHAT) { $_AUTO_CHAT } else { 'llama3.1:8b' }
$COMPLETION_MODEL = if ($env:COMPLETION_MODEL) { $env:COMPLETION_MODEL } elseif ($_AUTO_COMP) { $_AUTO_COMP } else { 'qwen2.5-coder:1.5b-base' }
if ($_AUTO_TIER) {
  Write-Host ("==> Detected {0} GB RAM (tier: {1}) -> chat={2}, completion={3}" -f $_AUTO_RAM_GB, $_AUTO_TIER, $CHAT_MODEL, $COMPLETION_MODEL) -ForegroundColor Cyan
}
$OLLAMA_HOST      = if ($env:OLLAMA_HOST)      { $env:OLLAMA_HOST }      else { 'http://127.0.0.1:11434' }
$EXTRA_MODELS     = if ($env:EXTRA_MODELS)     { $env:EXTRA_MODELS }     else { '' }

function Test-Cmd($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Invoke-WinGet($id) {
  if (-not (Test-Cmd winget)) {
    Die "winget not found. Install 'App Installer' from the Microsoft Store and re-run."
  }
  Write-Log "winget install --id $id"
  winget install --id $id --silent --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { Die "winget install $id failed (exit $LASTEXITCODE)." }
}

# -----------------------------------------------------------------------------
# 1. Node
# -----------------------------------------------------------------------------
if (-not (Test-Cmd node)) {
  Write-Log 'Installing Node.js LTS via winget'
  Invoke-WinGet 'OpenJS.NodeJS.LTS'
  $env:PATH = "$env:PATH;$env:ProgramFiles\nodejs"
}
$nodeMajor = [int]((node -p 'process.versions.node.split(".")[0]').Trim())
if ($nodeMajor -lt 18) {
  Die "Node.js $nodeMajor detected; this extension needs >=18. Upgrade via 'winget upgrade OpenJS.NodeJS.LTS'."
}

# -----------------------------------------------------------------------------
# 2. VS Code CLI
# -----------------------------------------------------------------------------
if (-not (Test-Cmd $CODE_BIN)) {
  if ($CODE_BIN -eq 'code') {
    Write-Log 'Installing VS Code via winget'
    Invoke-WinGet 'Microsoft.VisualStudioCode'
    # Refresh PATH for this session
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('PATH','User')
  } else {
    Die "'$CODE_BIN' CLI not found. Install it and re-run."
  }
}

# -----------------------------------------------------------------------------
# 3. Ollama
# -----------------------------------------------------------------------------
function Test-OllamaUp {
  try {
    Invoke-WebRequest -Uri "$OLLAMA_HOST/api/tags" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
    return $true
  } catch { return $false }
}
function Wait-Ollama($tries = 30) {
  for ($i = 0; $i -lt $tries; $i++) {
    if (Test-OllamaUp) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}
function Start-OllamaBackground {
  $logFile = Join-Path $env:TEMP 'ollama-serve.log'
  Write-Log "Starting 'ollama serve' in background (logs: $logFile)"
  Start-Process -FilePath 'ollama' -ArgumentList 'serve' `
                -WindowStyle Hidden `
                -RedirectStandardOutput $logFile `
                -RedirectStandardError $logFile | Out-Null
}
function Ensure-OllamaRunning {
  if (Test-OllamaUp) {
    Write-Log "Ollama server already responding at $OLLAMA_HOST"
    return
  }
  Start-OllamaBackground
  if (Wait-Ollama 30) {
    Write-Log "Ollama server is up at $OLLAMA_HOST"
    return
  }
  Die "Ollama did not become reachable at $OLLAMA_HOST. Check $env:TEMP\ollama-serve.log"
}
function Invoke-Pull($name) {
  Write-Log "Pulling $name"
  & ollama pull $name
  if ($LASTEXITCODE -ne 0) {
    Die "Failed to pull $name. Check the tag at https://ollama.com/library"
  }
  $body = (Invoke-WebRequest -Uri "$OLLAMA_HOST/api/tags" -UseBasicParsing).Content
  if ($body -notmatch [regex]::Escape($name)) {
    Die "$name pulled but not visible in $OLLAMA_HOST/api/tags"
  }
}

if ($env:SKIP_OLLAMA -ne '1') {
  if (-not (Test-Cmd ollama)) {
    Write-Log 'Installing Ollama via winget'
    Invoke-WinGet 'Ollama.Ollama'
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('PATH','User')
  } else {
    Write-Log "Ollama already installed."
  }
  Ensure-OllamaRunning
  if ($env:SKIP_PULL -ne '1') {
    Invoke-Pull $CHAT_MODEL
    Invoke-Pull $COMPLETION_MODEL
    foreach ($m in ($EXTRA_MODELS -split '\s+' | Where-Object { $_ })) {
      Invoke-Pull $m
    }
  }
} else {
  if (-not (Test-OllamaUp) -and (Test-Cmd ollama)) {
    Write-Warn 'SKIP_OLLAMA=1 but no server reachable; starting one for you'
    Ensure-OllamaRunning
  }
}

# -----------------------------------------------------------------------------
# 4. Build, test, package
# -----------------------------------------------------------------------------
Write-Log 'Installing npm dependencies'
& npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Die 'npm install failed' }

Write-Log 'Compiling TypeScript'
& npm run compile
if ($LASTEXITCODE -ne 0) { Die 'tsc failed' }

Write-Log 'Running tests'
& npm test
if ($LASTEXITCODE -ne 0) { Die 'npm test failed' }

Write-Log 'Packaging .vsix'
& npx --yes @vscode/vsce package -o ollama-free-coder.vsix
if ($LASTEXITCODE -ne 0) { Die 'vsce package failed' }

# -----------------------------------------------------------------------------
# 5. Install
# -----------------------------------------------------------------------------
Write-Log "Installing extension into '$CODE_BIN'"
& $CODE_BIN --install-extension .\ollama-free-coder.vsix --force
if ($LASTEXITCODE -ne 0) { Die "$CODE_BIN install failed" }

Write-Log 'Done!'
Write-Host @"

Next steps:
  1. Restart VS Code (or reload the window).
  2. Open the 'Ollama Free Coder' view from the Activity Bar (robot icon).
  3. Default models:
       chat        : $CHAT_MODEL
       completion  : $COMPLETION_MODEL
     Override via Settings -> 'Ollama Free Coder', or:
       Ctrl+Shift+P -> 'Ollama Free Coder: Select Chat Model'
  4. Keybindings:
       Ctrl+Alt+O  -> Open chat
       Ctrl+Alt+E  -> Explain selection
       Ctrl+Alt+R  -> Refactor selection

"@
