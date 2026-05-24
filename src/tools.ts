import * as vscode from "vscode";
import * as path from "path";
import { spawn } from "child_process";
import { searchWeb } from "./web";

/**
 * Workspace tools the LLM agent can call. Each tool has:
 *  - an OpenAI-style JSON schema (Ollama accepts the same shape)
 *  - an async executor that returns a string the model will see next turn
 *
 * All file paths are resolved relative to the first workspace folder.
 * Writes are guarded so the model cannot escape the workspace.
 */

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

const MAX_READ_BYTES = 64 * 1024; // 64 KB per read
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 50;

function workspaceRoot(): vscode.Uri {
  const f = vscode.workspace.workspaceFolders?.[0];
  if (!f) throw new Error("No workspace folder is open.");
  return f.uri;
}

function resolveInsideWorkspace(rel: string): vscode.Uri {
  const root = workspaceRoot();

  // Tolerate the most common shapes LLMs produce:
  //   './foo.cpp', '/foo.cpp', '\\foo.cpp', backslash separators, leading '~/',
  //   absolute paths that happen to live inside the workspace.
  let r = String(rel).trim();
  // Reject path traversal up front
  if (r.includes("..")) {
    throw new Error(`Path must not contain '..': ${rel}`);
  }
  // Normalise separators
  r = r.replace(/\\/g, "/");
  // Strip leading './', '/', '~/'
  r = r.replace(/^\.\//, "").replace(/^~\//, "").replace(/^\/+/, "");

  // Absolute path? If it's inside the workspace, make it relative.
  if (path.isAbsolute(r)) {
    const abs = vscode.Uri.file(r);
    const rootPath = root.fsPath + path.sep;
    if (abs.fsPath === root.fsPath || abs.fsPath.startsWith(rootPath)) {
      r = path.relative(root.fsPath, abs.fsPath);
    } else {
      throw new Error(`Absolute path is outside the workspace: ${rel}`);
    }
  }

  if (!r) throw new Error("Empty path");

  const abs = vscode.Uri.joinPath(root, r);
  const rootPath = root.fsPath + path.sep;
  if (!(abs.fsPath === root.fsPath || abs.fsPath.startsWith(rootPath))) {
    throw new Error(`Path escapes the workspace: ${rel}`);
  }
  return abs;
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file from the user's workspace. Returns up to 64KB of content with line numbers. Use this to look at code before answering or editing.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative file path, e.g. 'src/extension.ts'.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and subdirectories under a workspace-relative directory. Pass '.' for the workspace root. Honors .gitignore via VS Code's file search.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative directory path. Use '.' for the root.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description:
        "Search the workspace for a literal string or regex. Returns up to 50 matches with file:line:preview. Use this to find symbols, callers, definitions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal text or regex to search for." },
          is_regex: {
            type: "boolean",
            description: "Whether 'query' is a regex. Default false.",
          },
          glob: {
            type: "string",
            description:
              "Optional include glob, e.g. 'src/**/*.ts'. Defaults to all files.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file in the workspace with the given content. Use sparingly — the user will see a diff and may revert. Always read the file first if you intend to modify it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          content: { type: "string", description: "Full new file contents (UTF-8)." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_open_editors",
      description:
        "Return the workspace-relative paths of the currently open editors and which one is active, plus any current selection range.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command in the workspace root. The user sees a confirm dialog with the exact command before it runs. Returns combined stdout+stderr (up to 16KB) plus the exit code. Use sparingly; prefer the file-editing tools where possible. Disabled by default; enable with the ollamaCoder.enableRunCommand setting.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The command line to execute via /bin/sh -c (POSIX) or cmd /c (Windows). E.g. 'npm test', 'cargo build --release'.",
          },
          cwd: {
            type: "string",
            description: "Optional workspace-relative working directory. Defaults to the workspace root.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the public web for up-to-date information. Returns the top matches as 'title | url | snippet' lines. Use this for facts the model might not know, package names/versions, error messages, API docs. Default backend is DuckDuckGo (free, no key). If the user has configured Google Custom Search keys, Google is used instead.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query, e.g. 'pandas read_csv chunksize site:pandas.pydata.org'.",
          },
          limit: {
            type: "number",
            description: "Max results to return (1-10, default 5).",
          },
        },
        required: ["query"],
      },
    },
  },
];

