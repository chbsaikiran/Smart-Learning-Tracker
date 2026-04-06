/**
 * Smart Learning Tracker — popup: loads aggregated day + meta from storage,
 * draws canvas charts (no external libs), rule-based insights from background.
 */

const STORAGE_DAY_PREFIX = "slt_day_";
const STORAGE_META_KEY = "slt_meta";
const STORAGE_LOG_KEY = "slt_activity_log";

const COLORS = {
  coding: "#22c55e",
  learning: "#38bdf8",
  entertainment: "#f472b6",
  other: "#94a3b8",
  deep: "#6366f1",
  shallow: "#f59e0b",
};

function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Human-readable duration. Sub-minute values use seconds so the label matches
 * bar charts (rounded minutes used to show "0m" while bars still had width).
 */
function formatDuration(seconds) {
  if (seconds == null || seconds <= 0) return "0m";
  const s = Math.floor(Number(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function normalizeDayRecord(raw, dateKey) {
  if (!raw) {
    return {
      dateKey,
      totalActiveSeconds: 0,
      idleSeconds: 0,
      byCategory: { coding: 0, learning: 0, entertainment: 0, other: 0 },
      deepSeconds: 0,
      shallowSeconds: 0,
      passiveSeconds: 0,
      activeLearningSeconds: 0,
      gapSeconds: 0,
      hourlyTabSwitches: Array(24).fill(0),
      hourlyByCategory: Array.from({ length: 24 }, () => ({
        coding: 0,
        learning: 0,
        entertainment: 0,
        other: 0,
      })),
    };
  }
  const hourlyByCategory = raw.hourlyByCategory;
  if (!hourlyByCategory || hourlyByCategory.length !== 24) {
    raw.hourlyByCategory = Array.from({ length: 24 }, () => ({
      coding: 0,
      learning: 0,
      entertainment: 0,
      other: 0,
    }));
  }
  if (typeof raw.gapSeconds !== "number") raw.gapSeconds = 0;
  return raw;
}

function drawPie(canvas, slices) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2 - 8;
  ctx.clearRect(0, 0, w, h);
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (total <= 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#2d3a4d";
    ctx.fill();
    return;
  }
  let angle = -Math.PI / 2;
  slices.forEach((s) => {
    if (s.value <= 0) return;
    const slice = (s.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    angle += slice;
  });
}

/** Category chart: fixed label column + fixed track + duration column (never inside the fill). */
const CAT_LABEL_W = 84;
const CAT_TRACK_W = 210;
const CAT_VALUE_GAP = 10;
function drawCategoryBars(canvas, byCategory) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const keys = ["coding", "learning", "entertainment", "other"];
  const max = Math.max(1, ...keys.map((k) => byCategory[k] || 0));
  const barH = 22;
  const gap = 10;
  let y = 8;
  const trackLeft = CAT_LABEL_W;
  keys.forEach((k) => {
    const v = byCategory[k] || 0;
    const fillW = (v / max) * CAT_TRACK_W;
    ctx.fillStyle = "#2d3a4d";
    ctx.fillRect(trackLeft, y, CAT_TRACK_W, barH);
    ctx.fillStyle = COLORS[k];
    ctx.fillRect(trackLeft, y, fillW, barH);
    ctx.fillStyle = "#e7ecf3";
    ctx.font = "12px system-ui";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(k, 4, y + barH / 2);
    // Duration always starts after full track — visible even when bar is 100% full
    ctx.fillText(formatDuration(v), trackLeft + CAT_TRACK_W + CAT_VALUE_GAP, y + barH / 2);
    y += barH + gap;
  });
}

function drawTimeline(canvas, hourlyByCategory) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const barW = (w - 40) / 24;
  let max = 1;
  for (let hr = 0; hr < 24; hr++) {
    const b = hourlyByCategory[hr];
    const sum = (b.coding || 0) + (b.learning || 0) + (b.entertainment || 0) + (b.other || 0);
    if (sum > max) max = sum;
  }
  const chartH = h - 36;
  for (let hr = 0; hr < 24; hr++) {
    const b = hourlyByCategory[hr];
    const x = 32 + hr * barW;
    let acc = 0;
    const order = ["coding", "learning", "entertainment", "other"];
    order.forEach((k) => {
      const seg = b[k] || 0;
      if (seg <= 0) return;
      const sh = (seg / max) * chartH;
      ctx.fillStyle = COLORS[k];
      ctx.fillRect(x, h - 24 - acc - sh, barW - 2, sh);
      acc += sh;
    });
  }
  ctx.fillStyle = "#8b9cb3";
  ctx.font = "9px system-ui";
  for (let hr = 0; hr < 24; hr += 4) {
    ctx.fillText(String(hr), 32 + hr * barW, h - 8);
  }
}

async function loadToday() {
  const key = STORAGE_DAY_PREFIX + todayKey();
  const data = await chrome.storage.local.get([key, STORAGE_META_KEY]);
  const rec = normalizeDayRecord(data[key], todayKey());
  const meta = data[STORAGE_META_KEY] || { deepWorkStreak: 0 };
  return { rec, meta };
}

function render(rec, meta, insights) {
  document.getElementById("totalActive").textContent = formatDuration(rec.totalActiveSeconds);
  document.getElementById("idleTime").textContent = formatDuration(
    (rec.idleSeconds || 0) + (rec.gapSeconds || 0)
  );
  document.getElementById("streak").textContent =
    (meta.deepWorkStreak || 0) > 0 ? `${meta.deepWorkStreak} day(s)` : "—";
  document.getElementById("activeLearn").textContent = formatDuration(rec.activeLearningSeconds);
  document.getElementById("passive").textContent = formatDuration(rec.passiveSeconds);

  const pie = document.getElementById("deepShallowPie");
  drawPie(pie, [
    { value: rec.deepSeconds, color: COLORS.deep },
    { value: rec.shallowSeconds, color: COLORS.shallow },
  ]);
  const leg = document.getElementById("deepShallowLegend");
  leg.innerHTML = `
    <li><span class="swatch" style="background:${COLORS.deep}"></span> Deep ${formatDuration(rec.deepSeconds)}</li>
    <li><span class="swatch" style="background:${COLORS.shallow}"></span> Shallow ${formatDuration(rec.shallowSeconds)}</li>
  `;

  drawCategoryBars(document.getElementById("categoryBars"), rec.byCategory);
  drawTimeline(document.getElementById("timeline"), rec.hourlyByCategory);

  const ul = document.getElementById("insights");
  ul.innerHTML = "";
  insights.forEach((t) => {
    const li = document.createElement("li");
    li.textContent = t;
    ul.appendChild(li);
  });
}

async function refresh() {
  const { rec, meta } = await loadToday();
  const insights = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getInsights" }, (res) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(res?.insights || []);
    });
  });
  render(rec, meta, insights);
}

async function exportJson() {
  const all = await chrome.storage.local.get(null);
  const exportObj = {};
  Object.keys(all).forEach((k) => {
    if (k.startsWith("slt_")) exportObj[k] = all[k];
  });
  if (chrome.storage.session) {
    const sess = await chrome.storage.session.get(STORAGE_LOG_KEY);
    if (sess[STORAGE_LOG_KEY]) exportObj[STORAGE_LOG_KEY] = sess[STORAGE_LOG_KEY];
  }
  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `smart-learning-tracker-${todayKey()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("refreshBtn").addEventListener("click", () => refresh());
document.getElementById("exportBtn").addEventListener("click", () => exportJson());
refresh();
