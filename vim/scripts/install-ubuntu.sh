#!/usr/bin/env bash
# Install Ollama Coder for Vim / Neovim on Ubuntu.
#
# What this does:
#   1. Ensures curl, vim (or neovim), and ollama are present.
#   2. Starts the Ollama server (systemd or `ollama serve` fallback).
#   3. Pulls the default chat & completion models (failures are fatal).
#   4. Installs the plugin into Vim's pack/ directory (and Neovim's).
#
# Usage:
#   ./vim/scripts/install-ubuntu.sh                     # vim + nvim if present
#   EDITOR=nvim ./vim/scripts/install-ubuntu.sh          # neovim only
#   EDITOR=vim  ./vim/scripts/install-ubuntu.sh          # vim only
#   SKIP_OLLAMA=1 ./vim/scripts/install-ubuntu.sh        # don't touch Ollama
#   SKIP_PULL=1   ./vim/scripts/install-ubuntu.sh        # don't pull models
#   EXTRA_MODELS="qwen2.5:7b mistral:7b" ./vim/scripts/install-ubuntu.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLUGIN_SRC="$ROOT_DIR/vim"

log()  { printf "\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!! \033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31mxx \033[0m %s\n" "$*" >&2; exit 1; }

# Auto-pick chat & completion models based on system RAM, unless the user
# explicitly set CHAT_MODEL / COMPLETION_MODEL. See scripts/pick-models.sh
# for the tier table.
if [ -z "${CHAT_MODEL:-}" ] || [ -z "${COMPLETION_MODEL:-}" ]; then
  _PICK_SCRIPT="$(dirname "${BASH_SOURCE[0]}")/../../scripts/pick-models.sh"
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

# -----------------------------------------------------------------------------
# 1. Prerequisites
# -----------------------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
  log "Installing curl"
  sudo apt-get update -y
  sudo apt-get install -y curl
fi

WANT_VIM=0
WANT_NVIM=0
case "${EDITOR:-}" in
  vim)   WANT_VIM=1 ;;
  nvim)  WANT_NVIM=1 ;;
  ""|both)
    command -v vim  >/dev/null 2>&1 && WANT_VIM=1
    command -v nvim >/dev/null 2>&1 && WANT_NVIM=1
    ;;
  *) die "EDITOR must be one of: vim, nvim, both (got '$EDITOR')" ;;
esac

if [ "$WANT_VIM$WANT_NVIM" = "00" ]; then
  warn "Neither vim nor nvim is installed."
  read -r -p "Install vim now? [Y/n] " ans
  if [[ ! "$ans" =~ ^[Nn] ]]; then
    sudo apt-get update -y
    sudo apt-get install -y vim
    WANT_VIM=1
  else
    die "Aborting — install vim or neovim and re-run."
  fi
fi

# vim needs to be 8.0+ for +job. Check.
if [ "$WANT_VIM" = 1 ]; then
  if ! vim --version | grep -q '+job'; then
    warn "Installed vim lacks +job. The plugin needs Vim 8.0+ with +job."
    warn "On Ubuntu: sudo apt install vim-gtk3   (or vim-nox)"
    WANT_VIM=0
  fi
fi

# -----------------------------------------------------------------------------
# 2. Ollama
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
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -q '^ollama\.service'; then
    log "Enabling & starting ollama via systemd"
    sudo systemctl enable --now ollama || warn "systemctl enable --now ollama failed; will fall back"
    if wait_for_ollama 30; then return 0; fi
  fi
  start_ollama_background
  if wait_for_ollama 30; then
    log "Ollama server is up at $OLLAMA_HOST"
    return 0
  fi
  die "Ollama server did not become reachable at $OLLAMA_HOST"
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
    log "Installing Ollama"
    curl -fsSL https://ollama.com/install.sh | sh
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
# 3. Install the plugin
# -----------------------------------------------------------------------------
install_into() {
  local target="$1"     # e.g. ~/.vim/pack/ollama/start/ollama-coder
  local label="$2"      # 'vim' / 'nvim'
  log "Installing into $target ($label)"
  rm -rf "$target"
  mkdir -p "$target"
  cp -r "$PLUGIN_SRC/plugin"   "$target/"
  cp -r "$PLUGIN_SRC/autoload" "$target/"
  cp -r "$PLUGIN_SRC/doc"      "$target/"
  if [ "$label" = "vim" ]; then
    vim -es -u NONE +"helptags $target/doc" +qa! || warn "helptags failed (non-fatal)"
  else
    nvim --headless +"helptags $target/doc" +qa! || warn "helptags failed (non-fatal)"
  fi
}

if [ "$WANT_VIM" = 1 ]; then
  install_into "$HOME/.vim/pack/ollama/start/ollama-coder" vim
fi
if [ "$WANT_NVIM" = 1 ]; then
  install_into "${XDG_DATA_HOME:-$HOME/.local/share}/nvim/site/pack/ollama/start/ollama-coder" nvim
fi

# -----------------------------------------------------------------------------
# 4. Sanity check
# -----------------------------------------------------------------------------
log "Sanity-checking plugin load"
if [ "$WANT_VIM" = 1 ]; then
  if ! vim -es -u NONE -c "set rtp+=$HOME/.vim/pack/ollama/start/ollama-coder" \
                       -c "runtime plugin/ollama-coder.vim" \
                       -c "exists(':OllamaChat') == 2 ? qa! : cquit" 2>&1; then
    die "vim failed to load the plugin"
  fi
fi
if [ "$WANT_NVIM" = 1 ]; then
  if ! nvim --headless -u NONE \
        -c "set rtp+=${XDG_DATA_HOME:-$HOME/.local/share}/nvim/site/pack/ollama/start/ollama-coder" \
        -c "runtime plugin/ollama-coder.vim" \
        -c "if exists(':OllamaChat') == 2 | qa! | else | cquit | endif" 2>&1; then
    die "nvim failed to load the plugin"
  fi
fi

log "Done!"
cat <<EOF

Next steps:
  - Restart Vim/Neovim (or :runtime plugin/ollama-coder.vim)
  - Try:   :OllamaChat
  - Try:   :OllamaWrite write to a new file C++ Hello World program
  - Help:  :help ollama-coder
  - Default keymaps live under <leader>o (e.g. <leader>oc opens chat).

Models pulled:
  chat        : $CHAT_MODEL
  completion  : $COMPLETION_MODEL

EOF
