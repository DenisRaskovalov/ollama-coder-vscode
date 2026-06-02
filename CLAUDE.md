# CLAUDE.md

Guidance for Claude Code (and any AI agent) working in this repository.
Read this first; it tells you how the project is built, what is load-bearing,
and which invariants you must not break.

## What this project is

**Ollama Free Coder** is a fully-local VS Code coding assistant that talks to a
local [Ollama](https://ollama.com) server. Nothing leaves the machine; there
are no API keys and **zero runtime npm dependencies** (the Ollama client is
built on Node's `http` module). A sister Vim/Neovim plugin lives in `vim/`.

The guiding design principle, stated by the project owner and enshrined in
`ARCHITECTURE.md §4`:

> **Delegate language understanding to the Ollama model. Keep the plugin small,
> mechanical, and honest.**

When you add code, ask: is this *language understanding* (intent, phrasing,
structure)? If so it belongs in a model prompt, not a regex. Is this *plumbing
or a safety rail* (sandbox, confirm dialog, schema validation, streaming)? Then
it stays mechanical, in the plugin, and gets a test.

## Where the documentation lives

This repo is documentation-rich. Don't duplicate — link.

| Doc | Audience | Contents |
| --- | --- | --- |
| [`README.md`](./README.md) | users | install, features, settings, keybindings, model recommendations |
| [`DOCUMENTATION.md`](./DOCUMENTATION.md) | contributors | reference manual: every file, tool, setting, command, and the installer |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | contributors | design paper: the four-phase pipeline, the 8 invariants, the LLM-router migration plan |
| [`CHANGELOG.md`](./CHANGELOG.md) | everyone | per-version history |
| [`PUBLISHING.md`](./PUBLISHING.md) | maintainer | Marketplace publish flow |
| `vim/README.md` | users | the sister Vim/Neovim plugin |

If you change behavior, update the relevant doc in the same commit.
`ARCHITECTURE.md` is guarded by `test/architectureDoc.test.js`, which fails if
its load-bearing sections, the four phases, the named invariants, or the
real-code references in the data-flow trace go missing — keep them in sync.

## Architecture in one screen

```
INPUT  ──▶  ROUTER  ──▶  EXECUTOR  ──▶  OUTPUT
(chat,    (intent       (loop:        (chat panel,
 slash,    classify;     Ollama        editor buffer,
 keymap,   LLM router     /api/chat    or disk —
 inline)   + regex        + tools)     always confirmed)
           fallback)
```

Four phases, all traced end-to-end in `ARCHITECTURE.md §5`:

1. **Input** (`src/extension.ts`, `src/chatView.ts`) — normalize user text +
   editor context, expand `@mentions`. Deterministic; no model consulted.
2. **Routing** (`src/router.ts` authoritative, `looksLike*` regexes in
   `src/problemRef.ts` / `chatView.ts` as fallback) — decide: stay in chat,
   write a file, or ground with a web search. The LLM router is the default
   (`ollamaCoder.useLlmRouter: true`); regex is the fallback when it returns null.
3. **Execution** (`src/agentLoop.ts` → `runAgentLoop`, `src/tools.ts`) — either
   a single streaming `/api/chat`, or a bounded agent loop that calls tools.
4. **Output** (`src/apply.ts`, `src/tools.ts`) — screen, editor, or disk.
   Anything touching disk passes through a confirm dialog.

### Source map (start here when navigating)

| File | Responsibility |
| --- | --- |
| `src/extension.ts` | `activate()`: commands, status bar, providers, webview |
| `src/ollama.ts` | HTTP client: `generate` / `chat` / `chatFull` / `listModels`; streaming JSON-line parser; friendly 404→"model not pulled" |
| `src/chatView.ts` | chat sidebar webview: input bar, `@mentions`, model picker, streamed render with apply buttons |
| `src/agentLoop.ts` | `runAgentLoop`: the bounded tool-calling loop |
| `src/tools.ts` | agent tool schemas + executors; **the I/O + sandbox boundary** |
| `src/router.ts` | LLM intent router (`format: json`), schema-validated `RoutePlan` |
| `src/problemRef.ts` | detects LeetCode / Codeforces / Project Euler / AoC prompts |
| `src/editFile.ts` | Aider-style SEARCH/REPLACE diff edits (`edit_file` tool) |
| `src/repoMap.ts` | repo map / symbol extraction (`repo_map` tool) |
| `src/apply.ts` | `insertAtCursor` / `replaceSelection` / `saveToFile` (chat code-block buttons) |
| `src/completionProvider.ts` | inline FIM ghost-text completion |
| `src/codeActions.ts` | Explain / Refactor / Fix / Docstrings / Tests / Ask |
| `src/web.ts` | web search (DuckDuckGo default, optional Google CSE) |

## Invariants you must not break

These are the contract (full text in `ARCHITECTURE.md §3`). Every refactor
keeps all of them:

1. **Locality** — user input goes only to `$OLLAMA_HOST`, plus the optional
   `web_search` to DuckDuckGo/Google. No telemetry, no third-party calls.
2. **Sandbox** — every tool path resolves inside the first workspace folder via
   `tools.ts → resolveInsideWorkspace`; `..`, absolute paths, and symlink
   escapes are rejected.
3. **User assent for writes** — no file is created or modified without an
   explicit confirm. Diff preview is offered. There is **no setting to disable**
   the confirm.
4. **Abortable** — every long LLM call is wired to an `AbortSignal`.
5. **Tested as a contract** — every fixed regression has a test pinning it.
6. **Bounded loop** — the agent loop stops after `ollamaCoder.agentMaxSteps`.
7. **Backward-compatible defaults** — auto-picks only fire when the user did
   not configure them; explicit config always wins.
8. **Ollama has no filesystem access; the plugin owns all I/O.** Ollama speaks
   HTTP only. The model never reads or writes disk — the *plugin* pulls context
   in and writes files out, under the user's confirmation. If a model says "I
   created the file" without calling a tool, **nothing was written.** This
   boundary is pinned at the source level by `test/ioBoundary.test.js`: the
   only files in `src/` allowed to touch the filesystem or spawn processes are
   **`tools.ts`, `apply.ts`, and `chatView.ts`** (the last only for `@mention`
   reads). If you add an I/O surface, it must live in one of those modules or
   you must consciously expand that allowlist.

## Build, test, and the workflow we expect of you

```sh
npm install            # one-time; dev-only deps (vsce, typescript, @types)
npm run compile        # tsc -p ./   → out/
npm run watch          # incremental compile; F5 in VS Code launches a dev host
npm run typecheck      # tsc --noEmit, fast feedback
npm test               # compile + node --test test/*.test.js  (run before every commit)
npm run package        # vsce package -o ollama-free-coder.vsix
```

Tests use Node's built-in `node:test` runner (no test framework dependency).
`test/_vscode_stub.js` stubs the `vscode` module so compiled sources can be
`require()`'d in plain Node. `test/_scriptedOllama.js` and
`test/_fsToolExecutor.js` drive the agent end-to-end against a scripted model
and a real temp-dir filesystem.

**House rules for changes:**

- **TypeScript is the contract.** `npm run typecheck` must pass; a `tsc` test
  enforces it. No `any`-laundering to silence the compiler.
- **Positive AND negative tests.** For every "does the right thing" test, add a
  "fails closed on bad input" test. This is an explicit project value
  (`ARCHITECTURE.md §8` tracks the counts — 300+ cases).
- **Touch the I/O boundary deliberately.** New filesystem/process access lives
  in `tools.ts` / `apply.ts` only, or `ioBoundary.test.js` will fail.
- **Prefer shrinking regexes over growing them.** New intent understanding
  should go through `router.ts`, not a new `looksLike*` pattern.
- **Update docs in the same commit** as the behavior change.
- **Keep zero runtime deps.** Don't add an npm dependency that ships in the
  `.vsix`; use Node built-ins.

## Settings namespace

All user settings live under `ollamaCoder.*` (full table in `README.md` and
`DOCUMENTATION.md §9`). The ones that change agent behavior:
`useLlmRouter` (default `true`), `agentMaxSteps` (default `8`),
`enableRunCommand` (default `false`, gates the `run_command` tool behind a
per-call modal confirm), `searchBackend` (`duckduckgo` | `google`).

## Publishing

Manual and by design — see `PUBLISHING.md`. Don't automate or trigger a
publish; Marketplace identity stays a human decision (`ARCHITECTURE.md §4.6`).
