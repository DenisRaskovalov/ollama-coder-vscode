#!/usr/bin/env bash
# Build & install the Ollama Free Coder VS Code extension on macOS.
#
# What this does:
#   1. Ensures Homebrew, Node.js (>=18), VS Code CLI, and Ollama are available.
#   2. Starts the Ollama server (launchctl if installed via brew services,
#      or `ollama serve` in the background otherwise).
#   3. Pulls the default chat & completion models (failures are fatal).
#   4. Compiles, tests, packages a .vsix, and installs it into VS Code.
#
# Usage:
#   ./scripts/install-macos.sh                       # build + install into `code`
#   CODE_BIN=codium ./scripts/install-macos.sh        # install into VSCodium
#   SKIP_OLLAMA=1 ./scripts/install-macos.sh          # don't touch Ollama
#   SKIP_PULL=1   ./scripts/install-macos.sh          # don't pull models
#   EXTRA_MODELS="qwen2.5:7b mistral:7b" ./scripts/install-macos.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!! \033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31mxx \033[0m %s\n" "$*" >&2; exit 1; }

CODE_BIN="${CODE_BIN:-code}"
CHAT_MODEL="${CHAT_MODEL:-llama3.1:8b}"
COMPLETION_MODEL="${COMPLETION_MODEL:-qwen2.5-coder:1.5b-base}"
OLLAMA_HOST="${OLLAMA_HOST:-http://127.0.0.1:11434}"
EXTRA_MODELS="${EXTRA_MODELS:-}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "This script is for macOS. Use scripts/install-ubuntu.sh on Linux."
fi

# -----------------------------------------------------------------------------
# 1. Homebrew
# -----------------------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  log "Installing Homebrew (the official installer)"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Make brew available in this shell session on Apple Silicon installs.
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

# -----------------------------------------------------------------------------
# 2. Node
# -----------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  log "Installing Node.js via Homebrew"
  brew install node
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  warn "Node.js $NODE_MAJOR detected; this extension needs >=18."
  warn "  brew upgrade node      # or install a newer toolchain via 'nvm'"
  die  "Aborting."
fi

# -----------------------------------------------------------------------------
# 3. VS Code CLI
# -----------------------------------------------------------------------------
if ! command -v "$CODE_BIN" >/dev/null 2>&1; then
  if [[ "$CODE_BIN" == "code" ]] && [[ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]]; then
    warn "'code' is not on \$PATH but VS Code.app is installed."
    warn "Open VS Code, run command palette (Cmd+Shift+P) -> 'Shell Command: Install code command in PATH'."
    die  "Aborting."
  fi
  warn "'$CODE_BIN' CLI not found. Install VS Code (or VSCodium) and re-run."
  warn "  brew install --cask visual-studio-code   # or download from code.visualstudio.com"
  die  "Aborting."
fi

# -----------------------------------------------------------------------------
# 4. Ollama
# -----------------------------------------------------------------------------
is_ollama_up() { curl -fsS --max-time 2 "$OLLAMA_HOST/api/tags" >/dev/null 2>&1; }
wait_for_ollama() {
  local tries="${1:-30}"
  for ((i=1; i<=tries; i++)); do
    if is_ollama_up; then return 0; fi
    sleep 1
  done
  return 1
}
start_ollama_background() {
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
  # If installed via 'brew install ollama', try brew services first.
  if command -v brew >/dev/null && brew services list 2>/dev/null | grep -q '^ollama'; then
    log "Starting ollama via brew services"
    brew services start ollama || warn "brew services start ollama failed; will fall back"
    if wait_for_ollama 30; then return 0; fi
  fi
  # Otherwise just run it ourselves; the Ollama.app GUI bundles the same server
  # but it may not be running yet.
  start_ollama_background
  if wait_for_ollama 30; then
    log "Ollama server is up at $OLLAMA_HOST"
    return 0
  fi
  die "Ollama did not become reachable at $OLLAMA_HOST. Check ${TMPDIR:-/tmp}/ollama-serve.log"
}
pull_model() {
  local name="$1"
  log "Pulling $name"
  if ! ollama pull "$name"; then
    die "Failed to pull $name. Check the tag at https://ollama.com/library"
  fi
  if ! curl -fsS "$OLLAMA_HOST/api/tags" | grep -Fq "\"$name\""; then
    die "$name pulled but not visible in $OLLAMA_HOST/api/tags"
  fi
}

if [ "${SKIP_OLLAMA:-0}" != "1" ]; then
  if ! command -v ollama >/dev/null 2>&1; then
    log "Installing Ollama via Homebrew"
    brew install ollama
  else
    log "Ollama already installed: $(ollama --version || true)"
  fi
  ensure_ollama_running
  if [ "${SKIP_PULL:-0}" != "1" ]; then
    pull_model "$CHAT_MODEL"
    pull_model "$COMPLETION_MODEL"
    for m in $EXTRA_MODELS; do pull_model "$m"; done
  fi
else
  if ! is_ollama_up && command -v ollama >/dev/null 2>&1; then
    warn "SKIP_OLLAMA=1 but no server reachable; starting one for you"
    ensure_ollama_running
  fi
fi

# -----------------------------------------------------------------------------
# 5. Build, test, package
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
# 6. Install
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
       Cmd+Shift+P -> "Ollama Free Coder: Select Chat Model"
  4. Keybindings:
       Cmd+Alt+O   -> Open chat
       Ctrl+Alt+E  -> Explain selection
       Ctrl+Alt+R  -> Refactor selection

EOF
