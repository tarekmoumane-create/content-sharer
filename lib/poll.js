// The actual job: read the handles channel, check each creator for uploads we
// haven't posted yet, and drop the new ones into the target channel.
//
// Three rules shape this file:
//   1. A creator seen for the first time does NOT get their backlog posted.
//      Marking their current videos as seen is the difference between "the bot
//      is live" and "the bot dumped 400 links into the channel".
//   2. One broken creator must not kill the run. Every check is isolated and
//      failures are collected into the summary instead of thrown.
//   3. A run has hard caps — creators checked and messages posted — so a
//      serverless invocation always finishes inside its time budget.
import { loadCreators } from "./creators.js";
import { fetchRecent } from "./platforms/index.js";
import { postMessage } from "./discord.js";
import {
  markSeen,
  markManySeen,
  trimSeen,
  isKnownCreator,
  markCreatorKnown,
  getCursor,
  setCursor,
} from "./store.js";

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

function render(template, video, creator) {
  return template
    .replace(/\{name\}/g, video.author || creator.name || creator.handle)
    .replace(/\{platform\}/g, creator.platform)
    .replace(/\{title\}/g, (video.title || "").slice(0, 200))
    .replace(/\{url\}/g, video.url || "");
}

// Oldest first, so a creator who dropped three videos between runs appears in
// the channel in the order they actually posted them.
function chronological(videos) {
  return [...videos].sort((a, b) => {
    const ta = Date.parse(a.publishedAt ?? "") || 0;
    const tb = Date.parse(b.publishedAt ?? "") || 0;
    return ta - tb;
  });
}

export async function runPoll({ dryRun = false } = {}) {
  const sourceChannel = process.env.DISCORD_SOURCE_CHANNEL_ID;
  const targetChannel = process.env.DISCORD_TARGET_CHANNEL_ID;
  if (!sourceChannel) throw new Error("DISCORD_SOURCE_CHANNEL_ID is not set");
  if (!targetChannel) throw new Error("DISCORD_TARGET_CHANNEL_ID is not set");

  const perRun = num(process.env.MAX_CREATORS_PER_RUN, 25);
  const perCheck = num(process.env.VIDEOS_PER_CHECK, 5);
  const maxPosts = num(process.env.MAX_POSTS_PER_RUN, 15);
  const backfill = (process.env.BACKFILL_ON_ADD || "none").toLowerCase();
  const template =
    process.env.POST_TEMPLATE || "**{name}** just posted on {platform}\n{url}";

  const allCreators = await loadCreators(sourceChannel);

  // Rotate through the roster so every creator gets checked eventually, even
  // when there are more of them than one run can handle.
  const cursor = allCreators.length ? (await getCursor()) % allCreators.length : 0;
  const slice =
    allCreators.length <= perRun
      ? allCreators
      : [...allCreators, ...allCreators].slice(cursor, cursor + perRun);

  const summary = {
    creatorsFound: allCreators.length,
    creatorsChecked: slice.length,
    posted: [],
    initialised: [],
    errors: [],
    skipped: [],
  };

  let postsLeft = maxPosts;

  for (const creator of slice) {
    try {
      const videos = await fetchRecent(creator, perCheck);
      if (!videos.length) continue;

      const known = await isKnownCreator(creator);

      // First sighting: absorb the backlog quietly.
      if (!known) {
        const ids = videos.map((v) => v.id);
        if (backfill === "latest") {
          const newest = chronological(videos).at(-1);
          await markManySeen(creator, ids.filter((id) => id !== newest.id));
          if (postsLeft > 0) {
            if (!dryRun) await postMessage(targetChannel, render(template, newest, creator));
            await markSeen(creator, newest.id);
            postsLeft--;
            summary.posted.push({ creator: creator.handle, url: newest.url });
          } else {
            await markSeen(creator, newest.id);
          }
        } else {
          await markManySeen(creator, ids);
        }
        await markCreatorKnown(creator);
        summary.initialised.push(`${creator.platform}:${creator.handle}`);
        continue;
      }

      for (const video of chronological(videos)) {
        if (!video.url) continue;
        if (postsLeft <= 0) {
          // Leave it unseen so the next run picks it up rather than losing it.
          summary.skipped.push({ creator: creator.handle, url: video.url });
          break;
        }

        // markSeen is atomic: it returns false if another run already claimed
        // this video, which is what stops double-posting.
        const isNew = await markSeen(creator, video.id);
        if (!isNew) continue;

        if (!dryRun) {
          await postMessage(targetChannel, render(template, video, creator));
        }
        postsLeft--;
        summary.posted.push({ creator: creator.handle, url: video.url });
      }

      await trimSeen(creator, videos.map((v) => v.id));
    } catch (err) {
      summary.errors.push({
        creator: `${creator.platform}:${creator.handle}`,
        error: String(err?.message || err),
        disabled: Boolean(err?.disabled),
      });
    }
  }

  if (allCreators.length) {
    await setCursor((cursor + slice.length) % allCreators.length);
  }

  return summary;
}
