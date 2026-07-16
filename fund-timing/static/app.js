"use strict";

const $ = (id) => document.getElementById(id);

let dashRange = "1y";
let detailRange = "3y";
let sortKey = "score";
let sortDir = -1;           // -1: 降順, 1: 昇順
let lastSummaries = [];
let detailCtx = null;       // {catalog_id} or {q, name}

// ============================================================ 表示切替
function showDashboard() {
  $("detail-view").hidden = true;
  $("dashboard-view").hidden = false;
  loadWatchlist();
}
function showDetail() {
  $("dashboard-view").hidden = true;
  $("detail-view").hidden = false;
  window.scrollTo(0, 0);
}

// ============================================================ 一覧（ウォッチリスト）
async function loadWatchlist(force) {
  setDashStatus("各投信を分析中… ⏳", "loading");
  let data;
  try {
    const url = `/api/watchlist/analyze?range=${encodeURIComponent(dashRange)}`
      + (force ? "&force=1" : "");
    data = await (await fetch(url)).json();
  } catch (e) {
    setDashStatus("⚠️ 通信エラー: " + e.message, "error");
    return;
  }
  setDashStatus("");
  lastSummaries = data.items || [];
  renderWatchTable();
}

function setDashStatus(msg, kind) {
  const el = $("dash-status");
  if (!msg) { el.hidden = true; return; }
  el.hidden = false; el.textContent = msg; el.className = "status " + (kind || "");
}

const VERDICT_ORDER = { buy: 3, neutral: 2, sell: 1 };

function renderWatchTable() {
  const body = $("watch-body");
  const empty = $("empty-watch");
  if (!lastSummaries.length) {
    body.innerHTML = ""; empty.hidden = false; return;
  }
  empty.hidden = true;

  const rows = lastSummaries.slice().sort((a, b) => {
    let va, vb;
    if (sortKey === "verdict") { va = VERDICT_ORDER[a.verdict] || 0; vb = VERDICT_ORDER[b.verdict] || 0; }
    else if (sortKey === "name") { va = a.name || ""; vb = b.name || ""; return sortDir * va.localeCompare(vb, "ja"); }
    else { va = a[sortKey]; vb = b[sortKey]; }
    if (va == null) return 1;
    if (vb == null) return -1;
    return sortDir * (va < vb ? -1 : va > vb ? 1 : 0);
  });

  body.innerHTML = rows.map((s) => {
    if (!s.ok) {
      return `<tr class="err-row" data-id="${s.catalog_id}">
        <td class="fund-cell"><div class="fund-nm">${escapeHtml(s.name)}</div>
          <div class="fund-sub">${escapeHtml(s.isin)}</div></td>
        <td colspan="5" class="err-msg">⚠️ ${escapeHtml(s.error || "取得に失敗")}</td>
        <td></td>
        <td><button class="row-del" data-id="${s.catalog_id}" title="削除">✕</button></td></tr>`;
    }
    const badge = verdictBadge(s.verdict, s.verdict_label);
    const chg = s.change_pct == null ? "—"
      : `<span class="${s.change_pct >= 0 ? 'up' : 'down'}">${s.change_pct >= 0 ? '+' : ''}${s.change_pct}%</span>`;
    const price = s.latest_price == null ? "—" : Number(s.latest_price).toLocaleString() + " 円";
    const rsi = s.rsi == null ? "—" : s.rsi.toFixed(1);
    return `<tr class="watch-row" data-id="${s.catalog_id}">
      <td class="fund-cell">
        <div class="fund-nm">${escapeHtml(s.name)}</div>
        <div class="fund-sub">${escapeHtml(s.category || s.isin)}</div>
      </td>
      <td>${badge}</td>
      <td>${scoreChip(s.score)}</td>
      <td class="num">${price}</td>
      <td class="num">${chg}</td>
      <td class="num">${rsi}</td>
      <td class="spark-cell">${sparkline(s.spark, s.verdict)}</td>
      <td><button class="row-del" data-id="${s.catalog_id}" title="削除">✕</button></td>
    </tr>`;
  }).join("");
}

function verdictBadge(verdict, label) {
  const cls = { buy: "buy", sell: "sell", neutral: "neutral" }[verdict] || "neutral";
  const emoji = { buy: "🟢", sell: "🔴", neutral: "🟡" }[verdict] || "🟡";
  return `<span class="vbadge ${cls}">${emoji} ${escapeHtml(label || "")}</span>`;
}

