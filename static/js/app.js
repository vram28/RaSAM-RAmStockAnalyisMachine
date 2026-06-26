"use strict";

const els = {
  btn: document.getElementById("checkNow"),
  input: document.getElementById("tickerInput"),
  status: document.getElementById("status"),
  countChips: document.getElementById("countChips"),
  winners: document.getElementById("winnersList"),
  losers: document.getElementById("losersList"),
  body: document.getElementById("stocksBody"),
  head: document.getElementById("stocksHead"),
  filters: document.getElementById("filters"),
  autoRefresh: document.getElementById("autoRefresh"),
  marketBadge: document.getElementById("marketBadge"),
};

let lastStocks = [];
let activeFilter = "All";

// --- Sort state ---
// null sortKey => use the server's default ordering (best rating first).
let sortKey = null;
let sortDir = 1; // 1 = ascending, -1 = descending
const STRING_KEYS = new Set(["symbol", "name"]);

// --- Auto-refresh state ---
const AUTO_REFRESH_MS = 60000; // refresh every minute
let isFetching = false;
let nextRefreshAt = 0;

const RATING_CLASS = {
  "Strong Buy": "strong-buy",
  Buy: "buy",
  Hold: "hold",
  Sell: "sell",
  "Strong Sell": "strong-sell",
  "No Rating": "no-rating",
};

function fmtMoney(v) {
  return v == null ? "—" : "$" + v.toFixed(2);
}
function fmtPct(v) {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return sign + v.toFixed(2) + "%";
}
function fmtMoneyDelta(v) {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  return sign + "$" + Math.abs(v).toFixed(2);
}
function pctClass(v) {
  if (v == null) return "";
  return v > 0 ? "up" : v < 0 ? "down" : "";
}

function renderCounts(counts) {
  const order = ["Strong Buy", "Buy", "Hold", "Sell", "Strong Sell", "No Rating"];
  els.countChips.innerHTML = order
    .map((k) => {
      const n = counts[k] || 0;
      return `<div class="count-chip"><span class="n">${n}</span><span class="l">${k}</span></div>`;
    })
    .join("");
}

function renderMovers(listEl, items) {
  if (!items.length) {
    listEl.innerHTML = `<li><span class="muted">No data</span></li>`;
    return;
  }
  listEl.innerHTML = items
    .map((s) => {
      const cls = pctClass(s.changePercent);
      return `<li>
        <span class="sym">${s.symbol}</span>
        <span class="${cls}">${fmtPct(s.changePercent)} <small>${fmtMoney(s.price)}</small></span>
      </li>`;
    })
    .join("");
}

function renderFirmActions(actions) {
  if (!actions || !actions.length) return `<span class="muted">—</span>`;
  return actions
    .map(
      (a) =>
        `<span class="fa-item"><span class="fa-firm">${a.firm || "?"}</span>: ${
          a.toGrade || a.action || "update"
        } <small>(${a.date})</small></span>`
    )
    .join("");
}

function sortRows(rows) {
  if (!sortKey) return rows;
  const isString = STRING_KEYS.has(sortKey);
  return [...rows].sort((a, b) => {
    let av = a[sortKey];
    let bv = b[sortKey];
    if (isString) {
      av = (av ?? "").toString().toLowerCase();
      bv = (bv ?? "").toString().toLowerCase();
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    }
    // Numbers: push null/undefined to the bottom regardless of direction.
    const aNull = av == null;
    const bNull = bv == null;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    return (av - bv) * sortDir;
  });
}

function updateSortIndicators() {
  els.head.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.toggle("sort-asc", th.dataset.sort === sortKey && sortDir === 1);
    th.classList.toggle("sort-desc", th.dataset.sort === sortKey && sortDir === -1);
  });
}