/** Execute a tool call and return a string result suitable to feed back to the model. */
export async function executeTool(
  call: ToolCall,
  opts: { requireConfirmForWrites?: boolean } = {}
): Promise<string> {
  try {
    switch (call.name) {
      case "read_file":
        return await readFile(String(call.arguments.path ?? ""));
      case "list_files":
        return await listFiles(String(call.arguments.path ?? "."));
      case "search_text":
        return await searchText(
          String(call.arguments.query ?? ""),
          Boolean(call.arguments.is_regex),
          call.arguments.glob ? String(call.arguments.glob) : undefined
        );
      case "write_file":
        return await writeFile(
          String(call.arguments.path ?? ""),
          String(call.arguments.content ?? ""),
          opts.requireConfirmForWrites !== false
        );
      case "get_open_editors":
        return getOpenEditors();
      case "web_search":
        return await runWebSearch(
          String(call.arguments.query ?? ""),
          Number(call.arguments.limit ?? 5)
        );
      case "run_command":
        return await runShellCommand(
          String(call.arguments.command ?? ""),
          call.arguments.cwd ? String(call.arguments.cwd) : undefined
        );
      default:
        return `ERROR: unknown tool '${call.name}'`;
    }
  } catch (e: any) {
    return `ERROR: ${e?.message ?? e}`;
  }
}

async function readFile(rel: string): Promise<string> {
  if (!rel) throw new Error("read_file: 'path' is required");
  const uri = resolveInsideWorkspace(rel);
  let data: Uint8Array;
  try {
    data = await vscode.workspace.fs.readFile(uri);
  } catch (e: any) {
    // Surface a structured 'not found' so the model can proceed with
    // write_file for a brand-new file instead of giving up.
    if (/ENOENT|not found|FileNotFound/i.test(String(e?.message ?? e))) {
      return `File not found: ${rel}. (Safe to create with write_file.)`;
    }
    throw e;
  }
  const bytes = data.byteLength;
  const slice =
    bytes > MAX_READ_BYTES
      ? data.subarray(0, MAX_READ_BYTES)
      : data;
  const text = Buffer.from(slice as Uint8Array).toString("utf8");
  const lines = text.split("\n");
  const numbered = lines
    .map((l, i) => `${String(i + 1).padStart(4, " ")}: ${l}`)
    .join("\n");
  const truncated =
    bytes > MAX_READ_BYTES
      ? `\n... [truncated: read ${MAX_READ_BYTES} of ${bytes} bytes]`
      : "";
  return `File: ${rel} (${bytes} bytes)\n${numbered}${truncated}`;
}

