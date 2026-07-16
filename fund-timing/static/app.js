"use strict";

let currentRange = "3y";
let lastQuery = "";
let lastName = "";

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind) {
  const el = $("status");
  if (!msg) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = msg;
  el.className = "status " + (kind || "");
}

async function analyze(query, name) {
  if (!query) { setStatus("ファンドを指定してください。", "error"); return; }
  lastQuery = query;
  lastName = name || "";
  setStatus("データを取得して分析中… ⏳", "loading");
  $("result").hidden = true;

  const url = `/api/analyze?q=${encodeURIComponent(query)}`
    + `&name=${encodeURIComponent(name || "")}&range=${encodeURIComponent(currentRange)}`;
  let data;
  try {
    const resp = await fetch(url);
    data = await resp.json();
    if (!resp.ok || !data.ok) {
      setStatus("⚠️ " + (data && data.error ? data.error : "取得に失敗しました。"), "error");
      return;
    }
  } catch (e) {
    setStatus("⚠️ 通信エラー: " + e.message, "error");
    return;
  }
  setStatus("");
  render(data);
}

function render(data) {
  $("result").hidden = false;

  // 判定カード
  const emoji = { buy: "🟢", sell: "🔴", neutral: "🟡" }[data.verdict] || "⏳";
  $("verdict-emoji").textContent = emoji;
  $("verdict-label").textContent = data.verdict_label;
  $("verdict-label").className = "verdict-label verdict-" + data.verdict;
  $("fund-name").textContent = data.fund.name + "（" + data.fund.isin + "）";

  // スコアバー（-100..100 → 0..100%）
  const pct = (data.score + 100) / 2;
  const bar = $("score-bar");
  bar.style.left = Math.min(Math.max(pct, 0), 100) + "%";
  bar.style.background = data.verdict === "buy" ? "#1f9d55"
    : data.verdict === "sell" ? "#e3342f" : "#c69a1a";
  bar.textContent = (data.score > 0 ? "+" : "") + data.score;

  // 統計タイル
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
  renderReasons(data.reasons);
  renderSignals(data.signals);
}

function isDark() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function baseLayout() {
  const dark = isDark();
  return {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: dark ? "#e6e6ea" : "#333", family: "Hiragino Sans, sans-serif" },
    margin: { l: 60, r: 20, t: 30, b: 40 },
    xaxis: { gridcolor: dark ? "#333" : "#eee", type: "date" },
    yaxis: { gridcolor: dark ? "#333" : "#eee" },
    legend: { orientation: "h", y: 1.12 },
    hovermode: "x unified",
  };
}

function drawPriceChart(data) {
  const ind = data.indicators;
  const dates = ind.dates;
  const buys = data.signals.filter((x) => x.kind === "buy");
  const sells = data.signals.filter((x) => x.kind === "sell");

  const traces = [
    { x: dates, y: ind.bb_upper, name: "BB +2σ", mode: "lines",
      line: { width: 0 }, showlegend: false, hoverinfo: "skip" },
    { x: dates, y: ind.bb_lower, name: "ボリンジャーバンド", mode: "lines",
      line: { width: 0 }, fill: "tonexty",
      fillcolor: isDark() ? "rgba(120,140,220,0.12)" : "rgba(80,110,220,0.08)",
      hoverinfo: "skip" },
    { x: dates, y: ind.price, name: "基準価額", mode: "lines",
      line: { color: "#3b6fd4", width: 2 } },
    { x: dates, y: ind.sma_short, name: "短期線(25日)", mode: "lines",
      line: { color: "#e08a1e", width: 1.3 } },
    { x: dates, y: ind.sma_long, name: "長期線(75日)", mode: "lines",
      line: { color: "#9b59b6", width: 1.3 } },
    { x: buys.map((b) => b.date), y: buys.map((b) => b.price), name: "買いサイン",
      mode: "markers", marker: { symbol: "triangle-up", size: 11, color: "#1f9d55" },
      text: buys.map((b) => b.reason), hovertemplate: "🟢買い %{x}<br>%{text}<extra></extra>" },
    { x: sells.map((b) => b.date), y: sells.map((b) => b.price), name: "売りサイン",
      mode: "markers", marker: { symbol: "triangle-down", size: 11, color: "#e3342f" },
      text: sells.map((b) => b.reason), hovertemplate: "🔴売り %{x}<br>%{text}<extra></extra>" },
  ];

  const layout = baseLayout();
  layout.height = 420;
  layout.yaxis.title = "基準価額 (円)";
  Plotly.newPlot("price-chart", traces, layout, { responsive: true, displayModeBar: false });
}

function drawRsiChart(data) {
  const ind = data.indicators;
  const traces = [
    { x: ind.dates, y: ind.rsi, name: "RSI(14)", mode: "lines",
      line: { color: "#d46fa8", width: 1.5 } },
  ];
  const layout = baseLayout();
  layout.height = 200;
  layout.yaxis.title = "RSI";
  layout.yaxis.range = [0, 100];
  layout.shapes = [
    hline(70, "#e3342f"), hline(30, "#1f9d55"),
  ];
  layout.showlegend = false;
  Plotly.newPlot("rsi-chart", traces, layout, { responsive: true, displayModeBar: false });
}

function hline(y, color) {
  return { type: "line", xref: "paper", x0: 0, x1: 1, y0: y, y1: y,
    line: { color: color, width: 1, dash: "dash" }, opacity: 0.6 };
}

function renderReasons(reasons) {
  $("reasons-list").innerHTML = (reasons && reasons.length)
    ? reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")
    : "<li>判断材料が不足しています。</li>";
}

function renderSignals(signals) {
  const recent = signals.slice(-20).reverse();
  $("signals-body").innerHTML = recent.length
    ? recent.map((s) => {
        const badge = s.kind === "buy"
          ? '<span class="badge buy">買い</span>'
          : '<span class="badge sell">売り</span>';
        return `<tr><td>${s.date}</td><td>${badge}</td>`
          + `<td>${Number(s.price).toLocaleString()} 円</td>`
          + `<td>${escapeHtml(s.reason)}</td></tr>`;
      }).join("")
    : '<tr><td colspan="4">この期間にサインはありません。</td></tr>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// ------------------------------------------------------------ イベント
$("analyze-btn").addEventListener("click", () => analyze($("query").value.trim(), ""));
$("query").addEventListener("keydown", (e) => {
  if (e.key === "Enter") analyze($("query").value.trim(), "");
});

document.querySelectorAll(".preset-chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    const q = btn.dataset.isin + "," + btn.dataset.code;
    $("query").value = q;
    analyze(q, btn.dataset.name);
  });
});

$("range-group").addEventListener("click", (e) => {
  const btn = e.target.closest(".range-btn");
  if (!btn) return;
  document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  currentRange = btn.dataset.range;
  if (lastQuery) analyze(lastQuery, lastName);
});
