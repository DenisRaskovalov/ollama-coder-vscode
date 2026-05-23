import * as vscode from "vscode";
import { generate } from "./ollama";

const FIM_STOP = ["<|endoftext|>", "<|fim_pad|>", "<|file_sep|>", "\n\n\n"];

export class OllamaInlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  private timer: NodeJS.Timeout | undefined;
  private inflight: AbortController | undefined;

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
    const cfg = vscode.workspace.getConfiguration("ollamaCoder");
    if (!cfg.get<boolean>("enableInlineCompletion", true)) return [];

    const endpoint = cfg.get<string>("endpoint", "http://localhost:11434");
    const model = cfg.get<string>("completionModel", "qwen2.5-coder:1.5b-base");
    const maxTokens = cfg.get<number>("maxCompletionTokens", 128);
    const ctxChars = cfg.get<number>("contextWindowChars", 4000);
    const temperature = cfg.get<number>("temperature", 0.2);
    const debounce = cfg.get<number>("completionDebounceMs", 250);

    // Debounce + cancel previous request
    if (this.timer) clearTimeout(this.timer);
    if (this.inflight) this.inflight.abort();

    await new Promise<void>((res) => {
      this.timer = setTimeout(res, debounce);
    });
    if (token.isCancellationRequested) return [];

    const before = document.getText(
      new vscode.Range(new vscode.Position(0, 0), position)
    );
    const after = document.getText(
      new vscode.Range(
        position,
        document.lineAt(document.lineCount - 1).range.end
      )
    );

    const prefix = before.slice(-ctxChars);
    const suffix = after.slice(0, ctxChars);

    // Only complete inside code-ish content; skip when line is just whitespace at start of file
    if (!prefix.trim() && !suffix.trim()) return [];

    const ctrl = new AbortController();
    this.inflight = ctrl;
    token.onCancellationRequested(() => ctrl.abort());

    let text = "";
    try {
      text = await generate(
        {
          endpoint,
          model,
          prompt: prefix,
          suffix,
          temperature,
          numPredict: maxTokens,
          stop: FIM_STOP,
          signal: ctrl.signal,
        }
      );
    } catch (e: any) {
      if (e?.message?.includes("aborted")) return [];
      // Don't spam the user; log to output channel
      console.warn("[ollama-coder] completion failed:", e?.message ?? e);
      return [];
    }

    text = stripFences(text);
    if (!text) return [];

    return [
      new vscode.InlineCompletionItem(
        text,
        new vscode.Range(position, position)
      ),
    ];
  }
}

function stripFences(s: string): string {
  // Some chat-tuned models wrap output in ``` even for FIM; strip a leading fence if present
  const m = s.match(/^```[a-zA-Z0-9_+-]*\n([\s\S]*?)\n```/);
  return m ? m[1] : s;
}
