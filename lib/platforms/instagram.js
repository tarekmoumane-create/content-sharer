// Instagram, same story as TikTok: no official API covers listing an arbitrary
// public account's Reels, so this runs through the configured scraper. It is the
// most fragile of the three platforms — expect to change provider occasionally.
//
// Only video posts are returned. An account's photo posts are filtered out,
// since the point of this bot is sharing videos.
import {
  provider,
  ScraperDisabled,
  runApifyActor,
  callRapidApi,
  firstOf,
  asArray,
} from "./scraper.js";

function isVideo(raw) {
  const type = String(firstOf(raw, "type", "media_type", "productType", "__typename") || "");
  if (/video|reel|clips/i.test(type)) return true;
  if (type === "2") return true; // Instagram's numeric media_type for video
  if (firstOf(raw, "videoUrl", "video_url", "video_versions") != null) return true;
  return false;
}

function normalise(raw, handle) {
  const code = firstOf(raw, "shortCode", "code", "shortcode");
  const id = code || firstOf(raw, "id", "pk");
  if (!id) return null;

  return {
    id: String(id),
    url:
      firstOf(raw, "url", "permalink") ||
      (code ? `https://www.instagram.com/reel/${code}/` : null),
    title: firstOf(raw, "caption.text", "caption", "text", "title") || "",
    author: firstOf(raw, "ownerUsername", "user.username", "username") || handle,
    publishedAt: firstOf(raw, "timestamp", "taken_at", "taken_at_timestamp") || null,
  };
}

export async function fetchRecent(creator, count = 5) {
  const p = provider();
  let items = [];

  if (p === "apify") {
    items = await runApifyActor(
      process.env.APIFY_INSTAGRAM_ACTOR || "apify~instagram-scraper",
      {
        directUrls: [`https://www.instagram.com/${creator.handle}/`],
        resultsType: "posts",
        // Over-fetch a little: photos get filtered out below, and we still want
        // `count` videos back when a creator mixes stills into their grid.
        resultsLimit: Math.max(count * 3, 12),
      },
    );
  } else if (p === "rapidapi") {
    const json = await callRapidApi(
      process.env.RAPIDAPI_INSTAGRAM_HOST || "instagram-scraper-api2.p.rapidapi.com",
      "/v1/posts",
      { username_or_id_or_url: creator.handle },
    );
    items = asArray(json, "data.items", "items", "data");
  } else {
    throw new ScraperDisabled("Instagram");
  }

  return items
    .filter(isVideo)
    .map((i) => normalise(i, creator.handle))
    .filter((v) => v && v.url)
    .slice(0, count);
}
