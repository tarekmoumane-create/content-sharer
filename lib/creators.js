// Turns the raw contents of the handles channel into a clean creator list.
//
// The channel is the source of truth: whatever links people have posted there
// are the accounts the bot watches. Drop a new link in, and the next cron run
// picks it up — no commands, no redeploy. This file is only about parsing; it
// does no network calls.
import { fetchChannelMessages } from "./discord.js";

// Paths that look like a username but aren't one.
const IG_RESERVED = new Set([
  "p", "reel", "reels", "stories", "explore", "accounts", "direct",
  "tv", "about", "developer", "legal", "privacy", "terms",
]);
const YT_RESERVED = new Set([
  "watch", "shorts", "playlist", "results", "feed", "hashtag", "about", "embed",
]);

// A handle is valid if it's plausible for the platform. Keeps stray punctuation
// from Discord formatting (trailing `)`, `>`, `.`) out of the stored key.
function clean(handle) {
  return String(handle || "").replace(/[^\w.\-]/g, "").toLowerCase();
}

function add(map, platform, handle, sourceUrl) {
  const h = clean(handle);
  if (!h || h.length < 2) return;
  const key = `${platform}:${h}`;
  if (map.has(key)) return;
  map.set(key, { platform, handle: h, name: h, sourceUrl });
}

// Pulls every creator reference out of one chunk of text. A single message can
// legitimately hold several links (people paste a creator's whole set at once).
export function parseCreatorsFromText(text, map = new Map()) {
  if (!text) return map;

  // --- TikTok: tiktok.com/@handle (optionally followed by /video/123) -------
  for (const m of text.matchAll(/tiktok\.com\/@([\w.\-]+)/gi)) {
    add(map, "tiktok", m[1], `https://www.tiktok.com/@${clean(m[1])}`);
  }

  // --- YouTube: /@handle, /channel/UC..., /c/name, /user/name ---------------
  for (const m of text.matchAll(/youtube\.com\/@([\w.\-]+)/gi)) {
    if (YT_RESERVED.has(clean(m[1]))) continue;
    add(map, "youtube", m[1], `https://www.youtube.com/@${clean(m[1])}`);
  }
  for (const m of text.matchAll(/youtube\.com\/channel\/(UC[\w\-]{20,})/gi)) {
    // Channel ids are case-sensitive, so store them verbatim rather than cleaned.
    const id = m[1];
    const key = `youtube:${id.toLowerCase()}`;
    if (!map.has(key)) {
      map.set(key, {
        platform: "youtube",
        handle: id.toLowerCase(),
        name: id,
        channelId: id,
        sourceUrl: `https://www.youtube.com/channel/${id}`,
      });
    }
  }
  for (const m of text.matchAll(/youtube\.com\/(?:c|user)\/([\w.\-]+)/gi)) {
    if (YT_RESERVED.has(clean(m[1]))) continue;
    add(map, "youtube", m[1], `https://www.youtube.com/c/${clean(m[1])}`);
  }

  // --- Instagram: instagram.com/username -----------------------------------
  for (const m of text.matchAll(/instagram\.com\/([\w.\-]+)/gi)) {
    if (IG_RESERVED.has(clean(m[1]))) continue;
    add(map, "instagram", m[1], `https://www.instagram.com/${clean(m[1])}`);
  }

  // --- Explicit shorthand, for creators posted without a full URL ----------
  // e.g.  tiktok: @someone   |   yt @someone   |   ig: someone
  const shorthand = /\b(tiktok|tt|youtube|yt|instagram|ig)\s*[:=]?\s*@([\w.\-]+)/gi;
  for (const m of text.matchAll(shorthand)) {
    const p = m[1].toLowerCase();
    const platform =
      p === "tt" || p === "tiktok" ? "tiktok"
      : p === "yt" || p === "youtube" ? "youtube"
      : "instagram";
    add(map, platform, m[2], null);
  }

  return map;
}

// Reads the handles channel and returns a de-duplicated creator list.
// Embeds count too: when someone pastes a link Discord often strips it from the
// visible content and keeps the URL in an embed, so we scan both.
export async function loadCreators(channelId, limit = 500) {
  const messages = await fetchChannelMessages(channelId, limit);
  const map = new Map();

  for (const msg of messages) {
    parseCreatorsFromText(msg.content, map);
    for (const e of msg.embeds || []) {
      parseCreatorsFromText([e.url, e.title, e.description, e.author?.url].filter(Boolean).join(" "), map);
    }
  }

  return [...map.values()];
}
