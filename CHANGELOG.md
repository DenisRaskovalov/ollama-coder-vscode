# Changelog

All notable changes to **Ollama Free Coder** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
