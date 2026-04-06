/**
 * Smart Learning Tracker — background service worker (Manifest V3)
 *
 * Time attribution: event-driven (tab/window/idle) + content heartbeats (~5s) +
 * chrome.alarms periodic flush (Chrome repeating alarms are ≥1 minute — heartbeats
 * keep same-tab attribution tighter when the service worker is awake).
 * Data is aggregated per day in chrome.storage.local (no raw event log).
 */

const STORAGE_DAY_PREFIX = "slt_day_";
const STORAGE_META_KEY = "slt_meta";
/**
 * Detailed session log in chrome.storage.session when available — survives sleep/lock/SW restarts;
 * cleared when the browser process exits (full quit). Falls back to local if session API missing.
 */
const STORAGE_LOG_KEY = "slt_activity_log";

function activityLogStorage() {
  return chrome.storage.session ?? chrome.storage.local;
}
const LOG_MAX_ENTRIES = 2500;

/**
 * If no flush ran for this long *and* Chrome is not in a normal reading context (see flushTime),
 * treat elapsed time as gapSeconds (sleep / lock / away) instead of wrongly attributing to a tab.
 */
const GAP_THRESHOLD_MS = 5 * 60 * 1000;
/** Ignore absurd clock jumps in one flush (still preserves storage via gap path). */
const SANITY_MAX_DELTA_SEC = 24 * 3600;

/**
 * Serialize all chrome.storage.local read–modify–write paths. Parallel flushes after resume
 * were racing and overwriting each other, which looked like “lost” data in exports.
 */
let storageLock = Promise.resolve();
function withStorageLock(task) {
  const run = storageLock.then(() => task());
  storageLock = run.catch(() => {});
  return run;
}

/** Hosts / patterns for rule-based classification */
const CODING_HOSTS = [
  "github.com",
  "stackoverflow.com",
  "stackexchange.com",
  "leetcode.com",
  "hackerrank.com",
  "codewars.com",
  "replit.com",
  "codesandbox.io",
  "gitlab.com",
  "bitbucket.org",
  "codepen.io",
  "npmjs.com",
  "pypi.org",
  "pkg.go.dev",
  "crates.io",
  "kaggle.com",
];

/** Print / epaper reading — The Hindu (incl. Frontline), Times of India epapers */
const NEWSPAPER_HOST_SUBSTR = [
  "thehindu.com", // www, frontline.thehindu.com, etc.
  "timesofindia.indiatimes.com",
  "timesofindia.com",
  "epaper.timesofindia",
  "toiplus.timesofindia",
];

function isNewspaperUrl(urlLower) {
  if (NEWSPAPER_HOST_SUBSTR.some((h) => urlLower.includes(h))) return true;
  // BCCL epaper / archive viewers sometimes live on indiatimes.com with epaper in path or host
  if (urlLower.includes("indiatimes.com") && urlLower.includes("epaper")) return true;
  return false;
}

const LEARNING_HOST_SUBSTR = [
  "developer.mozilla.org",
  "mdn.io",
  "readthedocs.io",
  "dev.to",
  "medium.com",
  "coursera.org",
  "udemy.com",
  "twitter.com",
  "x.com",
  "chatgpt.com",
  "freecodecamp.org",
  "w3schools.com",
  "realpython.com",
  "kotlinlang.org",
  "learn.microsoft.com",
  "canvas.instructure.com",
  "docs.",
];

const ENTERTAINMENT_HOSTS = [
  "youtube.com",
  "netflix.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "twitch.tv",
  "reddit.com",
  "disney.com",
  "hulu.com",
  "primevideo.com",
];

/** Often video-first: count time as passive consumption even if <video> not detected */
const PASSIVE_VIDEO_HOSTS = [
  "netflix.com",
  "twitch.tv",
  "tiktok.com",
  "primevideo.com",
  "disney.com",
  "hulu.com",
];

const LEARNING_TITLE_RE =
  /\b(tutorial|course|lesson|learn(ing)?|documentation|docs\b|guide|how\s*to|lecture|walkthrough|bootcamp|certification)\b/i;

