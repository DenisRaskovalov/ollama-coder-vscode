#!/usr/bin/env bash
# Build & install the Ollama Coder VS Code extension on Ubuntu (tested on 24.04+/26.04).
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
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!! \033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31mxx \033[0m %s\n" "$*" >&2; exit 1; }

CODE_BIN="${CODE_BIN:-code}"
CHAT_MODEL="${CHAT_MODEL:-llama3.1:8b-instruct}"
COMPLETION_MODEL="${COMPLETION_MODEL:-qwen2.5-coder:1.5b-base}"

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

  # Start the service if systemd is available
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable --now ollama || warn "Could not enable ollama via systemd"
  fi

  if [ "${SKIP_PULL:-0}" != "1" ]; then
    log "Pulling default models (this can take a while)"
    ollama pull "$CHAT_MODEL"       || warn "Failed to pull $CHAT_MODEL"
    ollama pull "$COMPLETION_MODEL" || warn "Failed to pull $COMPLETION_MODEL"
  fi
fi

# -----------------------------------------------------------------------------
# 3. Build the extension
# -----------------------------------------------------------------------------
log "Installing npm dependencies"
npm install --no-audit --no-fund

log "Compiling TypeScript"
npm run compile

log "Packaging .vsix"
npx --yes @vscode/vsce package -o ollama-coder.vsix

# -----------------------------------------------------------------------------
# 4. Install into VS Code
# -----------------------------------------------------------------------------
log "Installing extension into '$CODE_BIN'"
"$CODE_BIN" --install-extension ./ollama-coder.vsix --force

log "Done!"
cat <<EOF

Next steps:
  1. Restart VS Code (or reload the window).
  2. Open the 'Ollama Coder' view from the Activity Bar (robot icon).
  3. Default models:
       chat        : $CHAT_MODEL
       completion  : $COMPLETION_MODEL
     Override via Settings -> "Ollama Coder", or:
       Cmd/Ctrl+Shift+P -> "Ollama Coder: Select Chat Model"
  4. Keybindings:
       Ctrl+Alt+O  -> Open chat
       Ctrl+Alt+E  -> Explain selection
       Ctrl+Alt+R  -> Refactor selection

EOF
