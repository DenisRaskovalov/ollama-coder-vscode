// Negative tests for the agent loop. The production loop must keep its
// contract (history append, terminate cleanly, surface errors) even
// when its dependencies misbehave.

const test = require("node:test");
const assert = require("node:assert/strict");

const { runAgentLoop } = require("../out/agentLoop.js");

function baseOpts(messages) {
  return {
    endpoint: "x",
    model: "test-model",
    messages,
    tools: [],
    maxSteps: 5,
  };
}

test("executeTool throwing -> agent records an ERROR tool message and continues", async () => {
  let toolRound = 0;
  const chat = async () => {
    if (toolRound === 0) {
      toolRound = 1;
      return {
        content: "",
        tool_calls: [{ name: "read_file", arguments: { path: "x.py" } }],
      };
    }
    return { content: "done", tool_calls: [] };
  };
  const executeTool = async () => {
    throw new Error("simulated executor crash");
  };

  const result = await runAgentLoop(
    baseOpts([
      { role: "system", content: "agent" },
      { role: "user", content: "go" },
    ]),
    { chat, executeTool }
  );

  // Loop did NOT bubble up the throw \u2014 it converted it to a tool message
  // and gave the model a chance to recover.
  assert.equal(result.finishedCleanly, true);
  const toolMsg = result.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "expected a tool message in the history");
  assert.match(
    toolMsg.content,
    /ERROR: tool 'read_file' threw: simulated executor crash/
  );
});

test("chat rejecting (network error) -> the promise rejects (caller's job to catch)", async () => {
  // chatFull in production rejects on HTTP errors, and chatView catches
  // that in handleSend. The loop itself does NOT swallow chat rejections
  // \u2014 we don't want to silently treat a network outage as 'done'.
  const chat = async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:11434");
  };
  const executeTool = async () => "unreachable";

  await assert.rejects(
    runAgentLoop(
      baseOpts([
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ]),
      { chat, executeTool }
    ),
    /ECONNREFUSED/
  );
});

test("loop stops at maxSteps and fires onStoppedAtMaxSteps", async () => {
  // Adversarial model: never stops emitting tool_calls.
  const chat = async () => ({
    content: "still going",
    tool_calls: [{ name: "list_files", arguments: { path: "." } }],
  });
  const executeTool = async () => "Directory: .\nfile  a";
  let stoppedAt = -1;

  const result = await runAgentLoop(baseOpts([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]), {
    chat,
    executeTool,
    onStoppedAtMaxSteps: (n) => { stoppedAt = n; },
  });

  assert.equal(result.steps, 5);
  assert.equal(result.finishedCleanly, false);
  assert.equal(stoppedAt, 5);
});

test("maxSteps=0 means: don't even ask the model", async () => {
  // Bounded loop: callers can pass maxSteps=0 to short-circuit.
  let chatCalls = 0;
  const chat = async () => {
    chatCalls += 1;
    return { content: "shouldn't run", tool_calls: [] };
  };
  const result = await runAgentLoop(
    { ...baseOpts([
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ]), maxSteps: 0 },
    { chat, executeTool: async () => "" }
  );
  assert.equal(chatCalls, 0);
  assert.equal(result.finishedCleanly, false);
});

test("loop preserves history even when interrupted by maxSteps", async () => {
  let n = 0;
  const chat = async () => {
    n += 1;
    return {
      content: `step ${n}`,
      tool_calls: [{ name: "list_files", arguments: { path: "." } }],
    };
  };
  const result = await runAgentLoop(
    { ...baseOpts([
        { role: "system", content: "s" },
        { role: "user", content: "u" },
      ]), maxSteps: 3 },
    { chat, executeTool: async () => "ok" }
  );

  // After 3 rounds: 3 assistant messages + 3 tool messages + 2 starting msgs.
  const roles = result.messages.map((m) => m.role);
  assert.equal(roles.filter((r) => r === "assistant").length, 3);
  assert.equal(roles.filter((r) => r === "tool").length, 3);
  // Original user + system survived.
  assert.equal(roles[0], "system");
  assert.equal(roles[1], "user");
});
