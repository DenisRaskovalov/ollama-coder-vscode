// Tests for the repo-map symbol extractor.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const p = path.resolve(__dirname, "..", "out", "repoMap.js");
if (!fs.existsSync(p)) {
  throw new Error(`${p} not found. Run 'npm run compile' first.`);
}
const { extractSymbols, renderRepoMap } = require(p);

test("TypeScript: function / class / interface / type", () => {
  const src =
    "export function add(a: number, b: number) { return a + b; }\n" +
    "class Box { x = 0; }\n" +
    "export interface Pair { a: string; b: string; }\n" +
    "type Id = string;\n";
  const got = extractSymbols("src/foo.ts", src);
  const labels = got.map((s) => s.label);
  assert.ok(labels.includes("function add"), `missing function: ${labels}`);
  assert.ok(labels.includes("class Box"), `missing class: ${labels}`);
  assert.ok(labels.includes("interface Pair"), `missing interface: ${labels}`);
  assert.ok(labels.includes("type Id"), `missing type alias: ${labels}`);
});

test("Python: def, async def, class", () => {
  const src =
    "def hello():\n    pass\n\n" +
    "async def fetch(url):\n    return url\n\n" +
    "class Robot:\n    pass\n";
  const got = extractSymbols("bot.py", src).map((s) => s.label);
  assert.deepEqual(got, ["def hello", "async def fetch", "class Robot"]);
});

test("Rust: fn / struct / enum / trait", () => {
  const src =
    "pub fn run() {}\n" +
    "struct Counter { n: u32 }\n" +
    "enum Mode { On, Off }\n" +
    "pub trait Render { fn render(&self); }\n";
  const got = extractSymbols("a.rs", src).map((s) => s.label);
  assert.ok(got.includes("fn run"));
  assert.ok(got.includes("struct Counter"));
  assert.ok(got.includes("enum Mode"));
  assert.ok(got.includes("trait Render"));
});

test("Go: func + struct", () => {
  const src =
    "package main\n" +
    "func main() {}\n" +
    "type Server struct { addr string }\n";
  const got = extractSymbols("m.go", src).map((s) => s.label);
  assert.ok(got.includes("func main"));
  assert.ok(got.includes("struct Server"));
});

test("Bash: function declarations", () => {
  const src = "function deploy() {\n  echo go\n}\n\nbuild() {\n  make\n}\n";
  const got = extractSymbols("x.sh", src).map((s) => s.label);
  assert.ok(got.includes("function deploy"));
  assert.ok(got.includes("function build"));
});

test("symbols carry 1-based line numbers", () => {
  const src = "// header\nfunction first(){}\n// gap\nclass Second {}\n";
  const got = extractSymbols("f.ts", src);
  const first = got.find((s) => s.label === "function first");
  const second = got.find((s) => s.label === "class Second");
  assert.equal(first?.line, 2);
  assert.equal(second?.line, 4);
});

test("returns [] for unknown extensions", () => {
  assert.deepEqual(extractSymbols("README.md", "# Title\n"), []);
  assert.deepEqual(extractSymbols("data.bin", "\\x00\\x01"), []);
});

test("respects maxPerFile cap", () => {
  const src = Array.from({ length: 50 }, (_, i) => `def f${i}(): pass`).join("\n");
  const got = extractSymbols("x.py", src, 10);
  assert.equal(got.length, 10);
});

test("skips absurdly long lines", () => {
  const longLine = "x".repeat(500);
  const src = `function visible(){}\n${longLine}\nfunction also(){}\n`;
  const got = extractSymbols("f.ts", src).map((s) => s.label);
  assert.ok(got.includes("function visible"));
  assert.ok(got.includes("function also"));
});

test("renderRepoMap produces an alphabetical, line-numbered map", () => {
  const out = renderRepoMap([
    { path: "src/z.ts", symbols: [{ label: "function z", line: 3 }] },
    { path: "src/a.ts", symbols: [{ label: "class A", line: 1 }] },
  ]);
  const aIdx = out.indexOf("src/a.ts");
  const zIdx = out.indexOf("src/z.ts");
  assert.ok(aIdx < zIdx, "files must be sorted alphabetically");
  assert.match(out, /L1: class A/);
  assert.match(out, /L3: function z/);
});

test("renderRepoMap truncates at maxBytes and tells the user", () => {
  const entries = [];
  for (let i = 0; i < 200; i++) {
    entries.push({
      path: `src/file${String(i).padStart(3, "0")}.ts`,
      symbols: Array.from({ length: 10 }, (_, k) => ({
        label: `function veryLongFunctionName${k}`,
        line: k + 1,
      })),
    });
  }
  const out = renderRepoMap(entries, 1024);
  assert.ok(out.length <= 1024 + 200, "should respect maxBytes (within slack)");
  assert.match(out, /\[repo_map truncated/);
});

test("renderRepoMap handles the empty case gracefully", () => {
  const out = renderRepoMap([]);
  assert.match(out, /no source files matched/i);
});

test("repo_map tool is registered", () => {
  const Module = require("node:module");
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...rest) {
    if (request === "vscode") return require.resolve("./_vscode_stub.js");
    return orig.call(this, request, parent, ...rest);
  };
  const tools = require(path.resolve(__dirname, "..", "out", "tools.js"));
  Module._resolveFilename = orig;
  const schema = tools.TOOL_SCHEMAS.find((s) => s.function.name === "repo_map");
  assert.ok(schema, "repo_map missing from TOOL_SCHEMAS");
});
