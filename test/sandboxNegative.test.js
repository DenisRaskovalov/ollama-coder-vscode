// Sandbox-escape negative tests.
//
// Every workspace tool MUST reject paths that try to escape the workspace
// root. This file pins those rejections. Driven through the same test
// executor the E2E scenarios use \u2014 if a real escape ever slips
// through there, it would slip through these.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { makeExecutor } = require("./_fsToolExecutor.js");

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-sbx-"));
}

// ----- read_file -----

test("read_file rejects parent traversal '..'", async () => {
  const root = mkTempDir();
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "read_file",
    arguments: { path: "../etc/passwd" },
  });
  assert.match(out, /ERROR/, `expected ERROR, got: ${out}`);
  assert.match(out, /\.\./, `error message should mention the offending '..'`);
});

test("read_file rejects deeply nested '..' traversal", async () => {
  const root = mkTempDir();
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "read_file",
    arguments: { path: "sub/../../escape.txt" },
  });
  assert.match(out, /ERROR/, `expected ERROR, got: ${out}`);
});

test("read_file rejects an empty path", async () => {
  const root = mkTempDir();
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "read_file",
    arguments: { path: "" },
  });
  assert.match(out, /ERROR/);
});

test("read_file with leading-slash path is coerced to inside-workspace (never escapes)", async () => {
  // Design choice (see resolveInsideWorkspace): leading '/' is stripped
  // and the path is treated as workspace-relative. The invariant we DO
  // guarantee is 'never read outside the workspace root', which we check
  // by verifying the system file is not what we got back.
  const root = mkTempDir();
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "read_file",
    arguments: { path: "/etc/hosts" },
  });
  // It's a "not found" string (the workspace doesn't have etc/hosts),
  // NOT the contents of the real /etc/hosts.
  assert.match(out, /File not found/);
  assert.doesNotMatch(
    out,
    /localhost|127\.0\.0\.1/,
    "must not have read the real /etc/hosts"
  );
});

test("read_file with a workspace-relative path returns the file contents", async () => {
  const root = mkTempDir();
  fs.writeFileSync(path.join(root, "inner.txt"), "hi\n");
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "read_file",
    arguments: { path: "inner.txt" },
  });
  assert.doesNotMatch(out, /^ERROR/, `unexpected error: ${out}`);
  assert.match(out, /hi/);
});

// ----- write_file -----

test("write_file rejects '..' traversal", async () => {
  const root = mkTempDir();
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "write_file",
    arguments: { path: "../sneaky.txt", content: "evil" },
  });
  assert.match(out, /ERROR/);
  // And nothing was written outside the root.
  assert.equal(
    fs.existsSync(path.join(path.dirname(root), "sneaky.txt")),
    false,
    "write_file MUST NOT create files outside the workspace"
  );
});

test("write_file with leading-slash path is coerced inside the workspace (never escapes)", async () => {
  // Same containment invariant as the read_file test: leading '/' is
  // treated as workspace-relative, so the file is written *inside* the
  // workspace root, NEVER at the OS-absolute path the model named.
  const root = mkTempDir();
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "write_file",
    arguments: { path: "/tmp/escape-via-write.txt", content: "evil" },
  });
  // The tool reports success...
  assert.doesNotMatch(out, /^ERROR/);
  // ...but the file is INSIDE the workspace, not at /tmp.
  assert.equal(
    fs.existsSync("/tmp/escape-via-write.txt"),
    false,
    "MUST NOT write to the OS-absolute /tmp path"
  );
  // It lives at <root>/tmp/escape-via-write.txt (path coerced to relative).
  assert.equal(
    fs.readFileSync(path.join(root, "tmp/escape-via-write.txt"), "utf8"),
    "evil"
  );
});

test("write_file accepts and creates a path inside the workspace", async () => {
  const root = mkTempDir();
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "write_file",
    arguments: { path: "sub/dir/file.txt", content: "ok" },
  });
  assert.doesNotMatch(out, /^ERROR/, `unexpected error: ${out}`);
  assert.equal(
    fs.readFileSync(path.join(root, "sub/dir/file.txt"), "utf8"),
    "ok"
  );
});

// ----- edit_file -----

test("edit_file rejects '..' traversal in target path", async () => {
  const root = mkTempDir();
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "edit_file",
    arguments: { path: "../x.py", search: "", replace: "x" },
  });
  assert.match(out, /ERROR/);
});

test("edit_file with empty search on existing file rejects", async () => {
  const root = mkTempDir();
  fs.writeFileSync(path.join(root, "x.py"), "y = 1\n");
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "edit_file",
    arguments: { path: "x.py", search: "", replace: "y = 2\n" },
  });
  assert.match(out, /ERROR/);
  assert.match(out, /must not be empty/);
});

test("edit_file with non-empty search on missing file rejects", async () => {
  const root = mkTempDir();
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "edit_file",
    arguments: { path: "missing.py", search: "foo", replace: "bar" },
  });
  assert.match(out, /ERROR/);
  assert.match(out, /empty/);
});

// ----- list_files -----

test("list_files rejects '..' traversal", async () => {
  const root = mkTempDir();
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "list_files",
    arguments: { path: "../" },
  });
  assert.match(out, /ERROR/);
});

// ----- argument coercion (defence in depth) -----

test("read_file with null/undefined path falls through to ERROR (no crash)", async () => {
  const root = mkTempDir();
  const exec = makeExecutor(root);
  for (const args of [{}, { path: null }, { path: undefined }]) {
    const out = await exec.executeTool({ name: "read_file", arguments: args });
    assert.match(out, /ERROR/, `expected ERROR for args=${JSON.stringify(args)}`);
  }
});

test("unknown tool name returns ERROR (no thrown exception)", async () => {
  const root = mkTempDir();
  const exec = makeExecutor(root);
  const out = await exec.executeTool({
    name: "rm_rf_root",
    arguments: {},
  });
  assert.match(out, /ERROR/);
});
