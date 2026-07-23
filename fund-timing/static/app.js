"use strict";

const $ = (id) => document.getElementById(id);

let dashRange = "1y";
let detailRange = "3y";
let sortKey = "score";
let sortDir = -1;           // -1: 降順, 1: 昇順
let lastSummaries = [];
let detailCtx = null;       // {catalog_id} or {q, name}

// ============================================================ 表示切替
let currentView = "dashboard";   // "dashboard" | "portfolio"

function switchView(view) {
  currentView = view;
  $("main-nav").hidden = false;
  $("detail-view").hidden = true;
  $("dashboard-view").hidden = view !== "dashboard";
  $("portfolio-view").hidden = view !== "portfolio";
  $("price-view").hidden = view !== "price";
  document.querySelectorAll(".nav-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view));
  // 非表示中に描画したPlotlyのグラフはサイズが正しく取れないため、
  // 表示に切り替えてレイアウトが確定してからリサイズする
  if (view === "portfolio") {
    requestAnimationFrame(() => {
      ["pie-current", "pie-target"].forEach((id) => {
        const el = $(id);
        if (el && el.data) Plotly.Plots.resize(el);
      });
    });
  } else if (view === "price") {
    loadPriceHistory();
  }
  window.scrollTo(0, 0);
}

function showDashboard() {   // 詳細ビューの「← 戻る」用：元のタブへ戻る
  switchView(currentView);
  loadWatchlist();
}
function showDetail() {
  $("main-nav").hidden = true;
  $("dashboard-view").hidden = true;
  $("portfolio-view").hidden = true;
  $("price-view").hidden = true;
  $("detail-view").hidden = false;
  window.scrollTo(0, 0);
}

// ============================================================ トースト通知
let toastTimer = null;
function toast(msg, kind) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = kind === "error" ? "error" : "";
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ============================================================ 一覧（ウォッチリスト）
function showSkeleton() {
  const body = $("watch-body");
  if (!body.children.length) {
    const cell = (w) => `<td><span class="skel" style="width:${w}px"></span></td>`;
    body.innerHTML = Array.from({ length: 4 }, () =>
      `<tr>${cell(180)}${cell(90)}${cell(110)}${cell(80)}${cell(70)}${cell(80)}${cell(80)}${cell(100)}${cell(80)}${cell(60)}${cell(110)}<td></td></tr>`
    ).join("");
  }
}

async function loadWatchlist(force) {
  showSkeleton();
  setDashStatus("各投信を分析中… ⏳", "loading");
  let data;
  try {
    const url = `/api/watchlist/analyze?range=${encodeURIComponent(dashRange)}`
      + (force ? "&force=1" : "");
    const resp = await fetch(url);
    try {
      data = await resp.json();
    } catch (_) {
      throw new Error(`サーバーが応答を返せませんでした（HTTP ${resp.status}）。`
        + "ターミナルのエラー表示を確認してください。");
    }
    if (!data.ok && data.error) throw new Error(data.error);
  } catch (e) {
    setDashStatus("⚠️ " + e.message, "error");
    return;
  }
  setDashStatus("");
  if (Array.isArray(data.brokers) && data.brokers.length) BROKERS = data.brokers;
  lastSummaries = data.items || [];
  renderWatchTable();
  renderPortfolio(data.portfolio);
  renderAllocation(data.allocation);
  renderClassEditor();
  loadPresetCatalog();
}

// ============================================================ 資産配分・リバランス
const ASSET_CLASS_META = {
  "米国":       { icon: "🇺🇸", color: "#5b8def" },
  "グローバル": { icon: "🌐", color: "#8b5cf6" },
  "非米国":     { icon: "🌏", color: "#10b981" },
  "高配当":     { icon: "💰", color: "#f59e0b" },
  "高リターン": { icon: "🚀", color: "#ef4444" },
  "バリュー":   { icon: "💎", color: "#0ea5e9" },
};
function classChip(cls) {
  const m = ASSET_CLASS_META[cls];
  if (!m) return "";
  return `<span class="class-chip" style="--cc:${m.color}">${m.icon} ${escapeHtml(cls)}</span>`;
}

// 証券会社（プルダウンの選択肢。サーバーから受け取った値で上書きされる）
let BROKERS = ["SBI証券", "楽天証券", "三菱UFJスマート証券"];
function brokerChip(broker) {
  if (!broker) return "";
  return `<span class="broker-chip">🏦 ${escapeHtml(broker)}</span>`;
}
function brokerSelect(watchId, broker, cls) {
  const cur = broker || "";
  const opts = ['<option value="">未設定</option>']
    .concat(BROKERS.map((b) => `<option value="${escapeHtml(b)}"${cur === b ? " selected" : ""}>${escapeHtml(b)}</option>`))
    .join("");
  return `<select class="${cls}" data-watch="${watchId}"
      title="保有先の証券会社">${opts}</select>`;
}

let lastAllocation = null;
function renderAllocation(alloc) {
  const card = $("allocation-card");
  if (!alloc || !alloc.ok) { card.hidden = true; return; }
  card.hidden = false;
  lastAllocation = alloc;

  const classes = alloc.classes || [];
  const withValue = classes.filter((c) => c.share > 0);
  const pieOpts = { responsive: true, displayModeBar: false };
  const pieLayout = {
    height: 235, margin: { l: 10, r: 10, t: 6, b: 6 },
    paper_bgcolor: "rgba(0,0,0,0)", showlegend: false,
    font: { family: "Hiragino Sans, sans-serif",
            color: isDark() ? "#e7e8ef" : "#1e2130" },
  };
  Plotly.newPlot("pie-current", [{
    type: "pie", hole: 0.5, sort: false,
    labels: withValue.map((c) => c.icon + " " + c.name),
    values: withValue.map((c) => c.share),
    marker: { colors: withValue.map((c) => c.color) },
    textinfo: "label+percent", textposition: "auto",
    hovertemplate: "%{label}: %{value:.1f}%<extra></extra>",
  }], pieLayout, pieOpts);
  const tgt = classes.filter((c) => c.target > 0);
  Plotly.newPlot("pie-target", [{
    type: "pie", hole: 0.5, sort: false,
    labels: tgt.map((c) => c.icon + " " + c.name),
    values: tgt.map((c) => c.target),
    marker: { colors: tgt.map((c) => c.color) },
    textinfo: "label+percent", textposition: "auto",
    hovertemplate: "%{label}: %{value:.0f}%<extra></extra>",
  }], pieLayout, pieOpts);

  // リバランス表
  $("alloc-body").innerHTML = classes.map((c) => {
    const badgeCls = c.action === "ok" ? "buy" : c.action === "buy" ? "neutral" : "sell";
    const amount = c.amount != null
      ? `<span class="alloc-amount">目安 ${Number(c.amount).toLocaleString()} 円</span>` : "";
    const val = c.value != null ? Number(c.value).toLocaleString() + " 円" : "—";
    const diff = `${c.diff > 0 ? "+" : ""}${c.diff}pt`;
    return `<tr>
      <td><span class="alloc-cls" style="--cc:${c.color}">${c.icon} ${escapeHtml(c.name)}</span></td>
      <td class="num">${val}</td>
      <td class="num">${c.share}%</td>
      <td class="num">${c.target}%</td>
      <td class="num ${c.diff > 5 ? "down" : c.diff < -5 ? "up" : ""}">${diff}</td>
      <td><span class="vbadge ${badgeCls}">${escapeHtml(c.action_label)}</span> ${amount}</td>
    </tr>`;
  }).join("");

  buildTargetInputs(alloc.targets || {});
  renderRebalancePlan(alloc.plan);
}

function renderRebalancePlan(plan) {
  const el = $("rebalance-plan");
  if (!plan) { el.innerHTML = ""; return; }

  if (plan.status === "no_units") {
    el.innerHTML = `<div class="plan-banner neutral">💡 ${escapeHtml(plan.summary)}</div>`;
    return;
  }
  if (plan.status === "none") {
    el.innerHTML = `<div class="plan-banner good">${escapeHtml(plan.summary)}</div>`;
    return;
  }

  let html = `<h3 class="plan-title">🔁 リバランスのアドバイス</h3>`;
  html += `<div class="plan-banner ${plan.status === "defer" ? "warn" : "info"}">${escapeHtml(plan.summary)}</div>`;

  if (plan.sells && plan.sells.length) {
    html += `<div class="plan-section"><div class="plan-head sell-head">売却する商品</div>` +
      plan.sells.map((s) => `
        <div class="plan-row">
          <span class="plan-cls">${s.icon} ${escapeHtml(s.cls)}</span>
          <span class="plan-name">${escapeHtml(s.name)}</span>
          <span class="plan-amount">約 ${Number(s.amount).toLocaleString()} 円</span>
          <span class="plan-timing">${escapeHtml(s.timing_label)}</span>
          ${s.policy === "partial" ? '<span class="plan-tag">一部売却（上限50%）</span>' : ""}
        </div>`).join("") + `</div>`;
  }

  if (plan.buys && plan.buys.length) {
    html += `<div class="plan-section"><div class="plan-head buy-head">売却資金で購入する商品</div>` +
      plan.buys.map((b) => `
        <div class="plan-row">
          <span class="plan-cls">${b.icon} ${escapeHtml(b.cls)}</span>
          <span class="plan-name">${escapeHtml(b.name)}${b.in_watchlist ? "" : '<span class="plan-tag">内蔵リストより</span>'}</span>
          <span class="plan-amount">約 ${Number(b.amount).toLocaleString()} 円</span>
          <span class="plan-timing">${escapeHtml(b.timing_label)}</span>
        </div>`).join("") + `</div>`;
  }

  if (plan.excluded && plan.excluded.length) {
    html += `<div class="plan-section"><div class="plan-head excl-head">売却対象外の銘柄（設定・値上がり予測・損失回避）</div>` +
      plan.excluded.map((d) => `
        <div class="plan-defer"><b>${d.icon} ${escapeHtml(d.name)}</b> — ${escapeHtml(d.reason)}</div>`).join("") + `</div>`;
  }

  if (plan.deferred && plan.deferred.length) {
    html += `<div class="plan-section"><div class="plan-head defer-head">今回は見送り（損失回避）</div>` +
      plan.deferred.map((d) => `
        <div class="plan-defer">${d.icon} ${escapeHtml(d.reason)}</div>`).join("") + `</div>`;
  }

  if (plan.note) html += `<p class="plan-note">${escapeHtml(plan.note)}</p>`;
  el.innerHTML = html;
}

function buildTargetInputs(targets) {
  const wrap = $("targets-inputs");
  wrap.innerHTML = Object.keys(ASSET_CLASS_META).map((name) => {
    const m = ASSET_CLASS_META[name];
    const v = targets[name] != null ? targets[name] : 0;
    return `<label class="target-item">${m.icon} ${escapeHtml(name)}
      <input type="number" class="target-input units-input" data-cls="${escapeHtml(name)}"
             min="0" max="100" step="1" value="${v}">%</label>`;
  }).join("");
  updateTargetsSum();
}
function updateTargetsSum() {
  const sum = Array.from(document.querySelectorAll(".target-input"))
    .reduce((a, el) => a + (Number(el.value) || 0), 0);
  const el = $("targets-sum");
  el.textContent = `合計 ${sum}%`;
  el.classList.toggle("bad", Math.abs(sum - 100) > 0.5);
  return sum;
}
async function saveTargets() {
  const targets = {};
  document.querySelectorAll(".target-input").forEach((el) => {
    targets[el.dataset.cls] = Number(el.value) || 0;
  });
  const resp = await fetch("/api/targets", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targets }),
  });
  const data = await resp.json();
  if (!data.ok) { toast(data.error || "保存に失敗しました", "error"); return; }
  toast("✓ 理想の配分を保存しました");
  $("targets-form").hidden = true;
  loadWatchlist();
}

