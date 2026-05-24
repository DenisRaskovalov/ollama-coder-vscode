// Tests for the file-write intent detector and the path-resolver
// tolerance fixes. Without these the plugin would just chat back a
// code block when the user asked to create or edit a file.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return require.resolve("./_vscode_stub.js");
  return origResolve.call(this, request, parent, ...rest);
};

const chatViewPath = path.resolve(__dirname, "..", "out", "chatView.js");
if (!fs.existsSync(chatViewPath)) {
  throw new Error(`${chatViewPath} not found. Run 'npm run compile' first.`);
}

// chatView.js doesn't export the intent helper, but the regex set lives
// inside it as FILE_WRITE_INTENT. Re-implement the same checks here from
// the public behaviour spec, and assert the live module also passes —
// we drive it through the source file string so the regexes can't drift
// silently from the tests.

const chatViewSrc = fs.readFileSync(
  path.resolve(__dirname, "..", "src", "chatView.ts"),
  "utf8"
);

test("FILE_WRITE_INTENT exists in chatView.ts", () => {
  assert.ok(
    /FILE_WRITE_INTENT\s*=\s*\[/.test(chatViewSrc),
    "FILE_WRITE_INTENT must be defined in chatView.ts"
  );
});

test("looksLikeFileWriteIntent helper exists in chatView.ts", () => {
  assert.ok(
    /function looksLikeFileWriteIntent\b/.test(chatViewSrc),
    "looksLikeFileWriteIntent must exist in chatView.ts"
  );
});

// Reconstruct the helper from the compiled JS to test actual behaviour.
const compiledChatView = fs.readFileSync(chatViewPath, "utf8");
const ctor = new Function(
  compiledChatView +
    "\nreturn typeof looksLikeFileWriteIntent === 'function' ? looksLikeFileWriteIntent : null;"
);
// looksLikeFileWriteIntent is module-scope, so we can't trivially grab
// it via the regular CommonJS require. Instead, re-build the regex list
// from the source and exercise it. This stays in sync because the
// regexes are the *only* contract the rest of the code relies on.

// Import the actual compiled helpers so the test can't drift from the
// implementation. All three functions are exported from chatView.ts.
const {
  looksLikeFileWriteIntent: looksLike,
  looksLikeShowIntent: looksShow,
  inferLanguageExt,
} = require(chatViewPath);

// --- file-write intent positives ---

const POSITIVE = [
  "add a new file with C++ Hello World",
  "add vector class implementation to test.cpp",
  "create a new file foo.py with a Fibonacci function",
  "modify src/index.ts to export a helper",
  "save the result to output.json",
  // Reported regressions:
  "write to a new file C++ Hello World problem",
  "write a new file with C++ Hello World",
  "make hello.cpp with hello world",
  "new C++ Hello World file",
  "new Python script that prints primes",
  "create script using bash that lists pids",
  "implement Vector class in vector.hpp",
];
for (const s of POSITIVE) {
  test(`detects intent: ${JSON.stringify(s)}`, () => {
    assert.equal(looksLike(s), true, `expected positive match: ${s}`);
  });
}

const NEGATIVE = [
  "what is a vector class in C++?",
  "explain how Hello World works",
  "why does my code segfault?",
  "write some pseudocode for quicksort",
  "can you describe the Visitor pattern?",
];
for (const s of NEGATIVE) {
  test(`does NOT trigger: ${JSON.stringify(s)}`, () => {
    assert.equal(looksLike(s), false, `expected negative: ${s}`);
  });
}

// --- language inference ---

test("inferLanguageExt picks C++ for 'C++ Hello World'", () => {
  assert.deepEqual(inferLanguageExt("C++ Hello World"), {
    name: "C++",
    ext: ".cpp",
  });
});

test("inferLanguageExt picks Python for 'python primes script'", () => {
  assert.deepEqual(inferLanguageExt("python primes script"), {
    name: "Python",
    ext: ".py",
  });
});

test("inferLanguageExt picks Rust for 'rust fizzbuzz'", () => {
  assert.deepEqual(inferLanguageExt("rust fizzbuzz"), {
    name: "Rust",
    ext: ".rs",
  });
});

test("inferLanguageExt returns undefined when no language is mentioned", () => {
  assert.equal(inferLanguageExt("just a generic question"), undefined);
});

test("inferLanguageExt does not pick plain C when C++ is mentioned", () => {
  // Must not be confused by the 'C' in 'C++'.
  assert.deepEqual(inferLanguageExt("C++ Hello World"), {
    name: "C++",
    ext: ".cpp",
  });
});

// ---------------- show-on-screen intent ----------------

const SHOW_POSITIVE = [
  "show me a C++ Hello World",
  "display the SHA256 of a string in Python",
  "give me an example of a Vector class in C++",
  "give me a snippet for fizzbuzz",
  "what is a vector class in C++?",
  "how do I implement memoization in Python",
  "explain how Hello World works",
  "describe the Visitor pattern",
  "walk me through quicksort",
  "teach me how move semantics work",
  "summarize this function",
  "just show C++ Hello World in chat",
  "write fizzbuzz on screen, no file",
];
for (const s of SHOW_POSITIVE) {
  test(`detects show intent: ${JSON.stringify(s)}`, () => {
    assert.equal(looksShow(s), true, `expected show-intent positive: ${s}`);
  });
}

const SHOW_NEGATIVE = [
  "create a new file with C++ Hello World",
  "add Vector class implementation to test.cpp",
  "write a Python file fizzbuzz.py",
  "save the result to output.json",
];
for (const s of SHOW_NEGATIVE) {
  test(`does NOT trigger show intent: ${JSON.stringify(s)}`, () => {
    assert.equal(looksShow(s), false, `expected show-intent negative: ${s}`);
  });
}

// ---------------- the routing rule that uses both ----------------
//
// The chat view's effective rule is:
//   if showIntent       -> stay in chat (no agent), even if intent also matches
//   else if intent      -> route to agent
//   else                -> stay in chat
// Verify both signals together for the user's tricky cases.

function route(s) {
  if (looksShow(s)) return "chat";
  if (looksLike(s)) return "agent";
  return "chat";
}

test("'show me a C++ Hello World' -> chat (was wrongly routed to agent before)", () => {
  assert.equal(route("show me a C++ Hello World"), "chat");
});

test("'explain Vector class in C++' -> chat (was a regex false-positive)", () => {
  assert.equal(route("explain Vector class in C++"), "chat");
});

test("'what is a class in Python' -> chat", () => {
  assert.equal(route("what is a class in Python"), "chat");
});

test("'write to a new file C++ Hello World program' -> agent (regression)", () => {
  assert.equal(
    route("write to a new file C++ Hello World program"),
    "agent"
  );
});

test("'add Vector class implementation to test.cpp' -> agent (regression)", () => {
  assert.equal(
    route("add Vector class implementation to test.cpp"),
    "agent"
  );
});

test("'make a Hello World program in C++' -> chat (intent regex tightened)", () => {
  // Before this PR, this matched the noun+language pattern and silently
  // got routed to agent. The user expectation is chat.
  assert.equal(route("make a Hello World program in C++"), "chat");
});

test("'just show C++ Hello World in chat' -> chat (explicit override)", () => {
  assert.equal(route("just show C++ Hello World in chat"), "chat");
});

// --- path tolerance tests via tools.js ---

const toolsPath = path.resolve(__dirname, "..", "out", "tools.js");
const tools = require(toolsPath);

test("read_file returns a structured not-found instead of throwing", async () => {
  // The vscode stub returns an empty buffer, so the read path normally
  // succeeds. Replace fs.readFile to simulate ENOENT.
  const stub = require("./_vscode_stub.js");
  const orig = stub.workspace.fs.readFile;
  stub.workspace.fs.readFile = async () => {
    const e = new Error("ENOENT: no such file");
    throw e;
  };
  // Also need a workspaceRoot
  stub.workspace.workspaceFolders = [{ uri: { fsPath: "/tmp/ws", path: "/tmp/ws" } }];
  // Patch Uri.joinPath to act sensibly
  stub.Uri.joinPath = (root, ...parts) => ({
    fsPath: [root.fsPath, ...parts].join("/"),
    path: [root.path, ...parts].join("/"),
  });

  const out = await tools.executeTool({
    name: "read_file",
    arguments: { path: "does/not/exist.cpp" },
  });
  // executeTool wraps thrown errors as "ERROR: …" — we want the not-found
  // path to come back as a plain string the model can act on.
  assert.ok(
    /File not found/i.test(out),
    `expected 'File not found' message, got: ${out}`
  );

  stub.workspace.fs.readFile = orig;
});
