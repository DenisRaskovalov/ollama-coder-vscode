// Tests for src/problemRef.ts. The detector picks up well-known
// competitive-programming problem references in the user's prompt so the
// chat view can suggest a sensible filename and invite web_search.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const p = path.resolve(__dirname, "..", "out", "problemRef.js");
if (!fs.existsSync(p)) {
  throw new Error(`${p} not found. Run 'npm run compile' first.`);
}
const { detectProblemRef } = require(p);

/* ----------------------------- LeetCode ------------------------------ */

const LC = [
  "Generate a solution of LeetCode problem 1000 in a new file on disk",
  "solve leetcode 42 in python",
  "Please write a solution to LeetCode #1234 to disk",
  "leetcode problem no. 200, save it as a file",
];
for (const s of LC) {
  test(`LeetCode detected in: ${JSON.stringify(s)}`, () => {
    const r = detectProblemRef(s);
    assert.ok(r, `no problem ref detected: ${s}`);
    assert.equal(r.source, "LeetCode");
    assert.match(r.suggestedFilename, /^leetcode_\d+\.py$/);
    assert.match(r.referenceUrl, /^https:\/\/leetcode\.com\/problemset\/all\/\?search=\d+$/);
    assert.match(r.augmentation, /web_search/);
    assert.match(r.augmentation, /LeetCode/);
  });
}

test("LeetCode: extracts the right id", () => {
  const r = detectProblemRef("solve leetcode 42");
  assert.equal(r?.id, "42");
  assert.equal(r?.suggestedFilename, "leetcode_42.py");
});

/* ----------------------------- Codeforces ---------------------------- */

test("Codeforces: '1234A' style", () => {
  const r = detectProblemRef("solve codeforces 1234A in a file");
  assert.ok(r);
  assert.equal(r.source, "Codeforces");
  assert.equal(r.id, "1234A");
  assert.equal(r.suggestedFilename, "codeforces_1234A.py");
  assert.equal(
    r.referenceUrl,
    "https://codeforces.com/problemset/problem/1234/A"
  );
});

test("Codeforces: 'round 1898 problem B' style", () => {
  const r = detectProblemRef("Codeforces round 1898 problem B, save it");
  assert.ok(r);
  assert.equal(r.id, "1898B");
});

/* --------------------------- Project Euler --------------------------- */

test("Project Euler: 'project euler 50'", () => {
  const r = detectProblemRef("solve project euler 50 to a file");
  assert.ok(r);
  assert.equal(r.source, "Project Euler");
  assert.equal(r.id, "50");
  assert.equal(r.suggestedFilename, "project_euler_50.py");
  assert.equal(r.referenceUrl, "https://projecteuler.net/problem=50");
});

test("Project Euler: 'project euler problem #7'", () => {
  const r = detectProblemRef("write project euler problem #7 in a new file");
  assert.equal(r?.id, "7");
});

/* -------------------------- Advent of Code --------------------------- */

test("Advent of Code: with year and day", () => {
  const r = detectProblemRef("solve advent of code 2023 day 5 in a file");
  assert.ok(r);
  assert.equal(r.source, "Advent of Code");
  assert.match(r.id, /2023 day 5/);
  assert.equal(r.suggestedFilename, "aoc_2023_day5.py");
  assert.equal(r.referenceUrl, "https://adventofcode.com/2023/day/5");
});

test("Advent of Code: AoC abbreviation, day first then year", () => {
  const r = detectProblemRef("AoC day 17 2022, save to file");
  assert.ok(r);
  assert.equal(r.suggestedFilename, "aoc_2022_day17.py");
});

test("Advent of Code: just a day, no year", () => {
  const r = detectProblemRef("advent of code day 3 please");
  assert.ok(r);
  assert.equal(r.suggestedFilename, "aoc_day3.py");
});

/* ----------------------------- Negatives ----------------------------- */

const NOT_PROBLEMS = [
  "explain what a binary search is",
  "make a Hello World program in Python",
  "what is leetcode anyway",      // mentions the brand but has no number
  "we have 1000 customers",        // number without a source
  "project deadline 50 days away", // 'project' but not 'project euler'
];
for (const s of NOT_PROBLEMS) {
  test(`negative: ${JSON.stringify(s)}`, () => {
    assert.equal(
      detectProblemRef(s),
      null,
      `should NOT detect a problem ref in: ${s}`
    );
  });
}

/* -------------------------- Augmentation shape ----------------------- */

test("augmentation always invites web_search and names the suggested file", () => {
  const r = detectProblemRef(
    "Generate a solution of LeetCode problem 1000 in a new file on disk"
  );
  assert.ok(r);
  assert.match(r.augmentation, /web_search/);
  assert.match(r.augmentation, /leetcode_1000\.py/);
  assert.match(r.augmentation, /https:\/\/leetcode\.com/);
});
