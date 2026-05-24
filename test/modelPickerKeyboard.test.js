// Regression test: the model picker has full keyboard navigation.
// Validates the *contract* by inspecting the generated webview HTML/JS
// (no real DOM is available in node:test). The functional behaviour
// itself is exercised by hand inside VS Code; this test catches the
// "someone deleted the handler" / "someone glued it onto the textarea
// by mistake" classes of regression.

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
  return provider.html();
}
function getScript() {
  const m = generateHtml().match(/<script[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, "no <script> block found");
  return m[1];
}

test("modelBtn has a keydown listener for arrow keys", () => {
  const s = getScript();
  assert.ok(
    /modelBtn\.addEventListener\(\s*['"]keydown['"]/.test(s),
    "modelBtn must register its own keydown handler"
  );
});

test("modelBtn keydown handles ArrowDown, ArrowUp, Enter, Escape", () => {
  const s = getScript();
  // Find the modelBtn keydown handler block and assert every key is present.
  // The handler is a switch on e.key; grep the block.
  const start = s.indexOf("modelBtn.addEventListener('keydown'");
  assert.ok(start > 0, "modelBtn keydown handler not found");
  // Take a generous slice; the handler is < 2KB.
  const slice = s.slice(start, start + 3000);
  for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) {
    assert.ok(
      new RegExp(`['"]${key}['"]`).test(slice),
      `modelBtn keydown must handle ${key} (slice did not contain it)`
    );
  }
});

test("modelBtn keydown also handles Home/End and PageUp/PageDown", () => {
  const s = getScript();
  const start = s.indexOf("modelBtn.addEventListener('keydown'");
  const slice = s.slice(start, start + 3000);
  for (const key of ["Home", "End", "PageUp", "PageDown"]) {
    assert.ok(
      new RegExp(`['"]${key}['"]`).test(slice),
      `modelBtn keydown must handle ${key}`
    );
  }
});

test("the textarea's keydown listener is SEPARATE from the modelBtn one", () => {
  // The textarea has its own \u2191/\u2193 handler that walks command history.
  // If someone accidentally moves the model-picker handler onto the input,
  // typing in the chat input would steal model navigation. Guard against
  // that by asserting both listeners exist on the right elements.
  const s = getScript();
  assert.ok(
    /input\.addEventListener\(\s*['"]keydown['"]/.test(s),
    "textarea (input) must have its own keydown handler for history"
  );
  // ArrowUp must appear in BOTH handlers \u2014 once near 'input.', once near
  // 'modelBtn.'. Confirm both occurrences.
  const inputIdx  = s.indexOf("input.addEventListener('keydown'");
  const modelIdx  = s.indexOf("modelBtn.addEventListener('keydown'");
  assert.notEqual(inputIdx, -1, "no input keydown listener");
  assert.notEqual(modelIdx, -1, "no modelBtn keydown listener");
  // ArrowUp inside each block (slice 3KB after each)
  assert.ok(
    /['"]ArrowUp['"]/.test(s.slice(inputIdx, inputIdx + 3000)),
    "textarea handler must reference ArrowUp (command history)"
  );
  assert.ok(
    /['"]ArrowUp['"]/.test(s.slice(modelIdx, modelIdx + 3000)),
    "modelBtn handler must reference ArrowUp (option navigation)"
  );
});

test("the keyboard-highlighted .active style is defined in CSS", () => {
  // Without a visible highlight, arrow-key navigation feels broken
  // (\"is anything happening?\"). Pin the style.
  const html = generateHtml();
  assert.ok(
    /#modelMenu\s+\.opt\.active/.test(html),
    "CSS for #modelMenu .opt.active must exist"
  );
});

test("openModelMenu starts highlight on the currently selected option", () => {
  const s = getScript();
  assert.ok(
    /opts\.findIndex\(\(?el\)?\s*=>\s*el\.classList\.contains\(['"]selected['"]/.test(s),
    "openModelMenu must seed activeIdx from .selected option"
  );
});

test("commitModelActive posts a setModel message and closes the menu", () => {
  const s = getScript();
  const start = s.indexOf("function commitModelActive");
  assert.ok(start > 0, "commitModelActive must be defined");
  const slice = s.slice(start, start + 800);
  assert.ok(/vscode\.postMessage\(\{[^}]*type:\s*['"]setModel['"]/.test(slice),
    "commitModelActive must post setModel");
  assert.ok(/closeModelMenu\s*\(\s*\)/.test(slice),
    "commitModelActive must close the menu");
});
