// End-to-end re-run test for scripts/publish-ubuntu.sh.
//
// Reproduces the exact bug the user reported: "If I ran publish-ubuntu.sh
// two times, it fails." We invoke the script twice (dry run, no publish)
// and assert both invocations exit 0.
//
// Stubs `npm` and `npx` on PATH so the test doesn't actually:
//   - hit the network,
//   - call vsce / ovsx,
//   - mutate node_modules.
// We do, however, perform a real `npm install`-like mutation of
// `package-lock.json` inside the stub \u2014 that's the very mutation that
// caused the original re-run failure, and the regression test must
// reproduce it for the assertion to be meaningful.

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");

function setupWorkspace() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "oc-publish-rerun-"));
  // Copy the bits the script touches. We don't need the whole repo.
  for (const f of [
    "package.json",
    "package-lock.json",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    ".vscodeignore",
    ".gitignore",
    "tsconfig.json",
  ]) {
    fs.copyFileSync(path.join(ROOT, f), path.join(work, f));
  }
  for (const d of ["src", "media", "scripts", "out"]) {
    const from = path.join(ROOT, d);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(work, d), { recursive: true });
  }

  // Initialise a tiny git repo so the dirty-tree / branch checks pass.
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: work });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
                    "add", "."], { cwd: work });
  spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t",
                    "commit", "-q", "-m", "fixture"], { cwd: work });

  // Stub bin dir prepended to PATH. Lives OUTSIDE the work tree so it
  // doesn't show up as an untracked directory in 'git status' (which
  // would itself trip the dirty-tree check we're trying to test).
  const stubBin = fs.mkdtempSync(path.join(os.tmpdir(), "oc-stub-bin-"));

  // Stub `npm`. We need three subcommands:
  //   npm install ...    -> mutate package-lock.json (mimics real npm)
  //   npm test           -> exit 0
  //   anything else      -> exit 0
  fs.writeFileSync(path.join(stubBin, "npm"), `#!/usr/bin/env bash
case "$1" in
  install)
    # Mimic real npm install touching the lockfile, which is exactly what
    # broke the original second-run case.
    if [ -f package-lock.json ]; then
      # Append a comment-like field that doesn't affect JSON validity for
      # our purposes \u2014 we only care that the file's bytes change.
      # We just append a trailing newline; git will see it as modified.
      printf '\\n' >> package-lock.json
    fi
    ;;
  test) ;;
  *) ;;
esac
exit 0
`, { mode: 0o755 });

  // Stub `npx`. The script calls 'npx --yes @vscode/vsce package -o X'
  // and 'npx --yes @vscode/vsce ls'. Both must succeed; for 'package' we
  // create a dummy .vsix file, and for 'ls' we print the file list the
  // verify-contents step expects to see.
  fs.writeFileSync(path.join(stubBin, "npx"), `#!/usr/bin/env bash
# Skip --yes
while [ "$1" = "--yes" ]; do shift; done
# Skip the @vscode/vsce or ovsx package token
shift || true
case "$1" in
  package)
    shift
    OUT=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "-o" ]; then OUT="$2"; shift 2; else shift; fi
    done
    printf 'fake vsix' > "\${OUT:-out.vsix}"
    ;;
  ls)
    # Print exactly the listing the verify step requires.
    cat <<EOF
package.json
README.md
CHANGELOG.md
LICENSE
media/icon.png
out/extension.js
EOF
    ;;
  publish|--packagePath) exit 0;;
  *) exit 0;;
esac
exit 0
`, { mode: 0o755 });

  // Stub `node` is not needed \u2014 real node works.
  // Stub vsce just in case.
  fs.writeFileSync(path.join(stubBin, "vsce"), `#!/usr/bin/env bash
exit 0
`, { mode: 0o755 });

  return { work, stubBin };
}

function runScript(work, stubBin) {
  const env = {
    ...process.env,
    PATH: `${stubBin}:${process.env.PATH}`,
  };
  // IMPORTANT: invoke the *fixture's* copy of the script. The script
  // cd's to its own parent's parent (ROOT_DIR), so passing the real
  // repo's path would silently operate on the live repo instead of
  // the test fixture.
  return spawnSync(
    "bash",
    [path.join(work, "scripts/publish-ubuntu.sh")],
    { cwd: work, env, encoding: "utf8" }
  );
}

test("publish-ubuntu.sh succeeds on FIRST run (baseline)", () => {
  const { work, stubBin } = setupWorkspace();
  const r = runScript(work, stubBin);
  assert.equal(
    r.status,
    0,
    `1st run failed:\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`
  );
});

test("publish-ubuntu.sh succeeds when run TWICE in a row (regression)", () => {
  const { work, stubBin } = setupWorkspace();
  const r1 = runScript(work, stubBin);
  assert.equal(
    r1.status,
    0,
    `1st run failed:\nSTDOUT:\n${r1.stdout}\nSTDERR:\n${r1.stderr}`
  );
  const r2 = runScript(work, stubBin);
  assert.equal(
    r2.status,
    0,
    `2nd run failed (the exact bug):\nSTDOUT:\n${r2.stdout}\nSTDERR:\n${r2.stderr}`
  );
  // The git tree should also be clean after both runs so a *third* run
  // would also succeed.
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: work,
    encoding: "utf8",
  }).stdout.trim();
  assert.equal(
    status,
    "",
    `git tree is dirty after re-run; would block 3rd run:\n${status}`
  );
});

test("npm install lockfile churn is reverted, not committed", () => {
  // Direct unit-style check on the script: it must call 'git checkout --'
  // on package-lock.json after npm install when the diff is metadata-only.
  const src = fs.readFileSync(
    path.join(ROOT, "scripts/publish-ubuntu.sh"),
    "utf8"
  );
  assert.ok(
    /_LOCKFILE_HASH_BEFORE/.test(src),
    "publish-ubuntu.sh must snapshot the lockfile hash before npm install"
  );
  assert.ok(
    /git checkout -- package-lock\.json/.test(src),
    "publish-ubuntu.sh must revert lockfile metadata churn"
  );
});

test("publish step tolerates 'already exists' marketplace responses", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "scripts/publish-ubuntu.sh"),
    "utf8"
  );
  assert.ok(
    /already exists|cannot publish the same version|already published/.test(
      src
    ),
    "publish step must handle the marketplace 'already published' error"
  );
});

test("tag step pushes even when the local tag already exists", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "scripts/publish-ubuntu.sh"),
    "utf8"
  );
  // The fix moved the 'git push origin v$VERSION' line OUT of the
  // 'if tag-does-not-exist' branch so that re-runs still try to push
  // a previously-created local tag.
  const tagBlock = src.slice(src.indexOf("Step 8/8"));
  assert.ok(
    /git push origin "v\$VERSION"/.test(tagBlock),
    "tag-push must happen even when the tag already exists locally"
  );
});