function renderTable() {
  const filtered = lastStocks.filter(
    (s) => activeFilter === "All" || s.recommendation === activeFilter
  );
  const rows = sortRows(filtered);
  updateSortIndicators();

  if (!rows.length) {
    els.body.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:24px">No stocks match this filter.</td></tr>`;
    return;
  }

  els.body.innerHTML = rows
    .map((s) => {
      const badgeCls = RATING_CLASS[s.recommendation] || "no-rating";
      const dayChange =
        s.price != null && s.previousClose != null ? s.price - s.previousClose : null;
      return `<tr>
        <td class="sym-cell clickable" data-label="Symbol" data-symbol="${s.symbol}" role="button" tabindex="0" title="View price chart for ${s.symbol}">${s.symbol}</td>
        <td class="company" data-label="Company" title="${s.name}">${s.name}</td>
        <td class="num" data-label="Price">${fmtMoney(s.price)}</td>
        <td class="num ${pctClass(s.changePercent)}" data-label="Day Change"><span class="day-change">${fmtMoneyDelta(dayChange)}</span> <span class="day-pct">${fmtPct(s.changePercent)}</span></td>
        <td data-label="Recommendation"><span class="badge ${badgeCls}">${s.recommendation}</span></td>
        <td class="num" data-label="Analysts">${s.numberOfAnalysts ?? "—"}</td>
        <td class="num" data-label="Target">${fmtMoney(s.targetMeanPrice)}</td>
        <td class="num ${pctClass(s.upsidePercent)}" data-label="Upside">${fmtPct(s.upsidePercent)}</td>
        <td class="firm-actions" data-label="Recent Firm Actions">${renderFirmActions(s.firmActions)}</td>
      </tr>`;
    })
    .join("");
}

async function checkNow() {
  if (isFetching) return;
  isFetching = true;
  const tickers = els.input.value.trim();
  els.btn.disabled = true;
  els.btn.classList.add("loading");
  els.status.classList.remove("error");
  els.status.textContent = "Fetching latest analyst data…";

  try {
    const url = "/api/recommendations" + (tickers ? "?tickers=" + encodeURIComponent(tickers) : "");
    const res = await fetch(url);
    if (!res.ok) throw new Error("Server returned " + res.status);
    const data = await res.json();

    lastStocks = data.stocks || [];
    renderCounts(data.counts || {});
    renderMovers(els.winners, data.winners || []);
    renderMovers(els.losers, data.losers || []);
    renderTable();

    const when = new Date(data.updatedAt).toLocaleString();
    els.status.textContent =
      `Updated ${when} • ${lastStocks.length} stocks` + (data.cached ? " (cached)" : "");
  } catch (err) {
    els.status.classList.add("error");
    els.status.textContent = "Error: " + err.message;
  } finally {
    els.btn.disabled = false;
    els.btn.classList.remove("loading");
    isFetching = false;
    nextRefreshAt = Date.now() + AUTO_REFRESH_MS;
  }
}

// --- Market hours (US equities: Mon–Fri, 9:30–16:00 America/New_York) ---

// --- US market holiday calendar (computed, not hardcoded) ---
//
// Rules follow the NYSE/Nasdaq schedule:
//   * Fixed-date holidays observed Sat->Fri and Sun->Mon, EXCEPT New Year's Day,
//     which the NYSE does not move to the preceding Friday when Jan 1 is a Sat.
//   * Good Friday is derived from Easter (Anonymous Gregorian algorithm).
//   * Juneteenth is a market holiday only from 2022 onward.
// Half-day (1:00 PM ET close) rules: Black Friday, plus July 3 / Dec 24 when
// those fall on a weekday adjacent to a weekday Independence/Christmas Day.

const _holidayCache = new Map();
const _earlyCloseCache = new Map();