function scoreChip(score) {
  const pct = Math.min(Math.max((score + 100) / 2, 0), 100);
  const color = score >= 30 ? "#1f9d55" : score <= -30 ? "#e3342f" : "#c69a1a";
  return `<div class="score-chip">
    <div class="score-chip-track"><div class="score-chip-fill" style="width:${pct}%;background:${color}"></div>
      <div class="score-chip-mid"></div></div>
    <span class="score-chip-num">${score > 0 ? "+" : ""}${score}</span></div>`;
}

// 小さなインラインSVGスパークライン
function sparkline(vals, verdict) {
  if (!vals || vals.length < 2) return "";
  const w = 120, h = 32, pad = 2;
  const min = Math.min(...vals), max = Math.max(...vals);
  const rng = (max - min) || 1;
  const pts = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - min) / rng) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = verdict === "buy" ? "#1f9d55" : verdict === "sell" ? "#e3342f" : "#8a8f9c";
  const last = vals[vals.length - 1], first = vals[0];
  const areaColor = last >= first ? "rgba(31,157,85,0.10)" : "rgba(227,52,47,0.10)";
  const areaPts = `${pad},${h - pad} ${pts} ${w - pad},${h - pad}`;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="spark">
    <polyline points="${areaPts}" fill="${areaColor}" stroke="none"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

// ============================================================ 検索
let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 180);
}
async function doSearch() {
  const q = $("search-input").value.trim();
  const box = $("search-results");
  let data;
  try {
    data = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
  } catch (e) { return; }
  const results = data.results || [];
  if (!results.length) {
    const kw = q ? escapeHtml(q) : "";
    box.innerHTML = `<div class="search-empty">
      <p>「${kw}」は内蔵リストに見つかりませんでした。</p>
      <button class="si-add" id="empty-register">＋ この投信を登録する</button>
      <p class="search-empty-note">どの投信でも、コードを入れれば登録できます（次回から名前で検索可）。</p>
    </div>`;
    box.hidden = false;
    const btn = document.getElementById("empty-register");
    if (btn) btn.addEventListener("click", () => openRegisterPrefilled(q));
    return;
  }
  box.innerHTML = results.map((r) => `
    <div class="search-item">
      <div class="si-text"><div class="si-name">${escapeHtml(r.name)}</div>
        <div class="si-sub">${escapeHtml(r.category || "")} ${escapeHtml(r.isin)}</div></div>
      ${r.watched
        ? '<span class="si-added">✓ 追加済</span>'
        : `<button class="si-add" data-id="${r.id}">＋ 一覧に追加</button>`}
    </div>`).join("");
  box.hidden = false;
}

async function addToWatch(catalogId) {
  await fetch("/api/watchlist", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ catalog_id: Number(catalogId) }),
  });
  $("search-results").hidden = true;
  $("search-input").value = "";
  loadWatchlist();
}

async function removeFromWatch(catalogId) {
  await fetch("/api/watchlist", {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ catalog_id: Number(catalogId) }),
  });
  loadWatchlist();
}

function openRegisterPrefilled(keyword) {
  $("search-results").hidden = true;
  $("register-form").hidden = false;
  $("reg-name").value = keyword || "";
  // みんかぶ検索リンクを入力キーワードで更新
  const ml = document.getElementById("minkabu-link");
  if (ml && keyword) ml.href = "https://itf.minkabu.jp/search?keyword=" + encodeURIComponent(keyword);
  $("register-form").scrollIntoView({ behavior: "smooth", block: "nearest" });
  $("reg-code").focus();
}

async function registerFund() {
  const name = $("reg-name").value.trim();
  const query = $("reg-code").value.trim();
  if (!query) { alert("URLまたはISIN,協会コードを入力してください。"); return; }
  const resp = await fetch("/api/catalog", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, query, watch: true }),
  });
  const data = await resp.json();
  if (!data.ok) { alert("⚠️ " + (data.error || "登録に失敗しました")); return; }
  $("reg-name").value = ""; $("reg-code").value = "";
  $("register-form").hidden = true;
  loadWatchlist();
}

