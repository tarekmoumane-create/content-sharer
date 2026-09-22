// TikTok has no official API that will list an arbitrary creator's uploads, so
// this goes through whichever scraper SCRAPER_PROVIDER names. Both providers are
// normalised to the same { id, url, title, author, publishedAt } shape the rest
// of the bot expects.
import {
  provider,
  ScraperDisabled,
  runApifyActor,
  callRapidApi,
  firstOf,
  asArray,
} from "./scraper.js";

function normalise(raw, handle) {
  const id = firstOf(raw, "id", "video_id", "aweme_id", "videoId");
  if (!id) return null;

  const author =
    firstOf(raw, "authorMeta.name", "author.unique_id", "author.uniqueId", "authorUniqueId") ||
    handle;

  return {
    id: String(id),
    url:
      firstOf(raw, "webVideoUrl", "share_url", "url") ||
      `https://www.tiktok.com/@${author}/video/${id}`,
    title: firstOf(raw, "text", "title", "desc", "description") || "",
    author,
    publishedAt:
      firstOf(raw, "createTimeISO", "createTime", "create_time", "createtime") || null,
  };
}

export async function fetchRecent(creator, count = 5) {
  const p = provider();

  if (p === "apify") {
    const items = await runApifyActor(
      process.env.APIFY_TIKTOK_ACTOR || "clockworks~tiktok-scraper",
      {
        profiles: [creator.handle],
        resultsPerPage: count,
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
        shouldDownloadSubtitles: false,
        shouldDownloadSlideshowImages: false,
      },
    );
    return items.map((i) => normalise(i, creator.handle)).filter(Boolean).slice(0, count);
  }

  if (p === "rapidapi") {
    const json = await callRapidApi(
      process.env.RAPIDAPI_TIKTOK_HOST || "tiktok-scraper7.p.rapidapi.com",
      "/user/posts",
      { unique_id: `@${creator.handle}`, count: String(count), cursor: "0" },
    );
    const items = asArray(json, "data.videos", "data.itemList", "data", "videos");
    return items.map((i) => normalise(i, creator.handle)).filter(Boolean).slice(0, count);
  }

  throw new ScraperDisabled("TikTok");
}
