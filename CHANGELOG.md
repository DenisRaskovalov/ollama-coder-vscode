# Changelog

All notable changes to **Ollama Free Coder** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.9] — unreleased

### Fixed — the *“I opened a folder but no file ever shows up”* bug

Root cause was the write/edit confirm dialog: it was `{ modal: false }`,
so it appeared as a small toast in the bottom-right corner of VS Code,
**auto-dismissed after a few seconds**, and silently resolved to
`undefined`. The tool then correctly treated that as “user rejected”,
the model said *“ok, didn’t write the file”*, and the user saw nothing
happen.

Three changes:

1. **Every confirm dialog is now `{ modal: true }`** in `src/tools.ts`
   for `write_file`, `edit_file`, and `run_command`. The modal blocks
   the editor until the user answers — it cannot be missed.

2. **The dialog text shows the workspace path and proposed filename
   together**, e.g.
     > *Ollama Free Coder wants to create a file:*
     >
     > *`hello_world.py` (123 chars)*
     >
     > *in workspace: `/home/me/projects/demo`*
     >
     > *Allow?*

   So the user sees both *what* will be written and *where*.

3. **No-workspace error is loud**. `chatView.handleSend` now refuses to
   start the agent when `vscode.workspace.workspaceFolders` is empty,
   with the explicit message *“⚠ No folder is open in VS Code. Use
   File → Open Folder… first.”* When a folder IS open, the chat shows
   a *“Writing into workspace: <path>”* notice before the agent runs,
   so the user always knows where files will land.

### Tests: 309 → 315 (+6)
New `test/modalWriteConfirm.test.js`:
- Source contains **NO** `{ modal: false }` confirm dialogs.
- `writeFile`, `editFileTool`, and `runShellCommand` each contain a
  `showWarningMessage` with `{ modal: true }`.
- `writeFile` and `editFileTool` include `workspaceRoot().fsPath` in
  the dialog body.
- `chatView` checks `workspaceFolders` before agent runs and emits the
  *“Open Folder”* hint.
- `chatView` emits the *“Writing into workspace: …”* notice before each
  agent turn.

Verified by hand: temporarily re-introducing `{ modal: false }` turns
4 of the 6 new cases red; restoring the fix returns to green.

## [1.4.8] — unreleased

Auditing and closing the gap between positive and negative tests.

### Added
- `test/sandboxNegative.test.js` (15 cases). For every workspace tool,
  asserts the sandbox invariant: **`..` traversal rejects; absolute /
  leading-slash paths are coerced to inside the workspace; null,
  undefined and unknown tool names return ERROR without throwing.**
  Also includes a positive control (workspace-relative path works).
- `test/agentLoopNegative.test.js` (5 cases). The agent loop now
  tolerates an `executeTool` that throws — the thrown error is wrapped
  as `ERROR: tool 'X' threw: …` and pushed as a tool message so the
  model gets a chance to recover. `chat` rejections still bubble up
  (network outages should be loud). `maxSteps` is enforced (including
  `0`), `onStoppedAtMaxSteps` fires when adversarial models won’t
  stop emitting `tool_calls`, and the conversation history is
  preserved across truncation.
- `test/routerNegative.test.js` (8 cases). Every router HTTP-layer
  failure mode returns `null` so the regex fallback runs: chat
  throwing (`ECONNREFUSED`), garbage JSON, valid JSON with unknown
  `kind`, `create_file` without `target_path`, hung chat (timeout),
  empty content, JSON that is null/number/string/array.
- `ARCHITECTURE.md` gets a **“Test coverage — positive AND negative”**
  matrix listing every area with both kinds of test.

### Changed
- `src/agentLoop.ts`: `executeTool` is now wrapped in try/catch so a
  thrown executor cannot crash the loop. Production behaviour is
  unchanged because `tools.executeTool` already returns `ERROR: …`
  strings; this is defence in depth against custom executors
  (tests, future extensions).

## [1.4.7] — unreleased

Language understanding now lives in Ollama, not regex. This is
**step 4c of the migration plan in ARCHITECTURE.md §4.5** — the
LLM router becomes authoritative by default; the regex pipeline
remains as the fast fallback for when the router fails or times out.

### Changed
- `ollamaCoder.useLlmRouter` default: `false` → **`true`**. Every chat
  turn now goes through a small structured `format: 'json'` call to
  the router (default model: the completion model, typically
  `qwen2.5-coder:1.5b-base` — fast enough for sub-second routing on
  most hardware).
- The router’s `RoutePlan` schema grew four optional fields so the
  model can convey everything the regex layer used to compute:
  - `language` — replaces `inferLanguageExt`.
  - `needs_web` — replaces `looksLikeWebSearchIntent` as an
    authoritative signal for RAG-style auto-fetch.
  - `problem_source` + `problem_id` — replaces `detectProblemRef` for
    LeetCode / Codeforces / Project Euler / Advent of Code.
- `ROUTER_SYSTEM_PROMPT` expanded with an explicit schema and 8
  numbered routing rules covering every case the regex pipeline
  handles today (show-on-screen, file write, file edit, web search,
  selection actions, run command, competitive-programming
  references). Worker model and router model are explicitly
  different roles, spelled out at the top of the system prompt.
- `chatView.handleSend` consumes the new fields to build a unified
  hint block (`(Router hints: target file: leetcode_1000.py;
  language: python; problem reference: LeetCode 1000 …)`) and to
  drive web-search auto-fetch when `needs_web` is true.

### Kept (safety net)
- The regex classifiers (`looksLikeFileWriteIntent`,
  `looksLikeShowIntent`, `looksLikeWebSearchIntent`,
  `inferLanguageExt`, `detectProblemRef`) are still in the codebase
  and still tested. They run when the router returns null (timeout,
  bad JSON, no Ollama). Step 4d (delete the regex) is intentionally
  NOT in this PR; we want a release of soak time first.
