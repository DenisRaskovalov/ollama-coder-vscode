/**
 * Compact repository map for the agent.
 *
 * Inspired by Aider's "repo map" feature: give the model a single page
 * listing every important file in the workspace plus the top-level
 * symbols each one declares (functions, classes, methods, etc.). This
 * lets a small local model navigate a real-world project without having
 * to `read_file` every plausible candidate. Cheap, fast, and surprisingly
 * effective for Pi-style multi-step work.
 *
 * Pure helpers — no `vscode` imports — so this file is fully unit-testable.
 * The tool wrapper (which actually walks the workspace) lives in tools.ts.
 */

export interface Symbol {
  /** A short label: "function foo", "class Bar", "def baz". */
  label: string;
  line: number; // 1-based
}

/**
 * Extract top-level symbols from a source file using simple per-language
 * regexes. Deliberately shallow: this is a navigation aid, not a parser.
 * We tag each symbol with the line number so the model can re-read the
 * surrounding lines with read_file if it needs more.
 */
export function extractSymbols(
  filename: string,
  source: string,
  maxPerFile = 30
): Symbol[] {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const lines = source.split(/\r?\n/);
  const out: Symbol[] = [];
  const push = (label: string, lineIdx: number) => {
    if (out.length >= maxPerFile) return;
    out.push({ label, line: lineIdx + 1 });
  };

  // Per-language patterns. Each entry: regex + label-builder.
  const PATTERNS: Record<string, Array<{ re: RegExp; label: (m: RegExpMatchArray) => string }>> = {
    ts: [
      { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,            label: (m) => `function ${m[1]}` },
      { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,                            label: (m) => `class ${m[1]}` },
      { re: /^\s*(?:export\s+)?(?:abstract\s+)?interface\s+([A-Za-z_$][\w$]*)/,        label: (m) => `interface ${m[1]}` },
      { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,                         label: (m) => `type ${m[1]}` },
      { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/,                             label: (m) => `enum ${m[1]}` },
      { re: /^\s*(?:public|private|protected|static)?\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/, label: (m) => `method ${m[1]}` },
    ],
    js: [],   // populated below as alias of ts
    tsx: [],
    jsx: [],
    py: [
      { re: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/,    label: (m) => `def ${m[1]}` },
      { re: /^\s*async\s+def\s+([A-Za-z_][\w]*)/, label: (m) => `async def ${m[1]}` },
      { re: /^\s*class\s+([A-Za-z_][\w]*)/,       label: (m) => `class ${m[1]}` },
    ],
    rb: [
      { re: /^\s*def\s+([A-Za-z_][\w?!=]*)/, label: (m) => `def ${m[1]}` },
      { re: /^\s*class\s+([A-Z][\w:]*)/,     label: (m) => `class ${m[1]}` },
      { re: /^\s*module\s+([A-Z][\w:]*)/,    label: (m) => `module ${m[1]}` },
    ],
    go: [
      { re: /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)/, label: (m) => `func ${m[1]}` },
      { re: /^\s*type\s+([A-Z][\w]*)\s+(struct|interface)/, label: (m) => `${m[2]} ${m[1]}` },
    ],
    rs: [
      { re: /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/,       label: (m) => `fn ${m[1]}` },
      { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/,   label: (m) => `struct ${m[1]}` },
      { re: /^\s*(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/,     label: (m) => `enum ${m[1]}` },
      { re: /^\s*(?:pub\s+)?trait\s+([A-Za-z_][\w]*)/,    label: (m) => `trait ${m[1]}` },
      { re: /^\s*impl(?:<[^>]+>)?\s+(?:[\w:<>,\s]+\s+for\s+)?([A-Za-z_][\w]*)/, label: (m) => `impl ${m[1]}` },
    ],
    java: [
      { re: /^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:abstract\s+)?class\s+([A-Z][\w]*)/, label: (m) => `class ${m[1]}` },
      { re: /^\s*(?:public|protected|private)?\s*interface\s+([A-Z][\w]*)/,                          label: (m) => `interface ${m[1]}` },
    ],
    cpp: [
      { re: /^\s*(?:[\w:<>,\s\*&]+\s+)?([A-Za-z_][\w]*)\s*\(.*\)\s*(?:const)?\s*\{/, label: (m) => `function ${m[1]}` },
      { re: /^\s*(?:class|struct)\s+([A-Z][\w]*)/,                                   label: (m) => `class ${m[1]}` },
    ],
    h: [], hpp: [], c: [], cc: [], cxx: [],
    sh: [
      { re: /^\s*([A-Za-z_][\w]*)\s*\(\)\s*\{/, label: (m) => `function ${m[1]}` },
      { re: /^\s*function\s+([A-Za-z_][\w]*)/,  label: (m) => `function ${m[1]}` },
    ],
    bash: [],
  };
  // Aliases share the TS rules.
  for (const a of ["js", "tsx", "jsx"]) PATTERNS[a] = PATTERNS.ts;
  // C-family share the C++ rules.
  for (const a of ["h", "hpp", "c", "cc", "cxx"]) PATTERNS[a] = PATTERNS.cpp;
  // bash shares sh rules.
  PATTERNS.bash = PATTERNS.sh;

  const pats = PATTERNS[ext];
  if (!pats || !pats.length) return out;

  for (let i = 0; i < lines.length; i++) {
    if (out.length >= maxPerFile) break;
    const line = lines[i];
    if (line.length > 400) continue; // skip absurdly long lines
    for (const { re, label } of pats) {
      const m = line.match(re);
      if (m) {
        push(label(m), i);
        break; // one symbol per line is enough
      }
    }
  }
  return out;
}

export interface RepoMapEntry {
  path: string; // workspace-relative
  symbols: Symbol[];
}

/**
 * Render a compact textual map suitable for stuffing into an LLM context.
 * Files are listed alphabetically with their symbols indented underneath.
 * The whole output is bounded by `maxBytes`.
 */
export function renderRepoMap(
  entries: RepoMapEntry[],
  maxBytes = 12 * 1024
): string {
  const sorted = entries.slice().sort((a, b) => a.path.localeCompare(b.path));
  const out: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const e of sorted) {
    const header = e.path;
    const lines = [header];
    for (const s of e.symbols) {
      lines.push(`  L${s.line}: ${s.label}`);
    }
    const block = lines.join("\n") + "\n";
    if (bytes + block.length > maxBytes) {
      truncated = true;
      break;
    }
    out.push(block);
    bytes += block.length;
  }
  let text = out.join("");
  if (truncated) {
    text +=
      "... [repo_map truncated; raise the limit or be more specific]\n";
  }
  return text || "(no source files matched)";
}
