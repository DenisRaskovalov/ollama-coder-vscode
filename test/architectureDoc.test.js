// Guard against ARCHITECTURE.md silently losing its load-bearing sections.
// The point of this doc is to be a reference for future contributors; if
// someone deletes the four-phase pipeline diagram or the invariants list
// in a routine doc edit, the paper stops doing its job.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ARCH = path.join(ROOT, "ARCHITECTURE.md");

let doc;
test.before(() => {
  assert.ok(fs.existsSync(ARCH), "ARCHITECTURE.md must exist");
  doc = fs.readFileSync(ARCH, "utf8");
});

test("ARCHITECTURE.md has all the load-bearing top-level sections", () => {
  // Numbered sections (1\u20138) per the paper itself.
  for (const heading of [
    "## 1. TL;DR",
    "## 2. The four phases of an operation",
    "## 3. Invariants the plugin upholds",
    "## 4. The design principle: delegate language understanding to Ollama",
    "## 5. Data flow trace",
    "## 6. Open questions",
    "## 7. Glossary",
    "## 8. Status",
  ]) {
    assert.ok(
      doc.includes(heading),
      `ARCHITECTURE.md missing section heading: ${heading}`
    );
  }
});

test("the four phases of an operation are all listed", () => {
  for (const phase of [
    "Input phase",
    "Routing phase",
    "Execution phase",
    "Output phase",
  ]) {
    assert.ok(
      doc.includes(phase),
      `ARCHITECTURE.md missing phase: ${phase}`
    );
  }
});

test("the invariants section enumerates the safety properties", () => {
  // The seven invariants must be discoverable by name. Each is the
  // first bolded word of a numbered item.
  for (const inv of [
    "Locality",
    "Sandbox",
    "User assent",
    "Abortable",
    "Tested as a contract",
    "Bounded loop",
    "Backward-compatible defaults",
  ]) {
    assert.ok(
      new RegExp(`\\*\\*${inv}`).test(doc),
      `ARCHITECTURE.md missing invariant: **${inv}**`
    );
  }
});

test("the design principle is stated in the user's own words", () => {
  // The whole point of the paper is to enshrine this principle.
  assert.ok(
    /delegate language understanding/i.test(doc),
    "ARCHITECTURE.md must state the 'delegate language understanding to Ollama' principle"
  );
});

test("the migration plan to an LLM router is documented", () => {
  // Four shippable steps (introduce / shadow / swap / delete).
  for (const stage of [
    "router.ts",
    "Shadow mode",
    "Swap",
    "Delete",
    "useLlmRouter",
  ]) {
    assert.ok(
      doc.includes(stage),
      `ARCHITECTURE.md missing migration plan step: ${stage}`
    );
  }
});

test("the data-flow trace lines up with real code paths", () => {
  // The trace section must reference actual functions / files so it
  // doesn't drift from reality.
  for (const ref of [
    "chatView.handleSend",
    "looksLikeFileWriteIntent",
    "inferLanguageExt",
    "runAgentLoop",
    "tools.executeTool",
    "resolveInsideWorkspace",
  ]) {
    assert.ok(
      doc.includes(ref),
      `ARCHITECTURE.md trace missing real code reference: ${ref}`
    );
  }
});

test("README links to ARCHITECTURE.md so users can find it", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.ok(
    /ARCHITECTURE\.md/.test(readme),
    "README.md should link to ARCHITECTURE.md"
  );
});