// ============================================================ 詳細
async function openDetail(catalogId) {
  detailCtx = { catalog_id: catalogId };
  showDetail();
  await analyzeDetail();
}

async function analyzeDetail() {
  const params = new URLSearchParams({ range: detailRange });
  if (detailCtx.catalog_id != null) params.set("catalog_id", detailCtx.catalog_id);
  setVerdictLoading();
  let data;
  try {
    data = await (await fetch("/api/analyze?" + params.toString())).json();
  } catch (e) { alert("通信エラー: " + e.message); return; }
  if (!data.ok) { alert("⚠️ " + (data.error || "分析に失敗しました")); return; }
  renderDetail(data);
}

function setVerdictLoading() {
  $("verdict-emoji").textContent = "⏳";
  $("verdict-label").textContent = "分析中…";
  $("fund-name").textContent = "";
}

function renderDetail(data) {
  const emoji = { buy: "🟢", sell: "🔴", neutral: "🟡" }[data.verdict] || "⏳";
  $("verdict-emoji").textContent = emoji;
  $("verdict-label").textContent = data.verdict_label;
  $("verdict-label").className = "verdict-label verdict-" + data.verdict;
  $("fund-name").textContent = data.fund.name + "（" + data.fund.isin + "）";

  const pct = (data.score + 100) / 2;
  const bar = $("score-bar");
  bar.style.left = Math.min(Math.max(pct, 0), 100) + "%";
  bar.style.background = data.verdict === "buy" ? "#1f9d55"
    : data.verdict === "sell" ? "#e3342f" : "#c69a1a";
  bar.textContent = (data.score > 0 ? "+" : "") + data.score;

  const s = data.stats;
  const tiles = [
    ["最新基準価額", s.latest_price != null ? s.latest_price.toLocaleString() + " 円" : "—"],
    ["基準日", s.latest_date || "—"],
    ["RSI(14)", s.rsi != null ? s.rsi.toFixed(1) : "—"],
    ["長期線かい離", s.deviation_pct != null ? (s.deviation_pct > 0 ? "+" : "") + s.deviation_pct + " %" : "—"],
  ];
  $("stats-row").innerHTML = tiles.map(
    ([k, v]) => `<div class="stat-tile"><div class="stat-key">${k}</div><div class="stat-val">${v}</div></div>`
  ).join("");

  drawPriceChart(data);
  drawRsiChart(data);
  $("reasons-list").innerHTML = (data.reasons && data.reasons.length)
    ? data.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")
    : "<li>判断材料が不足しています。</li>";
  renderSignals(data.signals);
}

