import * as vscode from "vscode";
import { chatFull, ChatMessage, listModels } from "./ollama";
import { TOOL_SCHEMAS, executeTool, ToolCall } from "./tools";
import { insertAtCursor, replaceSelection, saveToFile } from "./apply";

const SYSTEM_BASIC =
  "You are Ollama Coder, an expert pair-programmer running locally inside the user's VS Code. " +
  "Answer concisely. Use fenced code blocks for code. " +
  "When you produce code intended for a specific file, ALWAYS put the path right after the language in the fence header, like ```ts src/foo.ts or ```cpp test.cpp. " +
  "The user can click 'Save' on a code block and the path you wrote will be used as the filename.";

const SYSTEM_AGENT =
  "You are Ollama Coder, an autonomous coding agent running locally in the user's VS Code. " +
  "You have tools to read and modify the workspace. USE THEM.\n\n" +
  "Rules:\n" +
  "1. When the user asks you to create a NEW file, IMMEDIATELY call write_file with the path and full content. Do NOT first reply with the code in a chat message asking for confirmation \u2014 the user already gets a confirm dialog from the editor.\n" +
  "2. When the user asks you to MODIFY an existing file, first call read_file to see its current contents, then call write_file with the COMPLETE new contents of the file (not a patch).\n" +
  "3. If the user gives you a target filename like 'test.cpp', use exactly that path. If they don't, pick a sensible workspace-relative path with the right extension.\n" +
  "4. Use list_files or search_text when you genuinely need to explore. Skip them for simple new-file requests.\n" +
  "5. After the file is written, give a one-sentence summary like 'Created test.cpp with a Vector class.' Do not paste the code again in chat \u2014 it's already in the file.\n" +
  "6. Use fenced code blocks only for tiny illustrative snippets or for the final summary. Do NOT dump full file contents in chat when you could call write_file instead.";

const MAX_AGENT_STEPS = 8;

