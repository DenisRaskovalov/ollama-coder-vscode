// Tests for the LLM router (src/router.ts). We exercise the pure logic
// (schema validation + coercion) without hitting Ollama, then verify that
// the router is wired into chatView via the documented settings.

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

const routerPath = path.resolve(__dirname, "..", "out", "router.js");
const chatViewPath = path.resolve(__dirname, "..", "out", "chatView.js");
if (!fs.existsSync(routerPath)) {
  throw new Error(`${routerPath} not found. Run 'npm run compile' first.`);
}
const {
  isValidRoutePlan,
  coerceRoutePlan,
  ROUTER_SYSTEM_PROMPT,
} = require(routerPath);

/* ----------------------------- isValidRoutePlan -------------------------- */

test("isValidRoutePlan accepts a minimal chat plan", () => {
  assert.equal(
    isValidRoutePlan({ kind: "chat", rephrased: "hi" }),
    true
  );
});

test("isValidRoutePlan accepts each valid kind", () => {
  const KINDS = [
    "chat",
    "web_search_then_chat",
    "explain_selection",
    "refactor_selection",
    "run_command",
  ];
  for (const k of KINDS) {
    assert.equal(
      isValidRoutePlan({ kind: k, rephrased: "x" }),
      true,
      `kind ${k} should validate`
    );
  }
});

test("isValidRoutePlan requires target_path for create_file/edit_file", () => {
  assert.equal(
    isValidRoutePlan({ kind: "create_file", rephrased: "x" }),
    false,
    "create_file without target_path must reject"
  );
  assert.equal(
    isValidRoutePlan({ kind: "create_file", rephrased: "x", target_path: "a.py" }),
    true
  );
  assert.equal(
    isValidRoutePlan({ kind: "edit_file", rephrased: "x", target_path: "" }),
    false,
    "edit_file with empty target_path must reject"
  );
});

test("isValidRoutePlan rejects unknown kinds", () => {
  assert.equal(
    isValidRoutePlan({ kind: "delete_everything", rephrased: "x" }),
    false
  );
});

test("isValidRoutePlan rejects malformed input", () => {
  assert.equal(isValidRoutePlan(null), false);
  assert.equal(isValidRoutePlan({}), false);
  assert.equal(isValidRoutePlan({ kind: "chat" }), false); // no rephrased
  assert.equal(
    isValidRoutePlan({ kind: "chat", rephrased: "   " }),
    false,
    "whitespace-only rephrased must reject"
  );
  assert.equal(
    isValidRoutePlan({ kind: "chat", rephrased: "ok", reason: 42 }),
    false
  );
});

/* ------------------------------ coerceRoutePlan -------------------------- */

test("coerceRoutePlan passes a clean plan through", () => {
  const plan = coerceRoutePlan(
    { kind: "chat", rephrased: "hello" },
    "fallback"
  );
  assert.deepEqual(plan, { kind: "chat", rephrased: "hello" });
});

test("coerceRoutePlan fills in rephrased from fallback when missing", () => {
  const plan = coerceRoutePlan(
    { kind: "chat" },
    "what is the capital of France"
  );
  assert.equal(plan?.rephrased, "what is the capital of France");
});

test("coerceRoutePlan unwraps {plan:...} and {route:...} wrappers", () => {
  const plan1 = coerceRoutePlan(
    { plan: { kind: "chat", rephrased: "x" } },
    "fallback"
  );
  assert.equal(plan1?.kind, "chat");
  const plan2 = coerceRoutePlan(
    { route: { kind: "chat", rephrased: "x" } },
    "fallback"
  );
  assert.equal(plan2?.kind, "chat");
});

test("coerceRoutePlan returns null for un-fixable input", () => {
  assert.equal(coerceRoutePlan({}, "f"), null);
  assert.equal(coerceRoutePlan({ kind: "nope" }, "f"), null);
  assert.equal(coerceRoutePlan(null, "f"), null);
  assert.equal(coerceRoutePlan("string", "f"), null);
});

test("coerceRoutePlan trims target_path and rejects whitespace-only", () => {
  const ok = coerceRoutePlan(
    { kind: "create_file", target_path: "  src/foo.ts ", rephrased: "x" },
    "f"
  );
  assert.equal(ok?.target_path, "src/foo.ts");
  const bad = coerceRoutePlan(
    { kind: "create_file", target_path: "   ", rephrased: "x" },
    "f"
  );
  assert.equal(bad, null, "create_file with whitespace path must fail");
});

/* --------------------------- router system prompt ------------------------ */

test("ROUTER_SYSTEM_PROMPT mentions every routing rule keyword", () => {
  // Required because the prompt is the model's whole spec. If someone
  // deletes one rule, behaviour silently drifts.
  for (const needle of [
    "create_file",
    "edit_file",
    "web_search_then_chat",
    "explain_selection",
    "refactor_selection",
    "run_command",
    "rephrased",
    "target_path",
  ]) {
    assert.ok(
      ROUTER_SYSTEM_PROMPT.includes(needle),
      `ROUTER_SYSTEM_PROMPT missing keyword: ${needle}`
    );
  }
});

/* ----------------------------- chatView wiring --------------------------- */

test("chatView reads useLlmRouter / shadowLlmRouter / routerModel settings", () => {
  const src = fs.readFileSync(chatViewPath, "utf8");
  for (const key of [
    "useLlmRouter",
    "shadowLlmRouter",
    "routerModel",
  ]) {
    assert.ok(
      src.includes(key),
      `chatView.js does not consult the ${key} setting`
    );
  }
  assert.ok(
    /routeWithModel\b/.test(src),
    "chatView must call routeWithModel"
  );
});

test("router is off by default in package.json", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
  );
  const cfg = pkg.contributes.configuration.properties;
  assert.equal(cfg["ollamaCoder.useLlmRouter"].default, false);
  assert.equal(cfg["ollamaCoder.shadowLlmRouter"].default, false);
  assert.equal(cfg["ollamaCoder.routerModel"].default, "");
});
