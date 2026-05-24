# Ollama Coder for Vim / Neovim

A fully-local LLM coding assistant for Vim 8+ and Neovim, talking to a local
[Ollama](https://ollama.com) server. Sister plugin to the VS Code extension in
this repo (`/src`). Nothing leaves your machine; no API keys.

## Features

- **`:OllamaChat`** — open a chat split, streaming responses appended in
  real time.
- **`:OllamaSend {prompt}`** — send a chat turn from anywhere.
- **`:OllamaWrite {prompt}`** — *agent mode*: model can call `read_file`,
  `list_files`, `write_file`. Every file write is gated by a `y/N` prompt.
- **Code actions on visual selection** — `:OllamaExplain`,
  `:OllamaRefactor`, `:OllamaFix`, `:OllamaDocs`, `:OllamaTests`,
  `:OllamaAsk`.
- **`:OllamaModel`** — pick from installed models (queried from `/api/tags`).
- **`:OllamaHistory`** — recall, edit, and resend a past prompt (history
  persists in `~/.cache/ollama-coder/history`).
- **`:OllamaStop`** — cancel any in-flight Ollama request.
- Streaming via `curl` + Vim's `job_start` / Neovim's `jobstart`, no Python
  or external runtime needed.

## Install

### Ubuntu / Debian
```sh
git clone https://github.com/evilmucedin/ollama-coder-vscode
cd ollama-coder-vscode
./vim/scripts/install-ubuntu.sh
```

### macOS
```sh
git clone https://github.com/evilmucedin/ollama-coder-vscode
cd ollama-coder-vscode
./vim/scripts/install-macos.sh
```
Uses Homebrew. If `vim` on your `$PATH` is the system `/usr/bin/vim`
(which lacks `+job`), the installer will gracefully fall back to
Neovim. Run `brew install vim` to get a modern Vim build.

### Windows (PowerShell 5.1+ or 7+)
```powershell
git clone https://github.com/evilmucedin/ollama-coder-vscode
cd ollama-coder-vscode
pwsh -ExecutionPolicy Bypass -File .\vim\scripts\install-windows.ps1
```
Uses `winget`. Installs into `%USERPROFILE%\vimfiles\pack\ollama\start\ollama-coder\`
and `%LOCALAPPDATA%\nvim-data\site\pack\ollama\start\ollama-coder\`.


The installer:
1. Ensures `curl`, `vim` (or `nvim`), and `ollama` are present.
2. Starts the Ollama server (systemd or background `ollama serve`).
3. Pulls the default chat and completion models (failures are fatal — no
   silent fall-through).
4. Installs the plugin into `~/.vim/pack/ollama/start/ollama-coder/` and
   `~/.local/share/nvim/site/pack/ollama/start/ollama-coder/`.
5. Generates helptags and sanity-checks that the plugin loads.

Env knobs:
| Variable | Default | Effect |
| --- | --- | --- |
| `EDITOR` | both if present | `vim`, `nvim`, or `both` |
| `CHAT_MODEL` | `llama3.1:8b` | model to pull for chat |
| `COMPLETION_MODEL` | `qwen2.5-coder:1.5b-base` | model to pull for completion |
| `EXTRA_MODELS` | (empty) | space-separated extras, e.g. `"qwen2.5:7b mistral:7b"` |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | server URL probed for readiness |
| `SKIP_OLLAMA` | `0` | don't touch Ollama (it's already set up) |
| `SKIP_PULL` | `0` | don't pull models (already pulled) |

## Default keymaps

Normal mode:
| Key | Command |
| --- | --- |
| `<leader>oc` | `:OllamaChat` |
| `<leader>om` | `:OllamaModel` |
| `<leader>os` | `:OllamaStop` |
| `<leader>oh` | `:OllamaHistory` |

Visual mode (works on the selection):
| Key | Command |
| --- | --- |
| `<leader>oe` | `:OllamaExplain` |
| `<leader>or` | `:OllamaRefactor` (replaces selection) |
| `<leader>of` | `:OllamaFix` (replaces selection) |
| `<leader>od` | `:OllamaDocs` (replaces selection) |
| `<leader>ot` | `:OllamaTests` (new buffer) |
| `<leader>oa` | `:OllamaAsk` (free-form question) |

Disable with `let g:ollama_coder_default_maps = 0` in your vimrc.

## Settings

```vim
let g:ollama_coder_endpoint           = 'http://localhost:11434'
let g:ollama_coder_chat_model         = 'llama3.1:8b'
let g:ollama_coder_completion_model   = 'qwen2.5-coder:1.5b-base'
let g:ollama_coder_temperature        = 0.2
let g:ollama_coder_context_chars      = 4000
let g:ollama_coder_agent_max_steps    = 8
let g:ollama_coder_default_maps       = 1
```

## Agent example

```vim
:OllamaWrite write to a new file C++ Hello World program
```

The model picks a filename (e.g. `hello_world.cpp`), calls `write_file`,
and you get a confirm prompt:

```
Ollama Coder agent: create hello_world.cpp (123 chars)? [y/N]
```

All paths are sandboxed to the project root (first `.git` ancestor of cwd,
falling back to cwd). The agent loop runs up to 8 steps.

## Privacy

Identical to the VS Code extension: every request goes to
`$OLLAMA_HOST` (default `http://localhost:11434`). No telemetry. No remote
calls. The only outbound network traffic in the entire repo is:

| Where | What |
| --- | --- |
| `vim/scripts/install-ubuntu.sh` | `apt-get`, the Ollama installer, `ollama pull` |
| Runtime | `curl` against `$OLLAMA_HOST` |

## See also

- The VS Code sister extension lives in `/src`, `/scripts`, `/package.json`.
- `DOCUMENTATION.md` at the repo root has architecture details.
