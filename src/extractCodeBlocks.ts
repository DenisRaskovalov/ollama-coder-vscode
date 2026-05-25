/**
 * Pure helpers used by the chat view's "fallback save" pass.
 *
 * Small local models sometimes ignore the agent's tool instructions and
 * just emit a code block in chat. When the user explicitly asked for a
 * NEW file, that's a regression in their workflow. We catch it: after
 * the agent loop returns, if no write-style tool fired but the response
 * has at least one fenced block, we propose to save the block to disk.
 *
 * Both functions are pure (no `vscode` imports) so they're directly
 * unit-testable. The chat view calls them and routes the result through
 * the existing `apply.saveToFile` confirm-and-write path.
 */

export interface CodeBlock {
  /** Language tag right after the opening fence, e.g. "ts", "python", "" */
  lang: string;
  /** Path hint after the language tag, e.g. "src/foo.ts". May be empty. */
  pathHint: string;
  /** Raw code content between the fences. */
  code: string;
}

/**
 * Extract every fenced code block from a chat-mode assistant response.
 * Recognises both ```lang and ```lang path/to/file forms.
 */
export function extractCodeBlocks(text: string): CodeBlock[] {
  const out: CodeBlock[] = [];
  if (!text) return out;
  // Match ```lang optional-path-and-rest-of-line \n CODE \n ```
  // The `lang` capture is restricted to a sane charset; `pathHint` is
  // whatever's left on the fence header line.
  const re = /```([a-zA-Z0-9_+\-]*)([^\n]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lang = (m[1] || "").trim();
    const headerTail = (m[2] || "").trim();
    out.push({
      lang,
      pathHint: headerTail,
      code: m[3].replace(/\s+$/, ""),
    });
  }
  return out;
}

/**
 * Guess a sensible default filename for a code block whose fence didn't
 * include a path. We use the language tag if available, otherwise scan
 * the body for cheap heuristics, otherwise fall back to a generic name.
 *
 * Conservative on purpose: the user will see and confirm the suggested
 * filename in an input box. We just want a useful first guess.
 */
export function guessFilenameForLang(
  lang: string,
  code: string,
  promptHint?: string
): string {
  const l = lang.toLowerCase();
  const LANG_TO_EXT: Record<string, string> = {
    ts: "ts", tsx: "tsx", typescript: "ts",
    js: "js", jsx: "jsx", javascript: "js", node: "js",
    py: "py", python: "py",
    rb: "rb", ruby: "rb",
    go: "go", golang: "go",
    rs: "rs", rust: "rs",
    java: "java", kt: "kt", kotlin: "kt", swift: "swift",
    cpp: "cpp", "c++": "cpp", cxx: "cpp", cc: "cpp",
    c: "c", h: "h", hpp: "hpp",
    cs: "cs", csharp: "cs",
    sh: "sh", bash: "sh", shell: "sh", zsh: "sh",
    html: "html", css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yaml", yml: "yml",
    md: "md", markdown: "md",
    sql: "sql", lua: "lua", php: "php",
  };
  let ext = LANG_TO_EXT[l];

  // No explicit language tag? Look for cheap signals in the code itself.
  if (!ext) {
    if (/#include\s*[<"]/.test(code)) ext = "cpp";
    else if (/^\s*def\s+\w+\s*\(/m.test(code)) ext = "py";
    else if (/\bfn\s+\w+\s*\(/.test(code) && /;\s*$/.test(code)) ext = "rs";
    else if (/^\s*package\s+\w+/.test(code) && /func\s+\w+\s*\(/.test(code)) ext = "go";
    else if (/\bimport\s+\{[\s\S]*?\}\s+from\s+['"]/.test(code)) ext = "ts";
    else if (/^#!\/.*\b(bash|sh)\b/.test(code) || /\$\(.*\)/.test(code)) ext = "sh";
    else ext = "txt";
  }

  // Pick a base name. Prefer hints baked into the prompt ("hello world" -> hello_world).
  const promptName =
    promptHint &&
    promptHint
      .toLowerCase()
      .replace(/[^a-z0-9 _-]+/g, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .join("_");
  const base = (promptName && promptName.length >= 3 && promptName) || `solution`;
  return `${base}.${ext}`;
}