function _pad2(n) {
  return String(n).padStart(2, "0");
}
function _dateKey(y, m, d) {
  return `${y}-${_pad2(m)}-${_pad2(d)}`;
}
function _dow(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun .. 6=Sat
}
function _nthWeekday(y, m, weekday, n) {
  const first = _dow(y, m, 1);
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}
function _lastWeekday(y, m, weekday) {
  const lastDom = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lastDow = _dow(y, m, lastDom);
  return lastDom - ((lastDow - weekday + 7) % 7);
}
function _easter(y) {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const mth = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mth + 114) / 31); // 3=Mar, 4=Apr
  const day = ((h + l - 7 * mth + 114) % 31) + 1;
  return { month, day };
}
// Observed key for a fixed-date holiday (Sat->Fri, Sun->Mon).
function _observedKey(y, m, d) {
  const dow = _dow(y, m, d);
  const dt = new Date(Date.UTC(y, m - 1, d + (dow === 0 ? 1 : dow === 6 ? -1 : 0)));
  return _dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function holidaysFor(year) {
  if (_holidayCache.has(year)) return _holidayCache.get(year);
  const H = new Set();

  // New Year's Day (Sun->Mon only; not moved to prior Fri on Saturday).
  const nyDow = _dow(year, 1, 1);
  if (nyDow === 0) H.add(_dateKey(year, 1, 2));
  else if (nyDow !== 6) H.add(_dateKey(year, 1, 1));

  H.add(_dateKey(year, 1, _nthWeekday(year, 1, 1, 3))); // MLK — 3rd Mon Jan
  H.add(_dateKey(year, 2, _nthWeekday(year, 2, 1, 3))); // Presidents' — 3rd Mon Feb

  const easter = _easter(year); // Good Friday = Easter - 2 days
  const gf = new Date(Date.UTC(year, easter.month - 1, easter.day - 2));
  H.add(_dateKey(gf.getUTCFullYear(), gf.getUTCMonth() + 1, gf.getUTCDate()));

  H.add(_dateKey(year, 5, _lastWeekday(year, 5, 1))); // Memorial — last Mon May
  if (year >= 2022) H.add(_observedKey(year, 6, 19)); // Juneteenth
  H.add(_observedKey(year, 7, 4)); // Independence Day
  H.add(_dateKey(year, 9, _nthWeekday(year, 9, 1, 1))); // Labor — 1st Mon Sep
  H.add(_dateKey(year, 11, _nthWeekday(year, 11, 4, 4))); // Thanksgiving — 4th Thu Nov
  H.add(_observedKey(year, 12, 25)); // Christmas

  _holidayCache.set(year, H);
  return H;
}

function earlyClosesFor(year) {
  if (_earlyCloseCache.has(year)) return _earlyCloseCache.get(year);
  const E = new Set();

  // Black Friday — day after Thanksgiving.
  const thanksgiving = _nthWeekday(year, 11, 4, 4);
  E.add(_dateKey(year, 11, thanksgiving + 1));

  // July 3 — early close when July 4 falls Tue–Fri (so July 3 is a weekday).
  const jul4 = _dow(year, 7, 4);
  if (jul4 >= 2 && jul4 <= 5) E.add(_dateKey(year, 7, 3));

  // Dec 24 — early close when Christmas falls Tue–Fri (so Dec 24 is a weekday).
  const dec25 = _dow(year, 12, 25);
  if (dec25 >= 2 && dec25 <= 5) E.add(_dateKey(year, 12, 24));

  _earlyCloseCache.set(year, E);
  return E;
}

function nyNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    hour: parseInt(get("hour"), 10),
    minute: parseInt(get("minute"), 10),
  };
}

// Returns { open, reason } where reason ∈ weekend | holiday | early | regular | after-hours.
function marketStatus() {
  const { dateKey, weekday, hour, minute } = nyNow();
  const year = parseInt(dateKey.slice(0, 4), 10);
  if (weekday === "Sat" || weekday === "Sun") return { open: false, reason: "weekend" };
  if (holidaysFor(year).has(dateKey)) return { open: false, reason: "holiday" };
  const mins = hour * 60 + minute;
  const isEarly = earlyClosesFor(year).has(dateKey);
  const closeMins = isEarly ? 13 * 60 : 16 * 60;
  if (mins >= 9 * 60 + 30 && mins < closeMins) {
    return { open: true, reason: isEarly ? "early" : "regular" };
  }
  return { open: false, reason: "after-hours" };
}