// Patterns that strongly imply the user wants a file actually created or edited
// on disk. When the chat is sent with agent mode OFF and the message matches one
// of these, we automatically run this one turn through the agent loop so the
// model gets the write_file tool. The user sees a one-line notice in the UI.
const FILE_WRITE_INTENT = [
  // "create/add/make/write a file ..."
  /\b(create|make|add|write|generate|scaffold|bootstrap|new)\b[^.?!\n]*\bfile\b/i,
  // "add X to/into/in test.cpp"
  /\b(add|insert|append|write|put)\b[^.?!\n]*\b(to|into|in)\b[^.?!\n]*\.[a-z0-9]{1,6}\b/i,
  // "save ... to/into/as output.json"
  /\bsave\b[^.?!\n]*\b(to|into|as)\b[^.?!\n]*\.[a-z0-9]{1,6}\b/i,
  // "edit foo.ts"
  /\bedit\b[^.?!\n]*\.[a-z0-9]{1,6}\b/i,
  // "modify/update/patch/refactor/fix foo.py"
  /\b(modify|update|patch|refactor|fix|implement)\b[^.?!\n]*\.[a-z0-9]{1,6}\b/i,
  // "make/create hello.cpp ..." — verb directly followed by a filename
  /\b(create|make|add|write|generate|new|touch|drop|put)\b\s+[\w./-]*\.[a-z0-9]{1,6}\b/i,
  // "new C++ Hello World file" / "C++ hello world as a file" / "new <lang> file"
  /\bnew\b[^.?!\n]*\b(file|program|script|module|class|header|test)\b/i,
  /\b(file|program|script|module|class|header|test)\b[^.?!\n]*\b(in|using|with|for)\b\s+(c\+\+|cpp|c#|csharp|python|py|ruby|rust|go(?:lang)?|java(?:script)?|ts|typescript|js|kotlin|swift|bash|shell|sh|html|css)\b/i,
];

export function looksLikeFileWriteIntent(text: string): boolean {
  return FILE_WRITE_INTENT.some((re) => re.test(text));
}

/**
 * Detect mentioned programming language(s) so we can give the agent a strong
 * extension hint when the user only mentions a language by name
 * (e.g. "write a new file C++ Hello World" — no ".cpp" anywhere).
 */
const LANG_EXT: Array<{ re: RegExp; name: string; ext: string }> = [
  // \b doesn't work after '++' or '#' because both are non-word chars next
  // to a non-word boundary (space/EOS). Use look-arounds instead.
  { re: /(?:^|\W)(c\+\+|cpp)(?=\W|$)/i, name: "C++", ext: ".cpp" },
  { re: /(?:^|\W)(c#|csharp)(?=\W|$)/i, name: "C#", ext: ".cs" },
  { re: /\bobjective-?c\b/i, name: "Objective-C", ext: ".m" },
  { re: /\bpython\b|\bpy\b/i, name: "Python", ext: ".py" },
  { re: /\brust\b|\brs\b/i, name: "Rust", ext: ".rs" },
  { re: /\bgo(?:lang)?\b/i, name: "Go", ext: ".go" },
  { re: /\btypescript\b|\bts\b/i, name: "TypeScript", ext: ".ts" },
  { re: /\bjavascript\b|\bjs\b/i, name: "JavaScript", ext: ".js" },
  { re: /\bjava\b/i, name: "Java", ext: ".java" },
  { re: /\bkotlin\b|\bkt\b/i, name: "Kotlin", ext: ".kt" },
  { re: /\bswift\b/i, name: "Swift", ext: ".swift" },
  { re: /\bruby\b|\brb\b/i, name: "Ruby", ext: ".rb" },
  { re: /\bbash\b|\bshell\b|\bsh script\b/i, name: "Bash", ext: ".sh" },
  { re: /\bhtml\b/i, name: "HTML", ext: ".html" },
  { re: /\bcss\b/i, name: "CSS", ext: ".css" },
  // C must come last so 'C++' / 'C#' wins. Use a negative lookahead so the
  // 'c' in 'c++' / 'c#' doesn't get picked as plain C (regex \b treats + and #
  // as word boundaries, which would otherwise match).
  { re: /\bc\b(?!\+\+|#)/i, name: "C", ext: ".c" },
];

export function inferLanguageExt(
  text: string
): { name: string; ext: string } | undefined {
  for (const e of LANG_EXT) if (e.re.test(text)) return { name: e.name, ext: e.ext };
  return undefined;
}

/**
 * Render tool arguments as a short single-line JSON for the chat UI.
 * Long string values are truncated so the tool-call line stays readable.
 */
export function compactJson(value: unknown, maxLen = 200): string {
  const seen = new WeakSet<object>();
  const replacer = (_k: string, v: any) => {
    if (typeof v === "string" && v.length > 80) return v.slice(0, 77) + "…";
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
    }
    return v;
  };
  let out: string;
  try {
    out = JSON.stringify(value, replacer);
  } catch {
    out = String(value);
  }
  if (out === undefined) out = String(value);
  return out.length > maxLen ? out.slice(0, maxLen - 1) + "…" : out;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "ollamaCoder.chatView";

  private view: vscode.WebviewView | undefined;
  private history: ChatMessage[] = [];
  private inflight: AbortController | undefined;

  /** Persisted ring buffer of the user's most recent prompts (newest first). */
  private cmdHistory: string[] = [];
  private static readonly CMD_HISTORY_KEY = "ollamaCoder.cmdHistory";
  private static readonly CMD_HISTORY_MAX = 100;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.cmdHistory = ctx.globalState.get<string[]>(
      ChatViewProvider.CMD_HISTORY_KEY,
      []
    );
  }

  private async rememberCommand(text: string) {
    const t = text.trim();
    if (!t) return;
    // Dedup: move to front if already present.
    this.cmdHistory = [t, ...this.cmdHistory.filter((x) => x !== t)].slice(
      0,
      ChatViewProvider.CMD_HISTORY_MAX
    );
    await this.ctx.globalState.update(
      ChatViewProvider.CMD_HISTORY_KEY,
      this.cmdHistory
    );
    this.post({ type: "history", items: this.cmdHistory });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          await this.sendModelList();
          // Also push the persisted command history to the webview.
          this.post({ type: "history", items: this.cmdHistory });
          break;
        case "clearHistory":
          this.cmdHistory = [];
          await this.ctx.globalState.update(
            ChatViewProvider.CMD_HISTORY_KEY,
            this.cmdHistory
          );
          this.post({ type: "history", items: [] });
          break;
        case "refreshModels":
          await this.sendModelList();
          break;
        case "setModel":
          await vscode.workspace
            .getConfiguration("ollamaCoder")
            .update(
              "chatModel",
              String(msg.model ?? ""),
              vscode.ConfigurationTarget.Global
            );
          break;
        case "send":
          await this.handleSend(
            String(msg.text ?? ""),
            !!msg.includeFile,
            !!msg.agent,
            msg.model ? String(msg.model) : undefined
          );
          break;
        case "stop":
          this.inflight?.abort();
          break;
        case "clear":
          this.history = [];
          this.post({ type: "cleared" });
          break;
        case "applyInsert":
          await insertAtCursor(String(msg.code ?? ""));
          break;
        case "applyReplace":
          await replaceSelection(String(msg.code ?? ""));
          break;
        case "applySave":
          await saveToFile(String(msg.code ?? ""), msg.path ? String(msg.path) : undefined);
          break;
      }
    });

    // If the user changes the model from the status bar, keep the dropdown in sync.
    const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ollamaCoder.chatModel")) {
        const m = vscode.workspace
          .getConfiguration("ollamaCoder")
          .get<string>("chatModel", "");
        this.post({ type: "currentModel", model: m });
      }
    });
    this.ctx.subscriptions.push(cfgSub);
  }

  private async sendModelList() {
    const cfg = vscode.workspace.getConfiguration("ollamaCoder");
    const endpoint = cfg.get<string>("endpoint", "http://localhost:11434");
    const current = cfg.get<string>("chatModel", "");
    let models: string[] = [];
    let error: string | undefined;
    try {
      models = await listModels(endpoint);
    } catch (e: any) {
      error = e?.message ?? String(e);
    }
    this.post({ type: "models", models, current, error });
  }

  reveal() {
    this.view?.show?.(true);
  }

  /** Public so commands can push a user turn from outside (e.g. "Add file to chat"). */
  async pushUserMessage(text: string) {
    this.post({ type: "userMessage", text });
    // Trigger a normal send (no extra context, agent mode follows current toggle).
    await this.handleSend(text, false, false);
  }

  private post(m: unknown) {
    this.view?.webview.postMessage(m);
  }

  /**
   * Expand `@path` and `@selection` mentions in the user's prompt.
   * `@path/to/file` (no spaces) → reads workspace file, appends as a fenced block.
   * `@selection` → appends current editor selection (or whole active file if none).
   */
  private async expandMentions(text: string): Promise<{
    text: string;
    attachments: string[];
  }> {
    const attachments: string[] = [];
    const folder = vscode.workspace.workspaceFolders?.[0];

    // @selection
    const selRe = /(^|\s)@selection\b/g;
    if (selRe.test(text)) {
      const ed = vscode.window.activeTextEditor;
      if (ed) {
        const sel = ed.selection;
        const code = sel.isEmpty
          ? ed.document.getText()
          : ed.document.getText(sel);
        const rel = vscode.workspace.asRelativePath(ed.document.uri);
        const lang = ed.document.languageId;
        const block = `\n\nFrom @selection (${rel}${
          sel.isEmpty ? "" : `:L${sel.start.line + 1}-L${sel.end.line + 1}`
        }):\n\`\`\`${lang}\n${code.slice(0, 8000)}\n\`\`\``;
        attachments.push(block);
      }
    }
    text = text.replace(selRe, "$1@selection");

    // @path/to/file  (must contain a slash or dot, no spaces)
    const fileRe = /(^|\s)@([^\s@`]+)/g;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = fileRe.exec(text)) !== null) {
      const ref = m[2];
      if (ref === "selection" || seen.has(ref)) continue;
      // Heuristic: must look like a path (has '/' or '.')
      if (!ref.includes("/") && !ref.includes(".")) continue;
      seen.add(ref);
      if (!folder) continue;
      const uri = vscode.Uri.joinPath(folder.uri, ref);
      try {
        const buf = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(buf.subarray(0, 16 * 1024)).toString("utf8");
        const truncated =
          buf.byteLength > 16 * 1024 ? "\n... [truncated]" : "";
        attachments.push(
          `\n\nFrom @${ref}:\n\`\`\`\n${content}${truncated}\n\`\`\``
        );
      } catch {
        attachments.push(`\n\n(could not read @${ref})`);
      }
    }

    return { text, attachments };
  }

  private async handleSend(
    text: string,
    includeFile: boolean,
    agent: boolean,
    modelOverride?: string
  ) {
    if (!text.trim()) return;
    this.inflight?.abort();

    const cfg = vscode.workspace.getConfiguration("ollamaCoder");
    const endpoint = cfg.get<string>("endpoint", "http://localhost:11434");
    const model =
      modelOverride && modelOverride.trim()
        ? modelOverride
        : cfg.get<string>("chatModel", "llama3.1:8b");
    const temperature = cfg.get<number>("temperature", 0.3);
    const ctxChars = cfg.get<number>("contextWindowChars", 4000);

    let userContent = text;

    // Implicit "include current file/selection" toggle (unchanged behavior)
    const ed = vscode.window.activeTextEditor;
    if (includeFile && ed) {
      const doc = ed.document;
      const sel = ed.selection;
      const lang = doc.languageId;
      const rel = vscode.workspace.asRelativePath(doc.uri);
      if (!sel.isEmpty) {
        const code = doc.getText(sel).slice(0, ctxChars);
        userContent = `${userContent}\n\nSelected code (${lang}, ${rel}):\n\`\`\`${lang}\n${code}\n\`\`\``;
      } else {
        const code = doc.getText().slice(0, ctxChars);
        userContent = `${userContent}\n\nCurrent file (${lang}, ${rel}):\n\`\`\`${lang}\n${code}\n\`\`\``;
      }
    }

    // @mention expansion
    const { text: cleaned, attachments } = await this.expandMentions(userContent);
    userContent = cleaned + attachments.join("");

    // Auto-route file-write intents to the agent loop even if the user didn't
    // tick the agent checkbox. Without this, the model just replies with a code
    // block and the requested file is never actually created on disk.
    let effectiveAgent = agent;
    const intent = looksLikeFileWriteIntent(text);
    if (!agent && intent) {
      effectiveAgent = true;
      this.post({
        type: "notice",
        text: "Detected a file create/edit request \u2014 running this turn in agent mode so I can write the file.",
      });
    }

    // If the user only named a language ("C++ Hello World") without giving a
    // filename, give the agent an explicit extension hint so it doesn't try to
    // create a path-less file or guess the wrong extension. Only when intent
    // is detected and the user didn't already include a path themselves.
    if (intent && !/[\w./-]*\.[a-z0-9]{1,6}\b/i.test(text)) {
      const lang = inferLanguageExt(text);
      if (lang) {
        userContent =
          userContent +
          `\n\n(Filename hint: the user did not specify a path. Use a sensible "${lang.ext}" file for ${lang.name}, e.g. "hello_world${lang.ext}".)`;
      }
    }

    if (this.history.length === 0) {
      this.history.push({
        role: "system",
        content: effectiveAgent ? SYSTEM_AGENT : SYSTEM_BASIC,
      });
    } else if (effectiveAgent) {
      // If user just toggled (or we auto-toggled) agent mode mid-conversation,
      // upgrade the system prompt.
      this.history[0] = { role: "system", content: SYSTEM_AGENT };
    }
    this.history.push({ role: "user", content: userContent });

    // Persist the raw user text (without the auto-attached @mention contents)
    // into the command history. Buttons in the chat log will let the user
    // re-send or edit it later.
    await this.rememberCommand(text);

    this.post({ type: "userMessage", text });

    const ctrl = new AbortController();
    this.inflight = ctrl;

    try {
      if (effectiveAgent) {
        await this.runAgentLoop(endpoint, model, temperature, ctrl.signal);
      } else {
        await this.runSingleTurn(endpoint, model, temperature, ctrl.signal);
      }
    } catch (e: any) {
      const aborted = String(e?.message).includes("aborted");
      this.post({
        type: "assistantError",
        text: aborted ? "(stopped)" : `Error: ${e?.message ?? e}`,
      });
    }
  }

  private async runSingleTurn(
    endpoint: string,
    model: string,
    temperature: number,
    signal: AbortSignal
  ) {
    this.post({ type: "assistantStart" });
    const r = await chatFull(
      {
        endpoint,
        model,
        messages: this.history,
        temperature,
        numPredict: 2048,
        signal,
      },
      (tok) => this.post({ type: "assistantToken", text: tok })
    );
    this.history.push({ role: "assistant", content: r.content });
    this.post({ type: "assistantEnd" });
  }

  private async runAgentLoop(
    endpoint: string,
    model: string,
    temperature: number,
    signal: AbortSignal
  ) {
    const maxSteps = vscode.workspace
      .getConfiguration("ollamaCoder")
      .get<number>("agentMaxSteps", MAX_AGENT_STEPS);
    for (let step = 0; step < maxSteps; step++) {
      this.post({ type: "assistantStart" });
      const r = await chatFull({
        endpoint,
        model,
        messages: this.history,
        temperature,
        numPredict: 2048,
        tools: TOOL_SCHEMAS,
        signal,
      });

      // If the model produced any prose, show it.
      if (r.content) this.post({ type: "assistantToken", text: r.content });

      // Record the assistant turn (with any tool_calls).
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: r.content,
      };
      if (r.tool_calls.length) {
        assistantMsg.tool_calls = r.tool_calls.map((tc) => ({
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      this.history.push(assistantMsg);

      if (!r.tool_calls.length) {
        // Done — no more tool calls.
        this.post({ type: "assistantEnd" });
        return;
      }

      // Execute each tool call and feed results back.
      for (const tc of r.tool_calls) {
        const argsStr = compactJson(tc.arguments);
        this.post({
          type: "toolCall",
          name: tc.name,
          args: argsStr,
        });
        const result = await executeTool(tc as ToolCall);
        this.post({
          type: "toolResult",
          name: tc.name,
          preview: result.slice(0, 400),
        });
        this.history.push({
          role: "tool",
          tool_name: tc.name,
          content: result,
        });
      }
      this.post({ type: "assistantEnd" });
    }
    this.post({
      type: "assistantError",
      text: `(agent stopped after ${maxSteps} steps)`,
    });
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         background: var(--vscode-sideBar-background); margin: 0; padding: 0;
         display: flex; flex-direction: column; height: 100vh; }
  #log { flex: 1; overflow-y: auto; padding: 8px; font-size: 13px; }
  .msg { margin-bottom: 12px; white-space: pre-wrap; word-wrap: break-word; }
  .msg.user { color: var(--vscode-textLink-foreground); position: relative; }
  .msg.assistant { color: var(--vscode-foreground); }
  .role { font-weight: bold; font-size: 11px; text-transform: uppercase;
          opacity: 0.7; margin-bottom: 2px; }
  .msg.user .msg-actions { position: absolute; top: 0; right: 0; display: none; gap: 4px; }
  .msg.user:hover .msg-actions { display: flex; }
  .msg.user .msg-actions button { font-size: 10px; padding: 1px 6px; }
  .tool { font-size: 11px; opacity: 0.75; font-family: var(--vscode-editor-font-family);
          background: var(--vscode-textCodeBlock-background); padding: 4px 6px;
          border-radius: 4px; margin: 4px 0; }
  .tool .name { color: var(--vscode-symbolIcon-functionForeground, #c586c0); font-weight: bold; }
  .notice { font-size: 11px; opacity: 0.8; font-style: italic;
            padding: 4px 6px; margin: 4px 0;
            border-left: 2px solid var(--vscode-focusBorder, #007acc); }
  .tool .preview { opacity: 0.7; display: block; margin-top: 2px;
                   max-height: 80px; overflow: hidden; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 6px;
        border-radius: 4px; overflow-x: auto; position: relative; margin: 4px 0; }
  pre .actions { position: absolute; top: 4px; right: 4px; display: none;
                 gap: 4px; }
  pre:hover .actions { display: flex; }
  pre .actions button { font-size: 10px; padding: 2px 6px; }
  pre .pathlabel { font-size: 10px; opacity: 0.6; padding: 0 0 4px 0;
                   font-family: var(--vscode-editor-font-family); }
  code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  #bar { border-top: 1px solid var(--vscode-panel-border); padding: 6px;
         display: flex; flex-direction: column; gap: 4px; }
  #input { width: 100%; box-sizing: border-box; resize: vertical; min-height: 56px;
           background: var(--vscode-input-background); color: var(--vscode-input-foreground);
           border: 1px solid var(--vscode-input-border, transparent); padding: 6px;
           font-family: var(--vscode-font-family); font-size: 13px; }
  #row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: 0; padding: 4px 10px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground);
                     color: var(--vscode-button-secondaryForeground); }
  label { font-size: 12px; opacity: 0.85; }
  #hint { font-size: 11px; opacity: 0.6; }
  #history-panel { display: none; max-height: 180px; overflow-y: auto;
                   border-top: 1px solid var(--vscode-panel-border);
                   background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); }
  #history-panel.open { display: block; }
  #history-panel .item { padding: 4px 8px; cursor: pointer;
                         border-bottom: 1px solid var(--vscode-panel-border);
                         font-family: var(--vscode-editor-font-family); font-size: 12px;
                         white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                         display: flex; gap: 6px; align-items: center; }
  #history-panel .item:hover { background: var(--vscode-list-hoverBackground); }
  #history-panel .item .text { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  #history-panel .item button { font-size: 10px; padding: 1px 6px; opacity: 0; }
  #history-panel .item:hover button { opacity: 1; }
  #history-panel .empty { padding: 8px; opacity: 0.5; font-style: italic; }
  #history-panel .header { display: flex; padding: 4px 8px; align-items: center;
                           font-size: 11px; opacity: 0.8; border-bottom: 1px solid var(--vscode-panel-border); }
  #history-panel .header button { font-size: 10px; padding: 1px 6px; margin-left: auto; }
