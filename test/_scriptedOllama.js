// Test helper: a scripted `chat` function for runAgentLoop.
//
// Each script entry is { content?, tool_calls?: [{name, arguments}] }.
// The factory returns a chat function that serves entries in order; if
// the agent calls chat more times than the script provides, the last
// entry is reused (typically `{content: "", tool_calls: []}` so the
// loop terminates).

function scriptedChat(script) {
  if (!Array.isArray(script) || script.length === 0) {
    throw new Error("scriptedChat: script must be a non-empty array");
  }
  let i = 0;
  const calls = []; // recorded for assertions

  const fn = async function chat(opts) {
    calls.push({ messages: opts.messages.slice(), tools: opts.tools });
    const entry = script[Math.min(i, script.length - 1)];
    i += 1;
    return {
      content: entry.content ?? "",
      tool_calls: (entry.tool_calls ?? []).map((tc) => ({
        name: tc.name,
        arguments: tc.arguments,
      })),
    };
  };
  fn.calls = calls;
  fn.scriptedRoundsConsumed = () => i;
  return fn;
}

module.exports = { scriptedChat };
