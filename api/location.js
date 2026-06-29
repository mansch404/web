// Stores "where Manuel is right now" so every visitor sees the same zone.
// GET  -> { timeZone }            (public, no auth)
// POST -> { timeZone } + header x-set-secret === SET_SECRET   (owner only)
//
// Backed by Vercel KV / Upstash Redis over its REST API (no npm deps needed).
// Until KV + SET_SECRET are configured it gracefully falls back to DEFAULT_ZONE
// and rejects writes, so the site still works.

const STORE_KEY = "home_timezone";
const DEFAULT_ZONE = "Asia/Tokyo";

function kvEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function kvGet() {
  const e = kvEnv();
  if (!e) return null;
  const r = await fetch(`${e.url}/get/${STORE_KEY}`, {
    headers: { Authorization: `Bearer ${e.token}` }
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.result || null;
}

async function kvSet(value) {
  const e = kvEnv();
  if (!e) return false;
  const r = await fetch(`${e.url}/set/${STORE_KEY}/${encodeURIComponent(value)}`, {
    headers: { Authorization: `Bearer ${e.token}` }
  });
  return r.ok;
}

function isValidZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method === "GET") {
    const tz = (await kvGet()) || DEFAULT_ZONE;
    res.setHeader("cache-control", "no-store");
    res.status(200).json({ timeZone: tz });
    return;
  }

  if (req.method === "POST") {
    const secret = process.env.SET_SECRET;
    if (!secret || req.headers["x-set-secret"] !== secret) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    const tz = body && body.timeZone;
    if (!isValidZone(tz)) {
      res.status(400).json({ error: "invalid timeZone" });
      return;
    }
    const ok = await kvSet(tz);
    res.status(ok ? 200 : 500).json({ timeZone: tz, saved: ok });
    return;
  }

  res.setHeader("allow", "GET, POST");
  res.status(405).end();
};