const state = {
  lastUpdate: Date.now(),
  idleState: "active",
  /** True only when a normal Chrome window actually has OS focus (see initWindowAndTabState). */
  windowFocused: false,
  activeTabId: null,
  activeWindowId: null,
  /** Cached from last tab query */
  currentUrl: "",
  currentTitle: "",
  category: "other",
  /** When user focused current tab (ms) */
  tabFocusStarted: Date.now(),
  /** Recent tab-activation timestamps for shallow/deep heuristics */
  switchTimestamps: [],
  /** Last content-script heartbeat: media playing + tab id */
  lastMediaPlaying: false,
  lastMediaTabId: null,
  lastMediaAt: 0,
  /** Preserve tab id across Chrome window blur so dwell time can continue */
  blurRememberTabId: null,
};

function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function emptyDayRecord(dateKey) {
  return {
    dateKey,
    totalActiveSeconds: 0,
    idleSeconds: 0,
    byCategory: { coding: 0, learning: 0, newspaper: 0, entertainment: 0, other: 0 },
    deepSeconds: 0,
    shallowSeconds: 0,
    passiveSeconds: 0,
    activeLearningSeconds: 0,
    /** Per-hour tab switch counts (0–23) for insights */
    hourlyTabSwitches: Array(24).fill(0),
    /** Rough buckets for timeline: hour -> seconds per category */
    hourlyByCategory: Array.from({ length: 24 }, () => ({
      coding: 0,
      learning: 0,
      newspaper: 0,
      entertainment: 0,
      other: 0,
    })),
    /** Sleep / lock / suspended worker — time preserved but not assigned to a site */
    gapSeconds: 0,
    lastUpdated: Date.now(),
  };
}

function migrateDayRecord(rec, dateKey) {
  if (!rec || typeof rec !== "object") return emptyDayRecord(dateKey);
  if (typeof rec.gapSeconds !== "number") rec.gapSeconds = 0;
  if (!rec.byCategory) {
    rec.byCategory = { coding: 0, learning: 0, newspaper: 0, entertainment: 0, other: 0 };
  }
  ["coding", "learning", "newspaper", "entertainment", "other"].forEach((k) => {
    if (typeof rec.byCategory[k] !== "number") rec.byCategory[k] = 0;
  });
  if (!Array.isArray(rec.hourlyTabSwitches) || rec.hourlyTabSwitches.length !== 24) {
    rec.hourlyTabSwitches = Array(24).fill(0);
  }
  if (!Array.isArray(rec.hourlyByCategory) || rec.hourlyByCategory.length !== 24) {
    rec.hourlyByCategory = Array.from({ length: 24 }, () => ({
      coding: 0,
      learning: 0,
      newspaper: 0,
      entertainment: 0,
      other: 0,
    }));
  } else {
    const hourKeys = ["coding", "learning", "newspaper", "entertainment", "other"];
    rec.hourlyByCategory.forEach((bucket) => {
      hourKeys.forEach((k) => {
        if (typeof bucket[k] !== "number") bucket[k] = 0;
      });
    });
  }
  return rec;
}

/**
 * Append to session log. Call only inside withStorageLock, or wrap with withStorageLock.
 */
