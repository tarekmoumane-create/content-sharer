// Thin wrapper over Upstash Redis (the storage Vercel provisions via its
// Marketplace). Everything the bot needs to remember lives here:
//
//   seen:<platform>:<handle>   -> SET of video ids already posted
//   known:<platform>:<handle>  -> "1" once a creator has been initialised
//   yt:channel:<handle>        -> resolved YouTube channel id (permanent cache)
//   cursor:creators            -> rotating offset so each cron run picks up
//                                 where the last one stopped
//
// Upstash auto-serializes objects to/from JSON, so we store/read plain values.
// Swapping storage later (Postgres, Supabase, etc.) means only editing this file.
import { Redis } from "@upstash/redis";

// Vercel's Upstash Marketplace integration sets KV_REST_API_URL / KV_REST_API_TOKEN.
// Fall back to the native UPSTASH_* names in case a future integration uses those.
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

// A creator can be referenced two different ways in the handles channel — a
// YouTube @handle and that same channel's UC... id, for instance. The adapter
// resolves both to one canonical `dedupKey`, so the two entries share a single
// seen-set and the channel never gets the same video posted twice.
const identity = (c) => (c.dedupKey || c.handle).toLowerCase();
const seenKey = (c) => `seen:${c.platform}:${identity(c)}`;
const knownKey = (c) => `known:${c.platform}:${identity(c)}`;

// Returns true if this video id had NOT been recorded before. SADD is atomic,
// so two overlapping cron runs can never both claim the same video — whichever
// gets there first gets `1` back, the other gets `0` and stays quiet.
export async function markSeen(creator, videoId) {
  const added = await redis.sadd(seenKey(creator), String(videoId));
  return added === 1;
}

// Record ids without treating them as new. Used on a creator's first sighting
// so their whole backlog doesn't flood the target channel.
export async function markManySeen(creator, videoIds) {
  const ids = videoIds.map(String).filter(Boolean);
  if (!ids.length) return;
  await redis.sadd(seenKey(creator), ...ids);
}

// Keeps the seen-set from growing without bound. A creator posting daily for a
// year is ~365 ids; we trim to the most recent `keep` by rewriting the set from
// the ids we just fetched plus whatever is still relevant.
export async function trimSeen(creator, keepIds, keep = 200) {
  const size = await redis.scard(seenKey(creator));
  if (size <= keep) return;
  const ids = keepIds.map(String).filter(Boolean);
  if (!ids.length) return;
  await redis.del(seenKey(creator));
  await redis.sadd(seenKey(creator), ...ids);
}

export async function isKnownCreator(creator) {
  return (await redis.get(knownKey(creator))) !== null;
}
export async function markCreatorKnown(creator) {
  await redis.set(knownKey(creator), 1);
}

// YouTube @handles have to be resolved to a UC... channel id once. That never
// changes, so cache it forever and save a page fetch on every later run.
export async function getCachedChannelId(handle) {
  return (await redis.get(`yt:channel:${handle.toLowerCase()}`)) || null;
}
export async function setCachedChannelId(handle, channelId) {
  await redis.set(`yt:channel:${handle.toLowerCase()}`, channelId);
}

// One-shot latch. Returns true only for the first caller inside `ttlSeconds`,
// so a condition that is true on every run (like a low credit balance) still
// only announces itself once per window instead of every 15 minutes.
export async function claimAlert(name, ttlSeconds) {
  const res = await redis.set(`alert:${name}`, Date.now(), { nx: true, ex: ttlSeconds });
  return res === "OK";
}

// Rotating cursor: with more creators than one run can check, each invocation
// takes the next slice and leaves the offset ready for the run after it.
export async function getCursor() {
  const v = await redis.get("cursor:creators");
  return Number(v) || 0;
}
export async function setCursor(n) {
  await redis.set("cursor:creators", n);
}
