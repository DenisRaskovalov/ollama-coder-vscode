// Version-floor guard.
//
// As of v1.4.0 the project enforces:
//   1. package.json 'version' is a valid semver triplet.
//   2. It is >= MIN_VERSION (1.4.0) \u2014 you cannot accidentally revert to a
//      pre-1.4 number on a PR.
//   3. package-lock.json reports the same version (npm install keeps these
//      in sync; this test catches manual edits that forget the lockfile).
//   4. CHANGELOG.md has an entry for the current version (so users can see
//      what shipped).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MIN_VERSION = [1, 4, 0];

function parseSemver(s) {
  const m = String(s).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

test("package.json version is a valid semver triplet", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  const v = parseSemver(pkg.version);
  assert.ok(
    v,
    `package.json version "${pkg.version}" is not a valid X.Y.Z`
  );
});

test(`package.json version is >= ${MIN_VERSION.join(".")}`, () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  const v = parseSemver(pkg.version);
  assert.ok(v, `unparseable version: ${pkg.version}`);
  assert.ok(
    cmpSemver(v, MIN_VERSION) >= 0,
    `version regressed: package.json says "${pkg.version}", floor is ${MIN_VERSION.join(".")}`
  );
});

test("package-lock.json version matches package.json", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8")
  );
  assert.equal(
    lock.version,
    pkg.version,
    `package-lock.json version "${lock.version}" != package.json "${pkg.version}"`
  );
  // npm 9+ also writes the version inside packages[""].version.
  const root = lock.packages && lock.packages[""];
  if (root && root.version) {
    assert.equal(
      root.version,
      pkg.version,
      `package-lock packages[""] version "${root.version}" != package.json "${pkg.version}"`
    );
  }
});

test("CHANGELOG.md has an entry for the current version", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  const cl = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  // Accept either '## [1.4.0]' or '## 1.4.0' as a heading.
  const escaped = pkg.version.replace(/\./g, "\\.");
  const re = new RegExp(`^##\\s+\\[?${escaped}\\]?`, "m");
  assert.ok(
    re.test(cl),
    `CHANGELOG.md missing a '## [${pkg.version}]' (or '## ${pkg.version}') heading`
  );
});