async function appendLogUnlocked(entry) {
  const area = activityLogStorage();
  const data = await area.get(STORAGE_LOG_KEY);
  const log = data[STORAGE_LOG_KEY];
  const entries = Array.isArray(log?.entries) ? log.entries.slice() : [];
  entries.push({ t: Date.now(), ...entry });
  const trimmed =
    entries.length > LOG_MAX_ENTRIES ? entries.slice(-LOG_MAX_ENTRIES) : entries;
  await area.set({ [STORAGE_LOG_KEY]: { entries: trimmed } });
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Rule-based category from URL + title (no ML).
 * Order: coding → newspaper (The Hindu / TOI epapers / Frontline) → entertainment → learning → other.
 */
function classifyActivity(url, title) {
  const u = (url || "").toLowerCase();
  const t = (title || "").toLowerCase();
  const onYoutube = u.includes("youtube.com") || u.includes("youtu.be");

  if (CODING_HOSTS.some((h) => u.includes(h))) return "coding";

  if (isNewspaperUrl(u)) return "newspaper";

  if (ENTERTAINMENT_HOSTS.some((h) => u.includes(h))) {
    if (onYoutube && LEARNING_TITLE_RE.test(title || "")) return "learning";
    return "entertainment";
  }

  if (LEARNING_HOST_SUBSTR.some((h) => u.includes(h))) return "learning";
  if (LEARNING_TITLE_RE.test(title || "")) return "learning";
  if (onYoutube) return LEARNING_TITLE_RE.test(title || "") ? "learning" : "entertainment";

  return "other";
}

function switchesInLastMinutes(minutes) {
  const cutoff = Date.now() - minutes * 60 * 1000;
  return state.switchTimestamps.filter((t) => t >= cutoff).length;
}

function pruneSwitchTimestamps() {
  const cutoff = Date.now() - 20 * 60 * 1000;
  state.switchTimestamps = state.switchTimestamps.filter((t) => t >= cutoff);
}

/**
 * Deep: sustained focus on same tab (≥10 min) and relatively few recent switches.
 * Shallow: many recent switches OR still within first 2 minutes on tab (burst).
 */
function allocateDeepShallow(seconds) {
  const dwellMs = Date.now() - state.tabFocusStarted;
  const switches10m = switchesInLastMinutes(5);
  const deepEligible = dwellMs >= 5 * 60 * 1000 && switches10m <= 5;
  const shallowHint = dwellMs < 2 * 60 * 1000 || switches10m >= 6;

  if (deepEligible && !shallowHint) return { deep: seconds, shallow: 0 };
  if (shallowHint || !deepEligible) return { deep: 0, shallow: seconds };
  return { deep: 0, shallow: seconds };
}

function isPassiveContext(url, title, category, mediaPlaying) {
  const u = (url || "").toLowerCase();
  const onYoutube = u.includes("youtube.com");
  const learningYt = onYoutube && LEARNING_TITLE_RE.test(title || "");

  if (category === "coding" || category === "learning" || category === "newspaper") return false;
  if (learningYt) return false;

  if (PASSIVE_VIDEO_HOSTS.some((h) => u.includes(h))) return true;
  if (category === "entertainment" && mediaPlaying) return true;
  if (onYoutube && !learningYt && mediaPlaying) return true;
  return false;
}

function isActiveLearningContext(category, url, title) {
  if (category === "coding" || category === "learning" || category === "newspaper") return true;
  const u = (url || "").toLowerCase();
  if (u.includes("youtube.com") && LEARNING_TITLE_RE.test(title || "")) return true;
  return false;
}

async function loadDayRecord(dateKey) {
  const key = STORAGE_DAY_PREFIX + dateKey;
  const data = await chrome.storage.local.get(key);
  if (data[key]) {
    const raw =
      typeof structuredClone === "function"
        ? structuredClone(data[key])
        : JSON.parse(JSON.stringify(data[key]));
    return migrateDayRecord(raw, dateKey);
  }
  return emptyDayRecord(dateKey);
}

async function saveDayRecord(record) {
  record.lastUpdated = Date.now();
  await chrome.storage.local.set({ [STORAGE_DAY_PREFIX + record.dateKey]: record });
}

async function loadMeta() {
  const data = await chrome.storage.local.get(STORAGE_META_KEY);
  return (
    data[STORAGE_META_KEY] || {
      deepWorkStreak: 0,
      /** Last calendar date (YYYY-MM-DD) that qualified for streak (≥1h deep that day) */
      lastQualifiedDate: "",
      summaryHour: 9,
      /** Last day we showed a daily summary for (typically yesterday’s key) */
      lastSummaryDay: "",
    }
  );
}

async function saveMeta(meta) {
  await chrome.storage.local.set({ [STORAGE_META_KEY]: meta });
}

/**
 * Apply elapsed seconds to today's aggregates (idle handled separately).
 */
async function applyActiveSeconds(seconds) {
  if (seconds <= 0) return;
  const dateKey = todayKey();
  const record = await loadDayRecord(dateKey);
  const hour = new Date().getHours();
  const { deep, shallow } = allocateDeepShallow(seconds);
  const cat = state.category;
  const mediaPlaying =
    state.lastMediaTabId === state.activeTabId &&
    Date.now() - state.lastMediaAt < 15000;

  record.totalActiveSeconds += seconds;
  record.byCategory[cat] = (record.byCategory[cat] || 0) + seconds;
  record.deepSeconds += deep;
  record.shallowSeconds += shallow;
  const hourBucket = record.hourlyByCategory[hour];
  hourBucket[cat] = (hourBucket[cat] || 0) + seconds;

  if (isPassiveContext(state.currentUrl, state.currentTitle, cat, mediaPlaying)) {
    record.passiveSeconds += seconds;
  }
  if (isActiveLearningContext(cat, state.currentUrl, state.currentTitle)) {
    record.activeLearningSeconds += seconds;
  }

  await saveDayRecord(record);
  await updateDeepStreakIfQualified(dateKey, record);
}

async function applyIdleSeconds(seconds) {
  if (seconds <= 0) return;
  const dateKey = todayKey();
  const record = await loadDayRecord(dateKey);
  record.idleSeconds += seconds;
  await saveDayRecord(record);
}

async function applyGapSeconds(seconds) {
  if (seconds <= 0) return;
  const dateKey = todayKey();
  const record = await loadDayRecord(dateKey);
  record.gapSeconds = (record.gapSeconds || 0) + seconds;
  await saveDayRecord(record);
}

/**
 * Streak: consecutive local days with ≥1h deep work (bonus). Runs at most once per dateKey.
 */
async function updateDeepStreakIfQualified(dateKey, record) {
  if (record.deepSeconds < 3600) return;
  const meta = await loadMeta();
  if (meta.lastQualifiedDate === dateKey) return;

  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yKey = todayKey(y);

  if (meta.lastQualifiedDate === yKey) {
    meta.deepWorkStreak = (meta.deepWorkStreak || 0) + 1;
  } else {
    meta.deepWorkStreak = 1;
  }
  meta.lastQualifiedDate = dateKey;
  await saveMeta(meta);
}

/**
 * Flush elapsed time since lastUpdate into storage.
 * Runs under withStorageLock so concurrent resumes don’t clobber the same day key.
 */
async function flushTime() {
  return withStorageLock(async () => {
    if (!flushedOnce) {
      await initWindowAndTabState();
      flushedOnce = true;
    }

    const now = Date.now();
    const rawDelta = now - state.lastUpdate;
    state.lastUpdate = now;
    if (rawDelta <= 0) return;

    let deltaSec = Math.round(rawDelta / 1000);
    if (deltaSec > SANITY_MAX_DELTA_SEC) deltaSec = SANITY_MAX_DELTA_SEC;

    if (state.windowFocused && state.activeTabId == null) {
      await refreshActiveTab();
      if (state.activeTabId == null) {
        await initWindowAndTabState();
      }
    }

    const longGap = rawDelta >= GAP_THRESHOLD_MS;

    /** True while user could be reading a visible page (no mouse required). */
    const browsingContext =
      state.windowFocused && state.activeTabId != null && state.idleState !== "locked";

    // Away from Chrome, no tab, or OS/screen locked → idle (not site time). chrome.idle "idle"
    // alone does not count as away — supports reading without mouse movement.
    const notCountingSiteTime =
      !state.windowFocused || state.activeTabId == null || state.idleState === "locked";

    // Long silence used to always become gapSeconds; the popup adds gap to "idle", so reading
    // without input (throttled timers / few flushes) looked like idle. Only use gap when we are
    // clearly not in front of a tab (away, locked, or unknown tab).
    if (longGap && !browsingContext) {
      await applyGapSeconds(deltaSec);
      await appendLogUnlocked({
        type: "gap_flush",
        reason: "no_flush_interval",
        seconds: deltaSec,
      });
      return;
    }

    if (notCountingSiteTime) {
      await applyIdleSeconds(deltaSec);
    } else {
      await applyActiveSeconds(deltaSec);
    }
  });
}

async function recordTabSwitch() {
  const h = new Date().getHours();
  const dateKey = todayKey();
  state.switchTimestamps.push(Date.now());
  pruneSwitchTimestamps();
  await withStorageLock(async () => {
    const rec = await loadDayRecord(dateKey);
    rec.hourlyTabSwitches[h] = (rec.hourlyTabSwitches[h] || 0) + 1;
    await saveDayRecord(rec);
    await appendLogUnlocked({ type: "tab_switch", hour: h });
  });
}

async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || tab.id == null) return;
    state.activeTabId = tab.id;
    state.activeWindowId = tab.windowId;
    state.currentUrl = tab.url || "";
    state.currentTitle = tab.title || "";
    state.category = classifyActivity(state.currentUrl, state.currentTitle);
  } catch {
    // ignore
  }
}

