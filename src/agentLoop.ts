/**
 * Pure agent loop, decoupled from VS Code so it can be driven by E2E tests.
 *
 * Inputs: a `chat` function (typically `chatFull` from ollama.ts, or a
 * scripted mock in tests) and an `executeTool` function (typically the
 * one from tools.ts, or a workspace-agnostic test executor).
 *
 * The loop:
 *   - sends the conversation to `chat` with `tools`,
 *   - if the response has no tool_calls, returns,
 *   - otherwise executes each tool call, appends the result, and recurses,
 *   - terminates after `maxSteps` rounds.
 *
 * All UI side effects go through optional `on*` callbacks the caller
 * supplies. Sufficient for a webview chat panel in production and for a
 * silent in-memory runner in tests.
 */

import { ChatMessage, ChatResult, ChatOptions } from "./ollama";

export interface ToolCallShape {
  name: string;
  arguments: Record<string, any>;
}

export interface AgentLoopDeps {
  /**
   * Send one chat request. Caller is responsible for the streaming /
   * non-streaming choice; this loop only consumes the resolved
   * ChatResult.
   */
  chat: (opts: ChatOptions) => Promise<ChatResult>;

  /** Execute one tool call and return a string suitable to feed back. */
  executeTool: (call: ToolCallShape) => Promise<string>;

  onAssistantStart?: () => void;
  onAssistantToken?: (t: string) => void;
  onAssistantEnd?: () => void;
  onToolCall?: (name: string, args: Record<string, any>) => void;
  onToolResult?: (name: string, preview: string) => void;
  onStoppedAtMaxSteps?: (steps: number) => void;
}

export interface AgentLoopOptions {
  endpoint: string;
  model: string;
  /** Initial conversation. The loop appends to this; the caller can read it back. */
  messages: ChatMessage[];
  tools: any[];
  temperature?: number;
  numPredict?: number;
  maxSteps?: number;
  signal?: AbortSignal;
}

export interface AgentLoopResult {
  /** Mutated copy of the input messages, with all assistant + tool turns appended. */
  messages: ChatMessage[];
  /** Number of `chat` round-trips actually performed. */
  steps: number;
  /** True when the loop terminated because the model stopped emitting tool_calls. */
  finishedCleanly: boolean;
}

const DEFAULT_MAX_STEPS = 8;

export async function runAgentLoop(
  opts: AgentLoopOptions,
  deps: AgentLoopDeps
): Promise<AgentLoopResult> {
  const messages = opts.messages.slice();
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

  for (let step = 1; step <= maxSteps; step++) {
    deps.onAssistantStart?.();

    const r = await deps.chat({
      endpoint: opts.endpoint,
      model: opts.model,
      messages,
      tools: opts.tools,
      temperature: opts.temperature,
      numPredict: opts.numPredict,
      signal: opts.signal,
    });

    if (r.content) deps.onAssistantToken?.(r.content);

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: r.content,
    };
    if (r.tool_calls.length) {
      assistantMsg.tool_calls = r.tool_calls.map((tc) => ({
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    messages.push(assistantMsg);

    if (!r.tool_calls.length) {
      deps.onAssistantEnd?.();
      return { messages, steps: step, finishedCleanly: true };
    }

    for (const tc of r.tool_calls) {
      deps.onToolCall?.(tc.name, tc.arguments);
      const result = await deps.executeTool({
        name: tc.name,
        arguments: tc.arguments,
      });
      deps.onToolResult?.(tc.name, result.slice(0, 400));
      messages.push({
        role: "tool",
        tool_name: tc.name,
        content: result,
      });
    }
    deps.onAssistantEnd?.();
  }

  deps.onStoppedAtMaxSteps?.(maxSteps);
  return { messages, steps: maxSteps, finishedCleanly: false };
}