function updateMarketBadge(status, enabled) {
  const b = els.marketBadge;
  if (!enabled) {
    b.textContent = "⏸ Auto-refresh off";
    b.className = "market-badge off";
    return;
  }
  if (!status.open) {
    const label =
      status.reason === "holiday"
        ? "Market holiday"
        : status.reason === "weekend"
        ? "Market closed (weekend)"
        : "Market closed";
    b.textContent = `● ${label} — auto-refresh paused`;
    b.className = "market-badge closed";
    return;
  }
  const secs = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  const tag = status.reason === "early" ? "Market open (early close 1 PM ET)" : "Market open";
  b.textContent = `● ${tag} — next refresh in ${secs}s`;
  b.className = "market-badge open";
}

// 1-second tick drives the countdown and triggers minute refreshes.
function tick() {
  const enabled = els.autoRefresh.checked;
  const status = marketStatus();
  updateMarketBadge(status, enabled);
  if (enabled && status.open && !isFetching && Date.now() >= nextRefreshAt) {
    checkNow();
  }
}

// ------------------------------------------------------------------
// Stock price chart modal
// ------------------------------------------------------------------

const chartEls = {
  overlay: document.getElementById("chartModal"),
  title: document.getElementById("chartTitle"),
  subtitle: document.getElementById("chartSubtitle"),
  close: document.getElementById("chartClose"),
  tabs: document.getElementById("rangeTabs"),
  status: document.getElementById("chartStatus"),
  container: document.getElementById("chartContainer"),
  stats: document.getElementById("chartStats"),
};

let chartSymbol = null;
let chartRange = "1M";
let chartFetchId = 0;

function openChart(symbol) {
  chartSymbol = symbol;
  chartRange = "1M";
  chartEls.title.textContent = symbol;
  chartEls.subtitle.textContent = "";
  [...chartEls.tabs.children].forEach((b) =>
    b.classList.toggle("active", b.dataset.range === chartRange)
  );
  chartEls.overlay.hidden = false;
  document.body.style.overflow = "hidden";
  loadChart();
}

function closeChart() {
  chartEls.overlay.hidden = true;
  document.body.style.overflow = "";
  chartSymbol = null;
}

async function loadChart() {
  if (!chartSymbol) return;
  const fetchId = ++chartFetchId;
  chartEls.status.classList.remove("error");
  chartEls.status.textContent = `Loading ${chartSymbol} • ${chartRange}…`;
  chartEls.container.innerHTML = "";
  chartEls.stats.innerHTML = "";
  try {
    const url =
      "/api/history?symbol=" +
      encodeURIComponent(chartSymbol) +
      "&range=" +
      encodeURIComponent(chartRange);
    const res = await fetch(url);
    if (!res.ok) throw new Error("Server returned " + res.status);
    const data = await res.json();
    if (fetchId !== chartFetchId) return; // a newer request superseded this one
    if (data.error) throw new Error(data.error);
    const points = data.points || [];
    if (!points.length) {
      chartEls.status.textContent = "No price data available for this range.";
      return;
    }
    chartEls.status.textContent = "";
    renderChart(points);
    renderChartStats(data.stats || {});
  } catch (err) {
    if (fetchId !== chartFetchId) return;
    chartEls.status.classList.add("error");
    chartEls.status.textContent = "Error: " + err.message;
  }
}

