#!/usr/bin/env bash
# Build & install the Ollama Free Coder VS Code extension on Ubuntu (tested on 24.04+/26.04).
#
# What this does:
#   1. Ensures Node.js (>=18), npm, and a VS Code CLI (`code` or `codium`) are available.
#   2. Optionally installs Ollama and pulls default models.
#   3. Installs npm deps, compiles TypeScript, packages a .vsix, and installs it.
#
# Usage:
#   ./scripts/install-ubuntu.sh                  # build + install into `code`
#   CODE_BIN=codium ./scripts/install-ubuntu.sh  # install into VSCodium
#   SKIP_OLLAMA=1 ./scripts/install-ubuntu.sh    # don't touch Ollama
#   SKIP_PULL=1   ./scripts/install-ubuntu.sh    # don't pull models
#   OLLAMA_HOST=http://127.0.0.1:11434 ...       # override server URL
#   EXTRA_MODELS="qwen2.5:7b mistral:7b" ...       # additionally pull these
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!! \033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31mxx \033[0m %s\n" "$*" >&2; exit 1; }

sudo apt update && sudo apt install wget gpg apt-transport-https -y
sudo snap install --classic code

CODE_BIN="${CODE_BIN:-code}"
# Auto-pick chat & completion models based on system RAM, unless the user
# explicitly set CHAT_MODEL / COMPLETION_MODEL. See scripts/pick-models.sh
# for the tier table.
if [ -z "${CHAT_MODEL:-}" ] || [ -z "${COMPLETION_MODEL:-}" ]; then
  _PICK_SCRIPT="$(dirname "${BASH_SOURCE[0]}")/pick-models.sh"
  if [ -x "$_PICK_SCRIPT" ]; then
    _PICK_OUT="$("$_PICK_SCRIPT" 2>/dev/null || true)"
    _AUTO_CHAT="$(printf '%s\n' "$_PICK_OUT" | sed -n 's/^CHAT_MODEL=//p')"
    _AUTO_COMP="$(printf '%s\n' "$_PICK_OUT" | sed -n 's/^COMPLETION_MODEL=//p')"
    _AUTO_RAM_GB="$(printf '%s\n' "$_PICK_OUT" | sed -n 's/^RAM_GB=//p')"
    _AUTO_TIER="$(printf '%s\n' "$_PICK_OUT" | sed -n 's/^TIER=//p')"
  fi
fi
CHAT_MODEL="${CHAT_MODEL:-${_AUTO_CHAT:-llama3.1:8b}}"
COMPLETION_MODEL="${COMPLETION_MODEL:-${_AUTO_COMP:-qwen2.5-coder:1.5b-base}}"
# Tell the user how the defaults were chosen.
if [ -n "${_AUTO_TIER:-}" ]; then
  : "${_AUTO_RAM_GB:=?}"
  printf "\033[1;36m==>\033[0m Detected %s GB RAM (tier: %s) -> chat=%s, completion=%s\n" \
    "$_AUTO_RAM_GB" "$_AUTO_TIER" "$CHAT_MODEL" "$COMPLETION_MODEL"
fi
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
EXTRA_MODELS="${EXTRA_MODELS:-}"

is_ollama_up() {
  curl -fsS --max-time 2 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1
}

wait_for_ollama() {
  local tries="${1:-30}"
  for ((i=1; i<=tries; i++)); do
    if is_ollama_up; then return 0; fi
    sleep 1
  done
  return 1
}

start_ollama_background() {
  # Spawn a detached `ollama serve`, redirect logs, and don't tie it to this shell.
  local log_file="${TMPDIR:-/tmp}/ollama-serve.log"
  log "Starting 'ollama serve' in background (logs: $log_file)"
  nohup ollama serve >"$log_file" 2>&1 </dev/null &
  disown || true
}

ensure_ollama_running() {
  if is_ollama_up; then
    log "Ollama server already responding at $OLLAMA_HOST"
    return 0
  fi

  # Prefer systemd when available (survives reboots, runs as the ollama user).
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^ollama\.service'; then
    log "Enabling & starting ollama via systemd"
    sudo systemctl enable --now ollama || warn "systemctl enable --now ollama failed; will fall back to 'ollama serve'"
    if wait_for_ollama 30; then return 0; fi
    warn "Ollama systemd service didn't become ready in time; trying 'ollama serve' directly"
  fi

  # Fallback: launch `ollama serve` ourselves (WSL, containers, non-systemd distros).
  start_ollama_background
  if wait_for_ollama 30; then
    log "Ollama server is up at $OLLAMA_HOST"
    return 0
  fi

  die "Ollama server did not become reachable at $OLLAMA_HOST. Check logs in ${TMPDIR:-/tmp}/ollama-serve.log"
}

# -----------------------------------------------------------------------------
# 1. System prerequisites
# -----------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  log "Installing Node.js via apt (nodejs + npm)"
  sudo apt-get update -y
  sudo apt-get install -y nodejs npm
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  warn "Node.js $NODE_MAJOR detected; this extension needs >=18."
  warn "Install a newer Node via NodeSource:"
  warn "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  warn "  sudo apt-get install -y nodejs"
  die  "Aborting."
fi

if ! command -v "$CODE_BIN" >/dev/null 2>&1; then
  warn "'$CODE_BIN' CLI not found. Install VS Code (or VSCodium) and re-run."
  warn "  https://code.visualstudio.com/docs/setup/linux"
  die  "Aborting."
fi

# -----------------------------------------------------------------------------
# 2. Ollama (optional)
# -----------------------------------------------------------------------------
if [ "${SKIP_OLLAMA:-0}" != "1" ]; then
  if ! command -v ollama >/dev/null 2>&1; then
    log "Installing Ollama"
    curl -fsSL https://ollama.com/install.sh | sh
  else
    log "Ollama already installed: $(ollama --version || true)"
  fi

  # Make sure the server is actually listening before we try to pull models.
  ensure_ollama_running

  if [ "${SKIP_PULL:-0}" != "1" ]; then
    # Pull every model the extension might use. Failing here is fatal — without
    # the model, /api/chat and /api/generate return HTTP 404 inside VS Code.
    pull_model() {
      local name="$1"
      log "Pulling $name"
      if ! ollama pull "$name"; then
        die "Failed to pull $name. Check the tag exists at https://ollama.com/library"
      fi
      # Verify it actually shows up in /api/tags (catches partial pulls).
      if ! curl -fsS "$OLLAMA_HOST/api/tags" | grep -Fq "\"$name\""; then
        die "$name pulled but not visible in $OLLAMA_HOST/api/tags"
      fi
    }
    pull_model "$CHAT_MODEL"
    pull_model "$COMPLETION_MODEL"
    for m in $EXTRA_MODELS; do pull_model "$m"; done
  fi
else
  # Even when we skip installing/pulling, the extension still needs a running server.
  if ! is_ollama_up && command -v ollama >/dev/null 2>&1; then
    warn "SKIP_OLLAMA=1 but no server reachable at $OLLAMA_HOST; starting one for you"
    ensure_ollama_running
  fi
fi

# -----------------------------------------------------------------------------
# 3. Build the extension
# -----------------------------------------------------------------------------
log "Installing npm dependencies"
npm install --no-audit --no-fund

log "Compiling TypeScript"
npm run compile

log "Running tests"
npm test

log "Packaging .vsix"
npx --yes @vscode/vsce package -o ollama-free-coder.vsix

# -----------------------------------------------------------------------------
# 4. Install into VS Code
# -----------------------------------------------------------------------------
log "Installing extension into '$CODE_BIN'"
"$CODE_BIN" --install-extension ./ollama-free-coder.vsix --force

log "Done!"
cat <<EOF

Next steps:
  1. Restart VS Code (or reload the window).
  2. Open the 'Ollama Free Coder' view from the Activity Bar (robot icon).
  3. Default models:
       chat        : $CHAT_MODEL
       completion  : $COMPLETION_MODEL
     Override via Settings -> "Ollama Free Coder", or:
       Cmd/Ctrl+Shift+P -> "Ollama Free Coder: Select Chat Model"
  4. Keybindings:
       Ctrl+Alt+O  -> Open chat
       Ctrl+Alt+E  -> Explain selection
       Ctrl+Alt+R  -> Refactor selection

EOF