/**
 * Reconcile focus + active tab with Chrome. Fixes “windowFocused true but activeTabId null”
 * (everything counted as idle) and cold-start desync.
 */
async function initWindowAndTabState() {
  try {
    const all = await chrome.windows.getAll({ windowTypes: ["normal"], populate: true });
    const focusedWin = all.find((w) => w.focused);
    if (!focusedWin) {
      state.windowFocused = false;
      return;
    }
    state.windowFocused = true;
    const tab = focusedWin.tabs?.find((t) => t.active);
    if (tab?.id != null) {
      state.activeTabId = tab.id;
      state.activeWindowId = focusedWin.id;
      state.currentUrl = tab.url || "";
      state.currentTitle = tab.title || "";
      state.category = classifyActivity(state.currentUrl, state.currentTitle);
    }
  } catch {
    await refreshActiveTab();
    if (state.activeTabId != null) state.windowFocused = true;
  }
}

let flushedOnce = false;

chrome.runtime.onInstalled.addListener(async () => {
  chrome.idle.setDetectionInterval(60);
  chrome.alarms.create("slt_flush", { periodInMinutes: 1 });
  await initWindowAndTabState();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.idle.setDetectionInterval(60);
  const alarms = await chrome.alarms.getAll();
  if (!alarms.some((a) => a.name === "slt_flush")) {
    chrome.alarms.create("slt_flush", { periodInMinutes: 1 });
  }
  await initWindowAndTabState();
});

