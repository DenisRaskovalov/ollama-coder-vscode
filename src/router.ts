import { chatFull } from "./ollama";

/**
 * LLM-driven router. See ARCHITECTURE.md \u00a74.3.
 *
 * Replaces the regex classifiers in chatView.ts with a single call to a small
 * fast model that returns a structured plan. The router is intentionally not
 * allowed to *execute* anything \u2014 it only labels. The plugin still owns the
 * sandbox, the confirmation dialogs, and the tool wiring.
 *
 * The output is schema-validated before we act on it. If the model returns
 * invalid JSON or an unknown `kind`, callers fall back to the regex pipeline.
 */

export type RouteKind =
  | "chat"                 // plain chat answer, no side effects
  | "create_file"          // new file to disk; target_path required
  | "edit_file"            // modify an existing file; target_path required
  | "web_search_then_chat" // RAG: fetch web first, then chat
  | "explain_selection"    // analyse the current editor selection
  | "refactor_selection"   // rewrite the current selection in-place
  | "run_command";         // shell command via run_command tool

export interface RoutePlan {
  kind: RouteKind;
  /** Workspace-relative path. Required when kind is create_file or edit_file. */
  target_path?: string;
  /**
   * The user's prompt, optionally cleaned up by the router. Passed on to the
   * worker model instead of the raw text. Always non-empty.
   */
  rephrased: string;
  /** Free-form one-line reason. Shown in the chat as a notice. */
  reason?: string;
}

const VALID_KINDS: RouteKind[] = [
  "chat",
  "create_file",
  "edit_file",
  "web_search_then_chat",
  "explain_selection",
  "refactor_selection",
  "run_command",
];

export const ROUTER_SYSTEM_PROMPT =
  "You are a routing classifier for a local-only coding assistant.\n" +
  "Read the user's request and emit a JSON object describing what should happen.\n" +
  "\n" +
  "Output schema (strict):\n" +
  "  kind:        one of [chat, create_file, edit_file, web_search_then_chat,\n" +
  "                       explain_selection, refactor_selection, run_command]\n" +
  "  target_path: required ONLY when kind is create_file or edit_file. Otherwise omit.\n" +
  "  rephrased:   the cleaned-up user request that will be sent to the worker model.\n" +
  "  reason:      a one-sentence explanation, useful for the UI.\n" +
  "\n" +
  "Routing rules:\n" +
  "1. If the user wants to create a new file -> create_file. Pick a sensible\n" +
  "   workspace-relative path with the right extension. If they named one, use it.\n" +
  "2. If the user wants to modify an existing file -> edit_file.\n" +
  "3. If the user wants the answer shown in chat (show me / what is / explain /\n" +
  "   give me an example / etc.) -> chat. Even if they mention a filename.\n" +
  "4. If the user wants up-to-date web information (latest, recent, current,\n" +
  "   today's, search for, google, what's new in ...) -> web_search_then_chat.\n" +
  "5. If the user wants the active editor selection acted on (explain this,\n" +
  "   refactor this, fix this) -> explain_selection or refactor_selection.\n" +
  "6. If the user wants a shell command run -> run_command, with rephrased\n" +
  "   describing the goal. The plugin will translate that into an actual\n" +
  "   command later, via the run_command tool.\n" +
  "7. Otherwise -> chat.\n" +
  "\n" +
  "You MUST return valid JSON. Do not include code fences. Do not add commentary.";

export interface RouterOptions {
  endpoint: string;
  model: string;
  userText: string;
  hasSelection?: boolean;
  activeFile?: string;
  signal?: AbortSignal;
  /**
   * Used by tests / shadow mode: timeout after which we give up on the router
   * and let callers fall back to the regex pipeline. Default 8s.
   */
  timeoutMs?: number;
}

/**
 * Schema-validate a parsed JSON object as a RoutePlan. Strict: unknown
 * `kind` values or missing required fields all reject. Exported because the
 * test suite exercises it directly.
 */
export function isValidRoutePlan(x: unknown): x is RoutePlan {
  if (!x || typeof x !== "object") return false;
  const o = x as any;
  if (!VALID_KINDS.includes(o.kind)) return false;
  if (typeof o.rephrased !== "string" || !o.rephrased.trim()) return false;
  if (o.kind === "create_file" || o.kind === "edit_file") {
    if (typeof o.target_path !== "string" || !o.target_path.trim()) return false;
  } else if (o.target_path !== undefined && typeof o.target_path !== "string") {
    return false;
  }
  if (o.reason !== undefined && typeof o.reason !== "string") return false;
  return true;
}

/**
 * Normalise a parsed JSON blob into a RoutePlan or `null`. Strips unknown
 * fields, coerces minor shape mismatches (e.g. wrapping text in an `object`
 * key, missing `rephrased` -> fall back to the original prompt).
 */
export function coerceRoutePlan(
  raw: unknown,
  fallbackUserText: string
): RoutePlan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as any;

  // Some small models nest the answer under a wrapper key. Be forgiving.
  const candidate =
    typeof r.kind === "string"
      ? r
      : r.plan && typeof r.plan === "object"
      ? r.plan
      : r.route && typeof r.route === "object"
      ? r.route
      : r;

  const plan: RoutePlan = {
    kind: candidate.kind,
    rephrased:
      typeof candidate.rephrased === "string" && candidate.rephrased.trim()
        ? candidate.rephrased.trim()
        : fallbackUserText,
  };
  if (typeof candidate.target_path === "string" && candidate.target_path.trim()) {
    plan.target_path = candidate.target_path.trim();
  }
  if (typeof candidate.reason === "string") {
    plan.reason = candidate.reason;
  }
  return isValidRoutePlan(plan) ? plan : null;
}

/**
 * Ask the model to classify the user's intent. Returns null if the router
 * fails (bad JSON, unknown kind, timeout, network error). Callers MUST be
 * prepared to fall back \u2014 the router is advisory, not authoritative.
 */
export async function routeWithModel(
  opts: RouterOptions
): Promise<RoutePlan | null> {
  const userPrompt = JSON.stringify({
    user_text: opts.userText,
    has_selection: !!opts.hasSelection,
    active_file: opts.activeFile ?? null,
  });

  const timeoutMs = opts.timeoutMs ?? 8000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  // Compose abort: user signal OR our timeout.
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  try {
    const r = await chatFull({
      endpoint: opts.endpoint,
      model: opts.model,
      messages: [
        { role: "system", content: ROUTER_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      numPredict: 256,
      format: "json",
      signal: ctrl.signal,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.content);
    } catch {
      return null;
    }
    return coerceRoutePlan(parsed, opts.userText);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
