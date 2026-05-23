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
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  endpoint: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  numPredict?: number;
  signal?: AbortSignal;
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

/** Streaming /api/chat. */
export async function chat(
  opts: ChatOptions,
  onToken?: (t: string) => void
): Promise<string> {
  const url = new URL("/api/chat", opts.endpoint);
  const body = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    options: {
      temperature: opts.temperature ?? 0.3,
      num_predict: opts.numPredict ?? 1024,
    },
  };
  let out = "";
  await request(url, body, opts.signal, (line) => {
    try {
      const j = JSON.parse(line);
      const tok: string = j.message?.content ?? "";
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

export async function listModels(endpoint: string): Promise<string[]> {
  const url = new URL("/api/tags", endpoint);
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    lib
      .get(url, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(buf);
            resolve((j.models || []).map((m: any) => m.name).sort());
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}