// プリセット（シーゲル流／バランス型）を編集フォームに反映
function applyPreset(name) {
  const presets = lastAllocation && lastAllocation.presets;
  const preset = presets && presets[name];
  if (!preset) { toast("プリセットを読み込めませんでした", "error"); return; }
  buildTargetInputs(preset);
  toast(name === "siegel" ? "シーゲル流の配分を入力しました" : "バランス型の配分を入力しました");
}

// ============================================================ 保有銘柄の設定（証券会社・資産クラス）
function renderClassEditor() {
  const card = $("class-edit-card");
  const body = $("class-edit-body");
  const empty = $("class-edit-empty");
  if (!card) return;
  const funds = lastSummaries.filter((s) => s.catalog_id != null);
  card.hidden = false;
  if (!funds.length) {
    body.innerHTML = ""; empty.hidden = false; return;
  }
  empty.hidden = true;
  body.innerHTML = funds.map((s) => `
    <tr>
      <td class="fund-cell">
        <div class="fund-nm">${escapeHtml(s.name)}</div>
        <div class="fund-sub">${s.kind === "stock" ? '<span class="kind-chip">株</span>' : ""}${brokerChip(s.broker)}${escapeHtml(s.category || s.isin || "")}</div>
      </td>
      <td>${classSelect(s)}</td>
    </tr>`).join("");
}