chrome.idle.onStateChanged.addListener((newState) => {
  flushTime().then(() => {
    state.idleState = newState;
  });
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await flushTime();
  const prevTab = state.activeTabId;
  if (prevTab != null && prevTab !== activeInfo.tabId) {
    await recordTabSwitch();
  }
  state.windowFocused = true;
  state.tabFocusStarted = Date.now();
  state.activeTabId = activeInfo.tabId;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    state.activeWindowId = tab.windowId;
    state.currentUrl = tab.url || "";
    state.currentTitle = tab.title || "";
    state.category = classifyActivity(state.currentUrl, state.currentTitle);
  } catch {
    state.category = "other";
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (tabId !== state.activeTabId) return;
  if (changeInfo.url) {
    await flushTime();
    const newDomain = domainFromUrl(changeInfo.url);
    const oldDomain = domainFromUrl(state.currentUrl);
    if (newDomain !== oldDomain) {
      state.tabFocusStarted = Date.now();
    }
    state.currentUrl = changeInfo.url;
  }
  if (changeInfo.title != null) state.currentTitle = changeInfo.title;
  if (changeInfo.status === "complete" || changeInfo.title || changeInfo.url) {
    state.category = classifyActivity(state.currentUrl, state.currentTitle);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await flushTime();
    state.windowFocused = false;
    state.blurRememberTabId = state.activeTabId;
    state.activeTabId = null;
    return;
  }
  await flushTime();
  state.windowFocused = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab && tab.id != null) {
      const sameTab = state.blurRememberTabId != null && tab.id === state.blurRememberTabId;
      state.blurRememberTabId = null;
      state.activeWindowId = windowId;
      state.activeTabId = tab.id;
      if (!sameTab) {
        state.tabFocusStarted = Date.now();
      }
      state.currentUrl = tab.url || "";
      state.currentTitle = tab.title || "";
      state.category = classifyActivity(state.currentUrl, state.currentTitle);
    }
  } catch {
    // ignore
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "slt_flush") {
    await flushTime();
    await maybeSendDailySummary();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "heartbeat" && sender.tab?.id != null) {
    (async () => {
      state.lastMediaPlaying = !!msg.mediaPlaying;
      state.lastMediaTabId = sender.tab.id;
      state.lastMediaAt = Date.now();
      try {
        if (sender.tab.active) {
          const w = await chrome.windows.get(sender.tab.windowId);
          if (w.focused) {
            state.windowFocused = true;
            state.activeTabId = sender.tab.id;
            state.activeWindowId = sender.tab.windowId;
            if (sender.tab.url) state.currentUrl = sender.tab.url;
            if (sender.tab.title != null) state.currentTitle = sender.tab.title;
            state.category = classifyActivity(state.currentUrl, state.currentTitle);
          }
        }
        if (sender.tab.id === state.activeTabId) {
          await flushTime();
        }
      } catch {
        /* ignore */
      }
    })();
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === "getInsights") {
    buildInsights()
      .then((insights) => sendResponse({ insights }))
      .catch(() => sendResponse({ insights: [] }));
    return true;
  }
  return false;
});

