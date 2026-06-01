// Tests for the pure "play music" helpers (src/music.ts). These exercise the
// language-independent mechanics — intent parsing, service normalization, and
// URL building — without any I/O. The actual openExternal call lives in
// chatView.ts / extension.ts and is not exercised here.
//
// Positive AND negative coverage per the project's house rule
// (ARCHITECTURE.md §8): every "must match" has a "must NOT match" sibling.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const musicPath = path.resolve(__dirname, "..", "out", "music.js");
if (!fs.existsSync(musicPath)) {
  throw new Error(`${musicPath} not found. Run 'npm run compile' first.`);
}
const {
  parsePlayIntent,
  normalizeService,
  buildMusicUrl,
  SERVICE_LABEL,
} = require(musicPath);

/* ------------------------------ parsePlayIntent -------------------------- */

test("parses the canonical 'Play X from Amazon Music' example", () => {
  const r = parsePlayIntent("Play Radio Tapok from Amazon Music");
  assert.ok(r);
  assert.equal(r.query, "Radio Tapok");
  assert.equal(normalizeService(r.service, "youtube"), "amazon");
});

test("parses an artist with no service named", () => {
  const r = parsePlayIntent("Play Five Finger Death Punch");
  assert.ok(r);
  assert.equal(r.query, "Five Finger Death Punch");
  assert.equal(r.service, undefined);
});

test("parses 'put on' and 'start playing' phrasings", () => {
  assert.equal(parsePlayIntent("put on Metallica").query, "Metallica");
  const r = parsePlayIntent("start playing Bach on Spotify");
  assert.equal(r.query, "Bach");
  assert.equal(normalizeService(r.service, "amazon"), "spotify");
});

test("strips filler words like 'some' and trailing 'music'", () => {
  assert.equal(parsePlayIntent("play some Metallica music").query, "Metallica");
  assert.equal(parsePlayIntent("play the Beatles songs").query, "Beatles");
});

test("handles 'turn on' and a YouTube alias", () => {
  const r = parsePlayIntent("turn on lofi beats on youtube");
  assert.equal(r.query, "lofi beats");
  assert.equal(normalizeService(r.service, "amazon"), "youtube");
});

test("recognizes 'from apple music' / itunes alias", () => {
  const r = parsePlayIntent("play Adele from Apple Music");
  assert.equal(normalizeService(r.service, "amazon"), "apple");
});

/* --------------------- parsePlayIntent: must NOT match ------------------- */

for (const neg of [
  "play around with the layout",
  "play with this function",
  "explain how to play audio in python",
  "display the current file",
  "replay the failing test",
  "open the playground config",
  "playwright test setup",
  "what is a playbook in ansible",
  "play the game",
  "   ",
  "",
]) {
  test(`does NOT treat as music: ${JSON.stringify(neg)}`, () => {
    assert.equal(parsePlayIntent(neg), null);
  });
}

/* ------------------------------ normalizeService ------------------------- */

test("normalizeService maps every alias family", () => {
  assert.equal(normalizeService("Amazon Music", "youtube"), "amazon");
  assert.equal(normalizeService("prime music", "youtube"), "amazon");
  assert.equal(normalizeService("Spotify", "amazon"), "spotify");
  assert.equal(normalizeService("YouTube Music", "amazon"), "youtube");
  assert.equal(normalizeService("ytm", "amazon"), "youtube");
  assert.equal(normalizeService("Apple Music", "amazon"), "apple");
  assert.equal(normalizeService("iTunes", "amazon"), "apple");
});

test("normalizeService falls back for unknown / empty input", () => {
  assert.equal(normalizeService("tidal", "amazon"), "amazon");
  assert.equal(normalizeService("", "spotify"), "spotify");
  assert.equal(normalizeService(undefined, "youtube"), "youtube");
});

/* ------------------------------- buildMusicUrl --------------------------- */

test("buildMusicUrl uses the right host per service and encodes the query", () => {
  assert.equal(
    buildMusicUrl("Radio Tapok", "amazon"),
    "https://music.amazon.com/search/Radio%20Tapok"
  );
  assert.equal(
    buildMusicUrl("Bach", "spotify"),
    "https://open.spotify.com/search/Bach"
  );
  assert.equal(
    buildMusicUrl("lofi beats", "youtube"),
    "https://music.youtube.com/search?q=lofi%20beats"
  );
  assert.equal(
    buildMusicUrl("Adele", "apple"),
    "https://music.apple.com/search?term=Adele"
  );
});

test("buildMusicUrl encodes special characters safely", () => {
  const url = buildMusicUrl("AC/DC & Friends", "amazon");
  assert.ok(url.startsWith("https://music.amazon.com/search/"));
  assert.ok(!url.includes(" "));
  assert.ok(url.includes("AC%2FDC"));
});

test("every service has a human label", () => {
  for (const s of ["amazon", "spotify", "youtube", "apple"]) {
    assert.equal(typeof SERVICE_LABEL[s], "string");
    assert.ok(SERVICE_LABEL[s].length > 0);
  }
});
