import * as vscode from "vscode";
import { chat, ChatMessage } from "./ollama";

interface ActionSpec {
  title: string;
  system: string;
  user: (code: string, lang: string, extra?: string) => string;
  /** If true, the result replaces the selection in the editor. Otherwise it's shown in a new doc. */
  replace: boolean;
}

const SYSTEM_BASE =
  "You are a senior software engineer. Be precise and concise. " +
  "When asked to modify code, return ONLY the modified code with no commentary, " +
  "no markdown fences, and preserve the original language.";

const ACTIONS: Record<string, ActionSpec> = {
  explain: {
    title: "Explain Selection",
    system:
      "You are a senior software engineer. Explain code clearly and concisely. " +
      "Use short paragraphs and bullet points where useful.",
    user: (code, lang) =>
      `Explain what the following ${lang} code does, then list any bugs, edge cases, or improvements.\n\n\`\`\`${lang}\n${code}\n\`\`\``,
    replace: false,
  },
  refactor: {
    title: "Refactor Selection",
    system: SYSTEM_BASE,
    user: (code, lang) =>
      `Refactor this ${lang} code for readability and idiomatic style. Keep behavior identical. ` +
      `Return only the refactored code.\n\n${code}`,
    replace: true,
  },
  fix: {
    title: "Fix Selection",
    system: SYSTEM_BASE,
    user: (code, lang) =>
      `Find and fix bugs in this ${lang} code. Keep the public API and behavior intent. ` +
      `Return only the fixed code.\n\n${code}`,
    replace: true,
  },
  docstrings: {
    title: "Add Docstrings/Comments",
    system: SYSTEM_BASE,
    user: (code, lang) =>
      `Add high-quality docstrings/comments to this ${lang} code. Do not change behavior. ` +
      `Return only the annotated code.\n\n${code}`,
    replace: true,
  },
  tests: {
    title: "Generate Unit Tests",
    system:
      "You are a senior software engineer who writes thorough, idiomatic unit tests.",
    user: (code, lang) =>
      `Write unit tests for the following ${lang} code. Pick the idiomatic test framework for the language. ` +
      `Return only the test file contents.\n\n\`\`\`${lang}\n${code}\n\`\`\``,
    replace: false,
  },
  ask: {
    title: "Ask About Selection",
    system:
      "You are a senior software engineer. Answer the user's question about the code precisely.",
    user: (code, lang, extra) =>
      `Question: ${extra}\n\nCode (${lang}):\n\`\`\`${lang}\n${code}\n\`\`\``,
    replace: false,
  },
};

export async function runAction(actionId: keyof typeof ACTIONS) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Ollama Coder: no active editor.");
    return;
  }
  const sel = editor.selection;
  const code = editor.document.getText(sel.isEmpty ? undefined : sel);
  if (!code.trim()) {
    vscode.window.showWarningMessage("Ollama Coder: selection is empty.");
    return;
  }
  const action = ACTIONS[actionId];
  if (!action) return;

  let extra: string | undefined;
  if (actionId === "ask") {
    extra = await vscode.window.showInputBox({
      prompt: "Ask Ollama about the selected code",
      placeHolder: "e.g. why is this O(n^2)?",
    });
    if (!extra) return;
  }

  const cfg = vscode.workspace.getConfiguration("ollamaCoder");
  const endpoint = cfg.get<string>("endpoint", "http://localhost:11434");
  const model = cfg.get<string>("chatModel", "llama3.1:8b");
  const temperature = cfg.get<number>("temperature", 0.2);

  const lang = editor.document.languageId;
  const messages: ChatMessage[] = [
    { role: "system", content: action.system },
    { role: "user", content: action.user(code, lang, extra) },
  ];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Ollama: ${action.title}…`,
      cancellable: true,
    },
    async (_progress, ctok) => {
      const ctrl = new AbortController();
      ctok.onCancellationRequested(() => ctrl.abort());

      try {
        const result = await chat(
          { endpoint, model, messages, temperature, signal: ctrl.signal }
        );
        const cleaned = stripFences(result).trim();
        if (!cleaned) {
          vscode.window.showWarningMessage("Ollama Coder: empty response.");
          return;
        }
        if (action.replace) {
          await editor.edit((eb) => eb.replace(sel, cleaned));
        } else {
          const doc = await vscode.workspace.openTextDocument({
            language: actionId === "tests" ? lang : "markdown",
            content: cleaned,
          });
          await vscode.window.showTextDocument(doc, { preview: true });
        }
      } catch (e: any) {
        if (!String(e?.message).includes("aborted")) {
          vscode.window.showErrorMessage(
            `Ollama Coder failed: ${e?.message ?? e}`
          );
        }
      }
    }
  );
}

function stripFences(s: string): string {
  const m = s.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : s;
}