/**
 * Rule-based insight strings from today's aggregates + hourly switches.
 */
async function buildInsights() {
  const dateKey = todayKey();
  const rec = await loadDayRecord(dateKey);
  const meta = await loadMeta();
  const insights = [];

  const deepH = (rec.deepSeconds / 3600).toFixed(1);
  if (rec.deepSeconds >= 600) {
    insights.push(`You spent about ${deepH} hours in deep work today (long focus blocks).`);
  } else if (rec.deepSeconds > 0) {
    insights.push(
      `Deep work so far: ${Math.round(rec.deepSeconds / 60)} minutes — longer single-tab sessions will grow this.`
    );
  }

  let maxH = 0;
  let maxS = -1;
  rec.hourlyTabSwitches.forEach((c, h) => {
    if (c > maxS) {
      maxS = c;
      maxH = h;
    }
  });
  if (maxS >= 8) {
    insights.push(
      `Frequent tab switching around ${maxH}:00–${maxH + 1}:00 — try blocking focus time if you need depth.`
    );
  }

  if (rec.passiveSeconds >= 1800 && rec.byCategory.entertainment >= 900) {
    insights.push("High passive-style time on entertainment-style sites (often video or feeds).");
  }

  if (rec.activeLearningSeconds >= 3600) {
    insights.push(
      `Strong active learning signal: ~${(rec.activeLearningSeconds / 3600).toFixed(1)} hrs on docs, courses, or coding sites.`
    );
  }

  if (rec.shallowSeconds > rec.deepSeconds * 2 && rec.totalActiveSeconds > 1800) {
    insights.push("Shallow browsing dominated today — short hops between tabs add up.");
  }

  if ((meta.deepWorkStreak || 0) >= 2) {
    insights.push(`${meta.deepWorkStreak}-day streak of 1h+ deep work. Keep the rhythm.`);
  }

  if (insights.length === 0) {
    insights.push("Keep browsing — insights will appear as the extension learns your day’s rhythm.");
  }

  return insights;
}

/**
 * Once per day at summaryHour: notify about *yesterday* (complete day).
 */
async function maybeSendDailySummary() {
  return withStorageLock(async () => {
    const now = new Date();
    const meta = await loadMeta();
    const summaryHour = meta.summaryHour ?? 9;
    if (now.getHours() !== summaryHour) return;

    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    const yKey = todayKey(y);
    if (meta.lastSummaryDay === yKey) return;

    const rec = await loadDayRecord(yKey);
    if (rec.totalActiveSeconds < 60) {
      meta.lastSummaryDay = yKey;
      await saveMeta(meta);
      return;
    }

    const deepMin = Math.round(rec.deepSeconds / 60);
    const title = "Smart Learning Tracker — yesterday";
    const message = `Active: ${Math.round(rec.totalActiveSeconds / 60)} min · Deep: ${deepMin} min · Shallow: ${Math.round(rec.shallowSeconds / 60)} min`;

    await chrome.notifications.create(`slt_summary_${yKey}`, {
      type: "basic",
      title,
      message,
    });

    meta.lastSummaryDay = yKey;
    await saveMeta(meta);
  });
}

chrome.idle.queryState(60, (s) => {
  state.idleState = s;
  state.lastUpdate = Date.now();
  initWindowAndTabState().catch(() => {});
});