</style>
</head>
<body>
  <div id="log"></div>
  <div id="history-panel">
    <div class="header"><span>History (newest first)</span>
      <button id="closeHistory" class="secondary">close</button>
      <button id="clearHistory" class="secondary">clear</button>
    </div>
    <div id="history-list"></div>
  </div>
  <div id="bar">
    <textarea id="input" placeholder="Ask anything. Use @path/to/file or @selection to attach context. ↑/↓ walks history. Ctrl/Cmd+Enter to send."></textarea>
    <div id="row">
      <label style="display:flex;align-items:center;gap:4px">
        Model:
        <select id="model" title="Model for the next query"><option value="">(loading…)</option></select>
        <button id="refreshModels" class="secondary" title="Refresh model list">↻</button>
      </label>
      <label><input type="checkbox" id="ctx" checked /> include current file/selection</label>
      <label><input type="checkbox" id="agent" /> agent mode (can read/write workspace)</label>
      <span style="flex:1"></span>
      <button id="historyBtn" class="secondary" title="Show command history">☰ History</button>
      <button id="stop" class="secondary">Stop</button>
      <button id="clear" class="secondary">Clear</button>
      <button id="send">Send</button>
    </div>
    <div id="hint">Tip: <code>@src/foo.ts</code> attaches a file. <code>@selection</code> attaches the editor selection. Hover a code block for apply actions.</div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const modelSel = document.getElementById('model');
  const historyPanel = document.getElementById('history-panel');
  const historyList = document.getElementById('history-list');
  let current = null;       // body element for current assistant message
  let currentRaw = "";
  let cmdHistory = [];
  // -1 means "on the fresh input line". 0..n-1 = walking history (newest first).
  let histCursor = -1;
  let histDraft = "";  // what the user had typed before they started walking history

  function renderHistoryPanel() {
    historyList.innerHTML = '';
    if (!cmdHistory.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No previous commands yet.';
      historyList.appendChild(e);
      return;
    }
    cmdHistory.forEach((t, i) => {
      const d = document.createElement('div');
      d.className = 'item';
      d.title = t;
      const txt = document.createElement('span');
      txt.className = 'text';
      txt.textContent = t.split('\n')[0];
      const edit = document.createElement('button');
      edit.textContent = '✎ edit';
      edit.onclick = (ev) => { ev.stopPropagation(); input.value = t; input.focus(); historyPanel.classList.remove('open'); };
      const resend = document.createElement('button');
      resend.textContent = '↻ resend';
      resend.onclick = (ev) => { ev.stopPropagation(); input.value = t; send(); historyPanel.classList.remove('open'); };
      d.appendChild(txt);
      d.appendChild(edit);
      d.appendChild(resend);
      d.onclick = () => { input.value = t; input.focus(); historyPanel.classList.remove('open'); };
      historyList.appendChild(d);
    });
  }

  document.getElementById('historyBtn').onclick = () => {
    historyPanel.classList.toggle('open');
  };
  document.getElementById('closeHistory').onclick = () => historyPanel.classList.remove('open');
  document.getElementById('clearHistory').onclick = () => {
    if (confirm('Clear all command history?')) vscode.postMessage({ type: 'clearHistory' });
  };

  function populateModels(list, current, error){
    modelSel.innerHTML = '';
    if (error) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '(error: ' + error.slice(0,40) + ')';
      modelSel.appendChild(o);
      return;
    }
    if (!list || list.length === 0) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '(no models — run: ollama pull …)';
      modelSel.appendChild(o);
      return;
    }
    // Make sure the currently-configured model is selectable even if not yet listed.
    if (current && !list.includes(current)) list = [current, ...list];
    for (const m of list) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      if (m === current) o.selected = true;
      modelSel.appendChild(o);
    }
  }

  modelSel.addEventListener('change', ()=>{
    vscode.postMessage({ type:'setModel', model: modelSel.value });
  });
  document.getElementById('refreshModels').onclick = ()=>vscode.postMessage({type:'refreshModels'});

  function escapeHtml(s){return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
  function escapeAttr(s){return s.replace(/"/g,'&quot;').replace(/</g,'&lt;');}

  // Parse fenced code blocks, including the Cursor-style "\`\`\`lang path/to/file" header.
  function render(raw){
    const parts = [];
    const re = /\`\`\`([a-zA-Z0-9_+\\-]*)([^\\n]*)\\n([\\s\\S]*?)\`\`\`/g;
    let last = 0, m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) parts.push(escapeHtml(raw.slice(last, m.index)));
      const lang = m[1] || '';
      const pathHint = (m[2] || '').trim();
      const codeRaw = m[3];
      const codeId = 'c' + Math.random().toString(36).slice(2);
      window.__codeBlocks = window.__codeBlocks || {};
      window.__codeBlocks[codeId] = { code: codeRaw, path: pathHint };
      const pathLabel = pathHint ? '<div class="pathlabel">'+escapeHtml(pathHint)+'</div>' : '';
      parts.push(
        '<pre data-id="'+codeId+'">' + pathLabel +
        '<div class="actions">' +
          '<button data-act="insert" data-id="'+codeId+'">Insert</button>' +
          '<button data-act="replace" data-id="'+codeId+'">Replace sel</button>' +
          '<button data-act="save" data-id="'+codeId+'">Save…</button>' +
          '<button data-act="copy" data-id="'+codeId+'">Copy</button>' +
        '</div>' +
        '<code>'+escapeHtml(codeRaw)+'</code></pre>'
      );
      last = m.index + m[0].length;
    }
    if (last < raw.length) parts.push(escapeHtml(raw.slice(last)));
    return parts.join('');
  }

  function addMsg(role, text){
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    let actions = '';
    if (role === 'user') {
      // Allow re-sending or editing this very prompt.
      const safe = encodeURIComponent(text);
      actions = '<div class="msg-actions">' +
        '<button data-resend="'+safe+'">↻ resend</button>' +
        '<button data-edit="'+safe+'">✎ edit</button>' +
        '</div>';
    }
    d.innerHTML = '<div class="role">'+role+'</div>'+actions+'<div class="body">'+render(text)+'</div>';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d.querySelector('.body');
  }
  function addTool(name, args){
    const d = document.createElement('div');
    d.className = 'tool';
    d.innerHTML = '<span class="name">⚙ '+escapeHtml(name)+'</span> <code>'+escapeHtml(args)+'</code>' +
                  '<span class="preview" data-preview></span>';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  let lastTool = null;

  function send(){
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    vscode.postMessage({
      type:'send',
      text,
      includeFile: document.getElementById('ctx').checked,
      agent: document.getElementById('agent').checked,
      model: modelSel.value || undefined,
    });
  }
  document.getElementById('send').onclick = send;
  document.getElementById('stop').onclick = ()=>vscode.postMessage({type:'stop'});
  document.getElementById('clear').onclick = ()=>{ log.innerHTML=''; vscode.postMessage({type:'clear'}); };
  input.addEventListener('keydown', (e)=>{
    if ((e.ctrlKey||e.metaKey) && e.key === 'Enter'){ e.preventDefault(); send(); return; }
    // Shell-style history walk: ↑ at top of input goes back, ↓ at bottom goes forward.
    if (e.key === 'ArrowUp') {
      // Only step into history if the cursor is on the first visual line.
      const before = input.value.slice(0, input.selectionStart || 0);
      if (before.includes('\n')) return; // multi-line edit, leave native behaviour
      if (histCursor === -1) histDraft = input.value;
      if (histCursor + 1 < cmdHistory.length) {
        histCursor++;
        input.value = cmdHistory[histCursor];
        input.setSelectionRange(input.value.length, input.value.length);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      const after = input.value.slice(input.selectionEnd || 0);
      if (after.includes('\n')) return;
      if (histCursor > 0) {
        histCursor--;
        input.value = cmdHistory[histCursor];
        input.setSelectionRange(input.value.length, input.value.length);
        e.preventDefault();
      } else if (histCursor === 0) {
        histCursor = -1;
        input.value = histDraft;
        input.setSelectionRange(input.value.length, input.value.length);
        e.preventDefault();
      }
      return;
    }
    // Any normal typing exits history-walk mode.
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Delete') {
      histCursor = -1;
    }
  });

  // Delegated click handler for per-message resend/edit buttons.
  log.addEventListener('click', (e)=>{
    const r = e.target.closest('button[data-resend]');
    const ed = e.target.closest('button[data-edit]');
    if (r) {
      const t = decodeURIComponent(r.getAttribute('data-resend'));
      input.value = t;
      send();
    } else if (ed) {
      const t = decodeURIComponent(ed.getAttribute('data-edit'));
      input.value = t;
      input.focus();
    }
  });

  // Delegated handler for code-block action buttons.
  document.addEventListener('click', (e)=>{
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    const blk = (window.__codeBlocks||{})[id];
    if (!blk) return;
    const act = btn.getAttribute('data-act');
    if (act === 'copy') {
      navigator.clipboard?.writeText(blk.code);
      btn.textContent = 'Copied';
      setTimeout(()=>btn.textContent='Copy', 1000);
      return;
    }
    if (act === 'insert')  vscode.postMessage({type:'applyInsert', code: blk.code});
    if (act === 'replace') vscode.postMessage({type:'applyReplace', code: blk.code});
    if (act === 'save')    vscode.postMessage({type:'applySave', code: blk.code, path: blk.path});
  });

  window.addEventListener('message', (e)=>{
    const m = e.data;
    if (m.type === 'userMessage') addMsg('user', m.text);
    else if (m.type === 'assistantStart'){ currentRaw=''; current = addMsg('assistant',''); }
    else if (m.type === 'assistantToken'){ currentRaw += m.text; if(current) current.innerHTML = render(currentRaw); log.scrollTop = log.scrollHeight; }
    else if (m.type === 'assistantEnd'){ current = null; }
    else if (m.type === 'assistantError'){ if(current) current.textContent = m.text; else addMsg('assistant', m.text); current = null; }
    else if (m.type === 'notice'){
      const d = document.createElement('div');
      d.className = 'notice';
      d.textContent = m.text;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    }
    else if (m.type === 'toolCall'){ lastTool = addTool(m.name, m.args); }
    else if (m.type === 'toolResult'){
      if (lastTool) {
        const p = lastTool.querySelector('[data-preview]');
        if (p) p.textContent = m.preview;
      }
    }
    else if (m.type === 'cleared'){ log.innerHTML=''; window.__codeBlocks={}; }
    else if (m.type === 'models'){ populateModels(m.models, m.current, m.error); }
    else if (m.type === 'currentModel'){
      for (const o of modelSel.options) o.selected = (o.value === m.model);
    }
    else if (m.type === 'history'){
      cmdHistory = m.items || [];
      histCursor = -1;
      renderHistoryPanel();
    }
  });

  // Ask the extension to send us the model list now that we're loaded.
  vscode.postMessage({ type:'ready' });
</script>
</body></html>`;
  }
}
