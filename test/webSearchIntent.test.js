// Tests for the new web-search exposure layer:
//   - parseSlashSearch    -> '/search QUERY' style slash commands
//   - looksLikeWebSearchIntent -> heuristic that triggers RAG-style augmentation
// These are the functions that make web_search actually visible from the
// chat input. Before this PR the tool existed but only the LLM could ever
// invoke it, so users only ever saw "Ollama agents".

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
const { parseSlashSearch, looksLikeWebSearchIntent } = require(chatViewPath);

/* ----------------------------- slash commands ----------------------------- */

test("parseSlashSearch recognises /search QUERY", () => {
  assert.equal(parseSlashSearch("/search pandas read_csv chunksize"),
    "pandas read_csv chunksize");
});

test("parseSlashSearch recognises /web and /google as aliases", () => {
  assert.equal(parseSlashSearch("/web latest TypeScript 5 release"),
    "latest TypeScript 5 release");
  assert.equal(parseSlashSearch("/google ollama tool calling"),
    "ollama tool calling");
});

test("parseSlashSearch is case-insensitive and tolerates leading whitespace", () => {
  assert.equal(parseSlashSearch("  /SEARCH X"), "X");
  assert.equal(parseSlashSearch("/Search   multi word query"),
    "multi word query");
});

test("parseSlashSearch returns null for plain prompts", () => {
  assert.equal(parseSlashSearch("how do I do X"), null);
  assert.equal(parseSlashSearch("/help me out"), null);
  assert.equal(parseSlashSearch("search the web for X"), null);
  assert.equal(parseSlashSearch("/search "), null); // empty query
});

/* ----------------------------- web-search intent -------------------------- */

const WEB_POSITIVE = [
  "google the latest TypeScript release",
  "bing 'ollama tool calling'",
  "search the web for free SVG icon sets",
  "search the internet for free SVG icons",
  "search online for python pathlib",
  "look that up online",
  "look it up on the web",
  "what's the latest in Rust 1.85",
  "what's new in TypeScript",
  "give me the recent news on llama 3",
  "today's news about ollama",
];
for (const s of WEB_POSITIVE) {
  test(`detects web-search intent: ${JSON.stringify(s)}`, () => {
    assert.equal(
      looksLikeWebSearchIntent(s),
      true,
      `expected web-search positive: ${s}`
    );
  });
}

const WEB_NEGATIVE = [
  "what is a vector class in C++?",
  "explain how Hello World works",
  "create a new file with C++ Hello World",
  "search this file for foo", // 'search' not followed by 'web/internet/online'
  "write a function called search",
];
for (const s of WEB_NEGATIVE) {
  test(`does NOT trigger web-search intent: ${JSON.stringify(s)}`, () => {
    assert.equal(
      looksLikeWebSearchIntent(s),
      false,
      `expected web-search negative: ${s}`
    );
  });
}

/* ----------------------- composition with file-write/show ----------------- */

const {
  looksLikeFileWriteIntent,
  looksLikeShowIntent,
} = require(chatViewPath);

test("'/search pandas chunksize' is treated as a slash command, NOT file write", () => {
  const t = "/search pandas read_csv chunksize";
  assert.ok(parseSlashSearch(t));
  // The handleSend() short-circuit means write/show classifiers don't even
  // run, but the absence-of-false-positive here is still useful insurance.
  assert.equal(looksLikeFileWriteIntent(t), false);
  assert.equal(looksLikeShowIntent(t), false);
});

test("'google the latest C++ standards' -> web intent, not file write", () => {
  const t = "google the latest C++ standards";
  assert.equal(looksLikeWebSearchIntent(t), true);
  assert.equal(looksLikeFileWriteIntent(t), false);
});
