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
const EXTENSION_NAME = "ollama-free-coder";
const EXTENSION_DISPLAY_NAME = "Ollama Free Coder";

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

test(`package.json name is "${EXTENSION_NAME}"`, () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  assert.equal(
    pkg.name,
    EXTENSION_NAME,
    `extension name drifted: package.json says "${pkg.name}"`
  );
});

test(`package.json displayName is "${EXTENSION_DISPLAY_NAME}"`, () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  assert.equal(
    pkg.displayName,
    EXTENSION_DISPLAY_NAME,
    `displayName drifted: package.json says "${pkg.displayName}"`
  );
});

test(`every contributed command title starts with "${EXTENSION_DISPLAY_NAME}: "`, () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  const cmds = pkg.contributes?.commands ?? [];
  assert.ok(cmds.length > 0, "package.json must contribute commands");
  for (const c of cmds) {
    assert.ok(
      typeof c.title === "string" &&
        c.title.startsWith(`${EXTENSION_DISPLAY_NAME}: `),
      `command title not under "${EXTENSION_DISPLAY_NAME}: ": ${c.title}`
    );
  }
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

test(`no stray references to the old extension name on the VS Code side`, () => {
  // The Vim sister plugin (under vim/) is allowed to keep "Ollama Coder"
  // \u2014 it's a separately published plugin. CHANGELOG.md is also exempt:
  // historical entries and rename-announcement notes can (and should)
  // mention the old name. The check applies to everything users see in
  // the running extension and to the install/publish tooling.
  const vscodeFiles = [
    "README.md",
    "DOCUMENTATION.md",
    "PUBLISHING.md",
    "src/extension.ts",
    "src/chatView.ts",
    "src/codeActions.ts",
    "src/apply.ts",
    "src/tools.ts",
    "scripts/install-ubuntu.sh",
    "scripts/install-macos.sh",
    "scripts/install-windows.ps1",
    "scripts/publish-ubuntu.sh",
  ];
  for (const f of vscodeFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(
      !/\bOllama Coder\b/.test(src),
      `${f} still contains the old name "Ollama Coder"`
    );
  }
});

test(`Vim plugin keeps the 'Ollama Coder' name (separately published)`, () => {
  const vimReadme = fs.readFileSync(
    path.join(ROOT, "vim/README.md"),
    "utf8"
  );
  assert.ok(
    /Ollama Coder/.test(vimReadme),
    "vim/README.md must keep 'Ollama Coder' \u2014 the Vim plugin is a separate sister artifact"
  );
});
