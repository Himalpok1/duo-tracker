# duo-tracker

Watches Apple Store **in-store pickup** for every iPhone Duo model (all storage sizes, Star White and Night Sky, unlocked) at Apple Stores within 30 miles, and sends a notification to your iPhone the moment one is ready for pickup.

- **Live page:** https://himalpok1.github.io/duo-tracker/ — stock at each nearby store, plus a log of recent drops.
- **Checker:** runs free on GitHub Actions about every 20 seconds, around the clock.

## Get alerts on your iPhone (iOS 16.4+)

1. Open the live page in **Safari**, tap **Share → Add to Home Screen**.
2. Open **Duo Tracker** from your Home Screen, tap **Turn on alerts**, and allow notifications.
3. Tap **Open GitHub → Commit changes** to save your iPhone, then **I saved it**.

Within ~5 minutes you'll get an "Alerts are on ✅" notification. Tapping a stock alert opens that exact model on apple.com — choose **Pickup** and reserve fast.

## Settings

Secrets (Settings → Secrets and variables → Actions → Secrets):

| Secret | What |
|---|---|
| `ZIP` | Your 5-digit ZIP code |
| `VAPID_PRIVATE_KEY` | Private key that signs the push notifications (keep secret) |

Optional variables (same page → Variables):

| Variable | Default | What |
|---|---|---|
| `RADIUS_MILES` | `30` | Max store distance |
| `INTERVAL_SEC` | `20` | Seconds between checks |
| `INCLUDE_CARRIER` | `false` | Also alert on AT&T / Verizon / T-Mobile models |
| `PARTS` | auto | Comma-separated Apple part numbers, if auto-detection breaks |

## Start, stop, test

- **Start / test:** Actions → Duo tracker → Run workflow (tick the test box to ping every saved iPhone).
- **Stop:** Actions → Duo tracker → ⋯ → Disable workflow.
- **Remove a device:** delete its file in `subscriptions/`.
- Each run lasts ~5.5 hours; the hourly schedule queues the next one so there's no gap.

## Notes

- Live status lives on the `status` branch (one commit, overwritten each update).
- GitHub pauses scheduled workflows after 60 days with no repo activity; just re-enable it.
- If Apple blocks GitHub's servers, the page shows "Can't reach Apple" and you get a notification.
- Not affiliated with Apple. Always confirm at checkout.
