// Tests for scripts/pick-models.sh. We drive it via OVERRIDE_RAM_MB so the
// tests are deterministic and don't depend on the host's actual RAM.
//
// Also runs structural checks against the PowerShell sibling
// (scripts/pick-models.ps1) — same tier table, same output format.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PICK_SH = path.join(ROOT, "scripts/pick-models.sh");
const PICK_PS1 = path.join(ROOT, "scripts/pick-models.ps1");

function pick(overrideRamMb) {
  const res = spawnSync(PICK_SH, [], {
    encoding: "utf8",
    env: { ...process.env, OVERRIDE_RAM_MB: String(overrideRamMb) },
  });
  assert.equal(
    res.status,
    0,
    `pick-models.sh failed:\n${res.stdout}\n${res.stderr}`
  );
  const out = {};
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/* ------------------------------ basic shape ------------------------------ */

test("pick-models.sh is executable and prints all 5 keys", () => {
  const st = fs.statSync(PICK_SH);
  assert.ok(st.mode & 0o100, "pick-models.sh must be executable");
  const out = pick(16384);
  for (const k of ["RAM_MB", "RAM_GB", "TIER", "CHAT_MODEL", "COMPLETION_MODEL"]) {
    assert.ok(out[k], `missing key in output: ${k}`);
  }
});

test("RAM_GB is a sane rounded conversion of RAM_MB", () => {
  const out = pick(16384);
  assert.equal(out.RAM_MB, "16384");
  assert.equal(out.RAM_GB, "16");
});

/* ------------------------- tier boundary table --------------------------- */
//
//   <  6 GB       tiny      llama3.2:3b         qwen2.5-coder:0.5b-base
//   <  12 GB      small     llama3.1:8b         qwen2.5-coder:1.5b-base
//   <  20 GB      medium    qwen2.5:14b         qwen2.5-coder:1.5b-base
//   <  40 GB      large     qwen2.5:32b         qwen2.5-coder:7b-base
//   >= 40 GB      huge      llama3.3:70b        qwen2.5-coder:7b-base

const CASES = [
  // [ram_mb,           tier,    chat,             completion              ],
  [  2048,             "tiny",   "llama3.2:3b",    "qwen2.5-coder:0.5b-base"],
  [  4096,             "tiny",   "llama3.2:3b",    "qwen2.5-coder:0.5b-base"],
  [  6143,             "tiny",   "llama3.2:3b",    "qwen2.5-coder:0.5b-base"],
  [  6144,             "small",  "llama3.1:8b",    "qwen2.5-coder:1.5b-base"],
  [  8192,             "small",  "llama3.1:8b",    "qwen2.5-coder:1.5b-base"],
  [ 12287,             "small",  "llama3.1:8b",    "qwen2.5-coder:1.5b-base"],
  [ 12288,             "medium", "qwen2.5:14b",    "qwen2.5-coder:1.5b-base"],
  [ 16384,             "medium", "qwen2.5:14b",    "qwen2.5-coder:1.5b-base"],
  [ 20479,             "medium", "qwen2.5:14b",    "qwen2.5-coder:1.5b-base"],
  [ 20480,             "large",  "qwen2.5:32b",    "qwen2.5-coder:7b-base"  ],
  [ 32768,             "large",  "qwen2.5:32b",    "qwen2.5-coder:7b-base"  ],
  [ 40959,             "large",  "qwen2.5:32b",    "qwen2.5-coder:7b-base"  ],
  [ 40960,             "huge",   "llama3.3:70b",   "qwen2.5-coder:7b-base"  ],
  [ 65536,             "huge",   "llama3.3:70b",   "qwen2.5-coder:7b-base"  ],
  [131072,             "huge",   "llama3.3:70b",   "qwen2.5-coder:7b-base"  ],
];

for (const [ram, tier, chat, comp] of CASES) {
  test(`tier @ ${ram} MB -> ${tier} / ${chat} / ${comp}`, () => {
    const out = pick(ram);
    assert.equal(out.TIER, tier);
    assert.equal(out.CHAT_MODEL, chat);
    assert.equal(out.COMPLETION_MODEL, comp);
  });
}

/* --------------------------- PowerShell sibling -------------------------- */

test("pick-models.ps1 exists and is syntactically structured", () => {
  const ps = fs.readFileSync(PICK_PS1, "utf8");
  // Same five outputs.
  for (const tag of ["RAM_MB=", "RAM_GB=", "TIER=", "CHAT_MODEL=", "COMPLETION_MODEL="]) {
    assert.ok(ps.includes(tag), `pick-models.ps1 missing output line: ${tag}`);
  }
  // Same tier boundary numbers.
  for (const n of [6144, 12288, 20480, 40960]) {
    assert.ok(
      new RegExp(`-lt\\s+${n}\\b`).test(ps),
      `pick-models.ps1 must reference tier boundary ${n}`
    );
  }
  // Same chat & completion model strings.
  for (const m of [
    "llama3.2:3b",
    "llama3.1:8b",
    "qwen2.5:14b",
    "qwen2.5:32b",
    "llama3.3:70b",
    "qwen2.5-coder:0.5b-base",
    "qwen2.5-coder:1.5b-base",
    "qwen2.5-coder:7b-base",
  ]) {
    assert.ok(ps.includes(m), `pick-models.ps1 must mention model: ${m}`);
  }
});

/* ----------------- installer wiring (cross-script contract) -------------- */

const INSTALLERS = [
  "scripts/install-ubuntu.sh",
  "scripts/install-macos.sh",
  "scripts/install-windows.ps1",
  "vim/scripts/install-ubuntu.sh",
  "vim/scripts/install-macos.sh",
  "vim/scripts/install-windows.ps1",
];

for (const rel of INSTALLERS) {
  test(`${rel} delegates default model picking to pick-models`, () => {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(
      /pick-models\.(sh|ps1)/.test(src),
      `${rel} should reference pick-models.{sh,ps1}`
    );
    // The user's env CHAT_MODEL must still win over the auto-pick.
    assert.ok(
      /CHAT_MODEL/.test(src),
      `${rel} must still honour an explicit CHAT_MODEL`
    );
  });
}
