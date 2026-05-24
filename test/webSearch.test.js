// Tests for src/web.ts and the web_search tool. The HTTP layer is never
// hit: we feed canned response bodies into the parsers and assert the
// extracted SearchResult[].

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

// out/tools.js imports 'vscode'; stub it like the other tests.
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "vscode") return require.resolve("./_vscode_stub.js");
  return origResolve.call(this, request, parent, ...rest);
};

const webPath = path.resolve(__dirname, "..", "out", "web.js");
if (!fs.existsSync(webPath)) {
  throw new Error(`${webPath} not found. Run 'npm run compile' first.`);
}

const {
  parseDuckDuckGoHtml,
  parseGoogleCseJson,
  unwrapDdgRedirect,
  stripTags,
  decodeHtml,
} = require(webPath);

/* --------------------------------- helpers --------------------------------- */

test("decodeHtml handles named, decimal, and hex entities", () => {
  assert.equal(decodeHtml("foo &amp; bar"), "foo & bar");
  assert.equal(decodeHtml("&lt;tag&gt;"), "<tag>");
  assert.equal(decodeHtml("a&nbsp;b"), "a b");
  assert.equal(decodeHtml("&#39;quoted&#39;"), "'quoted'");
  assert.equal(decodeHtml("&#x2014;dash"), "\u2014dash");
});

test("stripTags removes tags and decodes entities", () => {
  assert.equal(
    stripTags('<b class="x">hello &amp; goodbye</b>'),
    "hello & goodbye"
  );
});

test("unwrapDdgRedirect extracts the uddg= target", () => {
  const wrapped =
    "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fq%3D1&rut=abc";
  assert.equal(unwrapDdgRedirect(wrapped), "https://example.com/a?q=1");
});

test("unwrapDdgRedirect leaves real URLs alone", () => {
  assert.equal(
    unwrapDdgRedirect("https://example.com/path"),
    "https://example.com/path"
  );
});

test("unwrapDdgRedirect tolerates malformed input", () => {
  assert.equal(unwrapDdgRedirect("not a url"), "not a url");
});

/* ------------------------------ DDG parser ------------------------------- */

const DDG_HTML = `
<html><body>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2Flibrary%2Fpathlib.html&rut=x">Python pathlib &mdash; docs.python.org</a>
    <a class="result__snippet" href="//x">Object-oriented &amp; modern paths. Use pathlib.Path for new code.</a>
  </div>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Frealpython.com%2Fpython-pathlib%2F">RealPython: pathlib tutorial</a>
    <a class="result__snippet">Replace os.path with pathlib.</a>
  </div>
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F3rd">Third hit</a>
    <a class="result__snippet">A third snippet.</a>
  </div>
</body></html>`;

test("parseDuckDuckGoHtml extracts title, url, snippet and unwraps redirects", () => {
  const r = parseDuckDuckGoHtml(DDG_HTML, 5);
  assert.equal(r.length, 3, `expected 3 results, got ${r.length}`);
  assert.equal(r[0].title, "Python pathlib \u2014 docs.python.org");
  assert.equal(r[0].url, "https://docs.python.org/3/library/pathlib.html");
  assert.ok(r[0].snippet.startsWith("Object-oriented & modern paths"));
  assert.equal(r[1].url, "https://realpython.com/python-pathlib/");
});

test("parseDuckDuckGoHtml respects the limit", () => {
  const r = parseDuckDuckGoHtml(DDG_HTML, 2);
  assert.equal(r.length, 2);
});

test("parseDuckDuckGoHtml returns [] for empty / non-matching HTML", () => {
  assert.deepEqual(parseDuckDuckGoHtml("", 5), []);
  assert.deepEqual(parseDuckDuckGoHtml("<html>no results</html>", 5), []);
});

/* ------------------------------ Google parser ----------------------------- */

const GOOGLE_OK = JSON.stringify({
  kind: "customsearch#search",
  items: [
    {
      title: "DuckDuckGo - Wikipedia",
      link: "https://en.wikipedia.org/wiki/DuckDuckGo",
      snippet: "DuckDuckGo is an internet search engine.",
    },
    {
      title: "DuckDuckGo Homepage",
      link: "https://duckduckgo.com/",
      snippet: "Privacy, simplified.",
    },
  ],
});

test("parseGoogleCseJson maps items to SearchResult[]", () => {
  const r = parseGoogleCseJson(GOOGLE_OK, 10);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, "DuckDuckGo - Wikipedia");
  assert.equal(r[0].url, "https://en.wikipedia.org/wiki/DuckDuckGo");
  assert.match(r[0].snippet, /internet search engine/);
});

test("parseGoogleCseJson respects the limit", () => {
  const r = parseGoogleCseJson(GOOGLE_OK, 1);
  assert.equal(r.length, 1);
});

test("parseGoogleCseJson surfaces Google API errors", () => {
  const errBody = JSON.stringify({
    error: { code: 403, message: "Daily limit exceeded." },
  });
  assert.throws(
    () => parseGoogleCseJson(errBody, 5),
    /Google CSE error 403.*Daily limit/
  );
});

test("parseGoogleCseJson returns [] on malformed JSON or missing items", () => {
  assert.deepEqual(parseGoogleCseJson("", 5), []);
  assert.deepEqual(parseGoogleCseJson("not json", 5), []);
  assert.deepEqual(parseGoogleCseJson(JSON.stringify({}), 5), []);
});

test("parseGoogleCseJson drops items without title or link", () => {
  const body = JSON.stringify({
    items: [
      { title: "", link: "https://x.com", snippet: "no title" },
      { title: "no link", link: "", snippet: "x" },
      { title: "good", link: "https://good.example", snippet: "ok" },
    ],
  });
  const r = parseGoogleCseJson(body, 5);
  assert.equal(r.length, 1);
  assert.equal(r[0].url, "https://good.example");
});

/* ------------------------------ Tool schema ------------------------------ */

const toolsPath = path.resolve(__dirname, "..", "out", "tools.js");
const tools = require(toolsPath);

test("web_search is registered in TOOL_SCHEMAS", () => {
  const names = tools.TOOL_SCHEMAS.map((s) => s.function.name);
  assert.ok(
    names.includes("web_search"),
    `TOOL_SCHEMAS missing web_search; have: ${names.join(", ")}`
  );
});

test("web_search schema declares 'query' as required", () => {
  const schema = tools.TOOL_SCHEMAS.find((s) => s.function.name === "web_search");
  assert.ok(schema, "web_search schema not found");
  assert.deepEqual(schema.function.parameters.required, ["query"]);
  assert.ok(schema.function.parameters.properties.query);
  assert.ok(schema.function.parameters.properties.limit);
});
