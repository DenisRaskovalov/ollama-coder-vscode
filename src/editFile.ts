/**
 * Aider-style search/replace edits.
 *
 * Inspired by https://aider.chat (SEARCH/REPLACE diff blocks). The killer
 * insight: a small local model can reliably output a targeted patch — a
 * "here's the exact text to find, here's what it should become" — but
 * can't reliably re-emit a 500-line file every time it wants to change
 * three of those lines. SEARCH/REPLACE is the cheap, robust middle path.
 *
 * This module is intentionally pure (no `vscode` imports) so it can be
 * unit-tested by `node:test` without a stub.
 */

export interface EditResult {
  ok: boolean;
  /** Diagnostic / status string the caller can show or feed back to the model. */
  message: string;
  /** New file contents, only set when ok=true. */
  newContent?: string;
  /** Number of bytes that changed (heuristic; useful for UI). */
  changedBytes?: number;
}

/**
 * Apply a single SEARCH→REPLACE patch to `original`.
 *
 * Contract:
 *   - `search` must appear EXACTLY ONCE in `original`. Zero or multiple
 *     matches reject with an actionable error message — the model is
 *     supposed to expand its search snippet until the match is unique.
 *   - If `original` is empty, `search` must be empty too (new-file mode).
 *   - Line endings in both `search` and `original` are normalised to LF
 *     before comparison, so a CRLF/LF mismatch doesn't fail spuriously.
 *
 * The "must match exactly once" rule is the same one Aider uses; it gives
 * the model a clear retry signal without us having to invent fuzzy
 * matching (which is dangerous \u2014 we'd silently edit the wrong place).
 */
export function applySearchReplace(
  original: string,
  search: string,
  replace: string
): EditResult {
  // Normalise line endings on both sides so a stray \r\n vs \n doesn't
  // break a perfectly correct patch.
  const normOriginal = original.replace(/\r\n/g, "\n");
  const normSearch = search.replace(/\r\n/g, "\n");
  const normReplace = replace.replace(/\r\n/g, "\n");

  // New-file case: caller is creating the file with edit_file. Allowed
  // only when both original AND search are empty; the replace becomes
  // the entire new content.
  if (normOriginal.length === 0) {
    if (normSearch.length === 0) {
      return {
        ok: true,
        message: "Created new file content.",
        newContent: normReplace,
        changedBytes: normReplace.length,
      };
    }
    return {
      ok: false,
      message:
        "edit_file: file is empty (or new) but 'search' is non-empty. " +
        "To create a new file, pass an empty 'search'.",
    };
  }

  if (normSearch.length === 0) {
    return {
      ok: false,
      message:
        "edit_file: 'search' must not be empty for an existing file. " +
        "Provide enough surrounding context to identify a unique location.",
    };
  }

  const first = normOriginal.indexOf(normSearch);
  if (first < 0) {
    return {
      ok: false,
      message:
        "edit_file: 'search' was not found in the file. " +
        "Re-read the file with read_file and copy the exact text (including " +
        "indentation) you want to change. Whitespace matters.",
    };
  }
  const second = normOriginal.indexOf(normSearch, first + 1);
  if (second >= 0) {
    return {
      ok: false,
      message:
        "edit_file: 'search' matched more than once. " +
        "Expand 'search' with more surrounding context until it identifies " +
        "exactly one location in the file.",
    };
  }

  const newContent =
    normOriginal.slice(0, first) +
    normReplace +
    normOriginal.slice(first + normSearch.length);

  return {
    ok: true,
    message: `Replaced ${normSearch.length} chars with ${normReplace.length} chars.`,
    newContent,
    changedBytes: Math.abs(normReplace.length - normSearch.length),
  };
}