function classSelect(s) {
  const cur = s.asset_class || "";
  const opts = Object.keys(ASSET_CLASS_META).map((name) => {
    const m = ASSET_CLASS_META[name];
    return `<option value="${escapeHtml(name)}"${cur === name ? " selected" : ""}>${m.icon} ${escapeHtml(name)}</option>`;
  }).join("");
  return `<select class="class-select class-${escapeHtml(cur)}" data-id="${s.catalog_id}"
      title="この銘柄の資産クラス（配分・リバランス計算に反映されます）">${opts}</select>`;
}

async function saveAssetClass(catalogId, cls) {
  try {
    const resp = await fetch("/api/catalog/class", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalog_id: Number(catalogId), asset_class: cls }),
    });
    const data = await resp.json();
    if (!data.ok) { toast(data.error || "保存に失敗しました", "error"); return; }
    toast("✓ 資産クラスを変更しました");
    loadWatchlist();  // 配分・リバランスを再計算
  } catch (e) {
    toast("通信エラー: " + e.message, "error");
  }
}

async function saveBroker(watchId, broker) {
  try {
    const resp = await fetch("/api/watchlist/broker", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watch_id: Number(watchId), broker }),
    });
    const data = await resp.json();
    if (!data.ok) { toast(data.error || "保存に失敗しました", "error"); return; }
    toast(broker ? `✓ 証券会社を「${broker}」に設定しました` : "✓ 証券会社を未設定にしました");
    loadWatchlist();
  } catch (e) {
    toast("通信エラー: " + e.message, "error");
  }
}

// ============================================================ 内蔵（プリセット）商品を追加
let presetCatalog = [];
let presetClassFilter = "";
async function loadPresetCatalog() {
  let data;
  try {
    data = await (await fetch("/api/catalog/list")).json();
  } catch (e) { return; }
  if (!data.ok) return;
  if (Array.isArray(data.brokers) && data.brokers.length) BROKERS = data.brokers;
  presetCatalog = data.items || [];
  // 資産クラスの絞り込みプルダウンを初期化（初回のみ）
  const filter = $("preset-class-filter");
  if (filter && filter.options.length <= 1) {
    Object.keys(ASSET_CLASS_META).forEach((name) => {
      const m = ASSET_CLASS_META[name];
      const opt = document.createElement("option");
      opt.value = name; opt.textContent = `${m.icon} ${name}`;
      filter.appendChild(opt);
    });
  }
  renderPresetCatalog();
}

function renderPresetCatalog() {
  const body = $("preset-add-body");
  if (!body) return;
  // どの商品を、どの証券会社で保有しているか（同一商品を複数証券会社で持てる）
  const heldByCatalog = {};
  lastSummaries.forEach((s) => {
    if (s.catalog_id != null) {
      (heldByCatalog[s.catalog_id] = heldByCatalog[s.catalog_id] || []).push(s.broker || "未設定");
    }
  });
  let rows = presetCatalog.slice();
  if (presetClassFilter) rows = rows.filter((r) => r.asset_class === presetClassFilter);
  // 資産クラス→名前で並べる
  rows.sort((a, b) => {
    const ca = ASSET_CLASS_NAMES_ORDER[a.asset_class] ?? 99;
    const cb = ASSET_CLASS_NAMES_ORDER[b.asset_class] ?? 99;
    if (ca !== cb) return ca - cb;
    return a.name.localeCompare(b.name, "ja");
  });
  body.innerHTML = rows.map((r) => {
    const held = heldByCatalog[r.id];
    const heldHint = held && held.length
      ? `<div class="held-hint">🏦 保有中：${escapeHtml(held.join("、"))}</div>` : "";
    return `<tr class="preset-catalog-row" data-id="${r.id}">
      <td class="fund-cell">
        <div class="fund-nm">${escapeHtml(r.name)}</div>
        <div class="fund-sub">${r.kind === "stock" ? '<span class="kind-chip">株</span>' : ""}${escapeHtml(r.category || "")}</div>
        ${heldHint}
      </td>
      <td>${classChip(r.asset_class)}</td>
      <td>${brokerSelect(r.id, "", "preset-broker-select")}</td>
      <td><button class="si-add preset-add-btn" data-id="${r.id}">＋ 追加</button></td>
    </tr>`;
  }).join("");
}
const ASSET_CLASS_NAMES_ORDER = Object.fromEntries(
  Object.keys(ASSET_CLASS_META).map((n, i) => [n, i]));

async function addPreset(catalogId, broker) {
  const resp = await fetch("/api/watchlist", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ catalog_id: Number(catalogId), broker: broker || "" }),
  });
  const data = await resp.json().catch(() => ({}));
  if (data && data.added === false) {
    toast(broker ? `既に「${broker}」で保有しています` : "既に保有しています（証券会社を選ぶと別口座で追加できます）");
    return;
  }
  toast(broker ? `✓ ${broker}の口座に追加しました` : "✓ ポートフォリオに追加しました");
  loadWatchlist();
}

// ============================================================ 価格推移（取引履歴・実額ベース）
const PRICE_COLORS = ["#5b5bd6", "#e11d48", "#16a34a", "#f59e0b", "#0ea5e9",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#64748b", "#a855f7", "#0891b2",
  "#dc2626", "#65a30d", "#d97706", "#4f46e5", "#db2777", "#059669"];

async function loadPriceHistory() {
  const st = $("price-status");
  st.hidden = false; st.className = "status loading"; st.textContent = "集計中… ⏳";
  let data;
  try {
    data = await (await fetch(`/api/actual-history?range=${encodeURIComponent(priceRange)}`)).json();
  } catch (e) {
    st.className = "status error"; st.textContent = "⚠️ 通信エラー: " + e.message; return;
  }
  if (!data.ok) { st.className = "status error"; st.textContent = "⚠️ " + (data.error || "取得に失敗"); return; }
  st.hidden = true;
  lastActualData = data;
  renderPriceSummary(data);
  renderPriceChart(data.holdings || [], data.totals || []);
  renderPriceTable(data.holdings || [], data.excel_dates || data.dates || [], data.totals || []);
}

