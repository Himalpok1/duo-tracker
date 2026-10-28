# duo-tracker

Watches Apple Store **in-store pickup** for every iPhone Duo model (all storage sizes, Star White and Night Sky, unlocked) at Apple Stores within 30 miles of your ZIP, and sends a push notification to your phone the moment one becomes available.

Runs free on GitHub Actions, checking about every 20 seconds, around the clock.

## Get alerts on your phone

1. Install the free **ntfy** app (App Store / Google Play).
2. Tap **+** and subscribe to your topic (the value of the `NTFY_TOPIC` secret). Keep it private: anyone who knows it can see your alerts.
3. When an alert arrives, tap it to open the exact model on apple.com, choose **Pickup**, and reserve it fast.

## Settings

Secrets (Settings → Secrets and variables → Actions → Secrets):

| Secret | What |
|---|---|
| `ZIP` | Your 5-digit ZIP code |
| `NTFY_TOPIC` | Your private ntfy topic name |

Optional variables (same page → Variables):

| Variable | Default | What |
|---|---|---|
| `RADIUS_MILES` | `30` | Max store distance |
| `INTERVAL_SEC` | `20` | Seconds between checks |
| `INCLUDE_CARRIER` | `false` | Also alert on AT&T / Verizon / T-Mobile models |
| `PARTS` | auto | Comma-separated Apple part numbers, if auto-detection breaks |

## Start, stop, test

- **Start / test:** Actions → Duo tracker → Run workflow (tick "Send a test push alert").
- **Stop:** Actions → Duo tracker → ⋯ → Disable workflow.
- Each run lasts ~5.5 hours; the hourly schedule queues the next one so there is no gap.

## Notes

- GitHub pauses scheduled workflows after 60 days with no repo activity; just re-enable it.
- If Apple blocks GitHub's servers, you'll get a "can't reach Apple" alert. The same script works on any computer: `ZIP=76177 NTFY_TOPIC=your-topic node tracker.js` (Node 20+).
- Not affiliated with Apple. Always confirm at checkout.
