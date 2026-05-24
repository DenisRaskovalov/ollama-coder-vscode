# Ollama Free Coder

A fully-local LLM coding assistant powered by [Ollama](https://ollama.com).
Nothing leaves your machine.

This repository ships **two sister plugins** that share the same ideas:

| Editor | Source | Installers | Docs |
| --- | --- | --- | --- |
| **VS Code** | `src/` | `scripts/install-ubuntu.sh`, `scripts/install-macos.sh`, `scripts/install-windows.ps1` | this README + [`DOCUMENTATION.md`](./DOCUMENTATION.md) |
| **Vim / Neovim** | `vim/` | `vim/scripts/install-ubuntu.sh`, `vim/scripts/install-macos.sh`, `vim/scripts/install-windows.ps1` | [`vim/README.md`](./vim/README.md) + `:help ollama-coder` |

All six installers share the same environment-variable contract:
`CHAT_MODEL`, `COMPLETION_MODEL`, `EXTRA_MODELS`, `OLLAMA_HOST`,
`SKIP_OLLAMA`, `SKIP_PULL`. They each ensure the Ollama server is
running, pull the configured models (failures are fatal, never silent),
and verify them in `/api/tags` before installing the plugin.

The rest of this README is about the VS Code extension.

---

## Ollama Free Coder for VS Code

## Features

- **Inline ghost-text completion** as you type, using a FIM-capable model
  (defaults to `qwen2.5-coder:1.5b-base`). Debounced and cancellable.
- **Command history** — every prompt you send is persisted. Press ↑/↓ in the
  chat input to walk through past commands shell-style, click **History** for
  a list view, or hover any past user message in the chat log for one-click
  *resend* and *edit*.
- **Chat sidebar** (Activity Bar → robot icon) with streaming responses, a
  one-click "include current file/selection" toggle, and `@mentions`:
  - `@src/foo.ts` — attach a workspace file's contents to your question.
  - `@selection` — attach the current editor selection (or whole active file).
- **Show-on-screen vs. write-to-file routing** — prompts like *“show me a
  C++ Hello World”*, *“explain Vector class in C++”*, *“what is a class in
  Python”* always stream into the chat panel. Prompts like *“add Vector
  class implementation to test.cpp”* or *“write a new file with Python
  fizzbuzz”* are auto-routed through agent mode and create the file (with
  a confirm dialog). You can override either way by toggling **agent mode**.
- **Web search built in** — three ways to use it:
  1. Type `/search QUERY` (or `/web`, `/google`) in the chat input to run a
     web search directly and render the top hits inline. No LLM involved.
  2. Prompts with a web-search intent (*"google the latest TypeScript"*,
     *"what's new in Rust 1.85"*, *"search the web for free SVG icons"*)
     are auto-grounded: results are fetched and prepended as context
     before the LLM answers.
  3. The agent can call `web_search` itself in agent mode.
  A small `Search: DuckDuckGo` (or `Google`) label in the chat input shows
  which backend is active.
- **Apply code blocks** — hover any code block in chat for one-click
  *Insert at cursor*, *Replace selection*, *Save…* (with diff preview if the
  target file exists), and *Copy*. If the assistant emits a fence like
  ` ```ts src/foo.ts `, *Save…* pre-fills that path.
- **Agent mode** (checkbox in the chat input) lets the model call workspace
  tools to answer multi-step questions and apply edits:
  - `read_file`, `list_files`, `search_text` — read-only context gathering.
  - `get_open_editors` — see what's open and what's selected.
  - `web_search` — search the public web. Default backend is **DuckDuckGo**
    (free, no key, no signup). If you set `ollamaCoder.googleApiKey` and
    `ollamaCoder.googleCseId`, the tool switches to Google Custom Search
    JSON API (Google's free tier: 100 queries/day).
  - `write_file` — create / overwrite files (always shows a confirm dialog;
    "Show diff first" opens a side-by-side preview before applying).
  Uses Ollama's native tool calling — works well with `llama3.1:8b`,
  `qwen2.5:7b`, `qwen2.5-coder:7b`, and other tool-capable models.
- **Code actions on selection** (right-click → *Ollama Free Coder*):
  - Explain Selection
  - Refactor Selection (replaces selection)
  - Fix Selection (replaces selection)
  - Add Docstrings / Comments (replaces selection)
  - Generate Unit Tests (opens new editor)
  - Ask About Selection… (free-form question)
- **Status bar model switcher** — click the `Ollama: <model>` badge to swap
  between any model you've pulled (`ollama pull ...`).
- **Zero runtime npm deps** — uses Node's built-in `http` for the Ollama API.

## Default keybindings

| Action                | Shortcut          |
| --------------------- | ----------------- |
| Open chat             | `Ctrl+Alt+O`      |
| Explain selection     | `Ctrl+Alt+E`      |
| Refactor selection    | `Ctrl+Alt+R`      |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ollamaCoder.endpoint` | `http://localhost:11434` | Ollama server URL |
| `ollamaCoder.chatModel` | `llama3.1:8b` | Model for chat & code actions |
| `ollamaCoder.completionModel` | `qwen2.5-coder:1.5b-base` | Model for inline completion (FIM-capable recommended) |
| `ollamaCoder.enableInlineCompletion` | `true` | Toggle ghost-text completion |
| `ollamaCoder.completionDebounceMs` | `250` | Delay before a completion request |
| `ollamaCoder.maxCompletionTokens` | `128` | Max tokens per completion |
| `ollamaCoder.temperature` | `0.2` | Sampling temperature |
| `ollamaCoder.contextWindowChars` | `4000` | Max chars of file context sent to the model |
| `ollamaCoder.agentMaxSteps` | `8` | Max tool-calling steps per agent turn |
| `ollamaCoder.searchBackend` | `duckduckgo` | `duckduckgo` (free, no key) or `google` (requires the two keys below) |
| `ollamaCoder.googleApiKey` | `""` | Optional Google API key for Custom Search JSON API (free 100/day) |
| `ollamaCoder.googleCseId` | `""` | Optional Google Programmable Search Engine id |

## Quick install on Ubuntu (24.04 / 26.04)

```bash
git clone https://github.com/local/ollama-coder-vscode
cd ollama-coder-vscode
./scripts/install-ubuntu.sh
```

The script will:

1. Check for Node.js ≥ 18 (and install via apt if missing).
2. Install Ollama (via the official installer) and `systemctl enable --now ollama`.
3. Pull the two default models (`llama3.1:8b`, `qwen2.5-coder:1.5b-base`).
4. `npm install`, compile TypeScript, package a `.vsix`, and install it into the `code` CLI.

Useful environment variables:

```bash
CODE_BIN=codium ./scripts/install-ubuntu.sh   # install into VSCodium instead of VS Code
SKIP_OLLAMA=1   ./scripts/install-ubuntu.sh   # skip Ollama install
SKIP_PULL=1     ./scripts/install-ubuntu.sh   # skip pulling models
CHAT_MODEL=qwen2.5-coder:7b-instruct ./scripts/install-ubuntu.sh
```

## Manual build

```bash
npm install
npm run compile
npx vsce package -o ollama-free-coder.vsix
code --install-extension ./ollama-free-coder.vsix --force
```

## Development

```bash
npm install
npm run watch       # incremental compile
# In VS Code: F5 to launch an Extension Development Host.
```

Source layout:

```
src/
  extension.ts           # activation, commands, status bar
  ollama.ts              # streaming HTTP client for /api/generate, /api/chat, /api/tags
  completionProvider.ts  # InlineCompletionItemProvider with FIM (prompt + suffix)
  codeActions.ts         # Explain / Refactor / Fix / Docstrings / Tests / Ask
  chatView.ts            # Webview-based chat sidebar
scripts/
  install-ubuntu.sh      # one-shot build + install for Ubuntu
```

## Model recommendations

| Use case | Suggested model | `ollama pull` |
| --- | --- | --- |
| Inline completion (fast, FIM) | `qwen2.5-coder:1.5b-base` | `ollama pull qwen2.5-coder:1.5b-base` |
| Inline completion (better, FIM) | `qwen2.5-coder:7b-base` | `ollama pull qwen2.5-coder:7b-base` |
| Chat / code actions (small) | `llama3.1:8b` | `ollama pull llama3.1:8b` |
| Chat / code actions (better) | `qwen2.5-coder:7b-instruct` | `ollama pull qwen2.5-coder:7b-instruct` |

> The inline completion provider sends both a `prompt` (prefix) and `suffix` to
> `/api/generate`, which Ollama forwards to the model's fill-in-the-middle
> template. Use a `*-base` coder model for best results — `instruct`/`chat`
> models tend to wrap output in prose.

## License

Apache-2.0 (see `LICENSE`).
