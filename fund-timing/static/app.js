"use strict";

const $ = (id) => document.getElementById(id);

let dashRange = "1y";
let detailRange = "3y";
let sortKey = "broker";     // 既定は証券会社順（SBI→UFJ→楽天）
let sortDir = 1;            // -1: 降順, 1: 昇順
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
  $("plan-view").hidden = view !== "plan";
  $("settings-view").hidden = view !== "settings";
  document.querySelectorAll(".nav-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === view));
  // 非表示中に描画したPlotlyのグラフはサイズが正しく取れないため、
  // 表示に切り替えてレイアウトが確定してからリサイズする
  if (view === "portfolio") {
    renderPortfolioAi();
    requestAnimationFrame(() => {
      ["pie-current", "pie-target"].forEach((id) => {
        const el = $(id);
        if (el && el.data) Plotly.Plots.resize(el);
      });
    });
  } else if (view === "price") {
    loadPriceHistory();
  } else if (view === "plan") {
    loadPlan();
  } else if (view === "settings") {
    loadSettings();
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
  $("plan-view").hidden = true;
  $("settings-view").hidden = true;
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
    // 列: ファンド名/判定/強度/価格/口数/評価額/投資額/証券会社/口座/売却/騰落/値動き(+削除)
    body.innerHTML = Array.from({ length: 4 }, () =>
      `<tr>${cell(180)}${cell(90)}${cell(110)}${cell(80)}${cell(70)}${cell(80)}${cell(80)}${cell(100)}${cell(70)}${cell(80)}${cell(60)}${cell(90)}<td></td></tr>`
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
  renderShortTermBanner();
  renderWatchTable();
  renderPortfolio(data.portfolio);
  renderAllocation(data.allocation);
  renderClassEditor();
  loadPresetCatalog();
  // AIアドバイス：有効時のみ。初回 or 「最新に更新」時だけ呼ぶ（毎回は叩かない）。
  if (aiSettings.ai_model !== "off" && (force || !aiLoadedOnce)) {
    loadAiAdvice();
  }
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

async function loadPriceHistory(force) {
  const st = $("price-status");
  st.hidden = false; st.className = "status loading";
  st.textContent = force ? "最新の基準価額を取得中… ⏳" : "集計中… ⏳";
  let data;
  try {
    data = await (await fetch(`/api/actual-history?range=${encodeURIComponent(priceRange)}`
      + (force ? "&force=1" : ""))).json();
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
let trendFilter = "all";    // "all" | "up"（上昇）| "flat"（横ばい）| "down"（下降）

// 商品の評価額推移から上昇/横ばい/下降トレンドを判定する。
// 「直近加重ブレンド」：全期間の変化率を土台に、直近1/4期間の変化率を加味して
// 直近の失速・反発も少し織り込む（重み 全体0.6／直近0.4）。
function holdingTrend(h) {
  const src = (h.ratio && h.ratio.length) ? h.ratio : (h.amount || []);
  const vals = src.filter((v) => v != null);
  if (vals.length < 2) return "flat";
  const first = vals[0], last = vals[vals.length - 1];
  if (!first) return "flat";
  const fullChg = (last - first) / Math.abs(first) * 100;                 // 全期間の変化率(%)
  const rIdx = Math.min(Math.floor(vals.length * 0.75), vals.length - 2); // 直近1/4の起点
  const rBase = vals[rIdx];
  const recentChg = rBase ? (last - rBase) / Math.abs(rBase) * 100 : 0;   // 直近1/4の変化率(%)
  const score = 0.6 * fullChg + 0.4 * recentChg;                          // 直近を少し織り込む
  if (score >= 3) return "up";
  if (score <= -3) return "down";
  return "flat";
}

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

  // ── 投資信託のみのサマリー（個別株を含む場合に追加表示）──
  const hasStock = holds.some((h) => (h.kind || "fund") === "stock");
  const funds = holds.filter((h) => (h.kind || "fund") !== "stock");
  $("sum-all-title").textContent = hasStock ? "全体（投資信託＋個別株）" : "全体";
  $("sum-fund-title").hidden = !hasStock;
  $("sum-fund-grid").hidden = !hasStock;
  if (hasStock) {
    let finv = 0, fcur = 0, fprev = 0, haveCur = false, havePrev = false;
    funds.forEach((h) => {
      finv += Number(h.invested || 0);
      const amts = h.amount || [];
      const vals = [];
      for (let i = amts.length - 1; i >= 0 && vals.length < 2; i--) {
        if (amts[i] != null) vals.push(amts[i]);
      }
      if (vals[0] != null) { fcur += vals[0]; haveCur = true; }
      if (vals[1] != null) { fprev += vals[1]; havePrev = true; }
    });
    const fpl = fcur - finv, fplr = finv > 0 ? (fpl / finv * 100) : 0;
    $("sum-fund-invested").textContent = Number(finv).toLocaleString() + " 円";
    $("sum-fund-current").textContent = Number(Math.round(fcur)).toLocaleString() + " 円";
    $("sum-fund-pl").textContent = (fpl >= 0 ? "+" : "") + Number(Math.round(fpl)).toLocaleString() + " 円";
    $("sum-fund-pl").className = "pf-sum-val " + (fpl >= 0 ? "up" : "down");
    $("sum-fund-plr").textContent = (fplr >= 0 ? "+" : "") + fplr.toFixed(1) + "%";
    $("sum-fund-plr").className = "pf-sum-val " + (fplr >= 0 ? "up" : "down");
    const fdod = $("sum-fund-dod");
    if (haveCur && havePrev && fprev > 0) {
      const fdiff = fcur - fprev, fdp = fdiff / fprev * 100;
      fdod.textContent = `${fdiff >= 0 ? "+" : ""}${Number(Math.round(fdiff)).toLocaleString()} 円`
        + `（${fdp >= 0 ? "+" : ""}${fdp.toFixed(2)}%）`;
      fdod.className = "pf-sum-val pf-sum-dod " + (fdiff >= 0 ? "up" : "down");
    } else {
      fdod.textContent = "—"; fdod.className = "pf-sum-val pf-sum-dod";
    }
  }
}

function renderPriceChart(holdings, totals) {
  const empty = $("price-empty");
  if (!holdings.length) {
    empty.textContent = "取引履歴データがありません。";
    empty.hidden = false; Plotly.purge("actual-chart"); return;
  }
  empty.hidden = true;
  const amountMode = priceMode === "amount";
  const totalOnly = lineMode === "total";
  // トレンド絞り込みは商品別モードのみ有効。合計のみのときはトグルを無効表示に
  const trendToggle = $("price-trend-toggle");
  if (trendToggle) trendToggle.classList.toggle("disabled", totalOnly);
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
      if (trendFilter !== "all" && holdingTrend(h) !== trendFilter) return;  // トレンド絞り込み
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
  if (!traces.length) {   // トレンド絞り込みで該当なし
    const label = { up: "上昇傾向", flat: "横ばい", down: "下降傾向" }[trendFilter] || "";
    empty.textContent = `${label}の商品はありません。別のトレンドを選ぶか「すべて」に戻してください。`;
    empty.hidden = false; Plotly.purge("actual-chart"); return;
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
const POLICY_ORDER = { full: 0, partial: 1, locked: 2 };   // 売却可→一部可→不可
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
  // 前日比セル（直近2日の評価額の差）。%のみ表示
  const dodCell = (dts, amts) => {
    const vals = [];
    for (let i = (dts ? dts.length : 0) - 1; i >= 0 && vals.length < 2; i--) {
      const v = amts[i];
      if (v != null) vals.push(v);
    }
    if (vals.length < 2 || !vals[1]) return `<td class="num pt-dodcol">—</td>`;
    const diff = vals[0] - vals[1], pct = diff / vals[1] * 100;
    const cls = diff >= 0 ? "up" : "down", sg = diff >= 0 ? "+" : "";
    return `<td class="num pt-dodcol ${cls}">${sg}${pct.toFixed(2)}%</td>`;
  };
  // ヘッダ：商品名（固定）＋ 損益率（固定）＋ 前日比（固定）＋ 各日付
  $("price-table-head").innerHTML =
    `<th class="pt-namecol">商品名</th><th class="num pt-plcol">損益率</th><th class="num pt-dodcol">前日比</th>` +
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
        `<td class="pt-plcol"></td><td class="pt-dodcol"></td><td class="num" colspan="${ndates}"></td></tr>`;
    }
    const m = {}; h.dates.forEach((d, k) => { m[d] = h.amount[k]; });
    const cells = cols.map((d) => {
      const v = m[d];
      return `<td class="num">${v == null ? "—" : Number(v).toLocaleString()}</td>`;
    }).join("");
    const acct = (h.account && h.account !== h.name)
      ? `<div class="pt-acct">${escapeHtml(h.account)}</div>` : "";
    html += `<tr><td class="pt-namecol pt-col" style="--cc:${color}">${escapeHtml(h.name)}${acct}</td>${plCell(h.latest_ratio)}${dodCell(h.dates, h.amount)}${cells}</tr>`;
  });
  const totRatio = totals.length ? totals[totals.length - 1].ratio : null;
  const totalCells = cols.map((d) => {
    const v = totalMap[d];
    return `<td class="num">${v == null ? "—" : Number(v).toLocaleString()}</td>`;
  }).join("");
  const totDod = dodCell(totals.map((t) => t.date), totals.map((t) => t.amount));
  html += `<tr class="pt-total-row"><td class="pt-namecol">合計</td>${plCell(totRatio)}${totDod}${totalCells}</tr>`;
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

// 口座種別（NISA/特定）の保存 ※保有行(watch_id)単位。資産プランの税引後予測に反映
async function saveAccountType(watchId, accountType) {
  try {
    const resp = await fetch("/api/watchlist/account", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watch_id: Number(watchId), account_type: accountType }),
    });
    const data = await resp.json();
    if (!data.ok) { toast(data.error || "保存に失敗しました", "error"); return; }
    toast(`✓ 口座を${accountType === "nisa" ? "NISA（非課税）" : "特定"}に設定しました`);
    loadWatchlist();
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

// 短期ホライズンのスコアから 買い時(buy)/売り時(sell) を判定（±30が閾値）
function shortTermSignal(s) {
  if (!s || !s.ok || !Array.isArray(s.hz)) return null;
  const h = s.hz.find((x) => x.key === "short" && x.ok && x.score != null);
  if (!h) return null;
  if (h.score >= 30) return "buy";
  if (h.score <= -30) return "sell";
  return null;
}

// シグナルの強さ（±30〜±100）に応じた売買の口数・金額の目安を算出
function shortTermAdvice(s, signal) {
  const h = (s.hz || []).find((x) => x.key === "short");
  const score = h && h.score != null ? Math.abs(h.score) : 30;
  const strength = Math.min(1, Math.max(0, (score - 30) / 70)); // 0〜1
  const price = Number(s.latest_price) || 0;
  const units = Number(s.units) || 0;
  const value = Number(s.value) || 0;
  const isStock = s.kind === "stock";

  if (signal === "sell") {
    const pol = s.sell_policy || "full";
    if (pol === "locked") return { hold: true };
    let frac = 0.10 + strength * 0.20;                 // 10〜30%
    if (pol === "partial") frac = Math.min(frac, 0.15); // 「一部可」は控えめに
    const amount = Math.round(value * frac);
    const u = units > 0 ? Math.round(units * frac) : null;
    return { kind: "sell", frac, amount, units: u, isStock };
  }
  const frac = 0.05 + strength * 0.10;                  // 買い増しは 5〜15%
  const amount = Math.round(value * frac);
  const u = units > 0 ? Math.round(units * frac)
          : (price > 0 && amount > 0 ? Math.round(amount / price * 10000) : null);
  return { kind: "buy", frac, amount, units: u, isStock };
}

// 口数・金額の目安を読みやすい日本語にする
function shortTermAdviceText(s, signal) {
  const a = shortTermAdvice(s, signal);
  if (a.hold) return "売却不可設定のため今回は見送り（ホールド）";
  const hasAmt = a.amount > 0;
  const uStr = (a.units != null && a.units > 0)
    ? (a.isStock ? `${a.units.toLocaleString()}株` : `${a.units.toLocaleString()}口`) : null;
  const amtStr = hasAmt ? `約 ${a.amount.toLocaleString()} 円` : null;
  if (!hasAmt && !uStr) {
    return signal === "buy"
      ? "口数を入力すると買い増しの目安金額を表示します"
      : "口数を入力すると売却の目安金額を表示します";
  }
  const detail = (amtStr && uStr) ? `${amtStr}（≈ ${uStr}）` : (amtStr || uStr);
  const pct = Math.round(a.frac * 100);
  return signal === "buy"
    ? `買い増し目安 ${detail}・保有の約${pct}%`
    : `一部利益確定 ${detail}・保有の約${pct}%を売却検討`;
}

// 短期の売り時・買い時サマリーを画面上部に大きく表示（売買の目安つき）
function renderShortTermBanner() {
  const el = $("short-term-banner");
  if (!el) return;
  const buys = [], sells = [];
  lastSummaries.forEach((s) => {
    const st = shortTermSignal(s);
    if (st === "buy") buys.push(s);
    else if (st === "sell") sells.push(s);
  });
  if (!buys.length && !sells.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const list = (arr, signal) => arr.map((s) =>
    `<li><span class="st-item-nm">${escapeHtml(s.account || s.name)}</span>`
    + `<span class="st-item-adv">${escapeHtml(shortTermAdviceText(s, signal))}</span></li>`
  ).join("");
  let html = "";
  if (buys.length) {
    html += `<div class="st-line st-line-buy">
      <div class="st-head"><span class="st-icon">🟢🔔</span>
        <span class="st-text"><b>短期の買い時</b> ${buys.length} 件
          <span class="st-hint">（押し目・積立継続／買い増しを検討できる水準）</span></span></div>
      <ul class="st-list">${list(buys, "buy")}</ul></div>`;
  }
  if (sells.length) {
    html += `<div class="st-line st-line-sell">
      <div class="st-head"><span class="st-icon">🔴🔔</span>
        <span class="st-text"><b>短期の売り時</b> ${sells.length} 件
          <span class="st-hint">（過熱気味／一部利益確定を検討できる水準）</span></span></div>
      <ul class="st-list">${list(sells, "sell")}</ul></div>`;
  }
  html += `<div class="st-note">※ 口数・金額はシグナルの強さから算出した機械的な目安です（保有評価額に対する割合。税・手数料・分配金は未考慮）。投資助言ではありません。</div>`;
  el.innerHTML = html;
  el.hidden = false;
}

function renderWatchTable() {
  const body = $("watch-body");
  const empty = $("empty-watch");
  updateSortHeaders();   // 現在のソート列に▲/▼を反映（初回描画でも）
  if (!lastSummaries.length) {
    body.innerHTML = ""; empty.hidden = false; return;
  }
  empty.hidden = true;

  const rows = lastSummaries.slice().sort((a, b) => {
    let va, vb;
    if (sortKey === "broker") {
      // 証券会社: SBI → 三菱UFJ → 楽天 の順（未設定・その他は末尾）
      const oa = BROKER_ORDER[a.broker] ?? 99;
      const ob = BROKER_ORDER[b.broker] ?? 99;
      if (oa !== ob) return sortDir * (oa - ob);
      // 同じ証券会社内はシグナル強度の高い順
      return (b.score ?? -999) - (a.score ?? -999);
    }
    if (sortKey === "sell_policy") {
      // 売却設定: 売却可 → 一部可 → 不可 の順
      va = POLICY_ORDER[a.sell_policy] ?? 9;
      vb = POLICY_ORDER[b.sell_policy] ?? 9;
      return sortDir * (va - vb);
    }
    if (sortKey === "account_type") {
      va = a.account_type === "nisa" ? 0 : 1;
      vb = b.account_type === "nisa" ? 0 : 1;
      return sortDir * (va - vb);
    }
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
        <td colspan="11" class="err-msg">⚠️ ${escapeHtml(s.error || "取得に失敗")}</td>
        <td><button class="row-del" data-watch="${s.watch_id}" title="削除">✕</button></td></tr>`;
    }
    const badge = verdictBadge(s.verdict, s.verdict_label);
    const st = shortTermSignal(s);
    const stBadge = st === "buy"
      ? '<span class="st-badge st-buy" title="短期指標が買い寄り（押し目）の水準です">🔔 短期 買い時</span>'
      : st === "sell"
      ? '<span class="st-badge st-sell" title="短期指標が過熱・売り寄りの水準です">🔔 短期 売り時</span>'
      : "";
    const rowCls = st === "buy" ? "watch-row st-row-buy"
      : st === "sell" ? "watch-row st-row-sell" : "watch-row";
    const chg = s.change_pct == null ? "—"
      : `<span class="${s.change_pct >= 0 ? 'up' : 'down'}">${s.change_pct >= 0 ? '+' : ''}${s.change_pct}%</span>`;
    const price = s.latest_price == null ? "—" : Number(s.latest_price).toLocaleString() + " 円";
    const value = s.value == null ? "—" : Number(s.value).toLocaleString() + " 円";
    const plSub = (s.pl_pct == null) ? ""
      : `<div class="pl-sub ${s.pl_pct >= 0 ? "up" : "down"}">損益 ${s.pl_pct >= 0 ? "+" : ""}${s.pl_pct}%</div>`;
    const aiAdv = aiAdviceByWatch[s.watch_id]
      ? `<div class="ai-fund-advice">🤖 ${escapeHtml(aiAdviceByWatch[s.watch_id])}</div>` : "";
    return `<tr class="${rowCls}" data-id="${s.catalog_id}" data-watch="${s.watch_id}">
      <td class="fund-cell">
        <div class="fund-nm">${escapeHtml(s.name)}${stBadge}</div>
        <div class="fund-sub">${classChip(s.asset_class)}${s.account && s.account !== s.name ? `<span class="acct-chip">${escapeHtml(s.account)}</span>` : ""}${s.kind === "stock" ? '<span class="kind-chip">株</span>' : ""} ${escapeHtml(s.category || "")}</div>
        ${aiAdv}
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
      <td>${accountSelect(s)}</td>
      <td>${policySelect(s)}</td>
      <td class="num">${chg}</td>
      <td class="spark-cell">${sparkline(s.spark, s.verdict)}</td>
      <td><button class="row-del" data-watch="${s.watch_id}" title="削除">✕</button></td>
    </tr>`;
  }).join("");
}

function accountSelect(s) {
  const a = s.account_type === "nisa" ? "nisa" : "taxable";
  const opt = (v, label) => `<option value="${v}"${a === v ? " selected" : ""}>${label}</option>`;
  return `<select class="account-select account-${a}" data-watch="${s.watch_id}"
      title="口座種別。NISA＝非課税。資産プランの税引後予測でNISA分は非課税として計算します">
    ${opt("taxable", "特定")}${opt("nisa", "NISA")}
  </select>`;
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
      || e.target.closest(".policy-select") || e.target.closest(".row-broker")
      || e.target.closest(".account-select")) return;
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
  if (brk) { saveBroker(brk.dataset.watch, brk.value); return; }
  const acc = e.target.closest(".account-select");
  if (acc) saveAccountType(acc.dataset.watch, acc.value);
});
$("watch-body").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.closest(".num-comma")) e.target.blur();
});

document.querySelectorAll(".watch-table th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    if (sortKey === key) sortDir = -sortDir;
    else { sortKey = key; sortDir = (key === "name" || key === "broker" || key === "sell_policy" || key === "account_type") ? 1 : -1; }
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

// 価格推移の「最新に更新」：最新の基準価額（昨日分など）を強制取得
$("price-refresh-btn").addEventListener("click", () => loadPriceHistory(true));

// 価格推移グラフの表示切替（商品別 / 合計のみ）
$("price-line-toggle").addEventListener("click", (e) => {
  const b = e.target.closest(".pm-btn");
  if (!b || b.dataset.line === lineMode) return;
  lineMode = b.dataset.line;
  document.querySelectorAll("#price-line-toggle .pm-btn").forEach((x) =>
    x.classList.toggle("active", x.dataset.line === lineMode));
  if (lastActualData) renderPriceChart(lastActualData.holdings || [], lastActualData.totals || []);
});

// 価格推移グラフのトレンド絞り込み（上昇 / 横ばい / 下降）※商品別モードのみ
$("price-trend-toggle").addEventListener("click", (e) => {
  const b = e.target.closest(".pm-btn");
  if (!b || b.dataset.trend === trendFilter) return;
  if (lineMode === "total") return;   // 合計のみモードでは無効
  trendFilter = b.dataset.trend;
  document.querySelectorAll("#price-trend-toggle .pm-btn").forEach((x) =>
    x.classList.toggle("active", x.dataset.trend === trendFilter));
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

// ============================================================ 設定 / AIアドバイス
let aiSettings = { ai_model: "off", ai_available: false, ai_key_set: false, ai_key_from_env: false };
const AI_MODEL_LABELS = { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" };
function modelLabel(m) { return AI_MODEL_LABELS[m] || "AI"; }
let aiAdviceByWatch = {};   // watch_id -> コメント
let lastAiAdvice = null;    // 直近のAIアドバイス全体 {overall, rebalance, funds}
let lastAiModel = null;
let aiLoadedOnce = false;

async function loadSettings() {
  try {
    const r = await fetch("/api/settings");
    const d = await r.json();
    if (d && d.ok) { aiSettings = d; renderSettingsUI(); }
  } catch (_) { /* 設定取得失敗時は既定(off)のまま */ }
  // 資産プランの前提（取り崩し戦略）の値を設定画面へ反映
  try {
    const pr = await fetch("/api/plan");
    const pd = await pr.json();
    if (pd && pd.ok) {
      const pl = pd.plan || {};
      $("set-cash").value = fmtInt(pl.cash || 0);
      $("set-bonds").value = fmtInt(pl.bonds || 0);
      $("set-current-age").value = pl.current_age || "";
      $("set-retire-age").value = pl.retire_age || "";
      $("set-pension-age").value = pl.pension_age || "";
      $("set-pension-monthly").value = fmtInt(pl.pension_monthly || 0);
      $("set-spend-monthly").value = fmtInt(pl.spend_monthly || 0);
      $("set-inflation").value = pl.inflation != null ? pl.inflation : "";
      $("set-tax").value = pl.tax != null ? pl.tax : 20.315;   // 既定：日本の約20.315%
      $("set-emergency-months").value = pl.emergency_months != null ? pl.emergency_months : 6;
      $("set-near-term").value = fmtInt(pl.near_term || 0);
    }
  } catch (_) {}
}

function renderSettingsUI() {
  document.querySelectorAll("#ai-model-toggle .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.model === aiSettings.ai_model));
  const st = $("ai-key-status");
  if (!st) return;
  if (!aiSettings.ai_available) {
    st.innerHTML = "⚠️ anthropic パッケージが未インストールです。<code>pip install anthropic</code> を実行してください。";
  } else if (aiSettings.ai_key_from_env) {
    st.textContent = "✅ 環境変数 ANTHROPIC_API_KEY を使用中（こちらが優先されます）。";
  } else if (aiSettings.ai_key_set) {
    st.textContent = "✅ APIキーは保存済みです（変更する場合のみ再入力してください）。";
  } else {
    st.textContent = "APIキーは未設定です。";
  }
}

async function saveAiModel(model) {
  aiSettings.ai_model = model;
  renderSettingsUI();
  try {
    await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ai_model: model }) });
  } catch (_) {}
  if (model === "off") {
    aiAdviceByWatch = {}; lastAiAdvice = null; aiLoadedOnce = false;
    const b = $("ai-advice-banner"); b.hidden = true; b.innerHTML = "";
    renderWatchTable();
    renderPortfolioAi();
    toast("AIアドバイスをオフにしました");
  } else {
    toast(`AIアドバイス: ${modelLabel(model)} に設定しました`);
    aiLoadedOnce = false;
    loadAiAdvice();
  }
}

async function saveAiKey() {
  const key = $("ai-key-input").value.trim();
  try {
    await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ai_api_key: key }) });
    $("ai-key-input").value = "";
    toast(key ? "APIキーを保存しました" : "APIキーを削除しました");
    await loadSettings();
  } catch (_) { toast("保存に失敗しました", "error"); }
}

async function loadAiAdvice(fromTest) {
  const banner = $("ai-advice-banner");
  const testStatus = $("ai-test-status");
  if (aiSettings.ai_model === "off") { banner.hidden = true; return; }
  if (fromTest && testStatus) testStatus.textContent = "問い合わせ中… ⏳";
  banner.hidden = false;
  banner.innerHTML = '<div class="ai-head"><span class="ai-ico">🤖</span> AIがコメントを生成中… ⏳</div>';
  try {
    const r = await fetch(`/api/ai-advice?range=${encodeURIComponent(dashRange)}`);
    const d = await r.json();
    if (!d.ok) {
      banner.innerHTML = `<div class="ai-head ai-err"><span class="ai-ico">🤖</span> ${escapeHtml(d.error || "AIアドバイスを取得できませんでした")}</div>`;
      if (fromTest && testStatus) testStatus.textContent = "⚠️ " + (d.error || "失敗");
      return;
    }
    aiLoadedOnce = true;
    renderAiAdvice(d.advice, d.model);
    if (fromTest && testStatus) testStatus.textContent = "✅ 成功（銘柄一覧に表示しました）";
  } catch (_) {
    banner.innerHTML = '<div class="ai-head ai-err"><span class="ai-ico">🤖</span> AI呼び出しに失敗しました</div>';
    if (fromTest && testStatus) testStatus.textContent = "⚠️ 失敗";
  }
}

function renderAiAdvice(advice, model) {
  const banner = $("ai-advice-banner");
  advice = advice || {};
  lastAiAdvice = advice;
  lastAiModel = model;
  aiAdviceByWatch = {};
  (advice.funds || []).forEach((f) => {
    if (f && f.watch_id != null) aiAdviceByWatch[f.watch_id] = f.advice;
  });
  const label = modelLabel(model);
  // 銘柄一覧では「売買」に関するコメントのみ表示（リバランス・資産配分はポートフォリオ画面へ）
  const tradeHead = advice.trade_overall || advice.overall || "";
  let html = `<div class="ai-head"><span class="ai-ico">🤖</span><b>売買アドバイス</b><span class="ai-model">${label}</span></div>`;
  if (tradeHead) html += `<div class="ai-block"><div class="ai-block-t">売買の見立て</div><div class="ai-block-b">${escapeHtml(tradeHead)}</div></div>`;
  html += '<div class="ai-foot">※ 各商品の売買コメントは表の銘柄名の下に表示しています。機械的な参考情報であり投資助言ではありません。</div>';
  banner.innerHTML = html;
  banner.hidden = false;
  renderWatchTable();   // 銘柄別コメントを表に反映
  renderPortfolioAi();  // ポートフォリオ画面のAIカードにも反映
}

// ポートフォリオ画面の「🤖 AIの見解」カード（総合・リバランス）
function renderPortfolioAi() {
  const card = $("ai-portfolio-card");
  if (!card) return;
  if (aiSettings.ai_model === "off" || !lastAiAdvice) { card.hidden = true; return; }
  const a = lastAiAdvice;
  const label = modelLabel(lastAiModel);
  let html = "";
  if (a.overall) html += `<div class="ai-block"><div class="ai-block-t">総合</div><div class="ai-block-b">${escapeHtml(a.overall)}</div></div>`;
  if (a.rebalance) html += `<div class="ai-block"><div class="ai-block-t">リバランス</div><div class="ai-block-b">${escapeHtml(a.rebalance)}</div></div>`;
  if (!html) { card.hidden = true; return; }
  html += `<div class="ai-foot"><span class="ai-model">${label}</span> ※ 機械的な参考情報であり投資助言ではありません。</div>`;
  $("ai-portfolio-body").innerHTML = html;
  card.hidden = false;
}

$("ai-model-toggle").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-btn");
  if (b && b.dataset.model !== aiSettings.ai_model) saveAiModel(b.dataset.model);
});
$("ai-key-save").addEventListener("click", saveAiKey);
$("ai-test-btn").addEventListener("click", () => loadAiAdvice(true));

// 資産プランの前提（設定画面）— 入力を /api/plan に保存
function bindPremise(id, key, comma) {
  const el = $(id); if (!el) return;
  el.addEventListener("input", (e) => {
    let v;
    if (comma) { reformatCommaInput(e.target); v = parseIntComma(e.target.value); }
    else { v = parseFloat(e.target.value) || 0; }
    savePlan({ [key]: v });
  });
}
bindPremise("set-cash", "cash", true);
bindPremise("set-bonds", "bonds", true);
bindPremise("set-current-age", "current_age", false);
bindPremise("set-retire-age", "retire_age", false);
bindPremise("set-pension-age", "pension_age", false);
bindPremise("set-pension-monthly", "pension_monthly", true);
bindPremise("set-spend-monthly", "spend_monthly", true);
bindPremise("set-inflation", "inflation", false);
bindPremise("set-tax", "tax", false);
bindPremise("set-emergency-months", "emergency_months", false);
bindPremise("set-near-term", "near_term", true);

// ============================================================ 資産プラン
let planData = { total_value: 0, total_invested: 0, holdings: [], plan: {} };
let planRange = "1y";
let lastPlanTotals = [];   // 直近取得した資産推移 [{date, amount}]
let aiBand = null;         // AI予測の年率 {base, optimistic, pessimistic}（無ければ手動）

async function loadPlan() {
  await flushPlanSave();   // 設定画面での前提変更を確定させてから取得（即時反映）
  try {
    const r = await fetch("/api/plan");
    const d = await r.json();
    if (d.ok) {
      planData = d;
      planData.plan = planData.plan || {};
      $("plan-goal").value = fmtInt(planData.plan.goal || 0);
      $("plan-monthly").value = fmtInt(planData.plan.monthly || 0);
      $("plan-return").value = planData.plan.return_rate != null ? planData.plan.return_rate : "";
      renderPlanGoal();
      renderCashAdvice();
      renderDividends();
    }
  } catch (_) {}
  // AI予測ボタンは設定でAIをオンにしているときだけ表示
  const aiRow = $("plan-ai-row");
  if (aiRow) aiRow.hidden = (aiSettings.ai_model === "off");
  loadPlanHistory();
}

async function loadPlanHistory() {
  try {
    const r = await fetch(`/api/actual-history?range=${encodeURIComponent(planRange)}`);
    const d = await r.json();
    // totals_full は選択期間に応じた推移（totals は記録実額の期間に固定）
    const src = (d && (d.totals_full || d.totals)) || [];
    lastPlanTotals = src.map((t) => ({ date: t.date, amount: t.amount }));
  } catch (_) { lastPlanTotals = []; }
  renderPlanHistory();
}

let planSaveTimer = null;
let planSavePending = null;             // 未送信の変更（まとめて送る）
let planSaveInflight = Promise.resolve();
function savePlan(payload) {
  // 変更を即メモリへ反映（メニュー切替時に古い値を再取得して上書きされないように）
  planData.plan = Object.assign(planData.plan || {}, payload);
  planSavePending = Object.assign(planSavePending || {}, payload);
  clearTimeout(planSaveTimer);
  planSaveTimer = setTimeout(flushPlanSave, 450);
}
// 保留中の変更を即時に送信し、直近の保存完了を待てる Promise を返す
function flushPlanSave() {
  clearTimeout(planSaveTimer);
  if (planSavePending) {
    const body = planSavePending; planSavePending = null;
    planSaveInflight = fetch("/api/plan", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  }
  return planSaveInflight;
}

// 保有現金＋債券（値上がりを見込まない安定資産）
function planReserve() {
  return (planData.plan.cash || 0) + (planData.plan.bonds || 0);
}
// 投信評価額
function planFundValue() { return planData.total_value || 0; }
// 総資産（投信＋現金＋債券）
function planTotalAssets() { return planFundValue() + planReserve(); }

// --- 目標・進捗 ---
function renderPlanGoal() {
  const goal = planData.plan.goal || 0;
  const fund = planFundValue();
  const reserve = planReserve();
  const cur = fund + reserve;   // 総資産で進捗を判定
  const pct = goal > 0 ? (cur / goal * 100) : 0;
  $("fire-fill").style.width = Math.min(100, pct).toFixed(1) + "%";
  $("fire-pct").textContent = goal > 0 ? `達成率 ${pct.toFixed(1)}%` : "目標額を入力してください";
  const remain = goal - cur;
  $("fire-remain").textContent = goal > 0
    ? (remain > 0 ? `あと ${Math.round(remain).toLocaleString()} 円` : "🎉 目標達成！")
    : "";
  let note = "";
  if (goal > 0) {
    note = `総資産 ${Math.round(cur).toLocaleString()} 円 ／ 目標 ${Math.round(goal).toLocaleString()} 円`;
    if (reserve > 0) note += `（内訳：投信 ${Math.round(fund).toLocaleString()} 円`
      + `＋現金 ${Math.round(planData.plan.cash || 0).toLocaleString()} 円`
      + `＋債券 ${Math.round(planData.plan.bonds || 0).toLocaleString()} 円）`;
  }
  $("plan-goal-note").textContent = note;

  // NISA（非課税枠）の使用状況。銘柄一覧で口座種別をNISAにすると集計されます
  const nisaEl = $("plan-nisa-note");
  if (nisaEl) {
    const nInv = planData.nisa_invested || 0, nVal = planData.nisa_value || 0;
    const CAP = 18000000;   // 生涯非課税保有限度額 1,800万円
    if (nInv > 0) {
      const man = (n) => Math.round(n / 10000).toLocaleString() + "万円";
      nisaEl.textContent = `🅽 NISA（非課税）：投資額 ${man(nInv)}（評価額 ${man(nVal)}）`
        + ` ／ 生涯枠1,800万円の残り 約 ${man(Math.max(0, CAP - nInv))}。NISA分の利益は税引後予測で非課税として計算します。`;
      nisaEl.hidden = false;
    } else {
      nisaEl.textContent = "🅽 NISA：銘柄一覧の「口座」列でNISAを選ぶと、非課税として税引後予測に反映し、枠の使用状況を表示します。";
      nisaEl.hidden = false;
    }
  }
}

// --- 手元に置きたい現金の目安（①生活防衛資金＋②数年内の予定支出＋③退職後の無年金クッション）---
function renderCashAdvice() {
  const body = $("cash-advice-body");
  if (!body) return;
  const p = planData.plan || {};
  const spend = p.spend_monthly || 0;                       // 月間生活費（退職後の生活費を流用）
  if (spend <= 0) {
    body.innerHTML = `<p class="empty-watch">設定の「資産プランの前提」で<strong>退職後の生活費</strong>を入力すると、手元に置きたい現金の目安を計算します。</p>`;
    return;
  }
  const emMonths = p.emergency_months != null ? p.emergency_months : 6;
  const nearTerm = p.near_term || 0;
  const retire = +p.retire_age || 0, pen = +p.pension_age || 0;
  const gapMonths = (retire && pen > retire) ? Math.round((pen - retire) * 12) : 0;
  const emergency = spend * emMonths;                        // ①
  const gapCushion = spend * gapMonths;                      // ③
  const nowTotal = emergency + nearTerm;                     // 今すぐ手元に置きたい（①＋②）
  const cash = p.cash || 0, bonds = p.bonds || 0, reserve = cash + bonds;
  const yen = (n) => Math.round(n).toLocaleString() + " 円";
  const row = (k, sub, v, extra) => `<div class="cash-adv-row ${extra || ""}">`
    + `<div class="cash-adv-k">${k}${sub ? `<span class="cash-adv-sub">${sub}</span>` : ""}</div>`
    + `<div class="cash-adv-v">${yen(v)}</div></div>`;

  let html = '<div class="cash-adv-rows">';
  html += row("① 生活防衛資金", `生活費 ${yen(spend)} × ${emMonths}ヶ月`, emergency);
  if (nearTerm > 0) html += row("② 数年内に使う予定額", "設定値", nearTerm);
  html += row("今すぐ手元に置きたい目安（①＋②）", "", nowTotal, "cash-adv-total");
  if (gapMonths > 0) {
    html += row("③ 退職〜年金の無年金クッション<span class=\"cash-adv-tag\">退職時までに</span>",
      `生活費 ${yen(spend)} × ${gapMonths}ヶ月（${retire}→${pen}歳・年金なしの生活費）`, gapCushion);
    html += row("退職時までに用意したい目安（①＋②＋③）", "", nowTotal + gapCushion, "cash-adv-total cash-adv-total-2");
  }
  html += '</div>';

  // 現状との比較。退職までの年数を踏まえ、退職が近い場合は③の不足も判定に反映する
  const age0 = +p.current_age || 0;
  const yearsToRetire = (retire && age0 && retire > age0) ? Math.round((retire - age0) * 10) / 10 : null;
  const retireTotal = nowTotal + gapCushion;
  let judge, cls;
  if (gapMonths <= 0) {
    // ③なし（退職・年金の前提が未設定 等）：今すぐの目安のみで判定
    if (reserve >= nowTotal) { cls = "up"; judge = `現金＋債券 ${yen(reserve)}（うち現金 ${yen(cash)}）は「今すぐの目安」を満たしています。余剰（約 ${yen(reserve - nowTotal)}）は投資に回す余地があります。`; }
    else { cls = "down"; judge = `「今すぐの目安」に対して 約 ${yen(nowTotal - reserve)} 不足しています（現在：現金 ${yen(cash)}＋債券 ${yen(bonds)}＝${yen(reserve)}）。`; }
  } else if (reserve >= retireTotal) {
    cls = "up";
    judge = `現金＋債券 ${yen(reserve)} は、退職時までの目安（①＋②＋③＝${yen(retireTotal)}）も満たしています。余剰（約 ${yen(reserve - retireTotal)}）は投資に回す余地があります。`;
  } else if (reserve >= nowTotal) {
    // 今すぐ（①＋②）は満たすが、③を含む退職時目安には不足
    const shortR = retireTotal - reserve;
    const perYear = (yearsToRetire && yearsToRetire > 0) ? shortR / yearsToRetire : shortR;
    const soon = (yearsToRetire != null && yearsToRetire <= 5);   // 退職まで5年以内は要注意
    cls = soon ? "down" : "warn";
    judge = `「今すぐの目安（①＋②）」は満たしていますが、退職時の目安（①＋②＋③＝${yen(retireTotal)}）には 約 ${yen(shortR)} 不足しています`
      + (yearsToRetire != null ? `（退職まであと約${yearsToRetire}年${yearsToRetire > 0 ? ` → 年 約 ${yen(perYear)} を上乗せで準備`: ""}）` : "")
      + (soon ? "。退職が近いので、下落局面で投資を売らずに済むよう、今から現金・債券を優先して厚くすることを検討してください。"
              : "。無年金期間に備え、退職までに計画的に用意していきましょう。");
  } else {
    cls = "down";
    judge = `「今すぐの目安（①＋②）」に対して 約 ${yen(nowTotal - reserve)} 不足しています（現在：現金 ${yen(cash)}＋債券 ${yen(bonds)}＝${yen(reserve)}）。まずはここを優先して確保しましょう。`;
  }
  html += `<p class="cash-adv-judge ${cls}">${judge}</p>`;
  if (gapMonths > 0) {
    html += `<p class="cash-adv-note">③は<strong>退職（${retire}歳）までに</strong>現金・債券で用意しておくと、下落局面でも投資を売らずに生活費をまかなえます。退職が先なら今から少しずつ、近いなら優先的に確保するのが安心です。</p>`;
  }
  body.innerHTML = html;
}
$("cash-goto-settings").addEventListener("click", () => switchView("settings"));

// --- 分配金・配当（インカム） ---
function renderDividends() {
  const body = $("dividend-body");
  if (!body) return;
  const dv = planData.dividends || {};
  const items = (dv.items || []).slice();
  const paying = items.filter((it) => (it.annual || 0) > 0);
  const yen = (n) => Math.round(n).toLocaleString() + " 円";
  if (!paying.length) {
    const anyOk = items.length > 0;
    body.innerHTML = `<p class="empty-watch">${anyOk
      ? "現在の保有商品には、直近1年で分配金・配当の実績がありません（無分配のインデックス投信が中心です）。"
      : "銘柄一覧で各商品の口数を入力すると、分配金・配当の実績を集計します。"}</p>`;
    return;
  }
  // 受取が多い順に並べる
  paying.sort((a, b) => (b.annual || 0) - (a.annual || 0));

  const modeSelect = (it) => {
    const opt = (v, label) => `<option value="${v}"${it.mode_raw === v ? " selected" : ""}>${label}</option>`;
    // 自動時は実際に適用されるモードを併記
    const autoLabel = it.mode === "receive" ? "自動（受取）" : "自動（再投資）";
    return `<select class="div-mode-select div-mode-${it.mode}" data-watch="${it.watch_id}"
        title="分配金の受け取り方。受取＝税引後キャッシュとして資産グラフの現金に反映。再投資＝運用資産に留まる想定">
      ${opt("", autoLabel)}${opt("receive", "受取")}${opt("reinvest", "再投資")}
    </select>`;
  };
  const basis = (it) => {
    const unit = it.kind === "stock" ? "1株" : "1万口";
    const price = it.latest_price != null ? Number(it.latest_price).toLocaleString() + "円" : "—";
    if (!(it.div_ttm > 0)) return "分配金なし（無分配）";
    return `${unit}あたり年 ${Number(it.div_ttm).toLocaleString()}円<span class="div-basis-sub">${it.kind === "stock" ? "配当" : "分配金"}実績 ÷ ${price}</span>`;
  };
  const acctChip = (it) => it.account_type === "nisa"
    ? '<span class="acct-chip acct-nisa">NISA</span>' : '<span class="acct-chip">特定</span>';

  let rows = paying.map((it) => `
    <tr>
      <td class="div-name">${escapeHtml(it.name)}${it.broker ? `<span class="div-broker">${escapeHtml(it.broker)}</span>` : ""}</td>
      <td class="num">${yen(it.annual)}</td>
      <td class="num">${it.yield}%</td>
      <td>${acctChip(it)}</td>
      <td>${modeSelect(it)}</td>
      <td class="num">${it.mode === "receive" ? yen(it.after_tax) : "<span class=\"div-reinv\">再投資</span>"}</td>
      <td class="div-basis">${basis(it)}</td>
    </tr>`).join("");

  const nonPay = items.length - paying.length;
  const totalAnnual = paying.reduce((s, it) => s + (it.annual || 0), 0);
  body.innerHTML = `
    <div class="div-table-wrap">
      <table class="div-table">
        <thead><tr>
          <th>商品</th><th class="num">年間（保有ベース）</th><th class="num">利回り</th>
          <th>口座</th><th>受取／再投資</th><th class="num">税引後受取</th><th>根拠</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="div-totals">
      <div class="div-total-row"><span>分配金・配当の年間合計（税引前・保有ベース）</span><b>${yen(totalAnnual)}</b></div>
      <div class="div-total-row div-total-recv"><span>うち「受取」の税引後キャッシュ収入（年）</span><b>${yen(dv.receive_net || 0)}</b></div>
      <div class="div-total-row div-total-sub"><span>うち「再投資」（運用資産に留まる想定・年）</span><b>${yen(dv.reinvest_total || 0)}</b></div>
      ${(dv.tax || 0) > 0 ? `<div class="div-total-row div-total-sub"><span>受取分にかかる税金（年・特定口座分）</span><b>${yen(dv.tax || 0)}</b></div>` : ""}
    </div>
    <p class="hint">${nonPay > 0 ? `※ 他 ${nonPay} 件は無分配（分配金なし）のため表に含めていません。` : ""}
      「受取」の税引後キャッシュ収入は、上の「資産の推移」グラフで<strong>現金の帯</strong>として積み上がり、取り崩し時の売却額を軽減します。
      受取／再投資は商品ごとに切り替えられます（特定口座で自動再投資でない商品は「受取」が既定です）。</p>`;

  body.querySelectorAll(".div-mode-select").forEach((sel) => {
    sel.addEventListener("change", (e) => saveDividendMode(e.target.dataset.watch, e.target.value));
  });
}

async function saveDividendMode(watchId, mode) {
  try {
    const r = await fetch("/api/watchlist/dividend-mode", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watch_id: Number(watchId), mode }),
    });
    const d = await r.json();
    if (!d.ok) { toast(d.error || "保存に失敗しました", "error"); return; }
    toast("分配金の設定を更新しました");
    await loadPlan();   // 合計・グラフを再計算
  } catch (_) { toast("保存に失敗しました", "error"); }
}

// --- 資産の推移＋将来予測と目標達成予定 ---
function addMonths(dateStr, n) {
  const d = new Date(dateStr);
  const r = new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
  return r.toISOString().slice(0, 10);
}
function projMonthlyRate(annual) { return Math.pow(1 + annual, 1 / 12) - 1; }
// cur から monthly 積立・年率 annual で months ヶ月ぶんの系列 [cur, ...] を返す
function projSeries(cur, monthly, annual, months) {
  const rm = projMonthlyRate(annual); const out = [cur]; let v = cur;
  for (let m = 1; m <= months; m++) { v = v * (1 + rm) + monthly; out.push(Math.round(v)); }
  return out;
}
// 目標到達までの月数（未到達は -1、達成不能は -1、既に達成は 0）
function projMonthsToGoal(cur, monthly, annual, goal, cap) {
  if (goal <= 0) return -1;
  if (cur >= goal) return 0;
  if (monthly <= 0 && annual <= 0) return -1;
  const rm = projMonthlyRate(annual); let v = cur;
  for (let m = 1; m <= cap; m++) { v = v * (1 + rm) + monthly; if (v >= goal) return m; }
  return -1;
}
function achLabel(lastDate, m) {
  if (m < 0) return "40年以内に届かず";
  if (m === 0) return "達成済み";
  const d = addMonths(lastDate, m);
  return `${d.slice(0, 4)}年${Number(d.slice(5, 7))}月頃`;
}

// 設定画面の「資産プランの前提」を取り出す（ライフプラン確定なら ok:true）
function planLifePlan() {
  const p = planData.plan || {};
  const age0 = +p.current_age || 0, retire = +p.retire_age || 0;
  return {
    ok: !!(age0 && retire && retire >= age0),
    age0, retire,
    penAge: +p.pension_age || retire,
    pension: p.pension_monthly || 0,
    spend: p.spend_monthly || 0,
    infl: (p.inflation || 0) / 100,
  };
}
// 生涯の資産推移（積立期→退職→取り崩し期）を月次で構築
// 返り値: 月次の {age,date,v} 系列 pts と、退職・年金開始・枯渇の情報
// 税率(tax)が指定された場合、pts の v は「利益に課税した後（売却して手にする）」の額。
//   運用資産の含み益 = 評価額 − 取得原価。取得原価は積立で増え、取り崩しで按分して減る。
//   現金・債券(reserve)には課税しない。
// div.grossY/netY: 「受取」に設定した分配金・配当の年率（運用資産に対する割合）。
//   想定年利は総リターン（分配込み）とみなし、受取分は運用資産から出て税引後キャッシュ（現金）
//   に振り替わる。再投資分は運用資産に留まり総リターンに含まれる想定なので別加算しない。
function buildLifePath(cur, lastDate, monthly, annual, lp, cash0, bonds0, basis0, tax, emFloor, div) {
  const rm = projMonthlyRate(annual);
  const t = tax || 0;
  const floor = emFloor || 0;   // ①生活防衛資金：緊急時用に現金として残す下限
  const dGrossM = (div && div.grossY ? div.grossY : 0) / 12;   // 受取分配（税引前・月率）
  const dNetM = (div && div.netY ? div.netY : 0) / 12;         // 受取分配（税引後・月率）
  let fund = cur;              // 運用資産（投信＋株）：想定年利で成長。全体が取り崩し対象
  let basis = (basis0 != null) ? basis0 : cur;   // 取得原価
  let cash = cash0 || 0, bonds = bonds0 || 0;    // 現金・債券：据え置き・非課税
  // 運用資産から amt だけ売却する（原価も按分して減らす）。売却できた額を返す。
  const sellFund = (amt) => {
    if (!(amt > 0) || !(fund > 0)) return 0;
    const take = Math.min(fund, amt);
    basis -= take * (basis / fund); fund -= take;
    if (fund < 0) fund = 0;
    if (basis < 0) basis = 0;
    return take;
  };
  const fundAT = () => fund - Math.max(0, fund - basis) * t;   // 投信の税引後評価額
  const snap = (age, dt) => {
    const fa = fundAT();
    return { age, date: dt, cash: Math.round(cash), bonds: Math.round(bonds),
             fund: Math.round(fa), v: Math.round(fa + cash + bonds) };
  };
  const pts = [snap(lp.age0, lastDate)];
  let depletionAge = -1, penStartAge = -1, retireBal = null;
  const endMonths = Math.max(1, Math.round((100 - lp.age0) * 12));
  for (let m = 1; m <= endMonths; m++) {
    const age = lp.age0 + m / 12;
    const dt = addMonths(lastDate, m);
    fund = fund * (1 + rm);              // 運用資産のみ成長（原価は変わらない＝含み益が増える）
    // 受取分配金：運用資産から出て、税引後は現金へ（グラフの現金の帯に反映）。
    if (dGrossM > 0 && fund > 0) {
      const net = fund * dNetM;                  // 税引後（現金へ）
      sellFund(Math.min(fund, fund * dGrossM));  // 税引前の分配ぶんが運用資産から出る
      cash += net;
    }
    if (age < lp.retire) {
      fund += monthly; basis += monthly;   // 積立は原価
    } else {
      if (retireBal === null) retireBal = fundAT() + cash + bonds;   // 退職時点の税引後資産
      const inflF = Math.pow(1 + lp.infl, m / 12);
      // 退職〜年金受給開始の間は年金なし（純粋に資産を取り崩す）
      const pen = (age >= lp.penAge) ? lp.pension * inflF : 0;
      if (lp.penAge > lp.retire && age >= lp.penAge && penStartAge < 0) penStartAge = age;
      const floorNow = floor * inflF;    // ①生活防衛資金：インフレ調整後（実質額を維持）
      let w = lp.spend * inflF - pen;    // 取り崩し額（正なら引き出し）
      if (w >= 0) {
        // 生活防衛資金(floorNow)は現金に残す。
        // 取り崩し順：現金(floorNow超)→債券→投信→（最後の手段）生活防衛資金
        let take = Math.min(Math.max(0, cash - floorNow), w); cash -= take; w -= take;
        if (w > 0) { take = Math.min(bonds, w); bonds -= take; w -= take; }
        if (w > 0) { w -= sellFund(w); }
        if (w > 0) { take = Math.min(cash, w); cash -= take; w -= take; }   // 最後の手段：生活防衛資金
      } else {                            // 年金＞生活費の余剰は運用資産へ（原価扱い）
        fund -= w; basis -= w;
      }
      // 生活防衛資金をインフレ後の水準まで現金で維持（不足分を債券→投信から少しずつ補充）
      if (cash < floorNow) {
        let need = floorNow - cash;
        let take = Math.min(bonds, need); bonds -= take; cash += take; need -= take;
        if (need > 0) { cash += sellFund(need); }
      }
    }
    const pt = snap(age, dt);
    pts.push(pt);
    if (pt.v <= 0) { depletionAge = age; break; }
  }
  if (retireBal === null) retireBal = fundAT() + cash + bonds;
  const endBal = pts[pts.length - 1].v;
  return { pts, retireBal, penStartAge, depletionAge, endBal };
}

// --- 金額の簡易フォーマット（軸ラベル用：億／万） ---
function jpYenShort(n) {
  n = Math.round(n);
  const oku = 1e8, man = 1e4, s = n < 0 ? "-" : ""; n = Math.abs(n);
  if (n >= oku) { const x = n / oku; return s + (Math.round(x * 10) / 10).toLocaleString() + "億"; }
  if (n >= man) return s + Math.round(n / man).toLocaleString() + "万";
  return s + n.toLocaleString();
}
function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
function niceTicks(maxv, count) {
  if (!(maxv > 0)) return [0];
  const step = niceStep(maxv / (count || 4)), out = [];
  for (let v = 0; v <= maxv * 1.0001; v += step) out.push(Math.round(v));
  return out;
}

function renderPlanHistory() {
  const empty = $("plan-history-empty");
  const note = $("plan-history-note");
  const eta = $("plan-eta");
  const ddSummary = $("plan-dd-summary");
  const totals = lastPlanTotals || [];
  if (!totals.length) {
    empty.hidden = false; note.textContent = ""; eta.textContent = ""; ddSummary.textContent = "";
    Plotly.purge("plan-history-chart"); return;
  }
  empty.hidden = true; ddSummary.textContent = "";
  const goal = planData.plan.goal || 0;
  const monthly = planData.plan.monthly || 0;
  const reserve = planReserve();                       // 現金＋債券（据え置きの安定資産）
  const pastDates = totals.map((t) => t.date);
  const pastFund = totals.map((t) => Math.round(t.amount));   // 投信の実額
  const pastAmt = pastFund.map((a) => a + reserve);    // 総資産（現金・債券を加算）
  const lastDate = pastDates[pastDates.length - 1];
  const fundCur = pastFund[pastFund.length - 1];        // 投信のみの現在値（成長の起点）
  const cur = pastAmt[pastAmt.length - 1];              // 総資産（現在）
  const CAP = 480;   // 最長40年

  const useAi = !!aiBand && aiSettings.ai_model !== "off";
  const baseRate = (useAi ? Number(aiBand.base) : (planData.plan.return_rate || 0)) / 100;
  const lp = planLifePlan();
  const canProject = (monthly > 0 || baseRate > 0);
  // 税率（未設定なら日本の約20.315%を既定として利益に課税）。利益＝評価額−取得原価。
  const baseTax = (planData.plan.tax != null ? planData.plan.tax : 20.315) / 100;
  // ポートフォリオ全体の含み益割合（投信＋日立株などの損益率）。/api/plan の評価額・投資額から算出
  const tv = planData.total_value || 0, ti = planData.total_invested || 0;
  // NISA（非課税）分を除いた「課税対象の割合」で実効税率を出す（NISAの利益は非課税）
  const taxableFrac = tv > 0 ? Math.min(1, Math.max(0, (planData.taxable_value || 0) / tv)) : 1;
  const taxRate = baseTax * taxableFrac;       // 実効税率（NISA分は非課税）
  const gainFrac = tv > 0 ? Math.max(0, (tv - ti) / tv) : 0;
  const basis0 = fundCur * (1 - gainFrac);   // グラフ現在値ベースの取得原価
  // 税引後の総資産（現金債券は非課税）
  const afterTax = (fundV, basisV) => reserve + fundV - Math.max(0, fundV - basisV) * taxRate;
  // 投信のみ成長・現金債券据え置き・利益に課税した「税引後」総資産系列を作るヘルパー
  const projT = (rate, h) => {
    const s = projSeries(fundCur, monthly, rate, h);
    return s.map((v, m) => Math.round(afterTax(v, basis0 + monthly * m)));
  };
  const curTotalAT = afterTax(fundCur, basis0);   // 税引後の現在総資産
  const m2g = (rate) => {
    if (goal <= 0) return -1;
    if (curTotalAT >= goal) return 0;
    const rm = projMonthlyRate(rate); let v = fundCur, bs = basis0;
    for (let m = 1; m <= CAP; m++) { v = v * (1 + rm) + monthly; bs += monthly;
      if (afterTax(v, bs) >= goal) return m; }
    return -1;
  };

  // 実績サマリー（全ケース共通）
  const first0 = pastAmt[0], diff0 = cur - first0, pctChg0 = first0 ? (diff0 / first0 * 100) : 0;
  note.textContent = `${reserve > 0 ? "総資産" : "実績"}（期間内）：${first0.toLocaleString()} 円 → ${cur.toLocaleString()} 円`
    + `（${diff0 >= 0 ? "+" : ""}${diff0.toLocaleString()} 円 / ${pctChg0 >= 0 ? "+" : ""}${pctChg0.toFixed(1)}%）`
    + (reserve > 0 ? `　※現金・債券 ${reserve.toLocaleString()} 円を含む` : "")
    + (baseTax > 0
        ? `　※予測は利益に課税（税引後）。${(planData.nisa_value || 0) > 0
            ? `NISA分は非課税とし実効税率${(taxRate * 100).toFixed(2)}%（うちNISA ${Math.round((planData.nisa_value || 0) / 10000).toLocaleString()}万円）`
            : `税率${(baseTax * 100).toFixed(3).replace(/\.?0+$/, "")}%`}で計算`
        : "");

  // ライフプランが確定していれば「ライフステージ別」パネルで表示
  if (lp.ok && canProject) {
    renderLifeStages({ cur: fundCur, lastDate, monthly, baseRate, goal, useAi, lp, eta, ddSummary,
                       reserve, cash0: (planData.plan.cash || 0), bonds0: (planData.plan.bonds || 0),
                       basis0, taxRate });
    return;
  }

  // === ライフプラン未設定：実績＋将来予測を1枚のグラフで表示（従来） ===
  const traces = [{
    x: pastDates, y: pastAmt, name: "実績", mode: "lines",
    line: { width: 2.5, color: "#5b8def" }, fill: "tozeroy", fillcolor: "rgba(91,141,239,0.08)",
    hovertemplate: "%{x}<br>実績 %{y:,.0f} 円<extra></extra>",
  }];
  const layout = (typeof baseLayout === "function") ? baseLayout() : {};
  layout.height = 360;
  layout.margin = { l: 72, r: 16, t: 12, b: 40 };
  layout.hovermode = "x unified";
  layout.showlegend = true;
  layout.legend = { orientation: "h", y: -0.18, font: { size: 11 } };
  layout.shapes = []; layout.annotations = [];
  let maxY = goal || 0;

  // 目標達成マーカーを追加する共通処理
  const addGoalStar = (ach) => {
    if (!(ach > 0) || goal <= 0) return;
    const achDate = addMonths(lastDate, ach);
    traces.push({ x: [achDate], y: [goal], mode: "markers", name: "目標達成",
      marker: { size: 11, color: "#16a34a", symbol: "star" },
      hovertemplate: `目標達成 ${achDate}<extra></extra>` });
    layout.annotations.push({ x: achDate, y: goal, xanchor: "center", yanchor: "top", ay: 28,
      text: `達成 ${achDate.slice(0, 7)}`, showarrow: true, arrowhead: 0,
      font: { size: 10.5, color: "#16a34a" }, arrowcolor: "#16a34a" });
  };

  if (useAi && canProject) {
    // === AI予測の標準/楽観/悲観バンド（従来どおり） ===
    const base = baseRate, opt = Number(aiBand.optimistic) / 100, pess = Number(aiBand.pessimistic) / 100;
    const baseAch = m2g(base);
    const horizon = Math.max(24, Math.min(CAP, baseAch > 0 ? Math.ceil(baseAch * 1.3) : 360));
    const futDates = [lastDate];
    for (let m = 1; m <= horizon; m++) futDates.push(addMonths(lastDate, m));
    const sB = projT(base, horizon);
    const sO = projT(opt, horizon);
    const sP = projT(pess, horizon);
    maxY = Math.max(maxY, ...sO);
    traces.push({ x: futDates, y: sP, name: `悲観 ${aiBand.pessimistic}%`, mode: "lines",
      line: { width: 1, color: "#9db8ef", dash: "dot" },
      hovertemplate: "%{x}<br>悲観 %{y:,.0f} 円<extra></extra>" });
    traces.push({ x: futDates, y: sO, name: `楽観 ${aiBand.optimistic}%`, mode: "lines",
      line: { width: 1, color: "#9db8ef", dash: "dot" }, fill: "tonexty", fillcolor: "rgba(91,141,239,0.12)",
      hovertemplate: "%{x}<br>楽観 %{y:,.0f} 円<extra></extra>" });
    traces.push({ x: futDates, y: sB, name: `AI標準 ${aiBand.base}%`, mode: "lines",
      line: { width: 2, color: "#5b8def", dash: "dot" },
      hovertemplate: "%{x}<br>AI標準 %{y:,.0f} 円<extra></extra>" });
    addGoalStar(baseAch);
    const optAch = m2g(opt);
    const pessAch = m2g(pess);
    if (goal <= 0) eta.textContent = "目標資産額を入力すると、AI予測での達成予定を表示します。";
    else if (curTotalAT >= goal) eta.textContent = "🎉 すでに目標を達成しています。";
    else eta.textContent = `🤖 AI予測：標準（年率${aiBand.base}%）で ${achLabel(lastDate, baseAch)}、`
      + `楽観（${aiBand.optimistic}%）〜悲観（${aiBand.pessimistic}%）で ${achLabel(lastDate, optAch)}〜${achLabel(lastDate, pessAch)} に到達見込みです。`;
    ddSummary.textContent = "設定画面の「資産プランの前提」で退職年齢・生活費を入力すると、退職後の取り崩し（資産寿命）も表示します。";
  } else {
    // === ライフプラン未設定・手動：想定年利による1本 ===
    const rate = baseRate;
    const canProj = (monthly > 0 || rate > 0);
    const ach = m2g(rate);
    if (canProj) {
      const horizon = Math.max(24, Math.min(CAP, ach > 0 ? Math.ceil(ach * 1.3) : 360));
      const futDates = [lastDate];
      for (let m = 1; m <= horizon; m++) futDates.push(addMonths(lastDate, m));
      const s = projT(rate, horizon);
      maxY = Math.max(maxY, ...s);
      traces.push({ x: futDates, y: s, name: "予測", mode: "lines",
        line: { width: 2, color: "#5b8def", dash: "dot" },
        hovertemplate: "%{x}<br>予測 %{y:,.0f} 円<extra></extra>" });
      addGoalStar(ach);
    } else { maxY = Math.max(maxY, ...pastAmt); }
    if (goal <= 0) eta.textContent = "目標資産額を入力すると、達成予定を表示します。";
    else if (curTotalAT >= goal) eta.textContent = "🎉 すでに目標を達成しています。";
    else if (!canProj) eta.textContent = "毎月の積立額または想定年利を入力すると、目標達成の予定時期をグラフに表示します。";
    else if (ach > 0) eta.textContent = `🎯 このペースなら 約 ${Math.floor(ach / 12)}年${ach % 12}ヶ月後（${achLabel(lastDate, ach)}）に目標 ${Math.round(goal).toLocaleString()} 円へ到達する見込みです。`;
    else eta.textContent = "🎯 現在の条件では40年以内に目標へ到達しません。積立額や想定年利を見直してみてください。";
    ddSummary.textContent = "設定画面の「資産プランの前提」で退職年齢・生活費を入力すると、退職後の取り崩し（資産寿命）も表示します。";
  }

  layout.yaxis = Object.assign(layout.yaxis || {}, { title: "円", range: [0, (maxY || 1) * 1.08] });
  if (goal > 0) {
    layout.shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, y0: goal, y1: goal,
      line: { color: "#16a34a", width: 1.6, dash: "dash" } });
    layout.annotations.push({ xref: "paper", x: 0, y: goal, xanchor: "left", yanchor: "bottom",
      text: `目標 ${Math.round(goal).toLocaleString()}円`, showarrow: false, font: { size: 11, color: "#16a34a" } });
  }
  Plotly.newPlot("plan-history-chart", traces, layout, { responsive: true, displayModeBar: false });
}

// ライフプランの生涯推移を「連続した1本の線」で表示する。
// 積立は退職時点で停止（buildLifePath 準拠）。退職〜寿命は横軸を圧縮して線の連続性を保ち、
// 退職・年金開始のタイミングに縦線を入れる。
function renderLifeStages(o) {
  const { cur, lastDate, monthly, baseRate, goal, useAi, lp, eta, ddSummary } = o;
  const reserve = o.reserve || 0;                    // 現金＋債券（据え置き）
  const cash0 = o.cash0 || 0, bonds0 = o.bonds0 || 0;
  const taxRate = o.taxRate || 0;
  const basis0 = (o.basis0 != null) ? o.basis0 : cur;
  const afterTax = (fundV, basisV) => reserve + fundV - Math.max(0, fundV - basisV) * taxRate;
  const curTotal = afterTax(cur, basis0);            // 現在の税引後総資産
  // ①生活防衛資金（生活費×月数）は取り崩さず現金として残す下限。手元現金を上限にする。
  const emMonths = (planData.plan.emergency_months != null) ? planData.plan.emergency_months : 6;
  const emFloor = Math.min(cash0, (lp.spend || 0) * emMonths);
  // 「受取」分配金の年率（税引前・税引後／運用資産全体に対する率）。
  const dv = planData.dividends || {};
  const div = { grossY: dv.receive_gross_yield || 0, netY: dv.receive_net_yield || 0 };
  const path = buildLifePath(cur, lastDate, monthly, baseRate, lp, cash0, bonds0, basis0, taxRate, emFloor, div);
  const pts = path.pts;
  const fa = (a) => Math.round(a);
  const retireAge = lp.retire, penAge = lp.penAge;
  const hasGap = penAge > retireAge + 1e-6;
  const depAge = path.depletionAge;                 // 枯渇年齢（-1なら枯渇しない）
  const endAge = depAge > 0 ? depAge : 100;
  const accMonths = Math.max(1, Math.round((retireAge - lp.age0) * 12));
  // 目標達成：税引後の総資産が目標に到達する月を求める
  let ach = -1;
  if (goal > 0) {
    if (curTotal >= goal) ach = 0;
    else {
      const rm = projMonthlyRate(baseRate); let v = cur, bs = basis0;
      for (let m = 1; m <= accMonths; m++) { v = v * (1 + rm) + monthly; bs += monthly;
        if (afterTax(v, bs) >= goal) { ach = m; break; } }
    }
  }
  const achAge = ach > 0 ? lp.age0 + ach / 12 : -1;

  // 横軸の区間と表示幅（画面比率）。退職後（＝取り崩し期）は長いので幅を絞って圧縮する。
  const segs = [{ a0: lp.age0, a1: retireAge, wid: 0.46 }];
  if (endAge > retireAge + 0.02) {
    if (hasGap) {
      const gEnd = Math.min(penAge, endAge);
      if (gEnd > retireAge + 0.02) segs.push({ a0: retireAge, a1: gEnd, wid: 0.16 });
      if (endAge > penAge + 0.02) segs.push({ a0: penAge, a1: endAge, wid: 0.38 });
    } else {
      segs.push({ a0: retireAge, a1: endAge, wid: 0.54 });
    }
  }
  const totW = segs.reduce((t, s) => t + s.wid, 0);
  let accW = 0;
  segs.forEach((s) => { s.x0 = accW / totW; accW += s.wid; s.x1 = accW / totW; });
  const lo = segs[0].a0, hi = segs[segs.length - 1].a1;
  const X = (age) => {   // 年齢 → プロット座標(0〜1)。区間ごとに線形。
    const a = Math.min(Math.max(age, lo), hi);
    for (const s of segs) if (a <= s.a1 + 1e-6) return s.x0 + (a - s.a0) / (s.a1 - s.a0) * (s.x1 - s.x0);
    return 1;
  };

  const traces = [];
  const layout = (typeof baseLayout === "function") ? baseLayout() : {};
  layout.height = 380;
  layout.margin = { l: 60, r: 24, t: 30, b: 54 };
  layout.showlegend = true;
  layout.legend = { orientation: "h", y: -0.16, x: 0, font: { size: 10.5 } };
  layout.hovermode = "closest";
  layout.shapes = []; layout.annotations = [];

  const gMax = Math.max(1, goal || 0, ...pts.filter((p) => p.age <= endAge + 0.12).map((p) => p.v));
  const gTicks = niceTicks(gMax, 5);
  const gTop = gMax * 1.12;

  // 資産構成の積み上げ（下から 現金 → 債券 → 投信）。退職後は現金・債券から取り崩されて漸減する。
  const XS = pts.map((p) => X(p.age));
  const area = (key, name, color, fillc) => ({
    x: XS, y: pts.map((p) => p[key]),
    customdata: pts.map((p) => [p.age, p.v > 0 ? Math.round(p[key] / p.v * 100) : 0]),
    name, mode: "lines", line: { width: 0.6, color }, stackgroup: "assets", fillcolor: fillc,
    hovertemplate: `%{customdata[0]:.0f}歳<br>${name} %{y:,.0f} 円（%{customdata[1]}%）<extra></extra>`,
  });
  if (cash0 > 0) traces.push(area("cash", "現金", "#0e9488", "rgba(14,148,136,0.60)"));
  if (bonds0 > 0) traces.push(area("bonds", "債券", "#22c55e", "rgba(34,197,94,0.45)"));
  traces.push(area("fund", "投信（税引後）", "#5b8def", "rgba(91,141,239,0.38)"));

  // 横軸：年齢の目盛り（区間境界＋10年刻み）。退職後は圧縮されて表示される。
  const bnd = [lp.age0, retireAge, endAge];
  if (hasGap && penAge < endAge) bnd.push(penAge);
  const tickSet = new Set(bnd);
  for (let a = Math.ceil(lp.age0 / 10) * 10; a < endAge; a += 10)
    if (bnd.every((b) => Math.abs(a - b) > 1.5)) tickSet.add(a);
  const tArr = [...tickSet].filter((a) => a >= lo - 0.01 && a <= hi + 0.01).sort((x, y) => x - y);
  layout.xaxis = {
    range: [0, 1], tickvals: tArr.map(X), ticktext: tArr.map((a) => fa(a) + "歳"),
    tickfont: { size: 9.5 }, showgrid: false, zeroline: false,
  };
  layout.yaxis = {
    range: [0, gTop], tickvals: gTicks, ticktext: gTicks.map(jpYenShort),
    tickfont: { size: 9.5 }, showgrid: true, gridcolor: "rgba(140,140,160,0.16)", zeroline: false,
  };

  // 退職・年金開始のタイミングに縦線
  const vline = (age, color, text) => {
    const x = X(age);
    layout.shapes.push({ type: "line", xref: "x", x0: x, x1: x, yref: "paper", y0: 0, y1: 1,
      line: { color, width: 1.4, dash: "dash" } });
    layout.annotations.push({ xref: "x", x, yref: "paper", y: 1.0, yanchor: "bottom", xanchor: "center",
      text, showarrow: false, font: { size: 10.5, color } });
  };
  vline(retireAge, "#6f7488", `退職 ${fa(retireAge)}歳`);
  if (hasGap && penAge < endAge) vline(penAge, "#2f6fed", `年金 ${fa(penAge)}歳`);

  // 目標ライン＋達成マーカー
  if (goal > 0) {
    layout.shapes.push({ type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: goal, y1: goal,
      line: { color: "#16a34a", width: 1.5, dash: "dash" } });
    layout.annotations.push({ xref: "paper", x: 0, yref: "y", y: goal, xanchor: "left", yanchor: "bottom",
      text: `目標 ${jpYenShort(goal)}`, showarrow: false, font: { size: 10, color: "#16a34a" } });
    if (achAge > 0 && achAge <= retireAge + 0.01) {
      traces.push({ x: [X(achAge)], y: [goal], mode: "markers", marker: { size: 13, color: "#16a34a", symbol: "star" },
        showlegend: false, hovertemplate: `目標達成 ${fa(achAge)}歳<extra></extra>` });
      layout.annotations.push({ xref: "x", x: X(achAge), yref: "y", y: goal, yanchor: "bottom", yshift: 8,
        xanchor: "center", text: `達成 ${fa(achAge)}歳`, showarrow: false, font: { size: 9.5, color: "#16a34a" } });
    }
  }

  // マーカー：現在・退職時資産・枯渇/100歳
  const dot = (age, val, text, color, star) => {
    const px = X(age);
    const xanchor = px > 0.93 ? "right" : px < 0.06 ? "left" : "center";
    const xshift = xanchor === "right" ? -6 : xanchor === "left" ? 6 : 0;
    traces.push({ x: [px], y: [val], mode: "markers", showlegend: false,
      marker: { size: star ? 13 : 8, color, symbol: star ? "star" : "circle" },
      hovertemplate: `${text}${val > 0 ? " %{y:,.0f} 円" : ""}<extra></extra>` });
    layout.annotations.push({ xref: "x", x: px, yref: "y", y: val,
      yanchor: star ? "bottom" : "top", yshift: star ? 8 : -8, xanchor, xshift,
      text: val > 0 ? `${text} ${jpYenShort(val)}` : text, showarrow: false, font: { size: 9.5, color } });
  };
  dot(lp.age0, curTotal, "現在", "#5b8def");
  if (retireAge > lp.age0 + 0.01) dot(retireAge, path.retireBal, "退職時", "#6f7488");
  if (depAge > 0) dot(depAge, 0, `枯渇 ${fa(depAge)}歳`, "#e11d48", true);
  else dot(100, path.endBal, "100歳", "#f59e0b");

  Plotly.newPlot("plan-history-chart", traces, layout, { responsive: true, displayModeBar: false });

  // 目標達成テキスト
  if (goal <= 0) eta.textContent = useAi ? "目標資産額を入力すると、AI予測での達成予定を表示します。" : "目標資産額を入力すると、達成予定を表示します。";
  else if (curTotal >= goal) eta.textContent = "🎉 すでに目標を達成しています。";
  else if (ach > 0) eta.textContent = (useAi ? `🤖 AI予測（年率${aiBand.base}%）：` : "🎯 このペースなら ")
    + `${achLabel(lastDate, ach)}（約 ${Math.floor(ach / 12)}年${ach % 12}ヶ月後）に目標 ${Math.round(goal).toLocaleString()} 円へ到達見込みです。`;
  else eta.textContent = `🎯 現在の条件では、退職（${retireAge}歳）までに目標へ到達しません。積立額や想定年利を見直してみてください。`;

  // 取り崩しサマリー
  let msg = `退職時（${retireAge}歳）の想定資産 約 ${Math.round(path.retireBal).toLocaleString()} 円`;
  msg += reserve > 0 ? `（うち現金・債券 ${reserve.toLocaleString()} 円を含む）。` : "。";
  if (hasGap) msg += `退職〜年金開始（${penAge}歳）までは年金なしで、まず現金→次に債券から取り崩す前提です（グラフの現金・債券の帯がこの間に減っていきます）。`;
  if (emFloor > 0) msg += `なお①生活防衛資金（現在価値 約 ${Math.round(emFloor).toLocaleString()} 円）は緊急時用に現金で残し、インフレに合わせて実質額を維持する前提です（不足分は運用資産から補充。年金受給後も維持）。`;
  if ((dv.receive_net || 0) > 0) msg += `また「受取」に設定した分配金・配当（現在の保有で税引後 約 ${Math.round(dv.receive_net).toLocaleString()} 円/年）を税引後キャッシュとして現金の帯に加え、取り崩し時の売却額を軽減しています。`;
  if (lp.spend <= 0) msg += " 退職後の生活費を設定すると、資産寿命の試算が表示されます。";
  else if (depAge > 0) msg += `この前提では、資産は 約 ${Math.floor(depAge)}歳 で尽きる見込みです。`;
  else msg += `この前提でも、資産は 100歳まで持続する見込みです（100歳時点で 約 ${Math.round(path.endBal).toLocaleString()} 円）。`;
  ddSummary.textContent = msg;
}

// 目標額の入力
$("plan-goal").addEventListener("input", (e) => {
  reformatCommaInput(e.target);
  planData.plan.goal = parseIntComma(e.target.value);
  renderPlanGoal(); renderPlanHistory();
  savePlan({ goal: planData.plan.goal });
});
// 毎月の積立額
$("plan-monthly").addEventListener("input", (e) => {
  reformatCommaInput(e.target);
  planData.plan.monthly = parseIntComma(e.target.value);
  renderPlanHistory();
  savePlan({ monthly: planData.plan.monthly });
});
// 想定年利（手動入力するとAI予測バンドは解除）
$("plan-return").addEventListener("input", (e) => {
  planData.plan.return_rate = parseFloat(e.target.value) || 0;
  if (aiBand) { aiBand = null; $("plan-ai-clear").hidden = true;
    $("plan-ai-comment").hidden = true; $("plan-dd-ai-comment").hidden = true; }
  renderPlanHistory();
  savePlan({ return_rate: planData.plan.return_rate });
});

// AIに想定利回りを予測してもらう
$("plan-ai-btn").addEventListener("click", async () => {
  const st = $("plan-ai-status");
  st.textContent = "AIが予測中… ⏳";
  try {
    const r = await fetch(`/api/ai-plan?range=${encodeURIComponent(planRange)}`);
    const d = await r.json();
    if (!d.ok) { st.textContent = "⚠️ " + (d.error || "失敗"); return; }
    const p = d.prediction || {};
    aiBand = { base: p.base_return, optimistic: p.optimistic_return, pessimistic: p.pessimistic_return };
    planData.plan.return_rate = Number(p.base_return) || 0;
    $("plan-return").value = planData.plan.return_rate;
    const cg = $("plan-ai-comment");
    cg.textContent = "🤖 " + (p.comment_growth || "");
    cg.hidden = !p.comment_growth;
    const cd = $("plan-dd-ai-comment");
    cd.textContent = "🤖 " + (p.comment_drawdown || "");
    cd.hidden = !p.comment_drawdown;
    $("plan-ai-clear").hidden = false;
    st.textContent = "✅ 予測を反映しました";
    renderPlanHistory();   // 資産推移＋取り崩し戦略の両方を再描画
    savePlan({ return_rate: planData.plan.return_rate });
  } catch (_) { st.textContent = "⚠️ 失敗しました"; }
});
// 手動に戻す
$("plan-ai-clear").addEventListener("click", () => {
  aiBand = null;
  $("plan-ai-clear").hidden = true;
  $("plan-ai-comment").hidden = true;
  $("plan-dd-ai-comment").hidden = true;
  $("plan-ai-status").textContent = "";
  renderPlanHistory();
});
// 取り崩しカードの「設定を開く」
$("plan-goto-settings").addEventListener("click", () => switchView("settings"));

// 推移グラフの期間切替
$("plan-range").addEventListener("click", (e) => {
  const b = e.target.closest(".range-btn"); if (!b) return;
  document.querySelectorAll("#plan-range .range-btn").forEach((x) => x.classList.remove("active"));
  b.classList.add("active"); planRange = b.dataset.range; loadPlanHistory();
});

// 初期表示（設定を先に読み込んでからウォッチリストを表示）
loadSettings().then(loadWatchlist);
