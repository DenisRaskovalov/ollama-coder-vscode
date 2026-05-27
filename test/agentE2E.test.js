// End-to-end agent acceptance tests.
//
// Each test follows the pattern the user described:
//   1. Start with a directory (maybe empty).
//   2. Run a sequence of "commands" \u2014 here, one agent turn driven by a
//      scripted Ollama and a real fs-backed tool executor.
//   3. The produced directory must compile / run / verify with the user's
//      actual toolchain (python3, g++, make). If the toolchain isn't on
//      PATH the scenario is skipped, not failed.
//
// This is what closes the gap between "tools.ts unit tests" and "does the
// agent actually produce a working program?"

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { runAgentLoop } = require("../out/agentLoop.js");
const { scriptedChat } = require("./_scriptedOllama.js");
const { makeExecutor, runProcess, hasBinary } = require("./_fsToolExecutor.js");

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `oc-e2e-${prefix}-`));
}

function baseAgentOpts(messages) {
  return {
    endpoint: "http://localhost:11434",
    model: "test-model",
    messages,
    tools: [], // not used by scriptedChat; the test scripts the responses
    maxSteps: 5,
  };
}

/* ----------------------------------------------------------------------- */
/* Scenario 1: empty dir -> "write a Python script that prints 1..10"      */
/* ----------------------------------------------------------------------- */

test("E2E: empty dir -> python script that prints 1..10, then run it", async (t) => {
  if (!hasBinary("python3")) return t.skip("python3 not on PATH");

  const root = mkTempDir("py-counter");
  const exec = makeExecutor(root);
  const chat = scriptedChat([
    {
      // Turn 1: agent decides to write the script.
      tool_calls: [
        {
          name: "write_file",
          arguments: {
            path: "count.py",
            content:
              "for i in range(1, 11):\n    print(i)\n",
          },
        },
      ],
    },
    // Turn 2: model wraps up with a summary, no more tool calls.
    { content: "Created count.py. Run it with `python3 count.py`." },
  ]);

  const result = await runAgentLoop(
    baseAgentOpts([
      { role: "system", content: "you are the test agent" },
      { role: "user", content: "write a python script that prints 1 to 10" },
    ]),
    { chat, executeTool: exec.executeTool }
  );

  assert.equal(result.finishedCleanly, true);
  // 1. The file landed.
  const written = path.join(root, "count.py");
  assert.ok(fs.existsSync(written), "count.py must be written to disk");
  // 2. It actually runs and prints 1..10 on stdout.
  const run = await runProcess("python3", ["count.py"], { cwd: root });
  assert.equal(run.status, 0, `python3 exited ${run.status}: ${run.stderr}`);
  const lines = run.stdout.trim().split("\n");
  assert.deepEqual(
    lines,
    Array.from({ length: 10 }, (_, i) => String(i + 1)),
    `stdout did not match 1..10:\n${run.stdout}`
  );
  // 3. The executor recorded the write so we can audit it.
  assert.equal(exec.writes.length, 1);
  assert.equal(exec.writes[0].path, "count.py");
});

/* ----------------------------------------------------------------------- */
/* Scenario 2: empty dir -> multi-file C++ Hello World with a Makefile     */
/* ----------------------------------------------------------------------- */