function renderChart(points) {
  const W = 820,
    H = 340,
    padL = 60,
    padR = 16,
    padT = 16,
    padB = 34;
  const closes = points.map((p) => p.c);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const n = points.length;
  const x = (i) => padL + (i / (n - 1 || 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - min) / span) * (H - padT - padB);

  const first = closes[0];
  const last = closes[n - 1];
  const up = last >= first;
  const color = up ? "#2ec16b" : "#ff5d6c";

  let line = "";
  points.forEach((p, i) => {
    line += (i === 0 ? "M" : "L") + x(i).toFixed(1) + " " + y(p.c).toFixed(1) + " ";
  });
  const baseline = (H - padB).toFixed(1);
  const area =
    line + `L${x(n - 1).toFixed(1)} ${baseline} L${x(0).toFixed(1)} ${baseline} Z`;

  // Horizontal gridlines + price labels
  const ticks = 4;
  let grid = "";
  for (let i = 0; i <= ticks; i++) {
    const val = min + (span * i) / ticks;
    const yy = y(val);
    grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(
      1
    )}" class="grid-line"/>`;
    grid += `<text x="${padL - 8}" y="${(yy + 4).toFixed(
      1
    )}" class="axis-label y">${val.toFixed(2)}</text>`;
  }

  const fmtDate = (t) => {
    const d = new Date(t);
    if (isNaN(d.getTime())) return "";
    const longRange = chartRange === "5Y" || chartRange === "10Y";
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(longRange ? { year: "numeric" } : {}),
    });
  };
  const xlabels =
    `<text x="${padL}" y="${H - 10}" class="axis-label x start">${fmtDate(
      points[0].t
    )}</text>` +
    `<text x="${W - padR}" y="${H - 10}" class="axis-label x end">${fmtDate(
      points[n - 1].t
    )}</text>`;

  const change = last - first;
  const changePct = (change / (first || 1)) * 100;
  const sign = change >= 0 ? "+" : "";
  chartEls.subtitle.innerHTML =
    `<span class="${up ? "up" : "down"}">$${last.toFixed(2)} ` +
    `${sign}${change.toFixed(2)} (${sign}${changePct.toFixed(2)}%)</span> ` +
    `<span class="muted">over ${chartRange}</span>`;

  const gradId = "grad" + Math.random().toString(36).slice(2);
  chartEls.container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="price-chart" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${chartSymbol} ${chartRange} price chart">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${grid}
      <path d="${area}" fill="url(#${gradId})" stroke="none"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${xlabels}
    </svg>`;
}

function renderChartStats(stats) {
  const items = [
    ["Open", stats.open],
    ["High", stats.dayHigh],
    ["Low", stats.dayLow],
    ["Close", stats.close],
    ["52-Week High", stats.fiftyTwoWeekHigh],
  ];
  chartEls.stats.innerHTML = items
    .map(
      ([label, val]) =>
        `<div class="stat"><span class="stat-l">${label}</span><span class="stat-v">${fmtMoney(
          val
        )}</span></div>`
    )
    .join("");
}

// Open the chart when a ticker symbol is clicked (or activated via keyboard).
els.body.addEventListener("click", (e) => {
  const cell = e.target.closest(".sym-cell");
  if (cell && cell.dataset.symbol) openChart(cell.dataset.symbol);
});
els.body.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const cell = e.target.closest(".sym-cell");
  if (cell && cell.dataset.symbol) {
    e.preventDefault();
    openChart(cell.dataset.symbol);
  }
});

chartEls.close.addEventListener("click", closeChart);
chartEls.overlay.addEventListener("click", (e) => {
  if (e.target === chartEls.overlay) closeChart();
});
chartEls.tabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".range-btn");
  if (!btn) return;
  chartRange = btn.dataset.range;
  [...chartEls.tabs.children].forEach((b) => b.classList.toggle("active", b === btn));
  loadChart();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !chartEls.overlay.hidden) closeChart();
});

els.btn.addEventListener("click", checkNow);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") checkNow();
});
els.filters.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  activeFilter = chip.dataset.filter;
  [...els.filters.children].forEach((c) => c.classList.toggle("active", c === chip));
  renderTable();
});

// Click a column header to sort; click again to toggle direction.
els.head.addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const key = th.dataset.sort;
  if (sortKey === key) {
    sortDir *= -1;
  } else {
    sortKey = key;
    // Strings default ascending (A→Z); numbers default descending (high→low).
    sortDir = STRING_KEYS.has(key) ? 1 : -1;
  }
  renderTable();
});

els.autoRefresh.addEventListener("change", () => {
  // Re-enabling while the market is open should refresh promptly.
  if (els.autoRefresh.checked && marketStatus().open) nextRefreshAt = Date.now();
  tick();
});

// Initial load + start the auto-refresh loop.
checkNow();
updateMarketBadge(marketStatus(), els.autoRefresh.checked);
setInterval(tick, 1000);
