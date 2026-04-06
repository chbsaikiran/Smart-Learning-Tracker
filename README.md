# Smart Learning Tracker

Chrome extension (Manifest V3) that estimates **deep vs shallow browsing**, **coding / learning / entertainment** mix, **passive vs active learning** (using tab media hints), and **rule-based insights**. **Daily aggregates** live in `chrome.storage.local` and are **not** cleared on sleep, lock, or hibernate. A **session activity log** (`slt_activity_log`) is stored in **`chrome.storage.session`** when supported: it survives sleep/lock and service worker restarts, and is **cleared when the browser process fully exits** (best available signal for “session end”; extensions cannot detect OS shutdown directly).

## Load the extension in Chrome

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**.
4. Select this folder: `Smart-Learning-Tracker` (the one that contains `manifest.json`).
5. Pin the extension if you want quick access to the popup.

### Permissions

On install, Chrome will ask for access to **all sites** so the content script can send lightweight heartbeats (and media hints) from normal pages. **Restricted URLs** (e.g. `chrome://`, the Chrome Web Store) do not run extension content scripts; time there is still updated via the service worker on tab events and the 1-minute alarm.

## Files

| File           | Role |
|----------------|------|
| `manifest.json` | MV3 manifest, permissions, content script registration |
| `background.js` | Tracking, classification, deep/shallow, storage, insights, daily notification |
| `content.js`    | Visible-tab heartbeat ~5s + `video`/`audio` playing heuristic |
| `popup.html` / `popup.js` / `styles.css` | Dashboard: charts, insights, export |

## Bonuses included

- **Daily summary notification** (yesterday’s totals) around **9:00** local time when the service worker runs (requires the browser to wake around that minute at least once).
- **Export JSON** from the popup: all `slt_*` keys from **local** storage plus **`slt_activity_log`** from **session** storage when present.
- **Deep-work streak**: consecutive days with **≥1 hour** deep work (see `slt_meta` in storage).

## Notes

- **Sleep / long suspend**: If no flush runs for several minutes (worker frozen, machine asleep, etc.), elapsed seconds are stored in **`gapSeconds`** for that calendar day so totals are not dropped and category rows are not overwritten by parallel writes. The popup combines **idle + gap** in “Idle / away / sleep gaps”.
- **Deep work** here means long stretches on the **same tab** with **relatively few** recent tab switches; **shallow** covers short bursts and heavy switching.
- **Passive consumption** uses **media playing** signals plus “video-first” hosts (e.g. Netflix); **active learning** uses coding/learning sites and YouTube titles that match learning keywords.
