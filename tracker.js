// iPhone Duo in-store pickup tracker.
// - Checks Apple's pickup availability for every iPhone Duo model near ZIP.
// - Publishes live status to the `status` branch (read by the GitHub Pages site).
// - Sends Web Push alerts to every iPhone that turned on alerts from the site.
// Runs on GitHub Actions (Node 20+).

const fs = require("fs");
const webpush = require("web-push");

const CONFIG = JSON.parse(fs.readFileSync(`${__dirname}/docs/config.json`, "utf8"));
const ZIP = (process.env.ZIP || "").trim();
const RADIUS_MILES = Number(process.env.RADIUS_MILES || 30);
const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || 20);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 330); // ~5.5h; the schedule queues the next run
const INCLUDE_CARRIER = /^(1|true|yes)$/i.test(process.env.INCLUDE_CARRIER || "");
const PARTS_OVERRIDE = (process.env.PARTS || "").split(/[\s,]+/).filter(Boolean);
const TEST_ALERT = /^(1|true|yes)$/i.test(process.env.TEST_ALERT || "");
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || "").trim();
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || `${CONFIG.owner}/${CONFIG.repo}`;

const BUY_BASE = "https://www.apple.com/shop/buy-iphone/iphone-duo";
const FULFILLMENT = "https://www.apple.com/shop/fulfillment-messages";
const CHUNK = 8; // parts per pickup request
const STATUS_EVERY_MS = 120_000;
const SUBS_EVERY_MS = 5 * 60_000;
const MAX_DROPS = 80;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: BUY_BASE,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) =>
  console.log(`[${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })}]`, ...a);

// ---------- GitHub helpers ----------
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { ok: res.ok, status: res.status, json };
}

async function loadPreviousStatus() {
  const r = await gh(`/contents/status.json?ref=status`, { headers: { Accept: "application/vnd.github.raw+json" } });
  if (r.ok && r.json && typeof r.json === "object") return r.json;
  return null;
}

// Replace the `status` branch with a single commit holding status.json (no growing history).
async function publishStatus(status) {
  if (!GH_TOKEN) return;
  try {
    const tree = await gh(`/git/trees`, {
      method: "POST",
      body: JSON.stringify({ tree: [{ path: "status.json", mode: "100644", type: "blob", content: JSON.stringify(status) }] }),
    });
    if (!tree.ok) throw new Error(`tree ${tree.status}`);
    const commit = await gh(`/git/commits`, {
      method: "POST",
      body: JSON.stringify({ message: "status", tree: tree.json.sha, parents: [] }),
    });
    if (!commit.ok) throw new Error(`commit ${commit.status}`);
    let ref = await gh(`/git/refs/heads/status`, {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.json.sha, force: true }),
    });
    if (!ref.ok) {
      ref = await gh(`/git/refs`, { method: "POST", body: JSON.stringify({ ref: "refs/heads/status", sha: commit.json.sha }) });
    }
    if (!ref.ok) throw new Error(`ref ${ref.status}`);
  } catch (e) {
    log("status publish failed:", e.message);
  }
}

// ---------- Web Push ----------
let subs = []; // [{name, sub}]

async function loadSubscriptions() {
  const list = await gh(`/contents/subscriptions?ref=main`);
  if (!list.ok || !Array.isArray(list.json)) return subs;
  const out = [];
  for (const f of list.json) {
    if (!f.name.endsWith(".json")) continue;
    const r = await gh(`/contents/subscriptions/${encodeURIComponent(f.name)}?ref=main`, {
      headers: { Accept: "application/vnd.github.raw+json" },
    });
    try {
      const sub = typeof r.json === "string" ? JSON.parse(r.json) : r.json;
      if (sub && sub.endpoint && sub.keys) out.push({ name: f.name, sub });
    } catch {
      log("bad subscription file:", f.name);
    }
  }
  subs = out;
  return subs;
}

async function push(payload, only) {
  if (!VAPID_PRIVATE_KEY) return log("(VAPID_PRIVATE_KEY not set) would push:", payload.title);
  const targets = only ? subs.filter((s) => only.includes(s.name)) : subs;
  for (const { name, sub } of targets) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 600, urgency: "high" });
    } catch (e) {
      log(`push to ${name} failed: ${e.statusCode || ""} ${e.body || e.message}`);
    }
  }
}

