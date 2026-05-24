# Changelog

All notable changes to **Ollama Free Coder** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.3] — unreleased

Agent capability bump, inspired by ideas from open-source coding agents.

### Added
- **`edit_file` tool** — Aider-style SEARCH/REPLACE patch. The model
  supplies `{ path, search, replace }`; the helper requires `search` to
  appear exactly once in the file and rejects with an actionable retry
  message otherwise (so a small model can iterate). Normalises CRLF to
  LF so a stray Windows line ending doesn’t break a correct patch.
  Order-of-magnitude cheaper in tokens than re-emitting the whole file
  for a 3-line change, and much more reliable on smaller chat models.
- **`repo_map` tool** — returns a compact textual map of the workspace:
  every source file with its top-level symbols (functions, classes,
  methods, types) and 1-based line numbers. Per-language regex
  extractors for TypeScript / JS / Python / Ruby / Go / Rust / Java /
  C/C++ / Bash. Capped to ~12 KB so it fits in a context window. Gives
  the agent navigation “vision” without having to read every file.
- The agent system prompt now actively coaches the model to:
  - Use `repo_map` first when unsure where to look.
  - Use `edit_file` instead of `write_file` for modifications.
  - Re-read with `read_file` before patching.

## [1.4.2] — unreleased

### Added
- **LLM router** (ARCHITECTURE.md §4.3, step 4a). New `src/router.ts` calls
  a small fast model with `format: 'json'` and returns a structured
  `RoutePlan` (`kind`, `target_path`, `rephrased`, `reason`). Off by
  default; opt in via `ollamaCoder.useLlmRouter` for authoritative
  routing or `ollamaCoder.shadowLlmRouter` for shadow-mode logging.
  `ollamaCoder.routerModel` lets you override which model handles
  routing (defaults to the completion model). Schema-validated; the
  router cannot make the plugin do anything outside the allowed kinds.
- **`run_command` tool** for the agent. Runs a shell command in the
  workspace root with a modal confirm dialog (model cannot bypass it),
  a kill-after-timeout (`ollamaCoder.runCommandTimeoutMs`, default 30s),
  and a 16KB output cap. Disabled by default; flip
  `ollamaCoder.enableRunCommand` to allow it. Each invocation still
  requires a per-call user click.
- `ollama.chatFull` learned `format: 'json'` for forced-structured
  output (used by the router; available for any caller).

## [1.4.1] — unreleased

### Added
- `ARCHITECTURE.md` — design paper covering the four phases of an
  operation (Input → Router → Executor → Output), the seven invariants
  the plugin upholds, the proposed migration from regex classifiers to
  an LLM-driven router, and an end-to-end data-flow trace of one
  realistic prompt.

## [1.4.0] — unreleased

First version with the full feature set described below. Bumped from the
0.1.x pre-release line to reflect that. From this version onwards every
shipped PR bumps the package version (at least the patch component).

### Added since the pre-release line
- Auto-detect `chat` and `completion` models from system RAM
  (`scripts/pick-models.sh` / `.ps1`, 5-tier table, override via
  `CHAT_MODEL` / `COMPLETION_MODEL` env vars).
- Web search built into the chat: `/search`, `/web`, `/google` slash
  commands; auto-RAG on prompts with web intent; visible backend label
  (`Search: DuckDuckGo` / `Google`); DuckDuckGo by default, Google CSE
  opt-in via `googleApiKey` + `googleCseId`.
- Full keyboard navigation in the model picker (Up/Down/Home/End/
  PageUp/PageDown/Enter/Escape).
- Show-on-screen intent classifier that overrides the file-write
  auto-routing for `show me …` / `what is …` / `explain …` / etc.
- macOS and Windows installers for both the VS Code extension and the
  Vim/Neovim sister plugin, with the shared env-var contract.
- One-command `scripts/publish-ubuntu.sh` (build → test → package →
  verify → publish → tag), idempotent across re-runs.
- Vim/Neovim sister plugin under `vim/` (commands `:OllamaChat`,
  `:OllamaSend`, `:OllamaWrite`, `:OllamaSearch`, code actions,
  history, model picker, agent loop).
- Test suite grew to 186+ cases with explicit regression guards for
  every reported bug.

### Changed
- Marketplace publisher: `local` → `DenRaskovalov`.
- Marketplace name: `ollama-coder` / “Ollama Coder” → `ollama-free-coder` /
  “Ollama Free Coder”. Vim sister plugin keeps the “Ollama Coder”
  name on purpose.
- Model picker is a custom DOM widget instead of `<select>` (native
  `<select>` rendered as invisible text in some VS Code themes).

### Fixed
- HTTP 404 from chat when the default model tag was bogus (script
  silently warned-and-continued before — now fatal).
- Model list dropdown showing fewer models than `ollama list` (newer
  Ollama `/api/tags` returns `m.model` instead of `m.name` for some
  entries).
- Webview frozen at `(loading…)` after escaping `\n` inside template
  literal-embedded JS strings.
- `compactJson` reference error during agent tool turns.
- `publish-ubuntu.sh` failing on the second run because `npm install`
  re-wrote `package-lock.json`.

## [0.1.0] — Initial Marketplace release

### Added
- Inline ghost-text completion via Ollama (`/api/generate` with FIM stop tokens).
  Default model: `qwen2.5-coder:1.5b-base`.
- Chat sidebar (Activity Bar → robot icon) with streaming responses.
- `@mentions` in chat: `@path/to/file` attaches a workspace file,
  `@selection` attaches the editor selection.
- **Apply buttons** on every assistant code block: *Insert at cursor*,
  *Replace selection*, *Save…* (with side-by-side diff preview before
  overwriting), and *Copy*. Recognises `` ```lang path/to/file `` headers.
- **Agent mode** (toggle in chat input). Uses Ollama’s native tool calling
  with five workspace tools: `read_file`, `list_files`, `search_text`,
  `write_file` (always user-confirmed, optional diff preview),
  `get_open_editors`. All paths sandboxed to the workspace root.
- **Model picker** dropdown in the chat input — switches the model for the
  next query and persists the choice.
- Code actions on selection: **Explain**, **Refactor**, **Fix**, **Add
  Docstrings/Comments**, **Generate Unit Tests**, **Ask About Selection…**.
- Status-bar model switcher.
- Default keybindings: `Ctrl/Cmd+Alt+O` (open chat), `Ctrl+Alt+E` (explain),
  `Ctrl+Alt+R` (refactor).
- Friendly `HTTP 404` handling: surfaces `Model "X" is not installed. Run:
  ollama pull X` instead of opaque errors.
- Ubuntu installer (`scripts/install-ubuntu.sh`) that bootstraps Node, the
  Ollama server (systemd or `ollama serve` fallback), pulls the configured
  models, runs tests, and installs the packaged extension.
- Test harness using Node’s built-in `node:test` runner (no extra deps):
  type-check test + `compactJson` unit tests.
- Documentation: `README.md`, `DOCUMENTATION.md` (architecture reference),
  `PUBLISHING.md` (Marketplace runbook).
