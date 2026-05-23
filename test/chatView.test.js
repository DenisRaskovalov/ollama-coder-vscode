// Unit tests for chatView helpers compiled to out/.
// Requires `npm run compile` to have been run first.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const compiled = path.resolve(__dirname, "..", "out", "chatView.js");
if (!fs.existsSync(compiled)) {
  // Surface a clear error rather than a confusing 'cannot find module'.
  throw new Error(
    `${compiled} not found. Run 'npm run compile' before 'npm test'.`
  );
}

// chatView.js imports the 'vscode' module which only exists at runtime
// inside VS Code. Stub it so we can require the file in plain Node.
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return require.resolve("./_vscode_stub.js");
  return origResolve.call(this, request, parent, ...rest);
};

const { compactJson } = require(compiled);

test("compactJson is exported", () => {
  assert.equal(typeof compactJson, "function");
});

test("compactJson serializes plain objects", () => {
  assert.equal(compactJson({ a: 1, b: "x" }), '{"a":1,"b":"x"}');
});

test("compactJson truncates long string values", () => {
  const out = compactJson({ s: "a".repeat(200) });
  // The string value itself is truncated to 77 chars + ellipsis.
  assert.ok(out.includes("…"), `expected ellipsis, got: ${out}`);
  assert.ok(
    out.length < 200,
    `expected truncation, got length ${out.length}`
  );
});

test("compactJson handles circular references without throwing", () => {
  const a = {};
  a.self = a;
  const out = compactJson(a);
  assert.ok(out.includes("[circular]"), `got: ${out}`);
});

test("compactJson truncates the overall output at maxLen", () => {
  const big = { fields: {} };
  for (let i = 0; i < 100; i++) big.fields["k" + i] = i;
  const out = compactJson(big, 80);
  assert.ok(out.length <= 80, `expected <=80 chars, got ${out.length}`);
  assert.ok(out.endsWith("…"));
});

test("compactJson never returns undefined for non-serializable values", () => {
  // BigInt is not JSON-serializable; JSON.stringify throws.
  const out = compactJson(10n);
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0);
});
