// YouTube needs no API key and no scraper: every channel publishes an Atom feed
// at /feeds/videos.xml?channel_id=UC..., updated within minutes of a new upload
// and covering both long-form videos and Shorts.
//
// The only wrinkle is that people share @handle URLs, and the feed wants the
// UC... channel id. We resolve a handle once by reading the channel page and
// pulling the id out of its metadata, then cache it forever.
import { getCachedChannelId, setCachedChannelId } from "../store.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Extracting the channel id is the one genuinely delicate part of this file.
// A channel page mentions 6-12 DIFFERENT channel ids — every recommended video
// carries its own "channelId" — so a naive match on that field silently binds a
// creator to a stranger's uploads. These four patterns all identify the page
// owner specifically, and were verified to agree with each other on live pages.
const ID_PATTERNS = [
  /feeds\/videos\.xml\?channel_id=(UC[\w\-]{20,})/,                                   // the page's own RSS link tag
  /"externalId":"(UC[\w\-]{20,})"/,                                                    // channel metadata blob
  /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w\-]{20,})"/, // canonical URL
  /<meta property="og:url" content="https:\/\/www\.youtube\.com\/channel\/(UC[\w\-]{20,})"/,
];

function extractChannelId(html) {
  for (const re of ID_PATTERNS) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

async function resolveChannelId(creator) {
  if (creator.channelId) return creator.channelId;

  // A cache miss is recoverable; a cache *outage* shouldn't stop us resolving.
  let cached = null;
  try {
    cached = await getCachedChannelId(creator.handle);
  } catch {
    // fall through to a live lookup
  }
  if (cached) return cached;

  // Try the modern @handle URL first, then the legacy /c/ and /user/ forms.
  const candidates = [
    `https://www.youtube.com/@${creator.handle}`,
    `https://www.youtube.com/c/${creator.handle}`,
    `https://www.youtube.com/user/${creator.handle}`,
  ];

  for (const url of candidates) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) continue;

    const id = extractChannelId(await res.text());
    if (id) {
      try {
        await setCachedChannelId(creator.handle, id);
      } catch {
        // caching is an optimisation, not a requirement
      }
      return id;
    }
  }

  throw new Error(`could not resolve YouTube channel id for @${creator.handle}`);
}

// The feed is small, well-formed XML. A full parser would be overkill here, so
// we pull the handful of fields we need with scoped regexes over each <entry>.
function parseFeed(xml) {
  const videos = [];

  for (const entry of xml.split("<entry>").slice(1)) {
    const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    if (!id) continue;

    videos.push({
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: decodeEntities(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ""),
      author: decodeEntities(entry.match(/<name>([\s\S]*?)<\/name>/)?.[1] || ""),
      publishedAt: entry.match(/<published>([^<]+)<\/published>/)?.[1] || null,
    });
  }

  return videos;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

export async function fetchRecent(creator, count = 5) {
  const channelId = await resolveChannelId(creator);

  // Canonical identity for de-duplication. Whether this creator was listed as
  // @handle or as a /channel/UC... link, both collapse onto the same key.
  creator.dedupKey = channelId.toLowerCase();

  const res = await fetch(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
    { headers: { "User-Agent": UA } },
  );
  if (!res.ok) throw new Error(`YouTube feed ${res.status} for ${creator.handle}`);

  const videos = parseFeed(await res.text());
  return videos.slice(0, count);
}