test("E2E: empty dir -> C++ Hello World + Makefile, then make && ./hello", async (t) => {
  if (!hasBinary("g++")) return t.skip("g++ not on PATH");
  if (!hasBinary("make")) return t.skip("make not on PATH");

  const root = mkTempDir("cpp-hello");
  const exec = makeExecutor(root);
  const chat = scriptedChat([
    {
      tool_calls: [
        {
          name: "write_file",
          arguments: {
            path: "main.cpp",
            content:
              '#include <iostream>\n' +
              '#include "hello.h"\n' +
              'int main() { std::cout << greeting() << "\\n"; return 0; }\n',
          },
        },
      ],
    },
    {
      tool_calls: [
        {
          name: "write_file",
          arguments: {
            path: "hello.h",
            content:
              "#pragma once\n#include <string>\nstd::string greeting();\n",
          },
        },
      ],
    },
    {
      tool_calls: [
        {
          name: "write_file",
          arguments: {
            path: "hello.cpp",
            content:
              '#include "hello.h"\nstd::string greeting() { return "Hello, World!"; }\n',
          },
        },
      ],
    },
    {
      tool_calls: [
        {
          name: "write_file",
          arguments: {
            path: "Makefile",
            content:
              "hello: main.cpp hello.cpp hello.h\n" +
              "\tg++ -std=c++17 -O0 -o hello main.cpp hello.cpp\n",
          },
        },
      ],
    },
    { content: "Wrote main.cpp, hello.h, hello.cpp, Makefile." },
  ]);

  await runAgentLoop(
    baseAgentOpts([
      { role: "system", content: "you are the test agent" },
      {
        role: "user",
        content: "make a tiny C++ project with a header, an impl file, and a Makefile",
      },
    ]),
    { chat, executeTool: exec.executeTool }
  );

  for (const f of ["main.cpp", "hello.h", "hello.cpp", "Makefile"]) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} missing`);
  }

  const make = await runProcess("make", [], { cwd: root, timeoutMs: 30000 });
  assert.equal(make.status, 0, `make failed:\n${make.stdout}\n${make.stderr}`);
  assert.ok(fs.existsSync(path.join(root, "hello")), "binary missing");

  const run = await runProcess("./hello", [], { cwd: root });
  assert.equal(run.status, 0);
  assert.equal(run.stdout.trim(), "Hello, World!");
});

/* ----------------------------------------------------------------------- */
/* Scenario 3: pre-existing buggy file -> read_file -> edit_file -> verify */
/* ----------------------------------------------------------------------- */

test("E2E: fix off-by-one in existing Python file via read+edit", async (t) => {
  if (!hasBinary("python3")) return t.skip("python3 not on PATH");

  const root = mkTempDir("py-fix");
  // Start with a deliberately wrong implementation: prints 1..9 instead of 1..10.
  fs.writeFileSync(
    path.join(root, "buggy.py"),
    "for i in range(1, 10):\n    print(i)\n",
    "utf8"
  );

  const exec = makeExecutor(root);
  const chat = scriptedChat([
    // Turn 1: agent reads the file.
    { tool_calls: [{ name: "read_file", arguments: { path: "buggy.py" } }] },
    // Turn 2: agent emits a SEARCH/REPLACE patch that fixes the off-by-one.
    {
      tool_calls: [
        {
          name: "edit_file",
          arguments: {
            path: "buggy.py",
            search: "range(1, 10)",
            replace: "range(1, 11)",
          },
        },
      ],
    },
    { content: "Fixed the off-by-one." },
  ]);

  const result = await runAgentLoop(
    baseAgentOpts([
      { role: "system", content: "you are the test agent" },
      { role: "user", content: "fix the off-by-one in buggy.py so it prints 1..10" },
    ]),
    { chat, executeTool: exec.executeTool }
  );

  assert.equal(result.finishedCleanly, true);
  // Sanity: agent went read -> edit, not write_file rewrite.
  assert.deepEqual(exec.reads, ["buggy.py"]);
  assert.equal(exec.writes.length, 1);
  assert.equal(exec.writes[0].path, "buggy.py");

  const run = await runProcess("python3", ["buggy.py"], { cwd: root });
  assert.equal(run.status, 0);
  const lines = run.stdout.trim().split("\n");
  assert.deepEqual(
    lines,
    Array.from({ length: 10 }, (_, i) => String(i + 1)),
    `expected 1..10 after fix, got:\n${run.stdout}`
  );
});

/* ----------------------------------------------------------------------- */
/* Scenario 4: pre-existing repo -> agent uses repo_map to find a target   */
/* ----------------------------------------------------------------------- */

test("E2E: repo_map identifies the right file, then edit_file modifies it", async () => {
  const root = mkTempDir("py-repomap");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "calc.py"),
    "def add(a, b):\n    return a + b\n\ndef subtract(a, b):\n    return a - b\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "src", "io_utils.py"),
    "def load(path):\n    return open(path).read()\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n", "utf8");

  const exec = makeExecutor(root);
  const chat = scriptedChat([
    // Turn 1: agent surveys the project first.
    { tool_calls: [{ name: "repo_map", arguments: {} }] },
    // Turn 2: armed with the map, agent edits the right file.
    {
      tool_calls: [
        {
          name: "edit_file",
          arguments: {
            path: "src/calc.py",
            search: "def subtract(a, b):\n    return a - b",
            replace:
              "def subtract(a, b):\n    return a - b\n\ndef multiply(a, b):\n    return a * b",
          },
        },
      ],
    },
    { content: "Added multiply() to src/calc.py." },
  ]);

  const result = await runAgentLoop(
    baseAgentOpts([
      { role: "system", content: "you are the test agent" },
      { role: "user", content: "find the calculator module and add multiply()" },
    ]),
    { chat, executeTool: exec.executeTool }
  );

  assert.equal(result.finishedCleanly, true);
  // Audit the tool sequence: repo_map first, edit_file second \u2014 the
  // exact behaviour SYSTEM_AGENT now coaches.
  const toolNames = result.messages
    .filter((m) => m.role === "tool")
    .map((m) => m.tool_name);
  assert.deepEqual(toolNames, ["repo_map", "edit_file"]);

  const final = fs.readFileSync(path.join(root, "src", "calc.py"), "utf8");
  assert.match(final, /def multiply\(a, b\):\s*return a \* b/);
});

/* ----------------------------------------------------------------------- */
/* Scenario 5: agent failure recovery \u2014 edit_file rejects ambiguous match */
/* ----------------------------------------------------------------------- */

/* ----------------------------------------------------------------------- */
/* Scenario 6: 'Generate a solution of LeetCode problem 1000 in a new file' */
/* The user's exact prompt from the bug report. End state: a Python file    */
/* leetcode_1000.py exists on disk and is at least syntactically valid.     */
/* ----------------------------------------------------------------------- */

const { hasBinary: _hasBin, runProcess: _runProc } = require("./_fsToolExecutor.js");

test("E2E: 'Generate a solution of LeetCode problem 1000 in a new file on disk' -> writes leetcode_1000.py", async (t) => {
  const root = mkTempDir("leetcode");
  const exec = makeExecutor(root);

  // Script the agent the way a *cooperating* model would behave when it
  // gets our new problem-ref augmentation: search first, then write.
  const chat = scriptedChat([
    {
      tool_calls: [
        { name: "web_search", arguments: { query: "LeetCode 1000" } },
      ],
    },
    {
      tool_calls: [
        {
          name: "write_file",
          arguments: {
            path: "leetcode_1000.py",
            content:
              "def minimumCostToMergeStones(stones, k):\n" +
              "    n = len(stones)\n" +
              "    if (n - 1) % (k - 1) != 0:\n" +
              "        return -1\n" +
              "    # Solution body omitted in the test; what matters\n" +
              "    # is that the file is on disk and is valid Python.\n" +
              "    return 0\n",
          },
        },
      ],
    },
    { content: "Wrote leetcode_1000.py." },
  ]);

  const result = await runAgentLoop(
    baseAgentOpts([
      { role: "system", content: "agent prompt" },
      {
        role: "user",
        content:
          "Generate a solution of LeetCode problem 1000 in a new file on disk\n\n" +
          // The chatView would normally inject this; we simulate it so the
          // scripted model has the same context it would in production.
          "(Problem reference detected: LeetCode 1000. " +
          "If you don't remember the exact problem statement, call web_search with " +
          "`LeetCode 1000` and read the result before solving. " +
          "Save the solution to `leetcode_1000.py`. " +
          "Reference URL: https://leetcode.com/problemset/all/?search=1000 )",
      },
    ]),
    { chat, executeTool: exec.executeTool }
  );

  // 1. Agent went through the right tool sequence.
  const toolSeq = result.messages
    .filter((m) => m.role === "tool")
    .map((m) => m.tool_name);
  assert.deepEqual(toolSeq, ["web_search", "write_file"]);

  // 2. The file is on disk with the suggested name.
  const written = path.join(root, "leetcode_1000.py");
  assert.ok(
    fs.existsSync(written),
    "leetcode_1000.py must be created on disk"
  );

  // 3. The written content is at least valid Python (compile check) if
  //    python3 is available. Otherwise just assert non-empty contents.
  const body = fs.readFileSync(written, "utf8");
  assert.ok(body.length > 0, "file must be non-empty");
  if (_hasBin("python3")) {
    const r = await _runProc(
      "python3",
      ["-c", `import py_compile; py_compile.compile('${written}', doraise=True)`],
      { cwd: root }
    );
    assert.equal(
      r.status,
      0,
      `python3 -c py_compile failed: ${r.stderr}`
    );
  }
});

test("E2E: agent recovers when edit_file rejects an ambiguous SEARCH", async () => {
  const root = mkTempDir("py-retry");
  fs.writeFileSync(
    path.join(root, "x.py"),
    "x = 1\ny = 1\nz = 1\n", // three identical assignments
    "utf8"
  );

  const exec = makeExecutor(root);
  const chat = scriptedChat([
    // Turn 1: agent tries an ambiguous patch.
    {
      tool_calls: [
        {
          name: "edit_file",
          arguments: { path: "x.py", search: "= 1", replace: "= 2" },
        },
      ],
    },
    // Turn 2: agent re-tries with a unique snippet.
    {
      tool_calls: [
        {
          name: "edit_file",
          arguments: {
            path: "x.py",
            search: "y = 1",
            replace: "y = 2",
          },
        },
      ],
    },
    { content: "Done." },
  ]);

  const result = await runAgentLoop(
    baseAgentOpts([
      { role: "system", content: "you are the test agent" },
      { role: "user", content: "set y to 2 in x.py" },
    ]),
    { chat, executeTool: exec.executeTool }
  );

  // Tool log: first edit returned ERROR, second succeeded.
  const toolMessages = result.messages.filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 2);
  assert.match(
    toolMessages[0].content,
    /more than once/,
    "first edit must report ambiguous-match error"
  );
  assert.match(toolMessages[1].content, /^Edited /);

  const finalText = fs.readFileSync(path.join(root, "x.py"), "utf8");
  assert.equal(finalText, "x = 1\ny = 2\nz = 1\n");
});
