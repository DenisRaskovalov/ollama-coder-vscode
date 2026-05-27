// Pin two production-side invariants that were the user's actual bug:
//
//   1. Every write/edit/run confirm dialog is { modal: true }. The earlier
//      non-modal toast auto-dismissed after a few seconds and silently
//      resolved to 'undefined', which the tool treated as 'user rejected'.
//      Users reported 'no file was created' because they never saw the
//      prompt. The modal blocks until answered — the user cannot miss it.
//
//   2. When no folder is open, the chat view emits an explicit error
//      BEFORE running the agent. Otherwise every write_file call would
//      throw the same generic "No workspace folder is open" deep inside
//      the loop and the user would see only "agent finished without
//      writing a file", not "you need to open a folder".

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

test("tools.ts has NO { modal: false } confirm dialogs", () => {
  // Catch the regression directly at the source level. Any new write- or
  // edit-gating confirm MUST be modal.
  const src = fs.readFileSync(path.join(ROOT, "src/tools.ts"), "utf8");
  assert.equal(
    /\{\s*modal\s*:\s*false\s*\}/.test(src),
    false,
    "src/tools.ts still has a { modal: false } showWarningMessage — these silently time out"
  );
});

test("write_file confirm is modal AND includes the workspace path", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/tools.ts"), "utf8");
  const start = src.indexOf("async function writeFile(");
  assert.ok(start > 0, "writeFile function not found");
  const slice = src.slice(start, start + 4000);
  assert.match(
    slice,
    /showWarningMessage\([\s\S]*?\{\s*modal\s*:\s*true\s*\}/,
    "writeFile confirm must be { modal: true }"
  );
  assert.match(
    slice,
    /workspaceRoot\(\)\.fsPath/,
    "writeFile confirm must include workspaceRoot in the dialog message"
  );
});

test("edit_file confirm is modal AND includes the workspace path", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/tools.ts"), "utf8");
  const start = src.indexOf("async function editFileTool(");
  assert.ok(start > 0, "editFileTool not found");
  const slice = src.slice(start, start + 4000);
  assert.match(
    slice,
    /showWarningMessage\([\s\S]*?\{\s*modal\s*:\s*true\s*\}/,
    "edit_file confirm must be { modal: true }"
  );
  assert.match(slice, /workspaceRoot\(\)\.fsPath/);
});

test("run_command confirm is modal", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/tools.ts"), "utf8");
  const start = src.indexOf("async function runShellCommand(");
  assert.ok(start > 0);
  const slice = src.slice(start, start + 4000);
  assert.match(
    slice,
    /showWarningMessage\([\s\S]*?\{\s*modal\s*:\s*true\s*\}/,
    "run_command confirm must be { modal: true }"
  );
});

test("chatView refuses to run the agent when no folder is open", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/chatView.ts"), "utf8");
  assert.match(
    src,
    /workspaceFolders/,
    "chatView must check workspaceFolders before agent runs"
  );
  assert.match(
    src,
    /Open Folder/,
    "chatView's no-folder error must tell the user to use 'File → Open Folder…'"
  );
  const sendIdx = src.indexOf("private async handleSend(");
  const noFolderIdx = src.indexOf("No folder is open in VS Code");
  assert.ok(
    sendIdx > 0 && noFolderIdx > sendIdx,
    "the 'no folder' error must live inside handleSend so it fires before runAgentLoop"
  );
});

test("chatView surfaces the target workspace before each agent turn", () => {
  const src = fs.readFileSync(path.join(ROOT, "src/chatView.ts"), "utf8");
  assert.match(
    src,
    /Writing into workspace:/,
    "chatView must post a 'Writing into workspace: <path>' notice before each agent turn"
  );
});