// ---------- Apple ----------
async function discoverParts() {
  const urls = [BUY_BASE, `${BUY_BASE}/7.6-inch-display-256gb-star-white-unlocked`];
  const found = new Set();
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { ...HEADERS, Accept: "text/html" } });
      const html = await res.text();
      log(`buy page ${url} -> HTTP ${res.status}, ${html.length} bytes`);
      for (const m of html.matchAll(/"partNumber"\s*:\s*"([A-Z0-9]{4,6}\/A)"/g)) found.add(m[1]);
      if (!found.size) for (const m of html.matchAll(/\b(M[A-Z0-9]{4}LL\/A)\b/g)) found.add(m[1]);
      if (found.size) break;
    } catch (e) {
      log("buy page fetch failed:", e.message);
    }
  }
  return [...found];
}

async function checkChunk(parts) {
  const q = new URLSearchParams({ pl: "true", "mts.0": "regular", "mts.1": "compact", cppart: "UNLOCKED/US", location: ZIP });
  parts.forEach((p, i) => q.set(`parts.${i}`, p));
  const res = await fetch(`${FULFILLMENT}?${q}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Apple HTTP ${res.status}`);
  const data = await res.json();
  return data?.body?.content?.pickupMessage?.stores || [];
}

function buyUrl(title) {
  const m = /(\d+\s?(?:GB|TB))\s+(.+?)(?:\s*\(|$)/i.exec(title || "");
  if (!m) return BUY_BASE;
  const storage = m[1].replace(/\s/g, "").toLowerCase();
  const color = m[2].trim().toLowerCase().replace(/\s+/g, "-");
  return `${BUY_BASE}/7.6-inch-display-${storage}-${color}-unlocked`;
}

const shortTitle = (t) => String(t).replace(/^iPhone Duo\s*/i, "").trim() || t;
const CARRIER_RE = /AT&T|Verizon|T-Mobile|Boost|Visible/i;

// ---------- main loop ----------
async function main() {
  if (!/^\d{5}$/.test(ZIP)) {
    console.error("Set the ZIP secret to a 5-digit ZIP code.");
    process.exit(1);
  }
  if (VAPID_PRIVATE_KEY) webpush.setVapidDetails(`https://github.com/${REPO}`, CONFIG.vapidPublicKey, VAPID_PRIVATE_KEY);

  const prev = (await loadPreviousStatus()) || {};
  const status = {
    updated: null,
    startedAt: new Date().toISOString(),
    radius: RADIUS_MILES,
    intervalSec: INTERVAL_SEC,
    ok: true,
    error: null,
    stores: [],
    models: [],
    drops: Array.isArray(prev.drops) ? prev.drops.slice(0, MAX_DROPS) : [],
    devices: 0,
    welcomed: Array.isArray(prev.welcomed) ? prev.welcomed : [],
  };
  // Any drop left "open" by a previous run is closed now.
  for (const d of status.drops) if (!d.end) d.end = prev.updated || status.startedAt;

  await loadSubscriptions();
  status.devices = subs.length;
  const welcomeNew = async () => {
    const fresh = subs.map((s) => s.name).filter((n) => !status.welcomed.includes(n));
    if (fresh.length) {
      await push({ title: "Alerts are on ✅", body: "This iPhone will get a notification the moment an iPhone Duo is ready for pickup near you.", url: CONFIG.siteUrl, tag: "welcome" }, fresh);
      status.welcomed.push(...fresh);
      log("welcomed", fresh.join(", "));
    }
  };
  await welcomeNew();
  if (TEST_ALERT) {
    await push({ title: "Test: iPhone Duo in stock", body: "Test alert from your Duo Tracker. Real alerts look like this.", url: CONFIG.siteUrl, tag: "test" });
    log(`test alert sent to ${subs.length} device(s)`);
  }

  const parts = PARTS_OVERRIDE.length ? PARTS_OVERRIDE : await discoverParts();
  if (!parts.length) {
    status.ok = false;
    status.error = "Couldn't read iPhone Duo models from Apple.";
    status.updated = new Date().toISOString();
    await publishStatus(status);
    log(status.error, "Set the PARTS repo variable manually.");
    process.exit(1);
  }
  log(`tracking ${parts.length} parts near ${ZIP} within ${RADIUS_MILES} mi`);

  const open = new Map(); // "storeNumber|part" -> drop object
  const deadline = Date.now() + RUN_MINUTES * 60_000;
  let lastPublish = 0;
  let lastSubs = Date.now();
  let failures = 0;
  let warned = false;

  while (Date.now() < deadline) {
    const stores = new Map(); // storeNumber -> {name, dist, items:{title:{available, quote}}}
    const models = new Set();
    const nowAvail = new Map();
    let okAll = true;
    let lastErr = null;

    for (let i = 0; i < parts.length; i += CHUNK) {
      const chunk = parts.slice(i, i + CHUNK);
      try {
        for (const s of await checkChunk(chunk)) {
          const dist = parseFloat(s.storedistance ?? s.storeDistanceWithUnit);
          if (!Number.isNaN(dist) && dist > RADIUS_MILES) continue;
          const store = stores.get(s.storeNumber) || { id: s.storeNumber, name: s.storeName, city: s.city || "", dist: Number.isNaN(dist) ? null : dist, items: {} };
          stores.set(s.storeNumber, store);
          for (const [part, a] of Object.entries(s.partsAvailability || {})) {
            const title = a?.messageTypes?.regular?.storePickupProductTitle || a?.messageTypes?.compact?.storePickupProductTitle || part;
            if (!/duo/i.test(title)) continue;
            if (!INCLUDE_CARRIER && CARRIER_RE.test(title)) continue;
            const name = shortTitle(title);
            models.add(name);
            const available = a.pickupDisplay === "available";
            store.items[name] = { available, quote: a.pickupSearchQuote || "" };
            if (available) nowAvail.set(`${s.storeNumber}|${part}`, { store: store.name, storeId: s.storeNumber, title, name, dist: store.dist, quote: a.pickupSearchQuote || "Available" });
          }
        }
      } catch (e) {
        okAll = false;
        lastErr = e.message;
        log(`check failed (${chunk.length} parts):`, e.message);
      }
      await sleep(400);
    }

    let changed = false;
    if (okAll) {
      failures = 0;
      status.ok = true;
      status.error = null;
      status.stores = [...stores.values()].sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99));
      status.models = sortModels([...models]);

      for (const [key, v] of nowAvail) {
        if (open.has(key)) continue;
        changed = true;
        const drop = { start: new Date().toISOString(), end: null, store: v.store, model: v.name, dist: v.dist, url: buyUrl(v.title) };
        open.set(key, drop);
        status.drops.unshift(drop);
        status.drops = status.drops.slice(0, MAX_DROPS);
        const body = `${v.name} is ready for pickup at Apple ${v.store}${v.dist != null ? ` (${v.dist} mi)` : ""}. ${v.quote}. Tap to reserve.`;
        log("IN STOCK:", body);
        await push({ title: `iPhone Duo in stock · ${v.store}`, body, url: drop.url, tag: key });
      }
      for (const [key, drop] of open) {
        if (!nowAvail.has(key)) {
          drop.end = new Date().toISOString();
          open.delete(key);
          changed = true;
        }
      }
    } else if (++failures >= 6) {
      status.ok = false;
      status.error = `Apple isn't answering (${lastErr}). It may be blocking GitHub's servers.`;
      if (failures >= 15 && !warned) {
        warned = true;
        await push({ title: "Duo Tracker can't reach Apple", body: "Checks have been failing for a few minutes. Open the tracker for details.", url: CONFIG.siteUrl, tag: "problem" });
      }
    }

    if (Date.now() - lastSubs > SUBS_EVERY_MS) {
      lastSubs = Date.now();
      await loadSubscriptions();
      status.devices = subs.length;
      await welcomeNew();
    }

    if (changed || Date.now() - lastPublish > STATUS_EVERY_MS) {
      status.updated = new Date().toISOString();
      await publishStatus(status);
      lastPublish = Date.now();
    }

    await sleep((INTERVAL_SEC + Math.random() * 5) * 1000);
  }

  for (const d of open.values()) d.end = new Date().toISOString();
  status.updated = new Date().toISOString();
  await publishStatus(status);
  log("run window finished; the next scheduled run takes over.");
}

function sortModels(names) {
  const size = (n) => {
    const m = /(\d+)\s*(GB|TB)/i.exec(n);
    return m ? Number(m[1]) * (m[2].toUpperCase() === "TB" ? 1024 : 1) : 0;
  };
  return names.sort((a, b) => size(a) - size(b) || a.localeCompare(b));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
