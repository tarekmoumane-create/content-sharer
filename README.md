# Content Sharer

A Discord bot that reads creator accounts from one channel and posts their new
videos into another channel automatically.

You don't maintain a list anywhere. Whatever links live in your handles channel
*are* the list — paste a new creator in, and the next run starts watching them.

```
#creator-handles                          #new-videos
┌────────────────────────┐                ┌──────────────────────────────┐
│ tiktok.com/@someone    │   ──cron──▶    │ **someone** just posted on   │
│ youtube.com/@another   │   every 15m    │ tiktok                       │
│ instagram.com/third    │                │ https://tiktok.com/@...      │
└────────────────────────┘                └──────────────────────────────┘
```

## Why there's no `discord.js` here

A normal Discord bot holds a websocket open forever. Vercel is serverless —
nothing stays running — so that design can't deploy there. Instead this runs as
a **cron job** that talks to Discord's plain HTTP API: it reads the handles
channel, checks each creator, posts what's new, and exits. Same result, and it
fits the hosting you already use.

## Platform support

| Platform | Status | What it needs |
|---|---|---|
| **YouTube** | Works out of the box | Nothing. Uses each channel's free RSS feed. Covers Shorts and long-form. |
| **TikTok** | Needs a scraper key | `SCRAPER_PROVIDER=apify` + `APIFY_TOKEN`, or `rapidapi` + `RAPIDAPI_KEY`. |
| **Instagram** | Needs a scraper key | Same as TikTok. Only video/Reel posts are shared; photos are skipped. |

TikTok and Instagram have no official API that lists a given creator's uploads,
so a third-party scraper is unavoidable. Both platforms go through one small
interface (`lib/platforms/scraper.js`), so switching vendors is an env var, not
a rewrite. Leave `SCRAPER_PROVIDER=none` and YouTube still works fine.

## Setup

### 1. Create the Discord bot

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy it. That's `DISCORD_BOT_TOKEN`.
3. On the same tab, turn **Message Content Intent** ON. Without it the bot
   reads your handles channel as a wall of blank messages.
4. **OAuth2 → URL Generator**: scope `bot`, permissions **View Channels**,
   **Read Message History**, **Send Messages**. Open the generated URL and add
   the bot to your server.
5. Make sure the bot can actually see both channels (check channel-level
   permission overrides, not just the server-wide role).

### 2. Get the channel IDs

Discord → Settings → Advanced → **Developer Mode** on. Then right-click each
channel → **Copy Channel ID**.

- `DISCORD_SOURCE_CHANNEL_ID` — where the handles live
- `DISCORD_TARGET_CHANNEL_ID` — where videos get posted

### 3. Deploy

```bash
npm install
vercel                      # first deploy, links the project
```

In the Vercel dashboard: **Storage → Upstash Redis → Connect**. That sets
`KV_REST_API_URL` and `KV_REST_API_TOKEN` for you (same setup as
`follow-up-backend`).

Then add the rest under **Settings → Environment Variables** — see
`.env.example` for the annotated list. At minimum:

```
DISCORD_BOT_TOKEN
DISCORD_SOURCE_CHANNEL_ID
DISCORD_TARGET_CHANNEL_ID
CRON_SECRET          # any long random string
```

Redeploy so the cron picks them up: `vercel --prod`.

### 4. Verify before waiting on a cron

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/health
```

This reports whether the token works, whether both channels are reachable, and
**exactly which creators it parsed** — the fastest way to confirm your handles
channel is being read the way you expect.

Then do a no-op trial run that posts nothing:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://<your-app>.vercel.app/api/cron?dryRun=1"
```

## ⚠️ One thing to know about Vercel cron

**Hobby plan cron only fires once per day.** `vercel.json` requests every 15
minutes, which needs **Vercel Pro** ($20/mo). On Hobby the bot works correctly
but videos show up up to a day late.

If you'd rather not pay for Pro, the cheapest fix is to keep the deploy exactly
as-is and have a free external scheduler hit the endpoint:
[cron-job.org](https://cron-job.org) can call
`https://<your-app>.vercel.app/api/cron` every 15 minutes with the
`Authorization: Bearer <CRON_SECRET>` header. Nothing in the code changes.

## Behaviour worth knowing

- **Adding a creator never floods the channel.** The first time a creator is
  seen, their existing videos are marked as already-posted and nothing is sent.
  Set `BACKFILL_ON_ADD=latest` if you'd rather announce their newest video.
- **No double-posting.** Claiming a video is a single atomic Redis operation, so
  two overlapping runs can't both post it. The same YouTube channel listed as
  both `@handle` and `/channel/UC...` collapses onto one identity.
- **One broken creator doesn't stop the run.** Failures are collected and
  returned in the cron response; everyone else still gets checked.
- **Caps keep runs bounded.** `MAX_CREATORS_PER_RUN` rotates through a large
  roster across runs; `MAX_POSTS_PER_RUN` stops a burst from spamming the
  channel. Anything skipped is picked up next run, never dropped.
- **Nothing the bot posts can ping anyone** — mentions are stripped.

## Layout

```
api/
  cron.js          the scheduled job (this is the whole product)
  health.js        setup check: token, channels, parsed creator list
lib/
  poll.js          core logic: what's new, what to post
  creators.js      parses the handles channel into creators
  discord.js       minimal Discord REST client
  store.js         Upstash Redis: seen videos, caches, cursor
  platforms/
    index.js       registry
    youtube.js     RSS, no key needed
    tiktok.js      via scraper
    instagram.js   via scraper
    scraper.js     Apify / RapidAPI provider layer
```

### Adding a platform

Write a module exporting `fetchRecent(creator, count)` that returns
`{ id, url, title, author, publishedAt }` objects, add it to the registry in
`lib/platforms/index.js`, and teach `lib/creators.js` to recognise its URLs.
Nothing else changes.

## Tuning

All optional, all in `.env.example` with comments:

| Variable | Default | Does |
|---|---|---|
| `MAX_CREATORS_PER_RUN` | 25 | Creators checked per run; rotates through the rest |
| `VIDEOS_PER_CHECK` | 5 | How far back to look per creator |
| `MAX_POSTS_PER_RUN` | 15 | Ceiling on messages per run |
| `BACKFILL_ON_ADD` | `none` | `none` or `latest` |
| `POST_TEMPLATE` | see below | `{name}` `{url}` `{platform}` `{title}` |

```
**{name}** just posted on {platform}
{url}
```

Posting the bare URL on its own line is deliberate — Discord unfurls it into a
playable embed. Wrapping it in markdown breaks that.
