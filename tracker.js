// iPhone Duo in-store pickup tracker.
// Checks Apple's pickup availability for every iPhone Duo model at Apple Stores
// near ZIP, and sends a push alert through ntfy.sh when one becomes available.
// No dependencies: Node 20+ (built-in fetch).

const ZIP = (process.env.ZIP || "").trim();
const NTFY_TOPIC = (process.env.NTFY_TOPIC || "").trim();
const RADIUS_MILES = Number(process.env.RADIUS_MILES || 30);
const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || 20);
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 330); // ~5.5h, then the workflow restarts
const INCLUDE_CARRIER = /^(1|true|yes)$/i.test(process.env.INCLUDE_CARRIER || "");
const PARTS_OVERRIDE = (process.env.PARTS || "").split(/[\s,]+/).filter(Boolean);
const TEST_ALERT = /^(1|true|yes)$/i.test(process.env.TEST_ALERT || "");

const BUY_BASE = "https://www.apple.com/shop/buy-iphone/iphone-duo";
const FULFILLMENT = "https://www.apple.com/shop/fulfillment-messages";
const CHUNK = 8; // parts per pickup request

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: BUY_BASE,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
const log = (...a) => console.log(`[${now()}]`, ...a);

async function notify(title, message, url, priority = "high") {
  if (!NTFY_TOPIC) return log("(no NTFY_TOPIC set) would notify:", title, message);
  const headers = { Title: title, Priority: priority, Tags: "iphone" };
  if (url) {
    headers.Click = url;
    headers.Actions = `view, Buy now, ${url}`;
  }
  try {
    const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: "POST",
      headers,
      body: message,
    });
    if (!res.ok) log("ntfy error", res.status, await res.text());
  } catch (e) {
    log("ntfy failed:", e.message);
  }
}

// Find every iPhone Duo part number from Apple's buy page.
async function discoverParts() {
  const urls = [BUY_BASE, `${BUY_BASE}/7.6-inch-display-256gb-star-white-unlocked`];
  const found = new Set();
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { ...HEADERS, Accept: "text/html" } });
      const html = await res.text();
      log(`buy page ${url} -> HTTP ${res.status}, ${html.length} bytes`);
      for (const m of html.matchAll(/"partNumber"\s*:\s*"([A-Z0-9]{4,6}\/A)"/g)) found.add(m[1]);
      if (found.size === 0) {
        for (const m of html.matchAll(/\b(M[A-Z0-9]{4}LL\/A)\b/g)) found.add(m[1]);
      }
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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data?.body?.content?.pickupMessage?.stores || [];
}

function buyUrl(title) {
  // "iPhone Duo 512GB Star White" -> .../7.6-inch-display-512gb-star-white-unlocked
  const m = /(\d+\s?(?:GB|TB))\s+(.+?)(?:\s*\(|$)/i.exec(title || "");
  if (!m) return BUY_BASE;
  const storage = m[1].replace(/\s/g, "").toLowerCase();
  const color = m[2].trim().toLowerCase().replace(/\s+/g, "-");
  return `${BUY_BASE}/7.6-inch-display-${storage}-${color}-unlocked`;
}

const CARRIER_RE = /AT&T|Verizon|T-Mobile|Boost|Visible/i;

async function main() {
  if (!/^\d{5}$/.test(ZIP)) {
    console.error("Set the ZIP secret to a 5-digit ZIP code.");
    process.exit(1);
  }
  if (TEST_ALERT) {
    await notify("Test: iPhone Duo in stock", "This is a test alert from your Duo tracker. Tap to open Apple's iPhone Duo page.", BUY_BASE, "default");
    log("test alert sent");
  }

  let parts = PARTS_OVERRIDE.length ? PARTS_OVERRIDE : await discoverParts();
  if (!parts.length) {
    log("Could not find iPhone Duo part numbers. Set the PARTS repo variable manually.");
    await notify("Duo tracker problem", "Couldn't read iPhone Duo models from Apple. Check the GitHub Actions log.", null, "default");
    process.exit(1);
  }
  log(`tracking ${parts.length} parts near ${ZIP} within ${RADIUS_MILES} mi:`, parts.join(" "));

  const lastAvailable = new Set(); // "store|part" keys currently in stock
  const deadline = Date.now() + RUN_MINUTES * 60_000;
  let failures = 0;
  let cycle = 0;
  let warnedBlock = false;

  while (Date.now() < deadline) {
    cycle++;
    const available = new Map(); // key -> {store, title, quote, dist}
    const storeNames = new Set();
    let ok = true;

    for (let i = 0; i < parts.length; i += CHUNK) {
      const chunk = parts.slice(i, i + CHUNK);
      try {
        const stores = await checkChunk(chunk);
        for (const s of stores) {
          const dist = parseFloat(s.storedistance ?? s.storeDistanceWithUnit);
          if (!Number.isNaN(dist) && dist > RADIUS_MILES) continue;
          storeNames.add(s.storeName);
          for (const [part, a] of Object.entries(s.partsAvailability || {})) {
            const title = a?.messageTypes?.regular?.storePickupProductTitle || a?.messageTypes?.compact?.storePickupProductTitle || part;
            if (!/duo/i.test(title)) continue;
            if (!INCLUDE_CARRIER && CARRIER_RE.test(title)) continue;
            if (a.pickupDisplay === "available") {
              available.set(`${s.storeNumber}|${part}`, { store: s.storeName, title, quote: a.pickupSearchQuote || "Available", dist });
            }
          }
        }
      } catch (e) {
        ok = false;
        log(`check failed (${chunk.length} parts):`, e.message);
      }
      await sleep(500);
    }

    if (ok) {
      failures = 0;
      if (cycle === 1) log(`stores within ${RADIUS_MILES} mi:`, [...storeNames].join(", ") || "(none found)");
      for (const [key, v] of available) {
        if (!lastAvailable.has(key)) {
          const msg = `${v.title} is ready for pickup at Apple ${v.store} (${isNaN(v.dist) ? "" : v.dist + " mi, "}${v.quote}). Reserve it now!`;
          log("IN STOCK:", msg);
          await notify(`iPhone Duo in stock: ${v.store}`, msg, buyUrl(v.title), "urgent");
        }
      }
      for (const key of [...lastAvailable]) if (!available.has(key)) lastAvailable.delete(key);
      for (const key of available.keys()) lastAvailable.add(key);
      if (cycle % 30 === 1) log(`cycle ${cycle}: ${available.size} in stock across ${storeNames.size} stores`);
    } else if (++failures >= 15 && !warnedBlock) {
      warnedBlock = true;
      await notify("Duo tracker can't reach Apple", "Apple has been refusing checks for a few minutes (it may be blocking GitHub's servers). See the Actions log.", null, "default");
    }

    await sleep((INTERVAL_SEC + Math.random() * 5) * 1000);
  }
  log("run window finished; next scheduled run takes over.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
