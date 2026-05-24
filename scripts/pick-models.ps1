# Detect total system RAM (Windows) and print a sensible Ollama model pick.
# Output mirrors scripts/pick-models.sh:
#
#   RAM_MB=16384
#   RAM_GB=16
#   TIER=medium
#   CHAT_MODEL=qwen2.5:14b
#   COMPLETION_MODEL=qwen2.5-coder:1.5b-base
#
# Override by setting $env:OVERRIDE_RAM_MB before invoking. The tier table is
# identical to the bash version.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Get-RamMb {
  if ($env:OVERRIDE_RAM_MB) { return [int]$env:OVERRIDE_RAM_MB }
  try {
    $bytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    return [int]($bytes / 1MB)
  } catch {
    return 0
  }
}

function Get-Tier($ramMb) {
  if     ($ramMb -lt 6144)  { return 'tiny' }
  elseif ($ramMb -lt 12288) { return 'small' }
  elseif ($ramMb -lt 20480) { return 'medium' }
  elseif ($ramMb -lt 40960) { return 'large' }
  else                      { return 'huge' }
}

function Get-ChatModel($tier) {
  switch ($tier) {
    'tiny'   { 'llama3.2:3b' }
    'small'  { 'llama3.1:8b' }
    'medium' { 'qwen2.5:14b' }
    'large'  { 'qwen2.5:32b' }
    'huge'   { 'llama3.3:70b' }
    default  { 'llama3.1:8b' }
  }
}

function Get-CompletionModel($tier) {
  switch ($tier) {
    'tiny'                  { 'qwen2.5-coder:0.5b-base' }
    { $_ -in 'small','medium' } { 'qwen2.5-coder:1.5b-base' }
    { $_ -in 'large','huge' }   { 'qwen2.5-coder:7b-base' }
    default                 { 'qwen2.5-coder:1.5b-base' }
  }
}

$ramMb = Get-RamMb
$ramGb = [int][Math]::Round($ramMb / 1024)
$tier  = Get-Tier $ramMb
$chat  = Get-ChatModel $tier
$comp  = Get-CompletionModel $tier

@"
RAM_MB=$ramMb
RAM_GB=$ramGb
TIER=$tier
CHAT_MODEL=$chat
COMPLETION_MODEL=$comp
"@
