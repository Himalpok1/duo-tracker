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
const ON_GITHUB = process.env.GITHUB_ACTIONS === "true";
// On GitHub each run lasts ~5.5h and the schedule queues the next one; at home it runs forever (0).
const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? (ON_GITHUB ? 330 : 0));
const INCLUDE_CARRIER = /^(1|true|yes)$/i.test(process.env.INCLUDE_CARRIER || "");
const PARTS_OVERRIDE = (process.env.PARTS || "").split(/[\s,]+/).filter(Boolean);
const TEST_ALERT = /^(1|true|yes)$/i.test(process.env.TEST_ALERT || "");
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || "").trim();
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const REPO = process.env.GITHUB_REPOSITORY || `${CONFIG.owner}/${CONFIG.repo}`;

const BUY_BASE = "https://www.apple.com/shop/buy-iphone/iphone-duo";
const FULFILLMENT = "https://www.apple.com/shop/fulfillment-messages";
const CHUNK = 12; // parts per pickup request (all iPhone Duo models fit in one)
const STATUS_EVERY_MS = 120_000;
const SUBS_EVERY_MS = 2 * 60_000;
const MAX_DROPS = 300; // ~30 days of history for the "when drops happen" chart

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
// Devices come from three places, merged by id:
//  1. the page's "Turn on alerts" button, relayed through a private ntfy.sh topic (no app needed)
//  2. devices remembered in status.json from earlier runs
//  3. optional files in the repo's subscriptions/ folder
let subs = []; // [{name, sub}]
let dropped = new Set(); // ids whose push endpoint expired

const validSub = (s) => s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.keys && s.keys.p256dh && s.keys.auth;

async function loadSubscriptions(remembered = []) {
  const byName = new Map();
  for (const r of remembered) if (validSub(r.sub)) byName.set(r.name, r);

  // 1. relay
  if (CONFIG.relayTopic) {
    try {
      const res = await fetch(`https://ntfy.sh/${CONFIG.relayTopic}/json?poll=1&since=12h`);
      for (const line of (await res.text()).split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.event !== "message") continue;
          const msg = JSON.parse(ev.message);
          if (/^[a-z0-9-]{4,40}$/i.test(msg.id || "") && validSub(msg.sub)) {
            byName.set(`dev-${msg.id}`, { name: `dev-${msg.id}`, sub: msg.sub, prefs: cleanPrefs(msg.prefs) });
          }
        } catch {}
      }
    } catch (e) {
      log("relay read failed:", e.message);
    }
  }

  // 3. repo folder
  const list = await gh(`/contents/subscriptions?ref=main`);
  if (list.ok && Array.isArray(list.json)) {
    for (const f of list.json) {
      if (!f.name.endsWith(".json")) continue;
      const r = await gh(`/contents/subscriptions/${encodeURIComponent(f.name)}?ref=main`, {
        headers: { Accept: "application/vnd.github.raw+json" },
      });
      try {
        const sub = typeof r.json === "string" ? JSON.parse(r.json) : r.json;
        if (validSub(sub)) byName.set(f.name, { name: f.name, sub });
      } catch {}
    }
  }
  // The same iPhone can be registered more than once (e.g. via the page and a repo file): keep one per endpoint.
  const seen = new Set();
  // Prefer page registrations (they carry alert preferences) over repo files for the same iPhone.
  const ordered = [...byName.values()].sort((a, b) => Number(!a.name.startsWith("dev-")) - Number(!b.name.startsWith("dev-")));
  subs = ordered.filter((s) => {
    if (dropped.has(s.name) || seen.has(s.sub.endpoint)) return false;
    seen.add(s.sub.endpoint);
    return true;
  });
  return subs;
}

// Alert preferences chosen on the page: empty list = everything.
function cleanPrefs(p) {
  const list = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === "string" && v.length < 60).slice(0, 30) : []);
  return p && typeof p === "object" ? { models: list(p.models), stores: list(p.stores) } : { models: [], stores: [] };
}
const wants = (prefs, model, store) =>
  (!prefs?.models?.length || prefs.models.includes(model)) && (!prefs?.stores?.length || prefs.stores.includes(store));