function isDark() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}
function baseLayout() {
  const dark = isDark();
  return {
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: dark ? "#e6e6ea" : "#333", family: "Hiragino Sans, sans-serif" },
    margin: { l: 60, r: 20, t: 30, b: 40 },
    xaxis: { gridcolor: dark ? "#333" : "#eee", type: "date" },
    yaxis: { gridcolor: dark ? "#333" : "#eee" },
    legend: { orientation: "h", y: 1.12 }, hovermode: "x unified",
  };
}
function drawPriceChart(data) {
  const ind = data.indicators, dates = ind.dates;
  const buys = data.signals.filter((x) => x.kind === "buy");
  const sells = data.signals.filter((x) => x.kind === "sell");
  const traces = [
    { x: dates, y: ind.bb_upper, mode: "lines", line: { width: 0 }, showlegend: false, hoverinfo: "skip" },
    { x: dates, y: ind.bb_lower, name: "ボリンジャーバンド", mode: "lines", line: { width: 0 }, fill: "tonexty",
      fillcolor: isDark() ? "rgba(120,140,220,0.12)" : "rgba(80,110,220,0.08)", hoverinfo: "skip" },
    { x: dates, y: ind.price, name: "基準価額", mode: "lines", line: { color: "#3b6fd4", width: 2 } },
    { x: dates, y: ind.sma_short, name: "短期線(25日)", mode: "lines", line: { color: "#e08a1e", width: 1.3 } },
    { x: dates, y: ind.sma_long, name: "長期線(75日)", mode: "lines", line: { color: "#9b59b6", width: 1.3 } },
    { x: buys.map((b) => b.date), y: buys.map((b) => b.price), name: "買いサイン", mode: "markers",
      marker: { symbol: "triangle-up", size: 11, color: "#1f9d55" },
      text: buys.map((b) => b.reason), hovertemplate: "🟢買い %{x}<br>%{text}<extra></extra>" },
    { x: sells.map((b) => b.date), y: sells.map((b) => b.price), name: "売りサイン", mode: "markers",
      marker: { symbol: "triangle-down", size: 11, color: "#e3342f" },
      text: sells.map((b) => b.reason), hovertemplate: "🔴売り %{x}<br>%{text}<extra></extra>" },
  ];
  const layout = baseLayout();
  layout.height = 420; layout.yaxis.title = "基準価額 (円)";
  Plotly.newPlot("price-chart", traces, layout, { responsive: true, displayModeBar: false });
}
function drawRsiChart(data) {
  const ind = data.indicators;
  const layout = baseLayout();
  layout.height = 200; layout.yaxis.title = "RSI"; layout.yaxis.range = [0, 100];
  layout.shapes = [hline(70, "#e3342f"), hline(30, "#1f9d55")]; layout.showlegend = false;
  Plotly.newPlot("rsi-chart",
    [{ x: ind.dates, y: ind.rsi, name: "RSI(14)", mode: "lines", line: { color: "#d46fa8", width: 1.5 } }],
    layout, { responsive: true, displayModeBar: false });
}
function hline(y, color) {
  return { type: "line", xref: "paper", x0: 0, x1: 1, y0: y, y1: y,
    line: { color, width: 1, dash: "dash" }, opacity: 0.6 };
}
function renderSignals(signals) {
  const recent = signals.slice(-20).reverse();
  $("signals-body").innerHTML = recent.length
    ? recent.map((s) => {
        const badge = s.kind === "buy" ? '<span class="badge buy">買い</span>' : '<span class="badge sell">売り</span>';
        return `<tr><td>${s.date}</td><td>${badge}</td><td>${Number(s.price).toLocaleString()} 円</td><td>${escapeHtml(s.reason)}</td></tr>`;
      }).join("")
    : '<tr><td colspan="4">この期間にサインはありません。</td></tr>';
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ============================================================ イベント
$("search-input").addEventListener("input", onSearchInput);
$("search-input").addEventListener("focus", onSearchInput);
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) $("search-results").hidden = true;
});

$("search-results").addEventListener("click", (e) => {
  const add = e.target.closest(".si-add");
  if (add) addToWatch(add.dataset.id);
});

$("show-register").addEventListener("click", () => {
  const f = $("register-form"); f.hidden = !f.hidden;
});
$("reg-submit").addEventListener("click", registerFund);

$("watch-body").addEventListener("click", (e) => {
  const del = e.target.closest(".row-del");
  if (del) { e.stopPropagation(); removeFromWatch(del.dataset.id); return; }
  const row = e.target.closest("tr[data-id]");
  if (row && !row.classList.contains("err-row")) openDetail(Number(row.dataset.id));
});

document.querySelectorAll(".watch-table th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (sortKey === key) sortDir = -sortDir;
    else { sortKey = key; sortDir = (key === "name") ? 1 : -1; }
    updateSortHeaders();
    renderWatchTable();
  });
});
function updateSortHeaders() {
  document.querySelectorAll(".watch-table th.sortable").forEach((th) => {
    const base = th.textContent.replace(/\s*[▲▼]\s*$/, "").trim();
    th.textContent = base + (th.dataset.key === sortKey ? (sortDir < 0 ? " ▼" : " ▲") : "");
  });
}

$("dash-range").addEventListener("click", (e) => {
  const b = e.target.closest(".range-btn"); if (!b) return;
  document.querySelectorAll("#dash-range .range-btn").forEach((x) => x.classList.remove("active"));
  b.classList.add("active"); dashRange = b.dataset.range; loadWatchlist();
});
$("refresh-btn").addEventListener("click", () => loadWatchlist(true));

$("detail-range").addEventListener("click", (e) => {
  const b = e.target.closest(".range-btn"); if (!b) return;
  document.querySelectorAll("#detail-range .range-btn").forEach((x) => x.classList.remove("active"));
  b.classList.add("active"); detailRange = b.dataset.range; analyzeDetail();
});
$("back-btn").addEventListener("click", showDashboard);

// 初期表示
loadWatchlist();
