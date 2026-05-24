import * as http from "http";
import * as https from "https";
import { URL } from "url";

export interface GenerateOptions {
  endpoint: string;
  model: string;
  prompt: string;
  suffix?: string;       // for FIM-style completion
  system?: string;
  temperature?: number;
  numPredict?: number;
  stop?: string[];
  signal?: AbortSignal;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Only for role='tool': name of the tool whose result this is. */
  tool_name?: string;
  /** Only for role='assistant': tool calls returned by the model. */
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, any> };
  }>;
}

export interface ChatOptions {
  endpoint: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  numPredict?: number;
  /** Tool/function-calling schemas. When provided, the response is non-streaming. */
  tools?: any[];
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  tool_calls: Array<{ name: string; arguments: Record<string, any> }>;
}

function request(
  url: URL,
  body: unknown,
  signal: AbortSignal | undefined,
  onChunk: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          let err = "";
          res.on("data", (d) => (err += d));
          res.on("end", () => {
            const status = res.statusCode!;
            let msg = err.trim();
            // Ollama returns JSON like {"error":"model 'foo' not found, try pulling it first"}
            try {
              const j = JSON.parse(msg);
              if (j && typeof j.error === "string") msg = j.error;
            } catch {
              /* keep raw body */
            }
            if (status === 404 && /model/i.test(msg)) {
              // Try to extract the model name from the request body for a clearer hint.
              let modelName = "";
              try {
                modelName = (body as any)?.model ?? "";
              } catch {
                /* ignore */
              }
              const hint = modelName
                ? `Model "${modelName}" is not installed. Run:  ollama pull ${modelName}`
                : `Model not installed. Pull it with 'ollama pull <model>'.`;
              reject(new Error(`${hint}  (Ollama said: ${msg})`));
            } else {
              reject(new Error(`Ollama HTTP ${status}: ${msg}`));
            }
          });
          return;
        }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line) onChunk(line);
          }
        });
        res.on("end", () => {
          const tail = buf.trim();
          if (tail) onChunk(tail);
          resolve();
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error("aborted"));
      } else {
        signal.addEventListener("abort", () => req.destroy(new Error("aborted")));
      }
    }
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** Streaming /api/generate. Calls onToken for each token; resolves to the full text. */
export async function generate(
  opts: GenerateOptions,
  onToken?: (t: string) => void
): Promise<string> {
  const url = new URL("/api/generate", opts.endpoint);
  const body: any = {
    model: opts.model,
    prompt: opts.prompt,
    stream: true,
    options: {
      temperature: opts.temperature ?? 0.2,
      num_predict: opts.numPredict ?? 256,
      stop: opts.stop,
    },
  };
  if (opts.suffix !== undefined) body.suffix = opts.suffix;
  if (opts.system) body.system = opts.system;

  let out = "";
  await request(url, body, opts.signal, (line) => {
    try {
      const j = JSON.parse(line);
      const tok: string = j.response ?? "";
      if (tok) {
        out += tok;
        onToken?.(tok);
      }
    } catch {
      /* ignore */
    }
  });
  return out;
}

/**
 * /api/chat. Streams when `tools` is not set; otherwise runs non-streaming so we
 * can capture any `tool_calls` from the final assistant message in one shot.
 */
export async function chat(
  opts: ChatOptions,
  onToken?: (t: string) => void
): Promise<string> {
  const r = await chatFull(opts, onToken);
  return r.content;
}

export async function chatFull(
  opts: ChatOptions,
  onToken?: (t: string) => void
): Promise<ChatResult> {
  const url = new URL("/api/chat", opts.endpoint);
  const useTools = !!(opts.tools && opts.tools.length);
  const body: any = {
    model: opts.model,
    // Convert our wire-friendly ChatMessage[] to Ollama's expected shape.
    messages: opts.messages.map((m) => {
      const o: any = { role: m.role === "tool" ? "tool" : m.role, content: m.content };
      if (m.tool_calls) o.tool_calls = m.tool_calls;
      if (m.tool_name) o.name = m.tool_name;
      return o;
    }),
    stream: !useTools,
    options: {
      temperature: opts.temperature ?? 0.3,
      num_predict: opts.numPredict ?? 1024,
    },
  };
  if (useTools) body.tools = opts.tools;

  let out = "";
  let toolCalls: Array<{ name: string; arguments: Record<string, any> }> = [];

  await request(url, body, opts.signal, (line) => {
    try {
      const j = JSON.parse(line);
      const msg = j.message ?? {};
      const tok: string = msg.content ?? "";
      if (tok) {
        out += tok;
        onToken?.(tok);
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function ?? {};
          let args = fn.arguments ?? {};
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              args = {};
            }
          }
          toolCalls.push({ name: fn.name, arguments: args });
        }
      }
    } catch {
      /* ignore */
    }
  });
  return { content: out, tool_calls: toolCalls };
}

/**
 * Parse the JSON body of GET /api/tags into a sorted, deduped list of model
 * names. Tolerates several response shapes Ollama has shipped over time:
 *   { models: [{ name: "llama3.1:8b", ... }, ...] }     // original
 *   { models: [{ model: "llama3.1:8b", ... }, ...] }    // newer (some builds)
 *   { models: [{ name: ..., model: ... }, ...] }        // both fields
 *   { models: ["llama3.1:8b", ...] }                    // bare strings
 * Entries missing both 'name' and 'model' are dropped instead of silently
 * becoming empty options in the dropdown.
 */
export function parseTagsResponse(body: unknown): string[] {
  const obj = (body ?? {}) as any;
  const arr: any[] = Array.isArray(obj.models)
    ? obj.models
    : Array.isArray(obj)
    ? obj
    : [];
  const names: string[] = [];
  for (const m of arr) {
    let n: unknown;
    if (typeof m === "string") n = m;
    else if (m && typeof m === "object") n = (m as any).name ?? (m as any).model;
    if (typeof n === "string" && n.length > 0) names.push(n);
  }
  // dedup preserving first-seen order, then sort alphabetically for stable UI.
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const n of names) if (!seen.has(n)) { seen.add(n); uniq.push(n); }
  uniq.sort((a, b) => a.localeCompare(b));
  return uniq;
}

export async function listModels(endpoint: string): Promise<string[]> {
  const url = new URL("/api/tags", endpoint);
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    // Use http.request rather than http.get so we can set headers and a
    // generous read timeout: Ollama hosts with many models return larger
    // response bodies, and silent socket timeouts on slower machines were
    // causing partial / dropped responses ("only a few models in the
    // dropdown" while 'ollama list' showed many more).
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: { Accept: "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer | string) =>
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        );
        res.on("end", () => {
          const buf = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 400) {
            reject(
              new Error(
                `Ollama /api/tags HTTP ${status}: ${buf.slice(0, 300)}`
              )
            );
            return;
          }
          try {
            const j = JSON.parse(buf);
            resolve(parseTagsResponse(j));
          } catch (e: any) {
            reject(
              new Error(
                `Failed to parse /api/tags response (${buf.length} bytes): ${e?.message ?? e}`
              )
            );
          }
        });
        res.on("error", reject);
      }
    );
    req.setTimeout(15000, () => {
      req.destroy(new Error("/api/tags timed out after 15s"));
    });
    req.on("error", reject);
    req.end();
  });
}