async function push(payload, only, match) {
  if (!VAPID_PRIVATE_KEY) return log("(VAPID_PRIVATE_KEY not set) would push:", payload.title);
  let targets = only ? subs.filter((s) => only.includes(s.name)) : subs;
  if (match) targets = targets.filter((s) => match(s.prefs));
  for (const { name, sub } of targets) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 600, urgency: "high" });
    } catch (e) {
      log(`push to ${name} failed: ${e.statusCode || ""} ${e.body || e.message}`);
      if (e.statusCode === 404 || e.statusCode === 410) {
        dropped.add(name);
        subs = subs.filter((s) => s.name !== name);
      }
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

// Apple's bot filter (HTTP 541) treats request shapes differently, so try a few and keep the first that works.
const VARIANTS = [
  { id: "retail-pickup-multi", url: "https://www.apple.com/shop/retail/pickup-message", base: { pl: "true", cppart: "UNLOCKED/US" }, multi: true, browser: true },
  { id: "fulfillment-multi", url: FULFILLMENT, base: { pl: "true", "mts.0": "regular", "mts.1": "compact", cppart: "UNLOCKED/US" }, multi: true, browser: true },
  { id: "fulfillment-single", url: FULFILLMENT, base: { "mts.0": "regular", "mts.1": "compact" }, multi: false, browser: true },
  { id: "fulfillment-plain", url: FULFILLMENT, base: { pl: "true", "mts.0": "regular" }, multi: false, browser: false },
  { id: "retail-pickup", url: "https://www.apple.com/shop/retail/pickup-message", base: { pl: "true", cppart: "UNLOCKED/US" }, multi: false, browser: true },
];
let variant = VARIANTS[0];
let cookie = "";

const BROWSER_HEADERS = {
  ...HEADERS,
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
  "X-Requested-With": "XMLHttpRequest",
};

async function warmCookies() {
  try {
    const res = await fetch(BUY_BASE, { headers: { ...HEADERS, Accept: "text/html" } });
    const set = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    cookie = set.map((c) => c.split(";")[0]).join("; ");
    return res.status;
  } catch (e) {
    return e.message;
  }
}

async function request(v, parts) {
  const q = new URLSearchParams({ ...v.base, location: ZIP });
  parts.forEach((p, i) => q.set(`parts.${i}`, p));
  const headers = { ...(v.browser ? BROWSER_HEADERS : HEADERS), ...(cookie ? { Cookie: cookie } : {}) };
  const res = await fetch(`${v.url}?${q}`, { headers });
  if (!res.ok) throw new Error(`Apple HTTP ${res.status}`);
  const data = await res.json();
  return data?.body?.content?.pickupMessage?.stores || data?.body?.stores || [];
}

async function probe(parts) {
  const diag = { buyPage: await warmCookies(), cookies: cookie ? cookie.split(";").length : 0, variants: {} };
  for (const v of VARIANTS) {
    try {
      const stores = await request(v, v.multi ? parts.slice(0, CHUNK) : parts.slice(0, 1));
      diag.variants[v.id] = `ok (${stores.length} stores)`;
      if (!diag.working) { diag.working = v.id; variant = v; }
    } catch (e) {
      diag.variants[v.id] = e.message;
    }
    await sleep(1500);
  }
  log("probe:", JSON.stringify(diag));
  return diag;
}

const chunkSize = () => (variant.multi ? CHUNK : 1);
const checkChunk = (parts) => request(variant, parts);

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
    host: ON_GITHUB ? "GitHub" : "Home lab",
    checks: 0,
    lastCheck: null,
    radius: RADIUS_MILES,
    intervalSec: INTERVAL_SEC,
    ok: true,
    error: null,
    stores: [],
    models: [],
    drops: Array.isArray(prev.drops) ? prev.drops.slice(0, MAX_DROPS) : [],
    devices: 0,
    welcomed: Array.isArray(prev.welcomed) ? prev.welcomed : [],
    subscriptions: Array.isArray(prev.subscriptions) ? prev.subscriptions : [],
    warnedAt: prev.warnedAt || null,
    diag: null,
  };
  // Any drop left "open" by a previous run is closed now.
  for (const d of status.drops) if (!d.end) d.end = prev.updated || status.startedAt;

  const refreshSubs = async () => {
    await loadSubscriptions(status.subscriptions);
    status.subscriptions = subs;
    status.devices = subs.length;
  };
  await refreshSubs();
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
  status.diag = await probe(parts);
  status.diag.parts = parts.length;
  status.updated = new Date().toISOString();
  await publishStatus(status);

  const open = new Map(); // "storeNumber|part" -> drop object
  const deadline = RUN_MINUTES > 0 ? Date.now() + RUN_MINUTES * 60_000 : Infinity;
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

    for (let i = 0; i < parts.length; i += chunkSize()) {
      const chunk = parts.slice(i, i + chunkSize());
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
        break; // don't keep hitting Apple once it pushes back
      }
      await sleep(400);
    }

    let changed = false;
    if (okAll) {
      failures = 0;
      status.checks++;
      status.lastCheck = new Date().toISOString();
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
        await push({ title: `iPhone Duo in stock · ${v.store}`, body, url: drop.url, tag: key }, null, (p) => wants(p, v.name, v.store));
      }
      for (const [key, drop] of open) {
        if (!nowAvail.has(key)) {
          drop.end = new Date().toISOString();
          open.delete(key);
          changed = true;
        }
      }
    } else if (++failures >= 2) {
      status.ok = false;
      status.error = `Apple is pushing back (${lastErr}). Slowing down and retrying automatically.`;
      if (failures === 3 || failures % 10 === 0) status.diag = { ...(await probe(parts)), parts: parts.length };
      if (ON_GITHUB && failures >= 8) {
        // Blocked for 10+ minutes: end this run so the next one starts on a fresh GitHub machine (new IP).
        status.updated = new Date().toISOString();
        await publishStatus(status);
        log("still blocked; ending run so a fresh machine takes over.");
        return;
      }
      const dayAgo = Date.now() - 24 * 3600_000;
      if (failures >= 5 && !warned && (!status.warnedAt || new Date(status.warnedAt) < dayAgo)) {
        warned = true;
        status.warnedAt = new Date().toISOString();
        await push({ title: "Duo Tracker can't reach Apple", body: "Checks have been failing for a few minutes. Open the tracker for details.", url: CONFIG.siteUrl, tag: "problem" });
      }
    }

    if (Date.now() - lastSubs > SUBS_EVERY_MS) {
      lastSubs = Date.now();
      await refreshSubs();
      await welcomeNew();
    }

    if (changed || Date.now() - lastPublish > STATUS_EVERY_MS) {
      status.updated = new Date().toISOString();
      await publishStatus(status);
      lastPublish = Date.now();
    }

    // Back off exponentially while Apple is blocking (up to 10 min between tries).
    const backoff = failures > 0 ? Math.min(INTERVAL_SEC * 2 ** failures, 600) : INTERVAL_SEC;
    await sleep((backoff + Math.random() * 5) * 1000);
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
