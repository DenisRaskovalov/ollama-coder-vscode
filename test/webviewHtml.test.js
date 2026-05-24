// Regression: an unescaped '\n' inside the webview HTML template literal in
// chatView.ts produces a real newline character inside a single-quoted JS
// string, which is a JavaScript SyntaxError. The webview then fails to load,
// the model dropdown sticks at "(loading…)" forever, and no command runs.
//
// This test instantiates the ChatViewProvider with a stubbed vscode module,
// pulls the generated HTML, extracts the <script> block, and parses it with
// the JavaScript parser (new Function). If the script has a syntax error
// the test fails — even though the rest of the test suite is happy.

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
const { ChatViewProvider } = require(chatViewPath);

function generateHtml() {
  const ctx = {
    globalState: { get: () => [], update: async () => {} },
    subscriptions: [],
  };
  const provider = new ChatViewProvider(ctx);
  // html() is a private method; call it directly. TypeScript-private is a
  // compile-time concept — at runtime it's a regular method.
  return provider.html();
}

function extractScript(html) {
  const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, "no <script> block found in webview HTML");
  return m[1];
}

test("webview HTML contains a <script> block", () => {
  const html = generateHtml();
  assert.ok(/<script[^>]*nonce=/.test(html), "missing nonced script tag");
});

test("embedded webview script parses as valid JavaScript", () => {
  const script = extractScript(generateHtml());
  // Wrap in a Function so we get a syntax check without executing it.
  // 'acquireVsCodeApi' is provided by VS Code at runtime; declare a no-op
  // so reference errors at parse time don't trip us (they wouldn't anyway,
  // but be explicit).
  try {
    new Function("acquireVsCodeApi", "document", "window", "navigator", script);
  } catch (e) {
    assert.fail(
      `webview <script> is not parseable JavaScript:\n${e.message}\n\nFirst 400 chars:\n${script.slice(0, 400)}`
    );
  }
});

test("key webview entry points are present in the script", () => {
  // These messages and handlers were broken by the unescaped-newline bug:
  // when the script fails to parse, none of them are wired up and the UI
  // sticks at '(loading…)'. Asserting they exist (and the parse test above
  // passes) means the message pipeline is at least syntactically intact.
  const script = extractScript(generateHtml());
  for (const needle of [
    "type:'ready'",
    "populateModels",
    "renderHistoryPanel",
    "addEventListener('message'",
  ]) {
    assert.ok(
      script.includes(needle),
      `webview script is missing expected entry point: ${needle}`
    );
  }
});
