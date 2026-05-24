# Ollama Free Coder — Architecture

This document is a *design* paper, not a reference manual. For an
exhaustive map of files and settings, see [`DOCUMENTATION.md`](./DOCUMENTATION.md).
This paper answers three questions:

1. **What does an operation look like, end-to-end?** From the moment the user
   presses Enter in the chat to the moment a file changes on disk, a buffer
   updates, or text appears on screen.
2. **Where do we make decisions?** The plugin currently classifies user
   intent with hand-written regular expressions. That has limits.
3. **What is the design principle going forward?** *Delegate language
   understanding to Ollama models. Keep the plugin small, mechanical, and
   honest.*

---

## 1. TL;DR

```
┌─────────┐      ┌──────────┐      ┌──────────────┐      ┌────────────┐
│  INPUT  │ ───▶ │  ROUTER  │ ───▶ │  EXECUTOR    │ ───▶ │  OUTPUT    │
│         │      │  (intent │      │  loop:       │      │  - chat    │
│ chat,   │      │   class- │      │  - Ollama    │      │  - editor  │
│ keymap, │      │   ifier) │      │    /chat     │      │  - disk    │
│ slash   │      │          │      │  - tools     │      │            │
└─────────┘      └──────────┘      └──────────────┘      └────────────┘
                       ▲                  │
                       │                  │ tool_calls → execute → result
                       │                  ▼
                       │           ┌──────────────┐
                       │           │   TOOLS      │
                       │           │  read_file,  │
                       │           │  write_file, │
                       │           │  list_files, │
                       │           │  search_text,│
                       │           │  web_search, │
                       │           │  get_open_…  │
                       │           └──────────────┘
                       │
                       └── (today: regex; goal: LLM-driven)
```

The plugin is a *thin shell* around Ollama. Everything that requires
understanding what the user wants — should this answer end up in chat? in a
file? — is, ideally, a job for the model.

The current implementation has a handful of regex classifiers (file-write
intent, show-on-screen intent, web-search intent, language inference). This
paper argues those should shrink, not grow.

---

## 2. The four phases of an operation

### 2.1 Input phase

Five entry points, all in `src/extension.ts`:

| Entry | How the user triggers it | Notes |
| --- | --- | --- |
| Chat send | textarea + Ctrl/Cmd+Enter (or the Send button) | `chatView.handleSend()` |
| Slash command | `/search QUERY`, `/web …`, `/google …` in the chat input | short-circuits the model |
| Code action on selection | right-click → submenu, or `<C+A>+E/R` etc. | `codeActions.runAction()` |
| Status bar / dropdown | model picker click | direct setting mutation |
| Inline completion | typing in any editor | `OllamaInlineCompletionProvider` |

The input phase normalises raw user text + the active editor's context
(selection, file path, language id) into a single `userContent` string with
attached `@mentions` expanded. **No model is consulted here.** This phase is
purely deterministic.

### 2.2 Routing phase

Today, three regex classifiers decide what happens next:

```
                ┌─ looksLikeShowIntent(text)        → stay in chat
text  ───▶      ├─ looksLikeFileWriteIntent(text)   → agent loop (tools on)
                └─ looksLikeWebSearchIntent(text)   → RAG prepend, then chat
```

Their job is to answer **"what does the user actually want to happen?"** —
specifically:

- Should this turn write a file? (`looksLikeFileWriteIntent`)
- …unless they explicitly want it on screen. (`looksLikeShowIntent`)
- …or unless they want the live web. (`looksLikeWebSearchIntent`)

Plus a slash-command parser (`parseSlashSearch`) and a language-extension
inferer (`inferLanguageExt`) that fills in a "sensible default filename"
when the user mentioned a language but not a path.

These classifiers are documented, regression-tested, and **fragile**.
They miss every phrasing they weren't tuned for, and they trip on edge
cases like *"explain the C class hierarchy"* (looks like `class` → file
write) until someone patches the regex.

Section 4 of this paper proposes replacing them with a model call.

### 2.3 Execution phase

Two shapes:

**Single-turn chat.** One streaming `POST /api/chat` against
`ollamaCoder.chatModel`. Tokens are streamed back to the webview and
appended to the running assistant message.

**Agent loop** (in `chatView.runAgentLoop`):

