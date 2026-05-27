// Post-publish hygiene: pin the Marketplace badge + one-liner install
// in the README so we can never break the front-door discoverability.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
);
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const ITEM = `${pkg.publisher}.${pkg.name}`;

test("README has a shields.io Marketplace version badge for the published itemName", () => {
  // The badge image must reference exactly publisher.name (no typos).
  const re = new RegExp(
    `https://img\\.shields\\.io/visual-studio-marketplace/v/${ITEM.replace(
      /\./g,
      "\\."
    )}`
  );
  assert.match(
    README,
    re,
    `README missing 'visual-studio-marketplace/v/${ITEM}' badge`
  );
});

test("README has a shields.io install-count badge for the published itemName", () => {
  const re = new RegExp(
    `https://img\\.shields\\.io/visual-studio-marketplace/i/${ITEM.replace(
      /\./g,
      "\\."
    )}`
  );
  assert.match(README, re, `README missing 'visual-studio-marketplace/i/${ITEM}' badge`);
});

test("README links to the Marketplace item page", () => {
  assert.match(
    README,
    new RegExp(
      `marketplace\\.visualstudio\\.com/items\\?itemName=${ITEM.replace(
        /\./g,
        "\\."
      )}`
    ),
    `README must link to https://marketplace.visualstudio.com/items?itemName=${ITEM}`
  );
});

test("README shows the 'code --install-extension <itemName>' one-liner", () => {
  assert.match(
    README,
    new RegExp(`code --install-extension ${ITEM.replace(/\./g, "\\.")}`),
    `README must show 'code --install-extension ${ITEM}'`
  );
});

test("README's Install section comes BEFORE the per-OS installer scripts", () => {
  // We want Marketplace install to be the front-door for new users;
  // the long-form bootstrap scripts are the alternative path.
  const installIdx = README.indexOf("Install (one-liner, recommended)");
  const ubuntuIdx = README.search(/Ubuntu|install-ubuntu\.sh/);
  assert.ok(installIdx > 0, "README must have an 'Install (one-liner, recommended)' section");
  assert.ok(
    ubuntuIdx === -1 || installIdx < ubuntuIdx,
    "Marketplace one-liner install must appear before the Ubuntu installer instructions"
  );
});

test("CHANGELOG has a real released marker for 1.4.10 (the first Marketplace build)", () => {
  const cl = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  // The dated heading must mention 2026-05-27 (the actual publish date)
  // OR at least 'first Marketplace release' so it can never silently
  // revert to '## [1.4.10] — unreleased'.
  assert.match(
    cl,
    /## \[1\.4\.10\][^\n]*first Marketplace release/i,
    "CHANGELOG must mark 1.4.10 as the first Marketplace release"
  );
});