let lastActualData = null;
let priceMode = "ratio";   // "ratio"（比率%）| "amount"（実額円）
let lineMode = "products";  // "products"（商品別）| "total"（合計のみ）
let priceRange = "6m";      // 価格推移グラフの期間

function renderPriceSummary(data) {
  const card = $("price-summary-card");
  const holds = data.holdings || [];
  if (!holds.length) { card.hidden = true; return; }
  card.hidden = false;
  const inv = data.total_invested || 0;
  const totals = data.totals || [];
  const cur = totals.length ? totals[totals.length - 1].amount : 0;
  const pl = cur - inv;
  const plr = inv > 0 ? (pl / inv * 100) : 0;
  $("sum-invested").textContent = Number(inv).toLocaleString() + " 円";
  $("sum-current").textContent = Number(cur).toLocaleString() + " 円";
  $("sum-pl").textContent = (pl >= 0 ? "+" : "") + Number(pl).toLocaleString() + " 円";
  $("sum-pl").className = "pf-sum-val " + (pl >= 0 ? "up" : "down");
  $("sum-plr").textContent = (plr >= 0 ? "+" : "") + plr.toFixed(1) + "%";
  $("sum-plr").className = "pf-sum-val " + (plr >= 0 ? "up" : "down");

  // 前日比（合計評価額の直近2日の差）
  const dod = $("sum-dod");
  if (totals.length >= 2) {
    const prev = totals[totals.length - 2].amount;
    const diff = cur - prev;
    const dpct = prev > 0 ? (diff / prev * 100) : 0;
    dod.textContent = `${diff >= 0 ? "+" : ""}${Number(diff).toLocaleString()} 円`
      + `（${dpct >= 0 ? "+" : ""}${dpct.toFixed(2)}%）`;
    dod.className = "pf-sum-val pf-sum-dod " + (diff >= 0 ? "up" : "down");
  } else {
    dod.textContent = "—"; dod.className = "pf-sum-val pf-sum-dod";
  }
}

function renderPriceChart(holdings, totals) {
  const empty = $("price-empty");
  if (!holdings.length) { empty.hidden = false; Plotly.purge("actual-chart"); return; }
  empty.hidden = true;
  const amountMode = priceMode === "amount";
  const totalOnly = lineMode === "total";
  const traces = [];
  if (totalOnly && totals.length) {   // 合計線は「合計のみ」モードでのみ表示
    traces.push({
      x: totals.map((t) => t.date), y: totals.map((t) => amountMode ? t.amount : t.ratio),
      name: "合計（全体）", mode: "lines",
      line: { width: 3, color: isDark() ? "#e7e8ef" : "#1e2130" },
      hovertemplate: amountMode ? "%{x}<br>全体 %{y:,.0f} 円<extra></extra>"
                                : "%{x}<br>全体 %{y:.1f}%<extra></extra>",
    });
  }
  if (!totalOnly) {   // 商品別モード：各商品の線のみ（合計・個別株は出さない）
    // 同じ正式名が複数あるとき（例：S&P500の成長/積立/旧NISA）は口座名を添えて区別
    const nameCount = {};
    holdings.forEach((h) => { nameCount[h.name] = (nameCount[h.name] || 0) + 1; });
    holdings.forEach((h, i) => {
      if (h.kind === "stock") return;   // 日立などの個別株は商品別グラフから除外
      const y = amountMode ? h.amount : h.ratio;
      if (!y || !y.length) return;   // データが無いものだけ除外
      const nm = (nameCount[h.name] > 1 && h.account) ? `${h.name}（${h.account}）` : h.name;
      traces.push({
        x: h.dates, y: y, name: nm, mode: "lines",
        line: { width: 1.6, color: PRICE_COLORS[i % PRICE_COLORS.length] },
        hovertemplate: amountMode ? "%{x}<br>" + escapeHtml(nm) + " %{y:,.0f} 円<extra></extra>"
                                  : "%{x}<br>" + escapeHtml(nm) + " %{y:.1f}%<extra></extra>",
      });
    });
  }
  const layout = baseLayout();
  layout.height = 460;
  layout.hovermode = "closest";   // 触れた1本だけを表示（吹き出しを見やすく）
  layout.margin = { l: amountMode ? 78 : 64, r: 20, t: 12, b: 40 };
  layout.legend = { orientation: "h", y: -0.18, font: { size: 10.5 } };
  if (amountMode) {
    layout.yaxis.title = "評価額（円）";
  } else {
    layout.yaxis.title = "評価額 ÷ 投資金額 (%)";
    layout.yaxis.ticksuffix = "%";
    layout.shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 100, y1: 100,
      line: { color: isDark() ? "#8a8f9c" : "#94a3b8", width: 1.2, dash: "dash" } }];
  }
  Plotly.newPlot("actual-chart", traces, layout, { responsive: true, displayModeBar: false });
}

