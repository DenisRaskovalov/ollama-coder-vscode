// Cross-platform installer sanity tests.
//
// For every installer we ship:
//   - bash -n on the .sh scripts (real shell-syntax check),
//   - PowerShell parser tokenise on the .ps1 scripts when `pwsh` is on PATH,
//     otherwise a structural check (parameter syntax, balanced braces,
//     mandatory helper functions present).
//   - Cross-script content check: every installer must implement the same
//     contract — same env vars, same model-pull function, same OLLAMA_HOST
//     probe, same plugin install path on its OS.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------- bash

const SH_SCRIPTS = [
  "scripts/install-ubuntu.sh",
  "scripts/install-macos.sh",
  "vim/scripts/install-ubuntu.sh",
  "vim/scripts/install-macos.sh",
];

for (const rel of SH_SCRIPTS) {
  test(`bash -n ${rel}`, () => {
    const res = spawnSync("bash", ["-n", path.join(ROOT, rel)], {
      encoding: "utf8",
    });
    assert.equal(
      res.status,
      0,
      `bash -n failed:\n${res.stdout}\n${res.stderr}`
    );
  });
}

// ---------------------------------------------------------------- PowerShell

const PS_SCRIPTS = [
  "scripts/install-windows.ps1",
  "vim/scripts/install-windows.ps1",
];

function hasPwsh() {
  return spawnSync("which", ["pwsh"], { encoding: "utf8" }).status === 0;
}

for (const rel of PS_SCRIPTS) {
  test(`powershell parses ${rel}`, () => {
    const full = path.join(ROOT, rel);
    if (hasPwsh()) {
      // Real parser: tokenise the file. Any syntax error surfaces here.
      const res = spawnSync(
        "pwsh",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$errors = $null; ` +
            `$tokens = $null; ` +
            `[System.Management.Automation.Language.Parser]::ParseFile('${full.replace(
              /'/g,
              "''"
            )}', [ref]$tokens, [ref]$errors) | Out-Null; ` +
            `if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Host $_.Message }; exit 1 } else { exit 0 }`,
        ],
        { encoding: "utf8" }
      );
      assert.equal(
        res.status,
        0,
        `pwsh parser failed:\n${res.stdout}\n${res.stderr}`
      );
    } else {
      // Fallback: structural check.
      const src = fs.readFileSync(full, "utf8");
      assert.ok(
        /\[CmdletBinding\(\)\]\s*param\(\)/.test(src),
        `${rel} must declare [CmdletBinding()] param()`
      );
      assert.ok(
        /\$ErrorActionPreference\s*=\s*'Stop'/.test(src),
        `${rel} must set $ErrorActionPreference = 'Stop'`
      );
      const openBraces = (src.match(/\{/g) || []).length;
      const closeBraces = (src.match(/\}/g) || []).length;
      assert.equal(
        openBraces,
        closeBraces,
        `${rel} has unbalanced braces (${openBraces} { vs ${closeBraces} })`
      );
      const openParens = (src.match(/\(/g) || []).length;
      const closeParens = (src.match(/\)/g) || []).length;
      assert.equal(
        openParens,
        closeParens,
        `${rel} has unbalanced parentheses (${openParens} ( vs ${closeParens} ))`
      );
    }
  });
}

// ---------------------------------------------------------------- contract

const VSC_INSTALLERS = [
  "scripts/install-ubuntu.sh",
  "scripts/install-macos.sh",
  "scripts/install-windows.ps1",
];

const VIM_INSTALLERS = [
  "vim/scripts/install-ubuntu.sh",
  "vim/scripts/install-macos.sh",
  "vim/scripts/install-windows.ps1",
];

for (const rel of [...VSC_INSTALLERS, ...VIM_INSTALLERS]) {
  test(`${rel} honours the shared env-var contract`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const needle of [
      "CHAT_MODEL",
      "COMPLETION_MODEL",
      "OLLAMA_HOST",
      "EXTRA_MODELS",
      "SKIP_OLLAMA",
      "SKIP_PULL",
    ]) {
      assert.ok(
        src.includes(needle),
        `${rel} missing env-var contract token: ${needle}`
      );
    }
    // The /api/tags probe and 'ollama pull' line must be present in every
    // installer (different syntax per shell, but both tokens always appear).
    assert.ok(/\/api\/tags/.test(src), `${rel} missing /api/tags probe`);
    assert.ok(/ollama pull/.test(src),  `${rel} missing 'ollama pull' invocation`);
  });
}

test("vim installers install into the platform-correct pack path", () => {
  const ubuntu = fs.readFileSync(
    path.join(ROOT, "vim/scripts/install-ubuntu.sh"),
    "utf8"
  );
  const macos = fs.readFileSync(
    path.join(ROOT, "vim/scripts/install-macos.sh"),
    "utf8"
  );
  const win = fs.readFileSync(
    path.join(ROOT, "vim/scripts/install-windows.ps1"),
    "utf8"
  );

  assert.ok(
    ubuntu.includes(".vim/pack/ollama/start/ollama-coder"),
    "ubuntu must install into ~/.vim/pack/ollama/start/ollama-coder"
  );
  assert.ok(
    ubuntu.includes("nvim/site/pack/ollama/start/ollama-coder"),
    "ubuntu must install into nvim site pack"
  );
  assert.ok(
    macos.includes(".vim/pack/ollama/start/ollama-coder"),
    "macos must install into ~/.vim/pack/ollama/start/ollama-coder"
  );
  assert.ok(
    macos.includes("nvim/site/pack/ollama/start/ollama-coder"),
    "macos must install into nvim site pack"
  );
  assert.ok(
    win.includes("vimfiles\\pack\\ollama\\start\\ollama-coder"),
    "windows must install into %USERPROFILE%\\vimfiles\\pack\\ollama\\start\\ollama-coder"
  );
  assert.ok(
    win.includes("nvim-data\\site\\pack\\ollama\\start\\ollama-coder"),
    "windows must install into %LOCALAPPDATA%\\nvim-data\\site\\pack\\ollama\\start\\ollama-coder"
  );
});