- All 277 pre-1.4.7 tests still pass. The router is invoked through
  the same `routeWithModel`/`coerceRoutePlan` path that
  `router.test.js` already exercises.

## [1.4.6] — unreleased

### Added
- **Competitive-programming problem detector**. New `src/problemRef.ts`
  recognises four well-known sources in the user’s prompt and produces
  a structured hint the agent acts on:
  - LeetCode (`leetcode 1000`, `leetcode #200`, `LeetCode problem 42`)
  - Codeforces (`codeforces 1234A`, `Codeforces round 1898 problem B`)
  - Project Euler (`project euler 50`, `project euler problem #7`)
  - Advent of Code (`AoC 2022 day 17`, `advent of code day 5 2023`)

  Each match yields a `source`, `id`, `suggestedFilename`
  (`leetcode_1000.py`, `codeforces_1234A.py`, etc.), `referenceUrl`,
  and an augmentation appended to the user message: *“(Problem
  reference detected: LeetCode 1000. If you don’t remember the exact
  problem statement, call web_search with `LeetCode 1000` and read the
  result before solving. Save the solution to `leetcode_1000.py`.)”*
  When a problem reference is detected we also force `effectiveAgent =
  true` so the agent has `web_search` and `write_file` available.

### Fixed
- *“Generate a solution of LeetCode problem 1000 in a new file on disk”*
  now reliably ends with a file on disk. The chat view detects the
  LeetCode reference, suggests `leetcode_1000.py`, invites `web_search`
  if the model doesn’t remember the problem, and the existing
  fallback-save pass from 1.4.5 catches any residual edge case.

## [1.4.5] — unreleased

### Fixed
- **"Write on a new file a solution of problem 'Hello World'" left the
  folder unchanged.** Small local models like `llama3.1:8b` sometimes
  ignore the agent’s tool instructions and reply with a chat-mode
  fenced code block instead of calling `write_file`. The agent loop
  terminated “cleanly” but no file got created, so the user got the
  code on screen and nothing on disk — exactly the regression they
  reported. Two complementary fixes:

  - **Sharper system prompt**: `SYSTEM_AGENT` now explicitly forbids
    answering a file-creation request with just a chat code block, and
    tells the model to default to Python `.py` when no language is
    specified.
  - **Fallback-save pass**: after `runAgentLoop` returns, if no
    `write_file` / `edit_file` tool call actually succeeded but the
    assistant’s last message contains a fenced code block, the chat
    view extracts the block and routes it through `apply.saveToFile`
    — the same confirm-and-write path the existing “Save…” button
    uses. The user sees a notice (“Agent finished without calling
    write_file. Saving the code block to disk — confirm the path in
    the input box.”) and can edit or accept the suggested filename
    in an input box.

### Added
- `src/extractCodeBlocks.ts` — pure helpers used by the fallback:
  `extractCodeBlocks(text)` recognises both ` ```lang ` and
  ` ```lang path/to/file ` fence headers; `guessFilenameForLang(lang,
  code, prompt)` maps the language tag to an extension, sniffs the
  body for cheap signals when the language is missing, and derives a
  base name from up to three lowercase tokens of the user’s prompt
  (so “Hello World” → `hello_world.py`).

## [1.4.4] — unreleased

Agent acceptance harness. End-to-end tests that follow the user's
"empty directory → sequence of commands → verify the output compiles
and runs" pattern.

### Added
- `src/agentLoop.ts` — the agent loop, extracted from `chatView.ts` into
  a pure dependency-injected function with no `vscode` imports. The
  loop takes `chat`, `executeTool`, and optional `on*` callbacks, so it
  can be driven by the production VS Code webview, by tests, or by a
  future CLI front-end.
- `test/_scriptedOllama.js` — a deterministic `chat` mock that serves
  a scripted sequence of `{ content, tool_calls }` entries.
- `test/_fsToolExecutor.js` — a workspace-agnostic tool executor backed
  by plain `fs`, reusing the production `applySearchReplace` and
  `extractSymbols` / `renderRepoMap` helpers. Auto-confirms writes
  (tests don't have a modal dialog).
- `test/agentE2E.test.js` with **five end-to-end scenarios**:
  1. Empty dir → “write a Python script that prints 1..10” →
     `python3 count.py` actually prints 1..10.
  2. Empty dir → multi-file C++ Hello World + Makefile →
     `make && ./hello` exits 0 and prints `Hello, World!`.
  3. Pre-existing buggy Python file → agent does `read_file` then a
     SEARCH/REPLACE patch via `edit_file` → `python3` shows the fixed
     output (`1..10`, not `1..9`).
  4. Pre-existing repo → agent uses `repo_map` first to find the
     calculator module, then `edit_file` adds a function. Test asserts
     the tool sequence is `[repo_map, edit_file]` — the exact ordering
     `SYSTEM_AGENT` coaches.
  5. Failure recovery: agent’s first `edit_file` has an ambiguous
     `search` (matches 3 times), the executor returns the
     “more than once” ERROR, and the agent retries with a unique
     snippet. Final file content is verified byte-for-byte.
- Scenarios that need a toolchain (`python3`, `g++`, `make`) skip
  themselves cleanly when the binary isn’t on `PATH`. No false reds
  on bare CI images.

### Changed
- `chatView.ts` now uses `runAgentLoop` from `src/agentLoop.ts` instead
  of the inlined body. Production behaviour is byte-identical; the
  refactor is purely to make the loop test-drivable. Verified by the
  other 240 tests staying green.

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
