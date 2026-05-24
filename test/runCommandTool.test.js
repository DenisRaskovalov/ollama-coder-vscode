// Tests for the run_command tool. We don't spawn real shells here \u2014 the
// VS Code stub doesn't even let us hit the confirm dialog \u2014 we verify the
// tool is registered with the right schema, has the right safety guards
// in source, and is off by default.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return require.resolve("./_vscode_stub.js");
  return origResolve.call(this, request, parent, ...rest);
};

const toolsPath = path.resolve(__dirname, "..", "out", "tools.js");
const tools = require(toolsPath);

test("run_command is registered in TOOL_SCHEMAS", () => {
  const names = tools.TOOL_SCHEMAS.map((s) => s.function.name);
  assert.ok(
    names.includes("run_command"),
    `TOOL_SCHEMAS missing run_command; have: ${names.join(", ")}`
  );
});

test("run_command schema requires 'command' and allows optional 'cwd'", () => {
  const schema = tools.TOOL_SCHEMAS.find(
    (s) => s.function.name === "run_command"
  );
  assert.ok(schema, "schema not found");
  assert.deepEqual(schema.function.parameters.required, ["command"]);
  assert.ok(schema.function.parameters.properties.command);
  assert.ok(schema.function.parameters.properties.cwd);
});

test("run_command is disabled by default at the package.json level", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  );
  const cfg = pkg.contributes.configuration.properties;
  assert.equal(
    cfg["ollamaCoder.enableRunCommand"].default,
    false,
    "enableRunCommand MUST default to false; this is the principal safety knob"
  );
});

test("run_command source has the four required safety guards", () => {
  const src = fs.readFileSync(toolsPath, "utf8");

  // Guard 1: feature flag check.
  assert.ok(
    /enableRunCommand/.test(src),
    "run_command must consult the enableRunCommand setting"
  );
  // Guard 2: cwd resolution must go through resolveInsideWorkspace.
  assert.ok(
    /resolveInsideWorkspace\(\s*cwdRel\s*\)/.test(src),
    "run_command must resolve cwd via resolveInsideWorkspace (sandbox)"
  );
  // Guard 3: modal confirm dialog.
  assert.ok(
    /showWarningMessage\([\s\S]*modal:\s*true/.test(src),
    "run_command must show a modal confirm dialog"
  );
  // Guard 4: per-process timeout that kills the child.
  assert.ok(
    /SIGKILL/.test(src) && /runCommandTimeoutMs/.test(src),
    "run_command must enforce runCommandTimeoutMs via SIGKILL"
  );
});

test("executeTool surfaces the disabled-flag message when the toggle is off", async () => {
  // The vscode stub returns the default for any getConfiguration().get(),
  // which means enableRunCommand reads as 'false' by default. We expect
  // the user-facing ERROR string, not a thrown exception or shell invocation.
  const out = await tools.executeTool({
    name: "run_command",
    arguments: { command: "echo hi" },
  });
  assert.match(
    out,
    /ERROR: run_command is disabled by default/,
    `expected disabled-flag error, got: ${out}`
  );
});

test("executeTool rejects empty command even with the flag on", async () => {
  // Patch the vscode stub so enableRunCommand reports true, then send an
  // empty command. We expect the validation ERROR, not a shell.
  const stub = require("./_vscode_stub.js");
  const origGetConfig = stub.workspace.getConfiguration;
  stub.workspace.getConfiguration = () => ({
    get: (k, d) => (k === "enableRunCommand" ? true : d),
    update: async () => {},
  });
  try {
    const out = await tools.executeTool({
      name: "run_command",
      arguments: { command: "   " },
    });
    assert.match(out, /run_command: 'command' is required/);
  } finally {
    stub.workspace.getConfiguration = origGetConfig;
  }
});
