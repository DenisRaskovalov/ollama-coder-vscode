// The exact bug report from the user:
//
//   In a VS Code window with an open folder I ran
//     "Write on a new file a solution of problem 'Hello World'."
//   After the agent finished, the folder had no new file.
//
// Root cause: small models (e.g. llama3.1:8b) sometimes ignore the agent
// tool instructions and reply with a chat-mode code block instead of
// calling write_file. The agent loop terminates cleanly but no file
// gets created.
//
// This test simulates that exact failure mode and asserts the new
// fallback-save pass kicks in: the chatView extracts the code block
// from the assistant message and routes it through saveToFile (the
// same confirm path the "Save..." button uses).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const Module = require("node:module");

// Stub `vscode` before we require the compiled chatView. We need to be
// able to observe what saveToFile was called with.
const recorded = { saveToFileCalls: [], inputs: [] };

const stubPath = path.resolve(__dirname, "_vscode_stub.js");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return stubPath;
  return origResolve.call(this, request, parent, ...rest);
};

// Hook saveToFile by mutating the compiled apply.js exports. We do this
// before chatView.js binds the reference \u2014 chatView's import statement
// pulls `saveToFile` lazily through the CommonJS exports object, so
// replacing it on `applyMod.saveToFile` is observed by chatView at
// call time.
const applyMod = require(path.resolve(__dirname, "..", "out", "apply.js"));
const realSaveToFile = applyMod.saveToFile;
applyMod.saveToFile = async (content, suggestedPath) => {
  recorded.saveToFileCalls.push({ content, suggestedPath });
  recorded.inputs.push(suggestedPath);
};

const { runAgentLoop } = require("../out/agentLoop.js");
const { scriptedChat } = require("./_scriptedOllama.js");
const { makeExecutor } = require("./_fsToolExecutor.js");
const { extractCodeBlocks, guessFilenameForLang } = require("../out/extractCodeBlocks.js");

// Reimplement chatView's fallback logic against the loop's result, so we
// can verify it end-to-end without needing the rest of the VS Code
// webview machinery.
async function runFallback(result, lastUserText) {
  const wroteSomething = result.messages.some(
    (m) =>
      m.role === "tool" &&
      (m.tool_name === "write_file" || m.tool_name === "edit_file") &&
      /^(Created|Updated|Edited)\b/i.test(m.content)
  );
  if (wroteSomething) return;
  const lastAssistant = [...result.messages]
    .reverse()
    .find((m) => m.role === "assistant" && m.content);
  if (!lastAssistant) return;
  const blocks = extractCodeBlocks(lastAssistant.content);
  if (!blocks.length) return;
  for (const blk of blocks) {
    const suggested =
      blk.pathHint && blk.pathHint.includes(".")
        ? blk.pathHint
        : guessFilenameForLang(blk.lang, blk.code, lastUserText);
    await applyMod.saveToFile(blk.code + "\n", suggested);
  }
}

test("repro: 'Write on a new file a solution of problem Hello World' -> file created via fallback", async () => {
  recorded.saveToFileCalls.length = 0;

  // The exact phrasing from the user's bug report.
  const userText = `Write on a new file a solution of problem "Hello World".`;
  // Script the model into the failure mode: NO tool calls, just a
  // chat-mode code fence \u2014 the most common failure path for small
  // local models.
  const chat = scriptedChat([
    {
      content:
        'Sure! Here is a Python solution:\n\n' +
        '```python\n' +
        'print("Hello, World!")\n' +
        '```\n',
      tool_calls: [],
    },
  ]);

  // The fs executor is still wired up so any write_file call WOULD
  // succeed \u2014 but we won't make one. That's the point.
  const exec = makeExecutor(fs.mkdtempSync(path.join(os.tmpdir(), "oc-fb-")));

  const result = await runAgentLoop(
    {
      endpoint: "http://localhost:11434",
      model: "test-model",
      messages: [
        { role: "system", content: "agent prompt here" },
        { role: "user", content: userText },
      ],
      tools: [],
      maxSteps: 5,
    },
    { chat, executeTool: exec.executeTool }
  );

  // 1. Agent terminated cleanly with no write tool call.
  assert.equal(result.finishedCleanly, true);
  assert.equal(
    exec.writes.length,
    0,
    "agent must NOT have called any write tool in this scenario \u2014 that's the bug"
  );

  // 2. The fallback pass picked up the code block and called saveToFile.
  await runFallback(result, userText);
  assert.equal(
    recorded.saveToFileCalls.length,
    1,
    "fallback must call saveToFile exactly once for the single emitted block"
  );

  // 3. The suggested filename uses the prompt phrase (Hello World) +
  //    the python extension inferred from the fence.
  const { content, suggestedPath } = recorded.saveToFileCalls[0];
  assert.match(
    suggestedPath,
    /^write_on_a\.py$|^hello_world\.py$|^solution\.py$/,
    `expected a sensible .py filename, got ${suggestedPath}`
  );
  assert.match(
    content,
    /print\(["']Hello, World!["']\)/,
    `code passed to saveToFile must contain the print, got: ${content}`
  );
});

test("fallback skips when a write tool already fired (no double-save)", async () => {
  recorded.saveToFileCalls.length = 0;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-fb-write-"));
  const exec = makeExecutor(root);

  const chat = scriptedChat([
    {
      // Agent does call write_file the right way.
      tool_calls: [
        {
          name: "write_file",
          arguments: { path: "hello.py", content: "print('hi')\n" },
        },
      ],
    },
    {
      // ...and ALSO chats a code block afterwards.
      content:
        "Done. For your reference the code is:\n\n```python\nprint('hi')\n```",
      tool_calls: [],
    },
  ]);

  const result = await runAgentLoop(
    {
      endpoint: "x",
      model: "m",
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "write hello.py" },
      ],
      tools: [],
      maxSteps: 5,
    },
    { chat, executeTool: exec.executeTool }
  );

  await runFallback(result, "write hello.py");
  assert.equal(
    recorded.saveToFileCalls.length,
    0,
    "fallback must NOT save when write_file already succeeded"
  );
  assert.equal(exec.writes.length, 1);
});

// Restore so subsequent test files see the real saveToFile.
test.after(() => {
  applyMod.saveToFile = realSaveToFile;
  Module._resolveFilename = origResolve;
});