async function listFiles(rel: string): Promise<string> {
  const dir = rel === "." || rel === "" ? "" : rel;
  const base = dir ? resolveInsideWorkspace(dir) : workspaceRoot();
  const entries = await vscode.workspace.fs.readDirectory(base);
  const sorted = entries
    .slice(0, MAX_LIST_ENTRIES)
    .sort((a, b) => {
      // dirs first
      if (a[1] !== b[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
  const lines = sorted.map(([name, type]) => {
    const tag =
      type === vscode.FileType.Directory
        ? "dir "
        : type === vscode.FileType.SymbolicLink
        ? "link"
        : "file";
    return `${tag}  ${name}`;
  });
  const more =
    entries.length > MAX_LIST_ENTRIES
      ? `\n... [${entries.length - MAX_LIST_ENTRIES} more entries truncated]`
      : "";
  return `Directory: ${dir || "."}\n${lines.join("\n")}${more}`;
}

async function searchText(
  query: string,
  isRegex: boolean,
  glob: string | undefined
): Promise<string> {
  if (!query) throw new Error("search_text: 'query' is required");
  const include = glob ?? "**/*";
  const uris = await vscode.workspace.findFiles(
    include,
    "**/{node_modules,.git,out,dist,build}/**",
    1000
  );
  let re: RegExp;
  try {
    re = isRegex
      ? new RegExp(query, "m")
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "m");
  } catch (e: any) {
    throw new Error(`bad regex: ${e.message}`);
  }
  const results: string[] = [];
  for (const uri of uris) {
    if (results.length >= MAX_SEARCH_RESULTS) break;
    let buf: Uint8Array;
    try {
      buf = await vscode.workspace.fs.readFile(uri);
    } catch {
      continue;
    }
    if (buf.byteLength > 1024 * 1024) continue; // skip >1MB
    const text = Buffer.from(buf).toString("utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const relPath = vscode.workspace.asRelativePath(uri);
        results.push(`${relPath}:${i + 1}: ${lines[i].slice(0, 200)}`);
        if (results.length >= MAX_SEARCH_RESULTS) break;
      }
    }
  }
  if (results.length === 0) return `No matches for ${isRegex ? "/" : '"'}${query}${isRegex ? "/" : '"'}.`;
  const head = `Found ${results.length}${
    results.length >= MAX_SEARCH_RESULTS ? "+" : ""
  } matches:\n`;
  return head + results.join("\n");
}

async function writeFile(
  rel: string,
  content: string,
  requireConfirm: boolean
): Promise<string> {
  if (!rel) throw new Error("write_file: 'path' is required");
  const uri = resolveInsideWorkspace(rel);

  let existed = true;
  let oldText = "";
  try {
    const old = await vscode.workspace.fs.readFile(uri);
    oldText = Buffer.from(old).toString("utf8");
  } catch {
    existed = false;
  }
  if (existed && oldText === content) {
    return `No changes: ${rel} already matches the requested content.`;
  }

  if (requireConfirm) {
    const verb = existed ? "Overwrite" : "Create";
    const pick = await vscode.window.showWarningMessage(
      `Ollama Free Coder agent wants to ${verb.toLowerCase()} ${rel} (${content.length} chars).`,
      { modal: false },
      verb,
      "Show diff first",
      "Reject"
    );
    if (pick === "Reject" || !pick) {
      return `User rejected write to ${rel}.`;
    }
    if (pick === "Show diff first") {
      await showDiff(uri, oldText, content, rel);
      const confirm = await vscode.window.showWarningMessage(
        `Apply changes to ${rel}?`,
        { modal: true },
        verb
      );
      if (confirm !== verb) return `User rejected write to ${rel}.`;
    }
  }

  // Ensure parent dir exists
  const parent = vscode.Uri.joinPath(uri, "..");
  try {
    await vscode.workspace.fs.createDirectory(parent);
  } catch {
    /* ignore */
  }
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  return `${existed ? "Updated" : "Created"} ${rel} (${content.length} chars).`;
}

async function showDiff(
  uri: vscode.Uri,
  oldText: string,
  newText: string,
  label: string
) {
  const left = await vscode.workspace.openTextDocument({
    content: oldText,
    language: guessLang(uri.path),
  });
  const right = await vscode.workspace.openTextDocument({
    content: newText,
    language: guessLang(uri.path),
  });
  await vscode.commands.executeCommand(
    "vscode.diff",
    left.uri,
    right.uri,
    `Ollama Free Coder: ${label} (proposed)`
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

async function runShellCommand(
  command: string,
  cwdRel: string | undefined
): Promise<string> {
  if (!command.trim()) return "ERROR: run_command: 'command' is required";

  const cfg = vscode.workspace.getConfiguration("ollamaCoder");
  if (!cfg.get<boolean>("enableRunCommand", false)) {
    return (
      "ERROR: run_command is disabled by default. Enable it in Settings -> " +
      "'Ollama Free Coder: Enable Run Command' if you trust the agent to " +
      "execute shell commands (each one still requires user confirmation)."
    );
  }

  const root = workspaceRoot();
  let cwd = root.fsPath;
  if (cwdRel) {
    try {
      cwd = resolveInsideWorkspace(cwdRel).fsPath;
    } catch (e: any) {
      return `ERROR: ${e.message}`;
    }
  }

  // Confirmation is REQUIRED. The model cannot bypass this.
  const preview = command.length > 200 ? command.slice(0, 197) + "..." : command;
  const pick = await vscode.window.showWarningMessage(
    `Ollama Free Coder agent wants to run:\n\n  ${preview}\n\nin ${vscode.workspace.asRelativePath(cwd) || "."}`,
    { modal: true },
    "Run",
    "Reject"
  );
  if (pick !== "Run") return `User rejected the command: ${preview}`;

  const timeoutMs = cfg.get<number>("runCommandTimeoutMs", 30000);
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWin ? ["/c", command] : ["-c", command];

  return await new Promise<string>((resolve) => {
    const child = spawn(shell, shellArgs, { cwd, env: process.env });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const MAX = 16 * 1024;
    let killed = false;

    const t = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    const onData = (b: Buffer) => {
      if (bytes >= MAX) return;
      const room = MAX - bytes;
      if (b.length <= room) {
        chunks.push(b);
        bytes += b.length;
      } else {
        chunks.push(b.subarray(0, room));
        bytes = MAX;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (e) => {
      clearTimeout(t);
      resolve(`ERROR: failed to spawn shell: ${e.message}`);
    });
    child.on("close", (code, signal) => {
      clearTimeout(t);
      const body = Buffer.concat(chunks).toString("utf8");
      const trailer = bytes >= MAX ? "\n... [truncated to 16KB]" : "";
      if (killed) {
        resolve(
          `command killed after ${timeoutMs}ms timeout. Output so far:\n${body}${trailer}`
        );
        return;
      }
      const tag =
        code === 0
          ? "exit 0"
          : signal
          ? `signal ${signal}`
          : `exit ${code ?? "?"}`;
      resolve(`Command finished (${tag}). Output:\n${body}${trailer}`);
    });
  });
}

async function runWebSearch(query: string, limit: number): Promise<string> {
  if (!query.trim()) return "ERROR: web_search: 'query' is required";
  const cfg = vscode.workspace.getConfiguration("ollamaCoder");
  const backend = cfg.get<string>("searchBackend", "duckduckgo") as
    | "duckduckgo"
    | "google";
  const googleApiKey = cfg.get<string>("googleApiKey", "");
  const googleCseId = cfg.get<string>("googleCseId", "");

  const results = await searchWeb(query, {
    backend,
    limit: Math.max(1, Math.min(10, limit || 5)),
    googleApiKey: googleApiKey || undefined,
    googleCseId: googleCseId || undefined,
  });

  if (!results.length) return `No web results for ${JSON.stringify(query)}.`;
  const lines = results.map(
    (r, i) =>
      `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.slice(0, 240)}`
  );
  const banner =
    backend === "google" && googleApiKey && googleCseId
      ? `Search (Google CSE) for "${query}":`
      : `Search (DuckDuckGo) for "${query}":`;
  return `${banner}\n${lines.join("\n")}`;
}

function getOpenEditors(): string {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
  const open = tabs
    .map((t) =>
      t.input instanceof vscode.TabInputText
        ? vscode.workspace.asRelativePath(t.input.uri)
        : null
    )
    .filter((x): x is string => !!x);

  const active = vscode.window.activeTextEditor;
  let activeInfo = "(no active editor)";
  if (active) {
    const rel = vscode.workspace.asRelativePath(active.document.uri);
    const sel = active.selection;
    if (sel.isEmpty) {
      activeInfo = `active: ${rel}  (cursor at L${sel.active.line + 1}:${sel.active.character + 1})`;
    } else {
      activeInfo = `active: ${rel}  (selection L${sel.start.line + 1}-L${sel.end.line + 1})`;
    }
  }
  return `Open editors:\n${open.map((p) => "  " + p).join("\n") || "  (none)"}\n${activeInfo}`;
}