const BROKER_ORDER = { "SBI証券": 0, "三菱UFJスマート証券": 1, "楽天証券": 2 };
function renderPriceTable(holdings, dates, totals) {
  const card = $("price-table-card");
  if (!holdings.length || !dates.length) { card.hidden = true; return; }
  card.hidden = false;
  const cols = dates.slice().reverse();   // 新しい日付が左
  const ndates = cols.length;
  const plCell = (r) => {   // 損益率セル（r=比率%）。マイナスは赤字
    if (r == null) return `<td class="num pt-plcol">—</td>`;
    const pl = Math.round((r - 100) * 10) / 10;
    return `<td class="num pt-plcol ${pl >= 0 ? "up" : "down"}">${pl >= 0 ? "+" : ""}${pl}%</td>`;
  };
  // ヘッダ：商品名（固定）＋ 損益率（固定）＋ 各日付
  $("price-table-head").innerHTML =
    `<th class="pt-namecol">商品名</th><th class="num pt-plcol">損益率</th>` +
    cols.map((d) => `<th class="num">${escapeHtml(d.slice(5))}</th>`).join("");
  // 証券会社順（SBI→三菱UFJ→楽天→その他）に並べ替え。色はグラフと合わせて元の並び順で固定
  const withColor = holdings.map((h, i) => ({ h, color: PRICE_COLORS[i % PRICE_COLORS.length] }));
  withColor.sort((a, b) =>
    (BROKER_ORDER[a.h.broker] ?? 9) - (BROKER_ORDER[b.h.broker] ?? 9));
  const totalMap = {}; totals.forEach((t) => { totalMap[t.date] = t.amount; });

  let html = "";
  let curBroker = null;
  withColor.forEach(({ h, color }) => {
    const bk = h.broker || "未設定";
    if (bk !== curBroker) {   // 証券会社の区切り見出し行
      curBroker = bk;
      html += `<tr class="pt-broker-row"><td class="pt-namecol">🏦 ${escapeHtml(bk)}</td>` +
        `<td class="pt-plcol"></td><td class="num" colspan="${ndates}"></td></tr>`;
    }
    const m = {}; h.dates.forEach((d, k) => { m[d] = h.amount[k]; });
    const cells = cols.map((d) => {
      const v = m[d];
      return `<td class="num">${v == null ? "—" : Number(v).toLocaleString()}</td>`;
    }).join("");
    const acct = (h.account && h.account !== h.name)
      ? `<div class="pt-acct">${escapeHtml(h.account)}</div>` : "";
    html += `<tr><td class="pt-namecol pt-col" style="--cc:${color}">${escapeHtml(h.name)}${acct}</td>${plCell(h.latest_ratio)}${cells}</tr>`;
  });
  const totRatio = totals.length ? totals[totals.length - 1].ratio : null;
  const totalCells = cols.map((d) => {
    const v = totalMap[d];
    return `<td class="num">${v == null ? "—" : Number(v).toLocaleString()}</td>`;
  }).join("");
  html += `<tr class="pt-total-row"><td class="pt-namecol">合計</td>${plCell(totRatio)}${totalCells}</tr>`;
  $("price-table-body").innerHTML = html;
}

// 保有全体（ポートフォリオ）の目安カード
function renderPortfolio(pf) {
  const card = $("portfolio-card");
  if (!pf || !pf.ok) { card.hidden = true; return; }
  card.hidden = false;

  const totalWrap = $("pf-total");
  if (pf.total_value != null) {
    totalWrap.hidden = false;
    $("pf-total-val").textContent = Number(pf.total_value).toLocaleString() + " 円";
  } else {
    totalWrap.hidden = true;
  }

  const stanceInfo = {
    add:  { cls: "buy",     emoji: "🟢" },
    hold: { cls: "neutral", emoji: "🟡" },
    trim: { cls: "sell",    emoji: "🔴" },
  };
  $("pf-horizons").innerHTML = (pf.horizons || []).map((h) => {
    if (!h.ok) {
      return `<div class="hz-row"><div class="hz-head">
        <span class="hz-label">${escapeHtml(h.label)}</span>
        <span class="vbadge neutral">— 判定不可</span></div>
        <p class="hz-comment">${escapeHtml(h.comment)}</p></div>`;
    }
    const si = stanceInfo[h.stance] || stanceInfo.hold;
    return `<div class="hz-row">
      <div class="hz-head">
        <span class="hz-label">${escapeHtml(h.label)}</span>
        <span class="vbadge ${si.cls}">${si.emoji} ${escapeHtml(h.stance_label)}</span>
        <span class="hz-score">全体スコア ${h.score > 0 ? "+" : ""}${h.score}</span>
      </div>
      <p class="hz-comment">${escapeHtml(h.comment)}</p>
    </div>`;
  }).join("");

  const note = $("pf-note");
  if (pf.note) { note.hidden = false; note.textContent = "ℹ️ " + pf.note; }
  else { note.hidden = true; }
}

// 売却属性の保存（リバランス計画に反映）※保有行(watch_id)単位
async function savePolicy(watchId, policy) {
  try {
    const resp = await fetch("/api/watchlist/policy", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watch_id: Number(watchId), policy }),
    });
    const data = await resp.json();
    if (!data.ok) { toast(data.error || "保存に失敗しました", "error"); return; }
    toast("✓ 売却属性を保存しました");
    loadWatchlist();  // リバランス計画を更新
  } catch (e) {
    toast("通信エラー: " + e.message, "error");
  }
}

// 保有口数の保存 ※保有行(watch_id)単位
async function saveUnits(watchId, units) {
  try {
    const resp = await fetch("/api/watchlist/units", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watch_id: Number(watchId), units: Number(units) || 0 }),
    });
    const data = await resp.json();
    if (!data.ok) { toast(data.error || "保存に失敗しました", "error"); return; }
    loadWatchlist();  // 評価額と全体判定を更新
  } catch (e) {
    toast("通信エラー: " + e.message, "error");
  }
}

