/**
 * Recognise a competitive-programming / coding-katas problem reference in
 * the user's prompt and produce a structured hint the agent can act on:
 *
 *   - source     : "LeetCode" | "Codeforces" | "Project Euler" | "Advent of Code" | ...
 *   - id         : a human-readable problem identifier
 *   - suggestedFilename : workspace-relative path with the right shape
 *   - referenceUrl      : where the problem statement lives (so the agent can
 *                         web_search / fetch if it doesn't remember)
 *   - augmentation      : prose appended to the user message; tells the model
 *                         which problem this is and that web_search is allowed
 *                         when memory fails.
 *
 * Pure (no `vscode` imports) so it's directly unit-testable. The chat
 * view consumes the result and injects it before the agent loop runs.
 */

export interface ProblemRef {
  source: string;
  id: string;
  suggestedFilename: string;
  referenceUrl: string;
  augmentation: string;
}

/**
 * Detect a problem reference. Returns `null` if the prompt doesn't look
 * like one. The patterns are deliberately conservative: a stray "problem
 * 1000" with no source word should NOT match, because the model can do
 * many other reasonable things with that phrasing.
 */
export function detectProblemRef(text: string): ProblemRef | null {
  if (!text) return null;
  // Order matters: more specific sources first so e.g. "Advent of Code"
  // wins over a bare "AoC" inside a longer string, and "Project Euler"
  // wins over a stray "Project" keyword.

  // Advent of Code: "advent of code day 5 2023", "AoC 2022 day 17", etc.
  // Try year-first, then day-first, then day-only. Year-only never wins.
  let aocYear = "";
  let aocDay = "";
  let aocM: RegExpMatchArray | null;
  if ((aocM = text.match(
        /\b(?:advent\s+of\s+code|aoc)\b[^\n]{0,40}?(20\d{2})[^\n]{0,20}?day[^\n]{0,5}?(\d{1,2})\b/i
      ))) {
    aocYear = aocM[1];
    aocDay = String(parseInt(aocM[2], 10));
  } else if ((aocM = text.match(
        /\b(?:advent\s+of\s+code|aoc)\b[^\n]{0,40}?day[^\n]{0,5}?(\d{1,2})[^\n]{0,20}?(20\d{2})\b/i
      ))) {
    aocDay = String(parseInt(aocM[1], 10));
    aocYear = aocM[2];
  } else if ((aocM = text.match(
        /\b(?:advent\s+of\s+code|aoc)\b[^\n]{0,40}?day[^\n]{0,5}?(\d{1,2})\b/i
      ))) {
    aocDay = String(parseInt(aocM[1], 10));
  }
  if (aocDay) {
    const id = aocYear ? `${aocYear} day ${aocDay}` : `day ${aocDay}`;
    const file = aocYear ? `aoc_${aocYear}_day${aocDay}.py` : `aoc_day${aocDay}.py`;
    const url = aocYear
      ? `https://adventofcode.com/${aocYear}/day/${aocDay}`
      : `https://adventofcode.com/`;
    return makeRef("Advent of Code", id, file, url);
  }

  // Project Euler.
  let m = text.match(
    /\bproject\s+euler\b[^\n]{0,40}?(?:problem|#|no\.?)?\s*(\d{1,4})/i
  );
  if (m) {
    const id = String(parseInt(m[1], 10));
    return makeRef(
      "Project Euler",
      id,
      `project_euler_${id}.py`,
      `https://projecteuler.net/problem=${id}`
    );
  }

  // Codeforces. Accept three shapes:
  //   1. compact:        "codeforces 1234A"          / "codeforces 1234 A"
  //   2. round+problem:  "codeforces round 1234 problem A"
  //   3. problem+round:  "codeforces problem A round 1234"
  let cfRound = "";
  let cfLetter = "";
  let cfM: RegExpMatchArray | null;
  if ((cfM = text.match(
        /\bcodeforces\b[^\n]{0,80}?\bround\s+(\d{2,5})\b[^\n]{0,40}?\bproblem\s+([A-Za-z])\b/i
      ))) {
    cfRound = cfM[1];
    cfLetter = cfM[2];
  } else if ((cfM = text.match(
        /\bcodeforces\b[^\n]{0,80}?\bproblem\s+([A-Za-z])\b[^\n]{0,40}?\bround\s+(\d{2,5})\b/i
      ))) {
    cfLetter = cfM[1];
    cfRound = cfM[2];
  } else if ((cfM = text.match(
        /\bcodeforces\b[^\n]{0,40}?(\d{2,5})\s*([A-Za-z])(?![A-Za-z])/i
      ))) {
    cfRound = cfM[1];
    cfLetter = cfM[2];
  }
  if (cfRound && cfLetter) {
    const letter = cfLetter.toUpperCase();
    const id = `${cfRound}${letter}`;
    return makeRef(
      "Codeforces",
      id,
      `codeforces_${id}.py`,
      `https://codeforces.com/problemset/problem/${cfRound}/${letter}`
    );
  }

  // LeetCode: "leetcode 1000", "leetcode problem 1000", "leetcode #1000".
  m = text.match(
    /\bleetcode\b[^\n]{0,40}?(?:problem|#|number|no\.?)?\s*(\d{1,5})\b/i
  );
  if (m) {
    const id = String(parseInt(m[1], 10));
    return makeRef(
      "LeetCode",
      id,
      `leetcode_${id}.py`,
      `https://leetcode.com/problemset/all/?search=${id}`
    );
  }

  // HackerRank by name slug (less structured; just point to search).
  m = text.match(/\bhackerrank\b\s+(?:problem\s+)?(["\u2018\u2019\u201c\u201d']?)([\w \-]{3,80})\1/i);
  if (m) {
    const name = m[2].trim();
    const slug = name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    return makeRef(
      "HackerRank",
      name,
      `hackerrank_${slug}.py`,
      `https://www.hackerrank.com/search?query=${encodeURIComponent(name)}`
    );
  }

  return null;
}

function makeRef(
  source: string,
  id: string,
  suggestedFilename: string,
  referenceUrl: string
): ProblemRef {
  const augmentation =
    `\n\n(Problem reference detected: ${source} ${id}. ` +
    `If you don't remember the exact problem statement, call web_search with ` +
    `\`${source} ${id}\` and read the result before solving. ` +
    `Save the solution to \`${suggestedFilename}\`. ` +
    `Reference URL: ${referenceUrl} )`;
  return { source, id, suggestedFilename, referenceUrl, augmentation };
}