```
loop up to ollamaCoder.agentMaxSteps (default 8):
  POST /api/chat with tools=TOOL_SCHEMAS  (non-streaming)
  if response.tool_calls is empty:
      stream the final text and exit
  for tc in response.tool_calls:
      execute tc via tools.executeTool()
      append the result as a role=tool message
      (the user sees a "⚙ tool_name(args)" line + a 400-char preview)
  goto loop
```

All tool calls are sandboxed inside the workspace root. `write_file` is
the only mutation, and it always prompts the user before applying.

### 2.4 Output phase

Three output kinds, picked by the route:

| Output | Triggered by | Code path |
| --- | --- | --- |
| **Screen** (chat panel) | every turn | `webview.postMessage({type:'assistantToken', ...})` |
| **Editor** | code actions with `replace=true`, "Insert at cursor", "Replace selection" buttons | `apply.insertAtCursor`, `apply.replaceSelection` |
| **Disk** | `write_file` tool, "Save…" button on a code block | `tools.writeFile`, `apply.saveToFile` |

A side effect that touches the user's filesystem **always** passes through
a confirmation prompt (modal for `apply.saveToFile`, info-dialog for
`tools.writeFile`). Side-effect surface area is small and well-known.

---

## 3. Invariants the plugin upholds

These hold today and are the contract any future refactor must keep:

1. **Locality.** Every byte of user input goes to `$OLLAMA_HOST` and nowhere
   else, except for the optional `web_search` tool which goes to
   DuckDuckGo or Google CSE. No telemetry, no anonymous metrics, no
   third-party request.
2. **Sandbox.** Every `read_file` / `write_file` / `list_files` /
   `search_text` path is resolved relative to the first workspace folder
   and rejected if it escapes that root via `..`, absolute paths, or
   symlinks. Verified in `tools.ts → resolveInsideWorkspace`.
3. **User assent for writes.** No file is created or modified without an
   explicit `y/N`-equivalent confirmation. Diff preview is offered.
4. **Abortable.** Every long-running LLM call is wired to an `AbortSignal`
   so the user can press Stop and have the request actually go away.
5. **Tested as a contract.** Every regression the user has hit (HTTP 404
   from a missing model, `(loading…)` stuck dropdown, `compactJson` not
   defined, model list shorter than `ollama list`, "create file"
   ignored, "show me" hijacked) has at least one test pinning the fix.
   Total: 190+ cases.
6. **Bounded loop.** The agent loop terminates after
   `ollamaCoder.agentMaxSteps` rounds. No model can recurse forever.
7. **Backward-compatible defaults.** Auto-picks (model, filename, search
   backend) only fire when the user did not configure them. Explicit
   user config always wins.

---

## 4. The design principle: delegate language understanding to Ollama

The user said it directly: *"we should delegate language understanding as
much as possible to Ollama models."* This section says how.

### 4.1 What "language understanding" means in our code

Anywhere the plugin tries to infer **intent** or **structure** from a
free-form English string is "language understanding". Today that surface
is:

| Location | What it understands | How |
| --- | --- | --- |
| `looksLikeShowIntent` | "user wants screen output" | regex list |
| `looksLikeFileWriteIntent` | "user wants a file change" | regex list |
| `looksLikeWebSearchIntent` | "user wants the live web" | regex list |
| `inferLanguageExt` | "the user said C++, pick .cpp" | regex list |
| Code-action system prompts | per-action instructions | hand-written prompts |
| Stop-token list for completion | "stop generating here" | hand-written list |

The first four are the fragile ones. The last two are stable — they
encode protocol, not intent.

### 4.2 Why the regex classifiers don't scale

- They cover the phrasings someone happened to think of. *"can you
  generate hello.py for me"* doesn't match `\\b(create|make|add|…)\\b
  \\s+[\\w./-]*\\.[a-z0-9]{1,6}\\b` because `for me` separates the verb
  from the filename. We patch, we retest, we ship, we miss the next one.
- They don't compose. *"google what the C++23 modules syntax is and put
  an example in test.cpp"* is **both** web-search and file-write, but
  the current pipeline picks one.
- They're English-only. Russian, Spanish, Japanese users get worse
  routing than English users for no good reason.

### 4.3 The proposed architecture: an LLM router

Replace the three intent regexes with a **routing prompt** sent to a
small, fast model. The router's job is to return a structured plan:

```json
{
  "kind":          "chat" | "edit_file" | "create_file" | "web_search_then_chat" |
                   "explain_selection" | "refactor_selection" | …,
  "target_path":   "src/foo.ts"   // when kind ∈ {edit_file, create_file}
                                  // else absent
  "needs_web":     true | false,
  "rephrased":     "the user prompt, optionally cleaned up for the worker model"
}
```

The router uses the **completion** model (which on every tier we already
pull, and on the smallest tier is `qwen2.5-coder:0.5b-base` — fast,
local, instant), called with `format: 'json'` so Ollama enforces a JSON
response. We don't need a 70B model to route; we need a small one that
can output the four-key object reliably.

Pseudo-code:

```ts
const plan = await routeWithModel({
  endpoint, model: routerModel,
  prompt: ROUTING_SYSTEM + JSON.stringify({ user_text, has_selection, active_file }),
  format: "json",
});