// 投資金額（元本）の保存 ※保有行(watch_id)単位
async function saveInvested(watchId, invested) {
  try {
    const resp = await fetch("/api/watchlist/invested", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watch_id: Number(watchId), invested: Number(invested) || 0 }),
    });
    const data = await resp.json();
    if (!data.ok) { toast(data.error || "保存に失敗しました", "error"); return; }
    // 価格推移タブを開いていれば再計算
    if (currentView === "price") loadPriceHistory();
  } catch (e) {
    toast("通信エラー: " + e.message, "error");
  }
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
      return `<tr class="err-row" data-id="${s.catalog_id}" data-watch="${s.watch_id}">
        <td class="fund-cell"><div class="fund-nm">${escapeHtml(s.name)}</div>
          <div class="fund-sub">${classChip(s.asset_class)}${brokerChip(s.broker)}${s.kind === "stock" ? '<span class="kind-chip">株</span>' : ""} ${escapeHtml(s.isin)}</div></td>
        <td colspan="10" class="err-msg">⚠️ ${escapeHtml(s.error || "取得に失敗")}</td>
        <td><button class="row-del" data-watch="${s.watch_id}" title="削除">✕</button></td></tr>`;
    }
    const badge = verdictBadge(s.verdict, s.verdict_label);
    const chg = s.change_pct == null ? "—"
      : `<span class="${s.change_pct >= 0 ? 'up' : 'down'}">${s.change_pct >= 0 ? '+' : ''}${s.change_pct}%</span>`;
    const price = s.latest_price == null ? "—" : Number(s.latest_price).toLocaleString() + " 円";
    const value = s.value == null ? "—" : Number(s.value).toLocaleString() + " 円";
    const plSub = (s.pl_pct == null) ? ""
      : `<div class="pl-sub ${s.pl_pct >= 0 ? "up" : "down"}">損益 ${s.pl_pct >= 0 ? "+" : ""}${s.pl_pct}%</div>`;
    return `<tr class="watch-row" data-id="${s.catalog_id}" data-watch="${s.watch_id}">
      <td class="fund-cell">
        <div class="fund-nm">${escapeHtml(s.name)}</div>
        <div class="fund-sub">${classChip(s.asset_class)}${s.account && s.account !== s.name ? `<span class="acct-chip">${escapeHtml(s.account)}</span>` : ""}${s.kind === "stock" ? '<span class="kind-chip">株</span>' : ""} ${escapeHtml(s.category || "")}</div>
      </td>
      <td>${badge}</td>
      <td>${scoreChip(s.score)}</td>
      <td class="num">${price}</td>
      <td class="num"><input class="units-input num-comma" type="text" inputmode="numeric"
            data-watch="${s.watch_id}" value="${fmtInt(s.units)}" placeholder="口数"
            title="保有口数（評価額 = 基準価額 × 口数 ÷ 10,000）"></td>
      <td class="num value-cell">${value}${plSub}</td>
      <td class="num"><input class="invested-input num-comma" type="text" inputmode="numeric"
            data-watch="${s.watch_id}" value="${fmtInt(s.invested)}" placeholder="投資金額"
            title="投資金額（元本）。価格推移タブの比率計算に使います"></td>
      <td>${brokerSelect(s.watch_id, s.broker, "broker-select row-broker")}</td>
      <td>${policySelect(s)}</td>
      <td class="num">${chg}</td>
      <td class="spark-cell">${sparkline(s.spark, s.verdict)}</td>
      <td><button class="row-del" data-watch="${s.watch_id}" title="削除">✕</button></td>
    </tr>`;
  }).join("");
}

