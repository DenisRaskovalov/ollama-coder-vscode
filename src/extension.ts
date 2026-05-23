import * as vscode from "vscode";
import { OllamaInlineCompletionProvider } from "./completionProvider";
import { runAction } from "./codeActions";
import { ChatViewProvider } from "./chatView";
import { listModels } from "./ollama";

export function activate(ctx: vscode.ExtensionContext) {
  const chatProvider = new ChatViewProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  ctx.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      new OllamaInlineCompletionProvider()
    )
  );

  // Status bar showing current chat model
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  status.command = "ollamaCoder.selectChatModel";
  const refreshStatus = () => {
    const m = vscode.workspace
      .getConfiguration("ollamaCoder")
      .get<string>("chatModel", "");
    status.text = `$(hubot) Ollama: ${m}`;
    status.tooltip = "Click to switch Ollama chat model";
    status.show();
  };
  refreshStatus();
  ctx.subscriptions.push(
    status,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ollamaCoder.chatModel")) refreshStatus();
    })
  );

  const reg = (id: string, fn: (...a: any[]) => any) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("ollamaCoder.openChat", async () => {
    await vscode.commands.executeCommand(
      "workbench.view.extension.ollamaCoder"
    );
    chatProvider.reveal();
  });

  reg("ollamaCoder.explainSelection", () => runAction("explain"));
  reg("ollamaCoder.refactorSelection", () => runAction("refactor"));
  reg("ollamaCoder.fixSelection", () => runAction("fix"));
  reg("ollamaCoder.addDocstrings", () => runAction("docstrings"));
  reg("ollamaCoder.generateTests", () => runAction("tests"));
  reg("ollamaCoder.askAboutSelection", () => runAction("ask"));

  reg("ollamaCoder.selectChatModel", () => pickModel("chatModel"));
  reg("ollamaCoder.selectCompletionModel", () =>
    pickModel("completionModel")
  );
}

async function pickModel(key: "chatModel" | "completionModel") {
  const cfg = vscode.workspace.getConfiguration("ollamaCoder");
  const endpoint = cfg.get<string>("endpoint", "http://localhost:11434");
  let models: string[] = [];
  try {
    models = await listModels(endpoint);
  } catch (e: any) {
    vscode.window.showErrorMessage(
      `Cannot reach Ollama at ${endpoint}: ${e?.message ?? e}`
    );
    return;
  }
  if (models.length === 0) {
    vscode.window.showWarningMessage(
      "No Ollama models found. Pull one with: `ollama pull llama3.1:8b`"
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(models, {
    title: `Select Ollama ${key === "chatModel" ? "chat" : "completion"} model`,
    placeHolder: cfg.get<string>(key) || "",
  });
  if (!pick) return;
  await cfg.update(key, pick, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Ollama Coder: ${key} → ${pick}`);
}

export function deactivate() {}
