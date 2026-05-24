// Tests for the Aider-style SEARCH/REPLACE patch engine in src/editFile.ts.
// Pure logic — no VS Code stub needed.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const editFilePath = path.resolve(__dirname, "..", "out", "editFile.js");
if (!fs.existsSync(editFilePath)) {
  throw new Error(`${editFilePath} not found. Run 'npm run compile' first.`);
}
const { applySearchReplace } = require(editFilePath);

test("simple in-place replacement", () => {
  const r = applySearchReplace(
    "hello world\nlorem ipsum\n",
    "lorem ipsum",
    "dolor sit"
  );
  assert.equal(r.ok, true);
  assert.equal(r.newContent, "hello world\ndolor sit\n");
});

test("new file: empty original + empty search inserts the replacement", () => {
  const r = applySearchReplace("", "", "fresh contents\n");
  assert.equal(r.ok, true);
  assert.equal(r.newContent, "fresh contents\n");
});

test("rejects empty file with non-empty search", () => {
  const r = applySearchReplace("", "foo", "bar");
  assert.equal(r.ok, false);
  assert.match(r.message, /file is empty/);
});

test("rejects empty search on existing file", () => {
  const r = applySearchReplace("some content\n", "", "x");
  assert.equal(r.ok, false);
  assert.match(r.message, /must not be empty/);
});

test("rejects when search is not found", () => {
  const r = applySearchReplace("alpha\nbeta\n", "gamma", "x");
  assert.equal(r.ok, false);
  assert.match(r.message, /not found/);
  // Message must coach the model to copy verbatim from read_file.
  assert.match(r.message, /read_file/);
});

test("rejects when search matches multiple times", () => {
  const r = applySearchReplace("foo\nfoo\nbar\n", "foo", "baz");
  assert.equal(r.ok, false);
  assert.match(r.message, /more than once/);
  assert.match(r.message, /more surrounding context/);
});

test("preserves CRLF tolerance: CRLF original + LF search still matches", () => {
  const r = applySearchReplace(
    "hello\r\nworld\r\n",
    "hello\nworld",
    "goodbye"
  );
  assert.equal(r.ok, true, `expected ok=true, got: ${r.message}`);
  // Output is LF-normalised \u2014 that's part of the contract.
  assert.equal(r.newContent, "goodbye\n");
});

test("preserves whitespace exactly inside the replace block", () => {
  const before = "  if (x) {\n    return 1;\n  }\n";
  const r = applySearchReplace(before, "return 1;", "return 42;");
  assert.equal(r.ok, true);
  assert.equal(r.newContent, "  if (x) {\n    return 42;\n  }\n");
});

test("multi-line search/replace block", () => {
  const before =
    "function foo() {\n" +
    "  console.log('hi');\n" +
    "  return 1;\n" +
    "}\n";
  const r = applySearchReplace(
    before,
    "  console.log('hi');\n  return 1;",
    "  return 2;"
  );
  assert.equal(r.ok, true);
  assert.equal(
    r.newContent,
    "function foo() {\n  return 2;\n}\n"
  );
});

test("reports changedBytes (heuristic, never negative)", () => {
  const r = applySearchReplace("foo bar baz", "bar", "QQQQ");
  assert.equal(r.ok, true);
  assert.ok(typeof r.changedBytes === "number");
  assert.ok(r.changedBytes >= 0);
});

test("tool schema: edit_file is registered with the right required fields", () => {
  // Stub vscode then require tools.
  const Module = require("node:module");
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (request === "vscode") return require.resolve("./_vscode_stub.js");
    return orig.call(this, request, parent, ...rest);
  };
  const tools = require(path.resolve(__dirname, "..", "out", "tools.js"));
  Module._resolveFilename = orig;

  const schema = tools.TOOL_SCHEMAS.find((s) => s.function.name === "edit_file");
  assert.ok(schema, "edit_file must be registered in TOOL_SCHEMAS");
  assert.deepEqual(
    schema.function.parameters.required.sort(),
    ["path", "replace", "search"]
  );
});
