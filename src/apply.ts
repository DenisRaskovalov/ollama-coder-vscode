import * as vscode from "vscode";
import * as path from "path";

/** Insert text at the current editor's cursor. */
export async function insertAtCursor(text: string): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    vscode.window.showWarningMessage("Ollama Free Coder: no active editor.");
    return;
  }
  await ed.edit((eb) => eb.insert(ed.selection.active, text));
}

/** Replace the current selection (or whole document if empty) with text. */
export async function replaceSelection(text: string): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    vscode.window.showWarningMessage("Ollama Free Coder: no active editor.");
    return;
  }
  const sel = ed.selection;
  await ed.edit((eb) => {
    if (sel.isEmpty) {
      const full = new vscode.Range(
        new vscode.Position(0, 0),
        ed.document.lineAt(ed.document.lineCount - 1).range.end
      );
      eb.replace(full, text);
    } else {
      eb.replace(sel, text);
    }
  });
}

/**
 * Save `content` to a workspace-relative path. If `suggestedPath` is empty,
 * prompts the user. Shows a diff for existing files.
 */
export async function saveToFile(
  content: string,
  suggestedPath?: string
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage("Ollama Free Coder: no workspace open.");
    return;
  }

  const rel = await vscode.window.showInputBox({
    prompt: "Save code block to (workspace-relative path)",
    value: suggestedPath ?? "",
    placeHolder: "e.g. src/foo.ts",
  });
  if (!rel) return;

  const uri = vscode.Uri.joinPath(folder.uri, rel);
  const rootPath = folder.uri.fsPath + path.sep;
  if (uri.fsPath !== folder.uri.fsPath && !uri.fsPath.startsWith(rootPath)) {
    vscode.window.showErrorMessage("Ollama Free Coder: path escapes the workspace.");
    return;
  }

  let existed = true;
  let oldText = "";
  try {
    const old = await vscode.workspace.fs.readFile(uri);
    oldText = Buffer.from(old).toString("utf8");
  } catch {
    existed = false;
  }

  if (existed) {
    const left = await vscode.workspace.openTextDocument({
      content: oldText,
      language: guessLang(rel),
    });
    const right = await vscode.workspace.openTextDocument({
      content,
      language: guessLang(rel),
    });
    await vscode.commands.executeCommand(
      "vscode.diff",
      left.uri,
      right.uri,
      `Ollama Free Coder: ${rel} (proposed)`
    );
    const ok = await vscode.window.showWarningMessage(
      `Overwrite ${rel}?`,
      { modal: true },
      "Overwrite"
    );
    if (ok !== "Overwrite") return;
  } else {
    try {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(uri, "..")
      );
    } catch {
      /* ignore */
    }
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  vscode.window.showInformationMessage(
    `Ollama Free Coder: ${existed ? "updated" : "created"} ${rel}`
  );
}

function guessLang(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact",
    js: "javascript", jsx: "javascriptreact",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", kt: "kotlin", swift: "swift",
    md: "markdown", json: "json", yml: "yaml", yaml: "yaml",
    sh: "shellscript", html: "html", css: "css",
  };
  return map[ext] ?? "plaintext";
}