switch (plan.kind) {
  case "chat":                  return chatTurn(plan.rephrased);
  case "edit_file":             return agentTurn(plan.rephrased, { force_target: plan.target_path });
  case "create_file":           return agentTurn(plan.rephrased, { force_target: plan.target_path });
  case "web_search_then_chat":  return ragChatTurn(plan.rephrased);
  // …
}
```

### 4.4 What stays mechanical

The router is *not* allowed to do everything. Concretely:

- The router **never executes a tool**. It only labels.
- The router **never sees secrets** (keychain entries, OS env, file
  contents). Just the user's prompt and a few editor-state flags.
- The router's output is **schema-validated** before we act on it. If
  the JSON doesn't parse, or `kind` is unknown, we fall back to plain
  chat. The model cannot make us do something we haven't authorised.
- All five invariants from section 3 still hold. In particular, file
  writes still go through `tools.writeFile` with its confirmation
  dialog. The router cannot bypass it.

### 4.5 Migration plan

This is a four-step, individually shippable refactor. Each step keeps
the regex fallback so behaviour can't regress mid-migration.

1. **Introduce `router.ts`** with the JSON-routing function above plus a
   pure unit-tested schema validator. Behind a setting,
   `ollamaCoder.useLlmRouter: false` by default.
2. **Shadow mode.** When the flag is on, log what the router would have
   picked, but still act on the regex result. Compare in a tiny opt-in
   telemetry-free local log. Tune the system prompt until they agree
   on the existing test corpus.
3. **Swap.** Flip the default. Regexes become the fallback for when the
   router fails / times out.
4. **Delete.** Once the LLM router has been the default for a release,
   remove the regex classifiers and the language-extension inferer.
   `inferLanguageExt` collapses into the router's `target_path` output.

Throughout: every existing positive/negative case in
`test/fileIntent.test.js`, `test/webSearchIntent.test.js`, and
`test/publishRerun.test.js` continues to pass. They become the
acceptance harness for the router.

### 4.6 What we DON'T move to the model

Just as importantly:

- **Streaming, retries, abort wiring.** Plumbing. Mechanical. Stays in
  `ollama.ts`.
- **Tool execution.** The model picks tools; the plugin runs them under
  the workspace sandbox. The model cannot bypass safety.
- **Confirmation dialogs.** Human in the loop for every write.
- **Apply buttons.** Pure DOM, no model knows about them.
- **Search backend selection.** Setting-driven, not model-driven, so
  users can audit which engine is being hit.
- **Marketplace identity / publishing.** Manual, by design.

---

## 5. Data flow trace: one realistic operation

To make this concrete: *"write to a new file C++ Hello World program"*.

```
1.  user types in chat, presses Cmd+Enter
2.  chatView.handleSend() receives { text, includeFile=false, agent=false }

3.  ROUTING PHASE (today: regex; tomorrow: LLM)
    looksLikeShowIntent(text)         → false
    looksLikeFileWriteIntent(text)    → true
    looksLikeWebSearchIntent(text)    → false
    inferLanguageExt(text)            → { name: "C++", ext: ".cpp" }
    decision: agent mode, with filename hint appended.

4.  chatView pushes a system message:
    "You are an autonomous coding agent. … 1. NEW file → IMMEDIATELY
     call write_file …"
    Plus the user message with the filename hint appended.

5.  EXECUTION PHASE (runAgentLoop)
    POST /api/chat   tools=TOOL_SCHEMAS   model=llama3.1:8b
    response.tool_calls = [ { name: "write_file",
                              arguments: { path: "hello_world.cpp",
                                           content: "#include <iostream> …" } } ]

6.  tools.executeTool("write_file", …)
        resolveInsideWorkspace("hello_world.cpp")
        showWarningMessage("Create hello_world.cpp?",
                           "Create", "Show diff first", "Reject")
        user clicks "Create"
        vscode.workspace.fs.writeFile(uri, Buffer.from(content))
        returns "Created hello_world.cpp (… chars)."

