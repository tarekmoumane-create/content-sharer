// Shared plumbing for the platforms that have no usable official API.
//
// TikTok and Instagram both require a third-party scraper. Rather than hardwire
// one vendor, both adapters call through here, so switching provider is an env
// var change instead of a rewrite. Set SCRAPER_PROVIDER to "apify", "rapidapi",
// or "none" (which disables those platforms and leaves YouTube working).
export function provider() {
  return (process.env.SCRAPER_PROVIDER || "none").toLowerCase();
}

export class ScraperDisabled extends Error {
  constructor(platform) {
    super(
      `${platform} is not configured — set SCRAPER_PROVIDER (apify|rapidapi) and the matching key`,
    );
    this.name = "ScraperDisabled";
    this.disabled = true;
  }
}

// Apify's run-sync endpoint starts an actor, waits for it, and hands back the
// dataset in one request — which is exactly the shape a cron function wants.
// Runs can take 20-60s, which is why api/cron.js has a generous maxDuration.
export async function runApifyActor(actor, input) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error("APIFY_TOKEN is not set");

  const res = await fetch(
    `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Apify ${actor} -> ${res.status} ${detail.slice(0, 300)}`);
  }

  const items = await res.json();
  return Array.isArray(items) ? items : [];
}

export async function callRapidApi(host, path, params) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) throw new Error("RAPIDAPI_KEY is not set");

  const url = `https://${host}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, {
    headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": host },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`RapidAPI ${host}${path} -> ${res.status} ${detail.slice(0, 300)}`);
  }

  return res.json();
}

// Scraper payloads differ between vendors and drift over time, so every field
// read out of one goes through these instead of assuming a shape.
export function firstOf(obj, ...paths) {
  for (const path of paths) {
    let cur = obj;
    for (const part of path.split(".")) {
      if (cur == null) break;
      cur = cur[part];
    }
    if (cur != null && cur !== "") return cur;
  }
  return undefined;
}

export function asArray(obj, ...paths) {
  for (const path of paths) {
    const v = firstOf(obj, path);
    if (Array.isArray(v)) return v;
  }
  return Array.isArray(obj) ? obj : [];
}
