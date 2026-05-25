// Unit tests for the fallback parser used by the chatView when the
// agent emits a chat-mode code block instead of calling write_file.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const p = path.resolve(__dirname, "..", "out", "extractCodeBlocks.js");
if (!fs.existsSync(p)) {
  throw new Error(`${p} not found. Run 'npm run compile' first.`);
}
const { extractCodeBlocks, guessFilenameForLang } = require(p);

/* ---------------------- extractCodeBlocks ---------------------- */

test("extractCodeBlocks: returns [] for empty / no-fence input", () => {
  assert.deepEqual(extractCodeBlocks(""), []);
  assert.deepEqual(extractCodeBlocks("no fences here, just prose"), []);
  assert.deepEqual(extractCodeBlocks(null), []);
});

test("extractCodeBlocks: single block with language tag", () => {
  const text =
    "Sure! Here's the program:\n```python\nprint('hi')\n```\nDone.";
  const blocks = extractCodeBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lang, "python");
  assert.equal(blocks[0].pathHint, "");
  assert.equal(blocks[0].code, "print('hi')");
});

test("extractCodeBlocks: Cursor-style fence with path hint", () => {
  const text = "```ts src/foo.ts\nexport const x = 1;\n```";
  const [b] = extractCodeBlocks(text);
  assert.equal(b.lang, "ts");
  assert.equal(b.pathHint, "src/foo.ts");
  assert.equal(b.code, "export const x = 1;");
});

test("extractCodeBlocks: multiple blocks", () => {
  const text =
    "```python\nprint(1)\n```\n\nand\n\n```python\nprint(2)\n```";
  const blocks = extractCodeBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].code, "print(1)");
  assert.equal(blocks[1].code, "print(2)");
});

test("extractCodeBlocks: language-less block still extracts", () => {
  const text = "```\nraw text\n```";
  const [b] = extractCodeBlocks(text);
  assert.equal(b.lang, "");
  assert.equal(b.code, "raw text");
});

/* ---------------------- guessFilenameForLang ---------------------- */

test("guessFilenameForLang: maps language tag to extension", () => {
  assert.equal(
    guessFilenameForLang("python", "print('hi')", "Hello World"),
    "hello_world.py"
  );
  assert.equal(
    guessFilenameForLang("cpp", "int main(){}", "Hello World"),
    "hello_world.cpp"
  );
  assert.equal(
    guessFilenameForLang("rust", "fn main(){}", "fizzbuzz"),
    "fizzbuzz.rs"
  );
});

test("guessFilenameForLang: defaults to Python via prompt sniff when lang missing", () => {
  // No fence language, but the body looks like Python.
  const name = guessFilenameForLang("", "def hi():\n    pass\n", "demo");
  assert.equal(name, "demo.py");
});

test("guessFilenameForLang: falls back to .txt when nothing identifies it", () => {
  const name = guessFilenameForLang("", "just some words", "");
  assert.ok(name.endsWith(".txt"), `expected .txt fallback, got ${name}`);
});

test("guessFilenameForLang: derives base name from prompt", () => {
  // "Hello World" -> "hello_world"
  assert.match(
    guessFilenameForLang("python", "", "Hello World"),
    /^hello_world\.py$/
  );
  // Strips punctuation.
  assert.match(
    guessFilenameForLang("python", "", "Hello, World!"),
    /^hello_world\.py$/
  );
  // First three tokens only.
  assert.match(
    guessFilenameForLang(
      "python",
      "",
      "a very long prompt with many irrelevant words"
    ),
    /^a_very_long\.py$/
  );
});

test("guessFilenameForLang: cpp inferred from #include when lang missing", () => {
  const name = guessFilenameForLang(
    "",
    "#include <iostream>\nint main(){return 0;}",
    ""
  );
  assert.ok(name.endsWith(".cpp"));
});

test("guessFilenameForLang: shell inferred from shebang", () => {
  const name = guessFilenameForLang("", "#!/bin/bash\necho hi", "deploy");
  assert.ok(name.endsWith(".sh"));
});