7.  loop iterates with the tool result appended
    POST /api/chat (second round)
    response.tool_calls = []
    response.content   = "Created hello_world.cpp with a minimal
                          C++ Hello World."
    stream into chat. loop exits.

8.  OUTPUT PHASE
    chat: short summary visible to user
    disk: hello_world.cpp committed
    editor: not touched (user can :e it)
```

Every arrow in the diagram corresponds to a function in the codebase.
Nothing happens "elsewhere".

---

## 6. Open questions

- **Latency of the LLM router.** Even the smallest local model adds
  ~100–300 ms per turn. On a 64 GB machine running a 70B chat model
  this is rounding error; on a 4 GB Raspberry Pi it might matter.
  Mitigation: keep regex shortcuts for the obvious unambiguous shapes
  (slash commands, explicit `@selection`) and only invoke the router
  for free-form prompts.
- **Tool-calling support.** Not every Ollama model implements the
  tool-calling protocol equally well. The router is *not* a tool call;
  it's a plain `format: json` chat. That works on every Ollama model.
  Tool calling stays where it is today (used by the executor).
- **Multi-language UX.** Right now the chat *system prompt* is in
  English. Should we localise? Probably — but only the system prompt.
  Tool names, schemas, command ids stay English.
- **State across turns.** The agent loop already maintains a
  conversation history. The router today is stateless. We may want to
  pass the last assistant turn back to the router for follow-up turns
  ("now do it again for the rust version").

---

## 7. Glossary

| Term | Meaning |
| --- | --- |
| **Router** | The piece that maps free-form English to a kind+params. Today: regex. Goal: LLM. |
| **Worker model** | The model that actually answers the user. `ollamaCoder.chatModel`. |
| **Router model** | A small fast model used only for routing decisions. Defaults to the completion model. |
| **Tool** | One of `read_file`, `write_file`, `list_files`, `search_text`, `web_search`, `get_open_editors`. Defined in `src/tools.ts`. |
| **Side effect** | Anything that touches disk or editor state outside of the chat panel. |
| **Sandbox** | The workspace root. Tools cannot escape it. |
| **Worker turn** | One `POST /api/chat`. |
| **Agent turn** | A chain of worker turns separated by tool executions. Bounded by `agentMaxSteps`. |

---

## 8. Status

Last updated for **v1.4.3**.

### Open-source ideas adopted

| Idea | Origin | Where it lives in this repo |
| --- | --- | --- |
| SEARCH/REPLACE diff edits | [Aider](https://aider.chat) | `src/editFile.ts`, `edit_file` tool |
| Repo map for navigation context | [Aider](https://aider.chat) | `src/repoMap.ts`, `repo_map` tool |
| LLM-driven router for intent classification | This paper §4.3 + general agent literature | `src/router.ts` |
| Confirmed shell execution | Cline / OpenHands | `run_command` tool in `src/tools.ts` |
| `format: json` structured-output prompting | Ollama docs + LangChain pattern | `chatFull` `format` parameter |

The principle from every one of these: **the plugin owns the safety
rails (sandbox, confirms, schema validation); the model owns the
language understanding.**

| Migration step (§4.5) | State |
| --- | --- |
| 4a. Introduce `src/router.ts` behind `ollamaCoder.useLlmRouter` | **shipped in v1.4.2** — schema-validated `RoutePlan`, `chatView` calls `routeWithModel` when the flag is on; falls back to regex on failure or when off |
| 4b. Shadow mode | **shipped in v1.4.2** — set `ollamaCoder.shadowLlmRouter: true` to log every router decision in chat without acting on it |
| 4c. Swap the default | **not yet** |
| 4d. Delete the regex classifiers | **not yet** |

The regex classifiers in §2.2 remain authoritative by default in v1.4.2.
Users who turn `useLlmRouter` on get the LLM-driven pipeline today.

Beyond the migration plan, v1.4.2 also adds the **`run_command` tool**
(§2.3 “Execution phase”), which lets the agent ask to run a shell command.
It is disabled by default (`ollamaCoder.enableRunCommand: false`) and
every invocation requires a per-call modal confirm. The four safety
guards (feature flag, workspace-sandboxed cwd, modal confirm, hard
kill-on-timeout) are pinned by `test/runCommandTool.test.js`.
