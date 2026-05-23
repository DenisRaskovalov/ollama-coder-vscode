// Run `tsc --noEmit` on the project and fail if it reports any errors.
// This catches undefined symbols (the exact class of bug that produced the
// missing `compactJson` reference at runtime).
//
// Uses Node's built-in test runner — no extra dependencies.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

test("tsc --noEmit reports no errors", () => {
  const root = path.resolve(__dirname, "..");
  const tsc = path.join(root, "node_modules", ".bin", "tsc");

  const res = spawnSync(tsc, ["-p", root, "--noEmit"], {
    cwd: root,
    encoding: "utf8",
  });

  const output = (res.stdout || "") + (res.stderr || "");
  assert.equal(
    res.status,
    0,
    `tsc exited with code ${res.status}\n\n${output}`
  );
  // tsc prints nothing on success; any output is suspicious.
  assert.equal(
    output.trim(),
    "",
    `tsc produced output even though it succeeded:\n${output}`
  );
});
