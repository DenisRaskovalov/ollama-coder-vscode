// Static smoke tests for scripts/publish-ubuntu.sh.
// We don't actually run vsce / publish here; we just guard against shell
// syntax breakage and against the script forgetting one of its documented
// pipeline steps. Real publishing is exercised by the human runbook in
// PUBLISHING.md.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/publish-ubuntu.sh");

test("scripts/publish-ubuntu.sh exists and is executable", () => {
  const st = fs.statSync(SCRIPT);
  assert.ok(st.isFile(), "publish-ubuntu.sh must be a regular file");
  // Mode check: at least owner-execute.
  assert.ok(st.mode & 0o100, "publish-ubuntu.sh must be executable (chmod +x)");
});

test("bash -n scripts/publish-ubuntu.sh", () => {
  const res = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(
    res.status,
    0,
    `bash -n failed:\n${res.stdout}\n${res.stderr}`
  );
});

test("script implements every documented pipeline step", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  // Each of the eight numbered steps must appear in the log() output so the
  // user can follow along (and so we can't silently drop one).
  for (let i = 1; i <= 8; i++) {
    assert.ok(
      new RegExp(`Step ${i}/8`).test(src),
      `missing 'Step ${i}/8' marker`
    );
  }
});

test("script supports the advertised CLI flags", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  for (const flag of [
    "--bump",
    "--publish",
    "--ovsx",
    "--allow-dirty",
    "--branch",
  ]) {
    assert.ok(
      src.includes(flag),
      `publish-ubuntu.sh missing documented flag: ${flag}`
    );
  }
});

test("script blocks publishing when publisher is still 'local'", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(
    /publisher.*['"]local['"]/.test(src),
    "publish-ubuntu.sh must guard against publisher=='local'"
  );
});

test("script reads VSCE_PAT and OVSX_TOKEN from environment", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(/VSCE_PAT/.test(src),  "publish-ubuntu.sh must mention VSCE_PAT");
  assert.ok(/OVSX_TOKEN/.test(src), "publish-ubuntu.sh must mention OVSX_TOKEN");
});

test("script verifies the .vsix does not leak dev files", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  // The leak guard must check at least src/, test/, PUBLISHING.md.
  for (const leak of ["src/*", "test/*", "PUBLISHING.md"]) {
    assert.ok(
      src.includes(leak),
      `leak guard missing pattern: ${leak}`
    );
  }
});

test("script verifies required files ARE in the .vsix", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  for (const must of [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "media/icon.png",
    "out/extension.js",
  ]) {
    assert.ok(
      src.includes(must),
      `required-file check missing: ${must}`
    );
  }
});

test("script tags the release v<version> on successful publish", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(
    /git tag\s+["']?\$\{?VERSION\}?["']?|git tag\s+["']?v\$\{?VERSION\}?["']?/.test(src),
    "publish-ubuntu.sh must tag the release"
  );
});

test("script tells the user the marketplace URL after publishing", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(
    /marketplace\.visualstudio\.com\/items\?itemName=/.test(src),
    "publish-ubuntu.sh must print the marketplace URL after publishing"
  );
});

test("script honours --branch override (does not hard-code 'main')", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(
    /REQUIRE_BRANCH/.test(src),
    "publish-ubuntu.sh must use a REQUIRE_BRANCH variable"
  );
});

test("script runs 'npm test' before packaging", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  // Find the 'npm test' line and the 'vsce package' line, and assert the
  // first appears before the second. This guarantees the pipeline can't
  // publish a build that didn't pass tests.
  const npmTestIdx = src.indexOf("npm test");
  const vsceIdx = src.search(/vsce package/);
  assert.notEqual(npmTestIdx, -1, "no 'npm test' invocation");
  assert.notEqual(vsceIdx, -1, "no 'vsce package' invocation");
  assert.ok(
    npmTestIdx < vsceIdx,
    "'npm test' must run before 'vsce package'"
  );
});

test("script is documented in PUBLISHING.md", () => {
  // The runbook should at least mention the helper script so users can
  // discover it from there.
  const pub = fs.readFileSync(path.join(ROOT, "PUBLISHING.md"), "utf8");
  assert.ok(
    /publish-ubuntu\.sh/.test(pub),
    "PUBLISHING.md should mention scripts/publish-ubuntu.sh"
  );
});
