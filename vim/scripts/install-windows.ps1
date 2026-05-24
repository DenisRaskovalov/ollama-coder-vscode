# Install Ollama Coder for Vim / Neovim on Windows.
#
# Same behavior as vim/scripts/install-ubuntu.sh, adapted for Windows.
#
# Usage (PowerShell 5.1+ or 7+):
#   pwsh -ExecutionPolicy Bypass -File .\vim\scripts\install-windows.ps1
#
# Optional environment variables (same names as the Linux/macOS scripts):
#   $env:EDITOR           = 'nvim'                    # or 'vim' or 'both'
#   $env:CHAT_MODEL       = 'llama3.1:8b'
#   $env:COMPLETION_MODEL = 'qwen2.5-coder:1.5b-base'
#   $env:OLLAMA_HOST      = 'http://127.0.0.1:11434'
#   $env:EXTRA_MODELS     = 'qwen2.5:7b mistral:7b'
#   $env:SKIP_OLLAMA      = '1'
#   $env:SKIP_PULL        = '1'

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$RootDir = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$PluginSrc = Join-Path $RootDir 'vim'
Set-Location $RootDir

function Write-Log  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Warn ($m) { Write-Host "!!  $m" -ForegroundColor Yellow }
function Die       ($m) { Write-Host "xx  $m" -ForegroundColor Red; exit 1 }

# Defaults
$EditorWant       = if ($env:EDITOR)           { $env:EDITOR }           else { '' }
# Auto-pick chat & completion models based on system RAM, unless the user
# explicitly set $env:CHAT_MODEL / $env:COMPLETION_MODEL. See
# scripts/pick-models.ps1 for the tier table.
$_AUTO_CHAT = ''; $_AUTO_COMP = ''; $_AUTO_TIER = ''; $_AUTO_RAM_GB = ''
$_PickScript = Join-Path $PSScriptRoot "..\..\scripts\pick-models.ps1"
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
function Refresh-Path {
  $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('PATH','User')
}
function Invoke-WinGet($id) {
  if (-not (Test-Cmd winget)) {
    Die "winget not found. Install 'App Installer' from the Microsoft Store and re-run."
  }
  Write-Log "winget install --id $id"
  winget install --id $id --silent --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { Die "winget install $id failed (exit $LASTEXITCODE)." }
  Refresh-Path
}

# -----------------------------------------------------------------------------
# 1. curl (PS 5.1 ships only the alias)
# -----------------------------------------------------------------------------
$CurlExe = (Get-Command curl.exe -ErrorAction SilentlyContinue)
if (-not $CurlExe) {
  Write-Warn 'curl.exe not on PATH. The plugin uses curl for streaming.'
  Write-Log 'Installing curl via winget'
  Invoke-WinGet 'cURL.cURL'
}

# -----------------------------------------------------------------------------
# 2. Pick editor(s)
# -----------------------------------------------------------------------------
$wantVim  = $false
$wantNvim = $false
switch ($EditorWant) {
  'vim'  { $wantVim  = $true }
  'nvim' { $wantNvim = $true }
  ''     {
    if (Test-Cmd vim)  { $wantVim  = $true }
    if (Test-Cmd nvim) { $wantNvim = $true }
  }
  'both' {
    if (Test-Cmd vim)  { $wantVim  = $true }
    if (Test-Cmd nvim) { $wantNvim = $true }
  }
  default { Die "`$env:EDITOR must be one of: vim, nvim, both (got '$EditorWant')" }
}

if (-not $wantVim -and -not $wantNvim) {
  Write-Warn 'Neither vim nor nvim is installed.'
  $ans = Read-Host 'Install Neovim now (recommended on Windows)? [Y/n]'
  if ($ans -notmatch '^[Nn]') {
    Invoke-WinGet 'Neovim.Neovim'
    $wantNvim = $true
  } else {
    Die 'Aborting — install vim or neovim and re-run.'
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
  } else {
    Write-Log 'Ollama already installed.'
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
# 4. Install plugin files
# -----------------------------------------------------------------------------
function Install-Into($target, $label) {
  Write-Log "Installing into $target ($label)"
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Copy-Item -Recurse (Join-Path $PluginSrc 'plugin')   $target
  Copy-Item -Recurse (Join-Path $PluginSrc 'autoload') $target
  Copy-Item -Recurse (Join-Path $PluginSrc 'doc')      $target
  $bin = if ($label -eq 'vim') { 'vim' } else { 'nvim' }
  $args = if ($label -eq 'vim') {
    @('-es', '-u', 'NONE', "+helptags $target\doc", '+qa!')
  } else {
    @('--headless', "+helptags $target\doc", '+qa!')
  }
  & $bin @args 2>$null
}

if ($wantVim) {
  $vimTarget = Join-Path $env:USERPROFILE 'vimfiles\pack\ollama\start\ollama-coder'
  Install-Into $vimTarget 'vim'
}
if ($wantNvim) {
  $nvimTarget = Join-Path $env:LOCALAPPDATA 'nvim-data\site\pack\ollama\start\ollama-coder'
  Install-Into $nvimTarget 'nvim'
}

# -----------------------------------------------------------------------------
# 5. Sanity check
# -----------------------------------------------------------------------------
Write-Log 'Sanity-checking plugin load'
function Sanity($bin, $target) {
  $headless = if ($bin -eq 'vim') { '-es' } else { '--headless' }
  & $bin -u NONE $headless `
    -c "set rtp+=$target" `
    -c 'runtime plugin/ollama-coder.vim' `
    -c "if exists(':OllamaChat') == 2 | qa! | else | cquit | endif"
  if ($LASTEXITCODE -ne 0) { Die "$bin failed to load the plugin" }
}
if ($wantVim)  { Sanity 'vim'  $vimTarget }
if ($wantNvim) { Sanity 'nvim' $nvimTarget }

Write-Log 'Done!'
Write-Host @"

Next steps:
  - Restart Vim/Neovim (or :runtime plugin/ollama-coder.vim)
  - Try:   :OllamaChat
  - Try:   :OllamaWrite write to a new file C++ Hello World program
  - Help:  :help ollama-coder
  - Default keymaps live under <leader>o (e.g. <leader>oc opens chat).

Models pulled:
  chat        : $CHAT_MODEL
  completion  : $COMPLETION_MODEL

"@