function policySelect(s) {
  const p = s.sell_policy || "full";
  const opt = (v, label) => `<option value="${v}"${p === v ? " selected" : ""}>${label}</option>`;
  return `<select class="policy-select policy-${p}" data-watch="${s.watch_id}"
      title="リバランスで売却してよいかの設定（計画に反映されます）">
    ${opt("full", "○ 売却可")}${opt("partial", "△ 一部可")}${opt("locked", "✕ 不可")}
  </select>`;
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

// ============================================================ 注目ランキング
async function loadRanking() {
  const st = $("ranking-status");
  st.hidden = false; st.className = "status loading";
  st.textContent = "全銘柄を分析中… ⏳（初回は少し時間がかかります）";
  $("ranking-table").hidden = true;
  $("ranking-note").hidden = true;
  let data;
  try {
    data = await (await fetch(`/api/ranking?range=${encodeURIComponent(dashRange)}`)).json();
  } catch (e) {
    st.className = "status error"; st.textContent = "⚠️ 通信エラー: " + e.message; return;
  }
  st.hidden = true;
  renderRanking(data.items || []);
}

function renderRanking(items) {
  const ok = items.filter((x) => x.ok);
  const body = $("ranking-body");
  body.innerHTML = ok.map((s, i) => {
    const rank = i + 1;
    const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank;
    const chg = s.change_pct == null ? "—"
      : `<span class="${s.change_pct >= 0 ? 'up' : 'down'}">${s.change_pct >= 0 ? '+' : ''}${s.change_pct}%</span>`;
    const action = s.in_watchlist
      ? '<span class="si-added">✓ 追加済</span>'
      : `<button class="si-add rank-add" data-id="${s.catalog_id}">＋ 追加</button>`;
    return `<tr class="rank-row" data-id="${s.catalog_id}">
      <td class="rank-no">${medal}</td>
      <td class="fund-cell"><div class="fund-nm">${escapeHtml(s.name)}</div>
        <div class="fund-sub">${escapeHtml(s.category || s.isin)}</div></td>
      <td>${verdictBadge(s.verdict, s.verdict_label)}</td>
      <td>${scoreChip(s.score)}</td>
      <td class="num">${chg}</td>
      <td class="spark-cell">${sparkline(s.spark, s.verdict)}</td>
      <td>${action}</td>
    </tr>`;
  }).join("");
  $("ranking-table").hidden = false;
  $("ranking-note").hidden = false;
}

// ============================================================ 検索
let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doSearch, 180);
}
let searchSeq = 0;
async function doSearch() {
  const q = $("search-input").value.trim();
  const box = $("search-results");
  const seq = ++searchSeq;
  let data;
  try {
    data = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
  } catch (e) { return; }
  if (seq !== searchSeq) return;  // 古い検索の応答は捨てる（後追い上書き防止）
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
        <div class="si-sub">${classChip(r.asset_class)}${escapeHtml(r.category || "")} ${escapeHtml(r.isin)}</div></div>
      ${r.watched ? '<span class="si-added">保有中</span>' : ''}
      <button class="si-add" data-id="${r.id}">＋ ${r.watched ? "追加" : "一覧に追加"}</button>
    </div>`).join("");
  box.hidden = false;
  searchSel = -1;
}

async function addToWatch(catalogId) {
  const resp = await fetch("/api/watchlist", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ catalog_id: Number(catalogId) }),
  });
  const data = await resp.json().catch(() => ({}));
  $("search-results").hidden = true;
  $("search-input").value = "";
  if (data && data.added === false) {
    toast("既に保有しています（証券会社は一覧で設定できます）");
    return;
  }
  toast("✓ ウォッチリストに追加しました");
  loadWatchlist();
}

async function removeFromWatch(watchId, name) {
  const label = name ? `「${name}」` : "この銘柄";
  if (!confirm(`${label}を一覧から削除します。よろしいですか？\n（評価額の履歴も削除されます）`)) return;
  await fetch("/api/watchlist", {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ watch_id: Number(watchId) }),
  });
  toast("✓ 削除しました");
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
  if (!query) { toast("URLまたはISIN,協会コードを入力してください。", "error"); return; }
  const resp = await fetch("/api/catalog", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, query, watch: true }),
  });
  const data = await resp.json();
  if (!data.ok) { toast(data.error || "登録に失敗しました", "error"); return; }
  $("reg-name").value = ""; $("reg-code").value = "";
  $("register-form").hidden = true;
  toast("✓ 登録して一覧に追加しました");
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
  } catch (e) { toast("通信エラー: " + e.message, "error"); return; }
  if (!data.ok) { toast(data.error || "分析に失敗しました", "error"); return; }
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
  renderHorizons(data.horizons);
  renderReasons(data.reasons, data.score);
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
    // ホバー時の吹き出しを、白地に白文字にならないよう濃色背景＋白文字で固定
    hoverlabel: { bgcolor: "#1e2130", bordercolor: "#1e2130",
                  font: { color: "#ffffff", size: 12.5, family: "Hiragino Sans, sans-serif" } },
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
function renderHorizons(horizons) {
  const el = $("horizons-list");
  if (!horizons || !horizons.length) { el.innerHTML = ""; return; }
  const stanceInfo = {
    add:  { cls: "buy",     emoji: "🟢" },
    hold: { cls: "neutral", emoji: "🟡" },
    trim: { cls: "sell",    emoji: "🔴" },
  };
  el.innerHTML = horizons.map((h) => {
    if (!h.ok) {
      return `<div class="hz-row">
        <div class="hz-head"><span class="hz-label">${escapeHtml(h.label)}</span>
          <span class="vbadge neutral">— 判定不可</span></div>
        <p class="hz-comment">${escapeHtml(h.comment)}</p></div>`;
    }
    const si = stanceInfo[h.stance] || stanceInfo.hold;
    const factors = (h.factors || []).map((f) => `<span class="hz-factor">${escapeHtml(f)}</span>`).join("");
    return `<div class="hz-row">
      <div class="hz-head">
        <span class="hz-label">${escapeHtml(h.label)}</span>
        <span class="vbadge ${si.cls}">${si.emoji} ${escapeHtml(h.stance_label)}</span>
        <span class="hz-score">スコア ${h.score > 0 ? "+" : ""}${h.score}</span>
      </div>
      <p class="hz-comment">${escapeHtml(h.comment)}</p>
      <div class="hz-factors">${factors}</div>
    </div>`;
  }).join("");
}

function renderReasons(reasons, score) {
  const el = $("reasons-list");
  if (!reasons || !reasons.length) {
    el.innerHTML = "<li>判断材料が不足しています。</li>";
    return;
  }
  // 文字列（旧形式）にも一応対応
  if (typeof reasons[0] === "string") {
    el.innerHTML = reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("");
    return;
  }
  const buys = reasons.filter((r) => r.dir === "buy");
  const sells = reasons.filter((r) => r.dir === "sell");
  const summary = score >= 30
    ? `買い材料が売り材料を上回っています（総合スコア +${score}）。`
    : score <= -30
      ? `売り材料が買い材料を上回っています（総合スコア ${score}）。`
      : `買い材料と売り材料が拮抗しています（総合スコア ${score > 0 ? "+" : ""}${score}）。`;
  const item = (r) => {
    const cls = r.dir === "buy" ? "buy" : r.dir === "sell" ? "sell" : "neutral";
    const tag = r.dir === "buy" ? "買い材料" : r.dir === "sell" ? "売り材料" : "中立";
    const pts = r.points > 0 ? `+${r.points}` : `${r.points}`;
    return `<li class="reason-item">
      <span class="reason-tag ${cls}">${tag}</span>
      <span class="reason-text">${escapeHtml(r.text)}</span>
      <span class="reason-pts ${cls}">${pts}</span></li>`;
  };
  el.innerHTML =
    `<li class="reason-summary">${summary}</li>` +
    buys.map(item).join("") + sells.map(item).join("") +
    reasons.filter((r) => r.dir === "neutral").map(item).join("");
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

// 数値を3桁カンマ区切りに（0/空は空文字）
function fmtInt(n) {
  const v = Number(n);
  if (!v || v <= 0) return "";
  return Math.round(v).toLocaleString("en-US");
}
// カンマ入り文字列 → 整数
function parseIntComma(s) {
  const d = String(s == null ? "" : s).replace(/[^\d]/g, "");
  return d ? parseInt(d, 10) : 0;
}
// 入力中に3桁カンマへ整形しつつ、カーソル位置を保つ
function reformatCommaInput(el) {
  const digits = el.value.replace(/[^\d]/g, "");
  const caret = el.selectionStart || 0;
  const digitsBefore = el.value.slice(0, caret).replace(/[^\d]/g, "").length;
  const formatted = digits ? Number(digits).toLocaleString("en-US") : "";
  el.value = formatted;
  let pos = 0, seen = 0;
  while (pos < formatted.length && seen < digitsBefore) {
    if (/\d/.test(formatted[pos])) seen++;
    pos++;
  }
  try { el.setSelectionRange(pos, pos); } catch (_) {}
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

// --- 検索のキーボード操作（↑↓で候補移動 / Enterで追加 / Escで閉じる）---
let searchSel = -1;
function updateSearchSel(items) {
  items.forEach((el, i) => el.classList.toggle("sel", i === searchSel));
  if (searchSel >= 0 && items[searchSel]) {
    items[searchSel].scrollIntoView({ block: "nearest" });
  }
}
$("search-input").addEventListener("keydown", (e) => {
  const box = $("search-results");
  const items = Array.from(box.querySelectorAll(".search-item"));
  if (e.key === "Escape") { box.hidden = true; e.target.blur(); return; }
  if (box.hidden || !items.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    searchSel = (searchSel + 1) % items.length;
    updateSearchSel(items);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    searchSel = (searchSel - 1 + items.length) % items.length;
    updateSearchSel(items);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const target = items[searchSel >= 0 ? searchSel : 0];
    if (!target) return;
    const add = target.querySelector(".si-add");
    if (add) add.click();
    else toast("この投信は追加済みです");
  }
});

// --- 「/」キーでどこからでも検索にフォーカス ---
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.metaKey && !e.ctrlKey
      && !e.target.closest("input, textarea, select")
      && !$("dashboard-view").hidden) {
    e.preventDefault();
    $("search-input").focus();
  }
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
  if (del) {
    e.stopPropagation();
    const row = del.closest("tr");
    const nm = row && row.querySelector(".fund-nm") ? row.querySelector(".fund-nm").textContent.trim() : "";
    removeFromWatch(del.dataset.watch, nm);
    return;
  }
  // 入力・設定中は詳細を開かない
  if (e.target.closest(".units-input") || e.target.closest(".invested-input")
      || e.target.closest(".policy-select") || e.target.closest(".row-broker")) return;
  const row = e.target.closest("tr[data-id]");
  if (row && !row.classList.contains("err-row")) openDetail(Number(row.dataset.id));
});

// 入力中の未確定保存を1件だけ保持（離脱時にも確実に流し込む）
let pendingSave = null;   // { path, watchId, key, value }
async function persistField(path, watchId, key, value) {
  try {
    await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watch_id: Number(watchId), [key]: Number(value) || 0 }),
    });
    pendingSave = null;
  } catch (_) { /* 入力途中の保存失敗は無視（確定時・離脱時に再保存される） */ }
}
// ページを離れる/リロードする瞬間に、未保存の入力を確実に送る（sendBeacon）
function flushPendingSave() {
  if (!pendingSave) return;
  const { path, watchId, key, value } = pendingSave;
  try {
    const body = new Blob([JSON.stringify({ watch_id: Number(watchId), [key]: Number(value) || 0 })],
                          { type: "application/json" });
    navigator.sendBeacon(path, body);
  } catch (_) {}
  pendingSave = null;
}
window.addEventListener("beforeunload", flushPendingSave);
window.addEventListener("pagehide", flushPendingSave);

// 数値入力を3桁カンマで整形しつつ、入力のたびにデバウンスしてDBへ保存
let fieldSaveTimer = null;
$("watch-body").addEventListener("input", (e) => {
  const el = e.target.closest(".num-comma");
  if (!el) return;
  reformatCommaInput(el);
  const isUnits = el.classList.contains("units-input");
  const path = isUnits ? "/api/watchlist/units" : "/api/watchlist/invested";
  const key = isUnits ? "units" : "invested";
  pendingSave = { path, watchId: el.dataset.watch, key, value: parseIntComma(el.value) };
  clearTimeout(fieldSaveTimer);
  fieldSaveTimer = setTimeout(() => {
    if (pendingSave) persistField(pendingSave.path, pendingSave.watchId, pendingSave.key, pendingSave.value);
  }, 400);
});

// 口数・投資金額・売却属性・証券会社の確定（フォーカスを外す/Enter）※保有行(watch_id)単位
$("watch-body").addEventListener("change", (e) => {
  const units = e.target.closest(".units-input");
  if (units) { clearTimeout(fieldSaveTimer); pendingSave = null; saveUnits(units.dataset.watch, parseIntComma(units.value)); return; }
  const inv = e.target.closest(".invested-input");
  if (inv) { clearTimeout(fieldSaveTimer); pendingSave = null; saveInvested(inv.dataset.watch, parseIntComma(inv.value)); return; }
  const pol = e.target.closest(".policy-select");
  if (pol) { savePolicy(pol.dataset.watch, pol.value); return; }
  const brk = e.target.closest(".row-broker");
  if (brk) saveBroker(brk.dataset.watch, brk.value);
});
$("watch-body").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.closest(".num-comma")) e.target.blur();
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

// メニュータブ切替
$("main-nav").addEventListener("click", (e) => {
  const tab = e.target.closest(".nav-tab");
  if (tab) switchView(tab.dataset.view);
});

// 価格推移グラフの表示切替（比率% / 実額円）
$("price-mode-toggle").addEventListener("click", (e) => {
  const b = e.target.closest(".pm-btn");
  if (!b || b.dataset.mode === priceMode) return;
  priceMode = b.dataset.mode;
  document.querySelectorAll("#price-mode-toggle .pm-btn").forEach((x) =>
    x.classList.toggle("active", x.dataset.mode === priceMode));
  if (lastActualData) renderPriceChart(lastActualData.holdings || [], lastActualData.totals || []);
});

// 価格推移グラフの期間切替
$("price-range").addEventListener("click", (e) => {
  const b = e.target.closest(".range-btn"); if (!b) return;
  document.querySelectorAll("#price-range .range-btn").forEach((x) => x.classList.remove("active"));
  b.classList.add("active"); priceRange = b.dataset.range; loadPriceHistory();
});

// 価格推移グラフの表示切替（商品別 / 合計のみ）
$("price-line-toggle").addEventListener("click", (e) => {
  const b = e.target.closest(".pm-btn");
  if (!b || b.dataset.line === lineMode) return;
  lineMode = b.dataset.line;
  document.querySelectorAll("#price-line-toggle .pm-btn").forEach((x) =>
    x.classList.toggle("active", x.dataset.line === lineMode));
  if (lastActualData) renderPriceChart(lastActualData.holdings || [], lastActualData.totals || []);
});

// 理想配分の編集
$("edit-targets-btn").addEventListener("click", () => {
  const f = $("targets-form"); f.hidden = !f.hidden;
});
$("targets-inputs").addEventListener("input", updateTargetsSum);
$("targets-save").addEventListener("click", saveTargets);
$("targets-form").addEventListener("click", (e) => {
  const b = e.target.closest(".preset-btn");
  if (b) applyPreset(b.dataset.preset);
});

// 資産クラスの変更（商品(catalog)単位）
$("class-edit-body").addEventListener("change", (e) => {
  const cls = e.target.closest(".class-select");
  if (cls) saveAssetClass(cls.dataset.id, cls.value);
});

// 内蔵商品の追加（証券会社を選んで＋追加）
$("preset-add-body").addEventListener("click", (e) => {
  const btn = e.target.closest(".preset-add-btn");
  if (!btn) return;
  const row = btn.closest("tr[data-id]");
  const sel = row ? row.querySelector(".preset-broker-select") : null;
  addPreset(btn.dataset.id, sel ? sel.value : "");
});
$("preset-class-filter").addEventListener("change", (e) => {
  presetClassFilter = e.target.value;
  renderPresetCatalog();
});

$("ranking-btn").addEventListener("click", loadRanking);
$("ranking-body").addEventListener("click", (e) => {
  const add = e.target.closest(".rank-add");
  if (add) {
    e.stopPropagation();
    addToWatch(add.dataset.id).then(loadRanking);
    return;
  }
  const row = e.target.closest("tr[data-id]");
  if (row) openDetail(Number(row.dataset.id));
});

$("detail-range").addEventListener("click", (e) => {
  const b = e.target.closest(".range-btn"); if (!b) return;
  document.querySelectorAll("#detail-range .range-btn").forEach((x) => x.classList.remove("active"));
  b.classList.add("active"); detailRange = b.dataset.range; analyzeDetail();
});
$("back-btn").addEventListener("click", showDashboard);

// 初期表示
loadWatchlist();
