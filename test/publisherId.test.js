// The Visual Studio Marketplace publisher id is the one piece of metadata
// that absolutely must be stable: once an extension is published, changing
// it strands every existing installation. This test pins the expected
// publisher in package.json and makes sure PUBLISHING.md, marketplace
// URLs, and install commands all agree.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const EXPECTED_PUBLISHER = "DenRaskovalov";
const EXTENSION_NAME = "ollama-coder";

test(`package.json publisher is "${EXPECTED_PUBLISHER}"`, () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  assert.equal(
    pkg.publisher,
    EXPECTED_PUBLISHER,
    `publisher drifted: package.json says "${pkg.publisher}"`
  );
});

test(`package.json publisher is NOT "local" (placeholder)`, () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  assert.notEqual(
    pkg.publisher,
    "local",
    `publisher must be your real Marketplace id, not the "local" placeholder`
  );
});

test(`PUBLISHING.md references the right publisher id`, () => {
  const md = fs.readFileSync(path.join(ROOT, "PUBLISHING.md"), "utf8");

  // The JSON snippet showing what package.json should contain
  assert.ok(
    new RegExp(`"publisher":\\s*"${EXPECTED_PUBLISHER}"`).test(md),
    `PUBLISHING.md must show \`"publisher": "${EXPECTED_PUBLISHER}"\``
  );

  // The Marketplace publisher-management URL
  assert.ok(
    md.includes(
      `marketplace.visualstudio.com/manage/publishers/${EXPECTED_PUBLISHER}`
    ),
    `PUBLISHING.md must link to /manage/publishers/${EXPECTED_PUBLISHER}`
  );

  // The Marketplace item URL
  assert.ok(
    md.includes(
      `marketplace.visualstudio.com/items?itemName=${EXPECTED_PUBLISHER}.${EXTENSION_NAME}`
    ),
    `PUBLISHING.md must link to items?itemName=${EXPECTED_PUBLISHER}.${EXTENSION_NAME}`
  );

  // The install-from-CLI command
  assert.ok(
    md.includes(
      `code --install-extension ${EXPECTED_PUBLISHER}.${EXTENSION_NAME}`
    ),
    `PUBLISHING.md must show 'code --install-extension ${EXPECTED_PUBLISHER}.${EXTENSION_NAME}'`
  );
});

test(`no stray references to old publisher ids in marketplace contexts`, () => {
  // We tolerate GitHub URLs containing other usernames (the repo owner is
  // separate from the Marketplace publisher), but any *.<oldid>.* or
  // itemName=<oldid> or 'install-extension <oldid>' should be gone.
  const md = fs.readFileSync(path.join(ROOT, "PUBLISHING.md"), "utf8");
  const pkg = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  for (const stale of ["evilmucedin", "local"]) {
    if (stale === EXPECTED_PUBLISHER) continue;
    // itemName=<stale>
    assert.ok(
      !new RegExp(`itemName=${stale}\\.`).test(md),
      `PUBLISHING.md still references stale Marketplace id: itemName=${stale}.`
    );
    // install-extension <stale>.
    assert.ok(
      !new RegExp(`install-extension ${stale}\\.`).test(md),
      `PUBLISHING.md still references stale Marketplace id: install-extension ${stale}.`
    );
    // publisher": "<stale>"
    assert.ok(
      !new RegExp(`"publisher":\\s*"${stale}"`).test(pkg),
      `package.json still has stale publisher: ${stale}`
    );
  }
});
