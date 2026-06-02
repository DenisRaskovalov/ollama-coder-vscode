/**
 * "Play music" support. See ARCHITECTURE.md §4 (the design principle) and §3
 * Invariant 8 ("Ollama has no I/O; the plugin owns it").
 *
 * The model's job is *language understanding*: turn a free-form request like
 * "Play Radio Tapok from Amazon Music" into a structured plan
 * { kind: "play_music", music_query: "Radio Tapok", music_service: "amazon" }.
 *
 * THIS module's job is purely mechanical: map a (query, service) pair to a
 * streaming-service search URL. It performs **no I/O** — no filesystem, no
 * network, no `child_process`. The plugin (chatView) opens the URL on the
 * user's machine via `vscode.env.openExternal`, which is the only side effect.
 *
 * Because the actual track/play action needs each service's authenticated API
 * to start a *specific* song, and this extension is keyless and fully local,
 * we open the service's search results for the query. The user presses play on
 * the result (often the artist's auto-generated radio) — one click, no keys.
 */

export type MusicService = "amazon" | "spotify" | "youtube" | "apple";

/** Human-readable labels for UI notices. */
export const SERVICE_LABEL: Record<MusicService, string> = {
  amazon: "Amazon Music",
  spotify: "Spotify",
  youtube: "YouTube Music",
  apple: "Apple Music",
};

/**
 * Map a raw service string (as named by the user or the router) to one of the
 * supported services. Unknown / empty input falls back to `fallback`.
 */
export function normalizeService(
  raw: string | undefined,
  fallback: MusicService
): MusicService {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return fallback;
  if (/\b(amazon|prime)\b/.test(s)) return "amazon";
  if (/\bspotify\b/.test(s)) return "spotify";
  if (/\b(youtube|ytm?)\b/.test(s)) return "youtube";
  if (/\b(apple|itunes)\b/.test(s)) return "apple";
  return fallback;
}

/**
 * Build the streaming-service search URL for a query. Pure string building;
 * the query is URL-encoded so artist names with spaces / punctuation are safe.
 */
export function buildMusicUrl(query: string, service: MusicService): string {
  const q = encodeURIComponent(query.trim());
  switch (service) {
    case "spotify":
      return `https://open.spotify.com/search/${q}`;
    case "youtube":
      return `https://music.youtube.com/search?q=${q}`;
    case "apple":
      return `https://music.apple.com/search?term=${q}`;
    case "amazon":
    default:
      return `https://music.amazon.com/search/${q}`;
  }
}

/** A service named at the *end* of a request: "... from/on Amazon Music". */
const TRAILING_SERVICE =
  /\s+(?:from|on|in|via|using|with)\s+((?:amazon|prime|spotify|youtube|yt|ytm|apple|itunes)(?:\s+music)?)\s*$/i;

/**
 * Verb-led phrasings that start a music request. Anchored at the start of the
 * string so mid-sentence "play" (e.g. "explain how to play audio in python")
 * does not match. The capture group is the rest of the request.
 */
const PLAY_LEAD =
  /^\s*(?:please\s+)?(?:play(?:\s+me)?|put\s+on|turn\s+on|start\s+playing)\s+([\s\S]+)$/i;

/**
 * Common false-positive continuations after "play": "play around with the
 * code", "play with this", "playing field". If the query is ONLY one of these
 * filler words we reject the match.
 */
const FALSE_POSITIVE_TAIL =
  /^(?:around|with|back|nice|fair|along|dumb|safe|god|dead|the\s+(?:game|test|tests|file|video|audio|sound|music\s+player))\b/i;

/**
 * Conservative regex fallback for when the LLM router is off or returns null.
 * Returns `{ query, service? }` or null. `query` is always non-empty when set;
 * `service` is the raw captured service string (caller normalizes it).
 *
 * The authoritative path is the LLM router (router.ts, kind "play_music");
 * this exists only so the feature still works with `useLlmRouter` disabled.
 */
export function parsePlayIntent(
  text: string
): { query: string; service?: string } | null {
  if (!text || !text.trim()) return null;
  // Reject words that merely *contain* "play": playground, playwright,
  // playbook, playlist-the-noun, replay, display. PLAY_LEAD already anchors on
  // a word verb, but guard the obvious prefixes explicitly.
  if (/^\s*(?:replay|display|playground|playwright|playbook)\b/i.test(text)) {
    return null;
  }
  const m = text.match(PLAY_LEAD);
  if (!m) return null;

  let rest = m[1].trim();
  if (FALSE_POSITIVE_TAIL.test(rest)) return null;

  let service: string | undefined;
  const sm = rest.match(TRAILING_SERVICE);
  if (sm) {
    service = sm[1].trim();
    rest = rest.slice(0, sm.index).trim();
  }
  // Strip a trailing "music"/"song"/"track"/"playlist" filler if it's left
  // dangling (e.g. "play some Metallica music").
  rest = rest.replace(/\s+(?:music|songs?|tracks?|playlists?)\s*$/i, "").trim();
  // Strip a leading "some"/"a"/"the" filler.
  rest = rest.replace(/^(?:some|a|an|the)\s+/i, "").trim();

  if (!rest) return null;
  return service ? { query: rest, service } : { query: rest };
}
