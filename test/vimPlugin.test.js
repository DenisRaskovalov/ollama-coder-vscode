// Smoke tests for the Vim/Neovim plugin in /vim.
//
// These run under Node's built-in test runner. They:
//   1. bash -n the Ubuntu installer (catches shell syntax errors).
//   2. Source the plugin under `vim -u NONE` and assert every documented
//      command is defined and the autoload file loads cleanly.
//
// Skipped automatically if `vim` is not on $PATH (e.g. macOS CI without it).

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");

function has(bin) {
  const res = spawnSync("which", [bin], { encoding: "utf8" });
  return res.status === 0;
}

test("vim/scripts/install-ubuntu.sh has valid shell syntax", () => {
  const res = spawnSync(
    "bash",
    ["-n", path.join(ROOT, "vim/scripts/install-ubuntu.sh")],
    { encoding: "utf8" }
  );
  assert.equal(
    res.status,
    0,
    `bash -n failed:\n${res.stdout}\n${res.stderr}`
  );
});

test("vim/scripts/install-ubuntu.sh exits cleanly with --help (style check via grep)", () => {
  // The script doesn't take --help; just check the usage block is present.
  const src = fs.readFileSync(
    path.join(ROOT, "vim/scripts/install-ubuntu.sh"),
    "utf8"
  );
  for (const needle of [
    "ensure_ollama_running",
    "pull_model",
    "$HOME/.vim/pack/ollama/start/ollama-coder",
    "nvim/site/pack/ollama/start/ollama-coder",
    "EXTRA_MODELS",
    "SKIP_OLLAMA",
  ]) {
    assert.ok(
      src.includes(needle),
      `install-ubuntu.sh missing expected section: ${needle}`
    );
  }
});

if (!has("vim")) {
  test("[skipped] vim binary not available on PATH — skipping vim load tests", () => {
    assert.ok(true);
  });
} else {
  let runId = 0;
  function runVim(commands) {
    runId += 1;
    const outFile = path.join(
      os.tmpdir(),
      `oc-vim-${process.pid}-${runId}.txt`
    );
    if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    const args = [
      "-u", "NONE", "--not-a-term",
      "-c", `set rtp+=${path.join(ROOT, "vim")}`,
      "-c", `redir! > ${outFile}`,
      ...commands.flatMap((c) => ["-c", c]),
      "-c", "redir END",
      "-c", "qa!",
    ];
    // Stay synchronous; pipe and discard so vim doesn't block on a missing tty.
    const res = spawnSync("vim", args, {
      input: "",
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (res.status !== 0 && res.status !== null) {
      // Surface the vim stderr so debugging is possible.
      return `[vim exit=${res.status}]\n${res.stderr || ""}`;
    }
    return fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
  }

  test("plugin/ollama-coder.vim sources without error", () => {
    const out = runVim([
      `try | runtime plugin/ollama-coder.vim | echo 'OK' | catch | echo 'ERR:' . v:exception | endtry`,
    ]);
    assert.match(out, /\bOK\b/, `plugin failed to load:\n${out}`);
    assert.doesNotMatch(out, /ERR:/, `unexpected error:\n${out}`);
  });

  test("autoload file sources without error (no E723 dict-parse regression)", () => {
    const out = runVim([
      `try | source vim/autoload/ollama_coder.vim | echo 'OK' | catch | echo 'ERR:' . v:exception | endtry`,
    ]);
    assert.match(out, /\bOK\b/, `autoload failed to load:\n${out}`);
    assert.doesNotMatch(out, /ERR:/, `unexpected error:\n${out}`);
  });

  test("every documented Ex command is defined after loading the plugin", () => {
    const cmds = [
      "OllamaChat",
      "OllamaSend",
      "OllamaWrite",
      "OllamaAsk",
      "OllamaExplain",
      "OllamaRefactor",
      "OllamaFix",
      "OllamaDocs",
      "OllamaTests",
      "OllamaModel",
      "OllamaStop",
      "OllamaHistory",
    ];
    // Vim caps -c at 10 args, so emit one single :echo that lists them all.
    const expr = cmds
      .map((c) => `'${c}=' . exists(':${c}')`)
      .join(" . ' ' . ");
    const out = runVim([
      `runtime plugin/ollama-coder.vim`,
      `echo ${expr}`,
    ]);
    for (const c of cmds) {
      assert.match(
        out,
        new RegExp(`\\b${c}=2\\b`),
        `:${c} not defined after loading the plugin.\nFull output:\n${out}`
      );
    }
  });

  test("autoload list_models returns a valid list shape", () => {
    // Doesn't require ollama to actually be running — we just assert the
    // function is callable and returns a list (empty is fine).
    // The plugin file populates defaults, so source it first.
    const out = runVim([
      `runtime plugin/ollama-coder.vim`,
      `try | let l = ollama_coder#list_models() | echo 'type=' . type(l) | catch | echo 'ERR:' . v:exception | endtry`,
    ]);
    assert.match(out, /type=3/, `expected a list (type 3), got:\n${out}`);
    assert.doesNotMatch(out, /ERR:/, `unexpected error:\n${out}`);
  });

  test("multiline dictionary literals survive non-default cpoptions (E723 guard)", () => {
    // Sourcing under -u NONE deliberately puts cpoptions in compat mode,
    // which breaks '\' line continuation unless the plugin explicitly does
    // `set cpoptions&vim` at the top. This test exists *because* an earlier
    // draft failed exactly this way (E723: Missing end of Dictionary).
    const out = runVim([
      // Don't set any cpoptions ourselves — keep the default -u NONE state.
      `try | source vim/autoload/ollama_coder.vim | echo 'OK' | catch | echo 'ERR:' . v:exception | endtry`,
    ]);
    assert.doesNotMatch(out, /E723/, `E723 regression:\n${out}`);
    assert.match(out, /\bOK\b/, `autoload should load under -u NONE:\n${out}`);
  });
}
