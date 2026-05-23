# Changelog

All notable changes to **Ollama Coder** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
