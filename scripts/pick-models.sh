#!/usr/bin/env bash
# Detect total system RAM and print a sensible Ollama model pick to stdout.
# The output is shell-evalable, e.g.:
#
#   $ ./scripts/pick-models.sh
#   RAM_MB=16384
#   RAM_GB=16
#   TIER=medium
#   CHAT_MODEL=qwen2.5:14b
#   COMPLETION_MODEL=qwen2.5-coder:1.5b-base
#
# Callers can `eval` it, or just grep individual lines:
#   CHAT_MODEL="$(./scripts/pick-models.sh | sed -n 's/^CHAT_MODEL=//p')"
#
# Override the detected memory by setting OVERRIDE_RAM_MB \u2014 used by the
# test suite so we don't have to mock /proc/meminfo or sysctl.
#
# The tier table (chosen for Q4_0 quantizations, with ~3 GB headroom for the
# OS + editor):
#
#   RAM           TIER      CHAT MODEL          COMPLETION MODEL
#   ---------     ------    ----------------    -------------------------
#   <  6 GB       tiny      llama3.2:3b         qwen2.5-coder:0.5b-base
#   <  12 GB      small     llama3.1:8b         qwen2.5-coder:1.5b-base
#   <  20 GB      medium    qwen2.5:14b         qwen2.5-coder:1.5b-base
#   <  40 GB      large     qwen2.5:32b         qwen2.5-coder:7b-base
#   >= 40 GB      huge      llama3.3:70b        qwen2.5-coder:7b-base

set -eu

detect_ram_mb() {
  if [ -n "${OVERRIDE_RAM_MB:-}" ]; then
    printf '%s\n' "$OVERRIDE_RAM_MB"
    return
  fi
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Linux)
      if [ -r /proc/meminfo ]; then
        awk '/^MemTotal:/ { print int($2/1024); exit }' /proc/meminfo
      else
        echo 0
      fi
      ;;
    Darwin)
      if command -v sysctl >/dev/null 2>&1; then
        sysctl -n hw.memsize 2>/dev/null | awk '{ print int($1/1048576) }'
      else
        echo 0
      fi
      ;;
    *)
      echo 0
      ;;
  esac
}

pick_tier() {
  ram_mb="$1"
  if   [ "$ram_mb" -lt 6144  ]; then echo "tiny"
  elif [ "$ram_mb" -lt 12288 ]; then echo "small"
  elif [ "$ram_mb" -lt 20480 ]; then echo "medium"
  elif [ "$ram_mb" -lt 40960 ]; then echo "large"
  else                               echo "huge"
  fi
}

pick_chat_model() {
  case "$1" in
    tiny)   echo "llama3.2:3b" ;;
    small)  echo "llama3.1:8b" ;;
    medium) echo "qwen2.5:14b" ;;
    large)  echo "qwen2.5:32b" ;;
    huge)   echo "llama3.3:70b" ;;
    *)      echo "llama3.1:8b" ;;
  esac
}

pick_completion_model() {
  case "$1" in
    tiny)            echo "qwen2.5-coder:0.5b-base" ;;
    small|medium)    echo "qwen2.5-coder:1.5b-base" ;;
    large|huge)      echo "qwen2.5-coder:7b-base"   ;;
    *)               echo "qwen2.5-coder:1.5b-base" ;;
  esac
}

ram_mb="$(detect_ram_mb)"
# Round to nearest GB for friendly display, but keep MB for tier math.
ram_gb=$(( (ram_mb + 512) / 1024 ))
tier="$(pick_tier "$ram_mb")"
chat="$(pick_chat_model "$tier")"
completion="$(pick_completion_model "$tier")"

cat <<EOF
RAM_MB=$ram_mb
RAM_GB=$ram_gb
TIER=$tier
CHAT_MODEL=$chat
COMPLETION_MODEL=$completion
EOF
