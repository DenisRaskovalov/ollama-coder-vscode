// Tests for parseTagsResponse — the JSON-shape tolerance layer in front of
// Ollama's GET /api/tags. The earlier implementation only read 'm.name';
// recent Ollama builds emit 'm.model' for some entries and the old code
// silently dropped them, so the chat dropdown looked emptier than
// 'ollama list' on the same machine.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const ollamaPath = path.resolve(__dirname, "..", "out", "ollama.js");
if (!fs.existsSync(ollamaPath)) {
  throw new Error(`${ollamaPath} not found. Run 'npm run compile' first.`);
}
const { parseTagsResponse } = require(ollamaPath);

test("parseTagsResponse is exported", () => {
  assert.equal(typeof parseTagsResponse, "function");
});

test("parses the classic { models: [{ name }] } shape", () => {
  const got = parseTagsResponse({
    models: [
      { name: "llama3.1:8b", size: 1 },
      { name: "qwen2.5-coder:1.5b-base", size: 2 },
    ],
  });
  assert.deepEqual(got, ["llama3.1:8b", "qwen2.5-coder:1.5b-base"]);
});

test("parses newer { models: [{ model }] } shape (root cause of the bug)", () => {
  // Recent Ollama versions return 'model' instead of 'name' on some entries.
  const got = parseTagsResponse({
    models: [
      { model: "mistral:7b" },
      { model: "phi3:mini" },
    ],
  });
  assert.deepEqual(got, ["mistral:7b", "phi3:mini"]);
});

test("parses mixed entries with name OR model OR both", () => {
  const got = parseTagsResponse({
    models: [
      { name: "llama3.1:8b" },
      { model: "mistral:7b" },
      { name: "qwen2.5:7b", model: "qwen2.5:7b" },
    ],
  });
  assert.deepEqual(got.sort(), [
    "llama3.1:8b",
    "mistral:7b",
    "qwen2.5:7b",
  ]);
});

test("drops entries missing both name and model instead of emitting blank options", () => {
  const got = parseTagsResponse({
    models: [
      { name: "llama3.1:8b" },
      { size: 999 }, // bogus entry, no name/model
      { name: "" },  // empty name
      null,
      { model: "rust:nightly" },
    ],
  });
  assert.deepEqual(got, ["llama3.1:8b", "rust:nightly"]);
});

test("accepts bare strings", () => {
  const got = parseTagsResponse({ models: ["a:1", "b:2"] });
  assert.deepEqual(got, ["a:1", "b:2"]);
});

test("accepts a bare array (no 'models' wrapper)", () => {
  const got = parseTagsResponse([
    { name: "a:1" },
    { model: "b:2" },
  ]);
  assert.deepEqual(got, ["a:1", "b:2"]);
});

test("returns [] for malformed bodies instead of throwing", () => {
  assert.deepEqual(parseTagsResponse(null), []);
  assert.deepEqual(parseTagsResponse(undefined), []);
  assert.deepEqual(parseTagsResponse({}), []);
  assert.deepEqual(parseTagsResponse({ models: null }), []);
  assert.deepEqual(parseTagsResponse({ models: "oops" }), []);
});

test("dedups duplicate model names", () => {
  const got = parseTagsResponse({
    models: [
      { name: "llama3.1:8b" },
      { model: "llama3.1:8b" },
      { name: "llama3.1:8b" },
    ],
  });
  assert.deepEqual(got, ["llama3.1:8b"]);
});

test("sorts alphabetically (stable UI)", () => {
  const got = parseTagsResponse({
    models: [
      { name: "zoo:1" },
      { name: "apple:1" },
      { name: "Banana:1" },
    ],
  });
  assert.deepEqual(got, ["apple:1", "Banana:1", "zoo:1"]);
});

test("preserves a long list — regression guard for 'fewer models than ollama list'", () => {
  // Simulate a machine with 25 pulled models, half with 'name' half with
  // 'model'. The pre-fix code returned only the 'name'-tagged half.
  const arr = [];
  for (let i = 0; i < 25; i++) {
    const tag = `model-${String(i).padStart(2, "0")}:latest`;
    arr.push(i % 2 === 0 ? { name: tag } : { model: tag });
  }
  const got = parseTagsResponse({ models: arr });
  assert.equal(got.length, 25, `expected all 25 models, got ${got.length}`);
});
