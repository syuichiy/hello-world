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
  $("strategy-view").hidden = view !== "strategy";
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
  } else if (view === "strategy") {
    // 資産プランと同じ前提で計算するため、先に読み込んでから自動で検証する
    loadPlan().then(() => {
      renderStrategyPremise();
      if (!strategyShown) runStrategy();
    });
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

// 画面（JS）だけ新しくてサーバー（Python）が古いときの案内。
// アプリのフォルダを差し替えてもプロセスを再起動しないとサーバー側は古いままになる。
const RESTART_HINT = "追加できませんでした。アプリを再起動してください"
  + "（ターミナルで Ctrl+C → もう一度 python3 app.py）。サーバー側が古い版のままです。";

async function addPreset(catalogId, broker, force) {
  const resp = await fetch("/api/watchlist", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ catalog_id: Number(catalogId), broker: broker || "", force: !!force }),
  });
  const data = await resp.json().catch(() => ({}));
  if (data && data.added === false) {
    // force を付けても追加されない＝サーバーが古い（アプリ未再起動）。
    // ここで再確認するとダイアログが繰り返し出るだけなので、原因を伝えて止める。
    if (force) { toast(RESTART_HINT, "error"); return; }
    // 同じ証券会社でも NISA と特定、成長投資枠とつみたて投資枠で分けて持つことがある
    const where = broker ? `「${broker}」で` : "";
    if (confirm(`すでに同じ商品を${where}保有しています。\n\nNISAと特定口座など、別口座として`
              + "もう1件追加しますか？\n（口座の種別は一覧の「口座」列で設定できます）")) {
      await addPreset(catalogId, broker, true);
    }
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
  renderPriceAsOf(data);
  renderPriceMismatch(data.mismatch || []);
  renderPriceSkipped(data.skipped || []);
  renderPriceSoldOut(data.sold_out || []);
  renderPriceSummary(data);
  renderPriceChart(data.holdings || [], data.totals || []);
  renderPriceTable(data.holdings || [], data.excel_dates || data.dates || [], data.totals || []);
}

// いつ時点のデータかを示す。投信の基準価額は当日中には公表されないため、
// 「今日の分が出ない」のが正常なのか、更新が必要なのかを判断できるようにする。
function renderPriceAsOf(data) {
  const el = $("price-asof");
  if (!el) return;
  const ds = data.excel_dates || data.dates || [];
  if (!ds.length) { el.hidden = true; return; }
  const last = ds[ds.length - 1];
  const today = new Date().toISOString().slice(0, 10);
  const diff = Math.round((new Date(today) - new Date(last)) / 86400000);
  el.hidden = false;
  el.innerHTML = `📅 データは <strong>${escapeHtml(last)}</strong> 時点です`
    + (last === today ? "（本日分まで反映済み）"
       : `（${diff}日前）。投資信託の基準価額は<strong>当日中には公表されません</strong>`
         + "（夕方以降、海外資産を含むものは翌営業日）。新しい価格が出ていれば "
         + "<strong>↻ 最新に更新</strong> で取り込めます。");
}

// グラフ・表に出せない保有を理由つきで知らせる（黙って除外すると原因が分からないため）
// 全額売却済みの商品はグラフ・表から外している。実現損益は残る情報なので知らせる。
function renderPriceSoldOut(sold) {
  const el = $("price-sold-note");
  if (!el) return;
  if (!sold.length) { el.hidden = true; el.innerHTML = ""; return; }
  const sum = sold.reduce((a, s) => a + (s.realized || 0), 0);
  const names = sold.map((s) => escapeHtml(s.name)).join("、");
  el.hidden = false;
  el.innerHTML = `✅ <strong>売却済み ${sold.length}件</strong>はグラフ・表から外しています`
    + `（実現損益の合計 <strong class="${sum >= 0 ? "up" : "down"}">`
    + `${sum >= 0 ? "+" : ""}${Math.round(sum).toLocaleString()} 円</strong>）：${names}`;
}

// 口数・売買の記録から計算した評価額と、記録されている実額が大きく違う保有を知らせる。
// 取引CSVを別口座の保有へ取り込んでしまうと口数が数倍になり、画面上は数字が並ぶだけで
// 気づけないため（例：実額68万円に対し、口数からの計算は616万円）。
function renderPriceMismatch(list) {
  const card = $("price-mismatch-card");
  if (!card) return;
  if (!list.length) { card.hidden = true; return; }
  card.hidden = false;
  const yen = (n) => Math.round(n).toLocaleString() + " 円";
  $("price-mismatch-list").innerHTML = list.map((m) => {
    const bk = m.broker ? `<span class="skipped-broker">${escapeHtml(m.broker)}</span>` : "";
    const acct = m.account_type === "nisa" ? "NISA" : "特定";
    return `<li>${escapeHtml(m.name)}${bk}<span class="skipped-tag">${acct}</span>`
      + `<span class="skipped-why">${m.date} 時点：記録されている評価額 <b>${yen(m.recorded)}</b>`
      + ` に対し、口数 ${Number(m.units).toLocaleString()} から計算すると <b class="skipped-need">${yen(m.calculated)}</b>`
      + `（約${m.ratio}倍）</span></li>`;
  }).join("");
}

function renderPriceSkipped(skipped) {
  const card = $("price-skipped-card");
  if (!card) return;
  if (!skipped.length) { card.hidden = true; return; }
  card.hidden = false;
  $("price-skipped-list").innerHTML = skipped.map((s) => {
    const bk = s.broker ? `<span class="skipped-broker">${escapeHtml(s.broker)}</span>` : "";
    const why = (s.reasons || []).map((r) =>
      `<span class="${s.need_units || s.need_invested ? "skipped-need" : ""}">${escapeHtml(r)}</span>`
    ).join("・");
    const tag = s.stale ? '<span class="skipped-tag">更新が止まっています</span>' : "";
    return `<li>${escapeHtml(s.name)}${bk}${tag}<span class="skipped-why">${why}</span></li>`;
  }).join("");
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
  // 凡例は商品ごとに1行増える（日本語の商品名が長いので、ほぼ1行1件になる）。
  // 高さを固定すると凡例が枠からはみ出し、描画領域が潰れるうえ、
  // はみ出した項目はクリックできなくなる（カードが手前に来て反応しない）。
  // そこで本数に応じて背を高くし、全部の凡例が収まるようにする。
  const legendH = Math.min(720, traces.length * 20 + 16);
  layout.height = 400 + legendH;
  layout.hovermode = "closest";   // 触れた1本だけを表示（吹き出しを見やすく）
  layout.margin = { l: amountMode ? 78 : 64, r: 20, t: 12, b: 40 + legendH };
  // 凡例は描画領域の下端から始めるが、そのままだと日付の目盛りに重なるので少し下げる
  const plotH = Math.max(1, layout.height - layout.margin.t - layout.margin.b);
  layout.legend = { orientation: "h", y: -36 / plotH, yanchor: "top", yref: "paper",
                    font: { size: 10.5 } };
  if (amountMode) {
    layout.yaxis.title = "評価額（円）";
  } else {
    layout.yaxis.title = "評価額 ÷ 投資金額 (%)";
    layout.yaxis.ticksuffix = "%";
    layout.shapes = [{ type: "line", xref: "paper", x0: 0, x1: 1, y0: 100, y1: 100,
      line: { color: isDark() ? "#8a8f9c" : "#94a3b8", width: 1.2, dash: "dash" } }];
  }
  // responsive:true だと、再描画のたびに高さを layout.height ではなく
  // 置き場所(div)の高さから取り直す（layout.height は autosize で捨てられる）。
  // 凡例のぶん margin.b を大きく取っているので、divの高さが合っていないと
  // 描画領域が潰れて目盛りと凡例が重なる。divにも同じ高さを持たせて食い違いを防ぐ。
  const gd = $("actual-chart");
  gd.style.height = layout.height + "px";
  Plotly.newPlot(gd, traces, layout, { responsive: true, displayModeBar: false });
}

const BROKER_ORDER = { "SBI証券": 0, "三菱UFJスマート証券": 1, "楽天証券": 2 };
const POLICY_ORDER = { full: 0, partial: 1, locked: 2 };   // 売却可→一部可→不可
function renderPriceTable(holdings, dates, totals) {
  const card = $("price-table-card");
  if (!holdings.length || !dates.length) { card.hidden = true; return; }
  card.hidden = false;
  const cols = dates.slice().reverse();   // 新しい日付が左
  const ndates = cols.length;
  const yenSign = (n) => (n >= 0 ? "+" : "−") + Math.abs(Math.round(n)).toLocaleString();
  // 損益セル：上に総利益（円）、下に損益率（%）。マイナスは赤字
  const plCell = (r, gain) => {
    if (r == null) return `<td class="num pt-plcol">—</td>`;
    const pl = Math.round((r - 100) * 10) / 10;
    const top = (gain == null) ? ""
      : `<b class="pt-amt">${yenSign(gain)}</b>`;
    return `<td class="num pt-plcol ${pl >= 0 ? "up" : "down"}">${top}`
      + `<span class="pt-pct">${pl >= 0 ? "+" : ""}${pl}%</span></td>`;
  };
  // 前日セル：上に前日益（円）、下に前日比（%）。直近2日の評価額の差から出す
  const dodCell = (dts, amts) => {
    const vals = [];
    for (let i = (dts ? dts.length : 0) - 1; i >= 0 && vals.length < 2; i--) {
      const v = amts[i];
      if (v != null) vals.push(v);
    }
    if (vals.length < 2 || !vals[1]) return `<td class="num pt-dodcol">—</td>`;
    const diff = vals[0] - vals[1], pct = diff / vals[1] * 100;
    const cls = diff >= 0 ? "up" : "down", sg = diff >= 0 ? "+" : "";
    return `<td class="num pt-dodcol ${cls}"><b class="pt-amt">${yenSign(diff)}</b>`
      + `<span class="pt-pct">${sg}${pct.toFixed(2)}%</span></td>`;
  };
  // 総利益＝最新の評価額 − 投資金額（投資金額が未入力なら出さない）
  const gainOf = (h) => {
    const inv = Number(h.invested || 0);
    return (inv > 0 && h.latest != null) ? h.latest - inv : null;
  };
  // ヘッダ：商品名（固定）＋ 損益率（固定）＋ 前日比（固定）＋ 各日付
  $("price-table-head").innerHTML =
    `<th class="pt-namecol">商品名</th>`
    + `<th class="num pt-plcol">総利益<span class="th-note">損益率</span></th>`
    + `<th class="num pt-dodcol">前日益<span class="th-note">前日比</span></th>` +
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
    html += `<tr><td class="pt-namecol pt-col" style="--cc:${color}">${escapeHtml(h.name)}${acct}</td>${plCell(h.latest_ratio, gainOf(h))}${dodCell(h.dates, h.amount)}${cells}</tr>`;
  });
  const totRatio = totals.length ? totals[totals.length - 1].ratio : null;
  // 合計の総利益＝各保有の総利益の合計（投資金額が入っているものだけ）
  const totGain = holdings.reduce((a, h) => {
    const g = gainOf(h);
    return g == null ? a : a + g;
  }, 0);
  const anyGain = holdings.some((h) => gainOf(h) != null);
  const totalCells = cols.map((d) => {
    const v = totalMap[d];
    return `<td class="num">${v == null ? "—" : Number(v).toLocaleString()}</td>`;
  }).join("");
  const totDod = dodCell(totals.map((t) => t.date), totals.map((t) => t.amount));
  html += `<tr class="pt-total-row"><td class="pt-namecol">合計</td>${plCell(totRatio, anyGain ? totGain : null)}${totDod}${totalCells}</tr>`;
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

// 口数の変更を「売買」として記録するか確認する
// 口数の欄は日付を持たないため、そのまま変えると「昔からこの口数だった」ことになり、
// 金額の推移が過去に遡って書き換わる。売買として記録すれば日付が入り、過去は動かない。
let unitsRec = null;   // { watchId, prev, units, kind, name }

function openUnitsRecord(s, prev, units) {
  unitsRec = { watchId: s.watch_id, prev, units, kind: s.kind };
  const isStock = s.kind === "stock";
  const lbl = isStock ? "株" : "口";
  const d = units - prev;
  $("units-rec-fund").textContent = s.name || "";
  $("units-rec-diff").innerHTML =
    `${fmtInt(prev)} ${lbl} → <b>${fmtInt(units)} ${lbl}</b>　`
    + `<span class="${d > 0 ? "up" : "down"}">${d > 0 ? "購入" : "売却"} ${fmtInt(Math.abs(d))} ${lbl}</span>`;
  $("units-rec-price-label").childNodes[0].nodeValue = isStock ? "株価（円）" : "基準価額（円）";
  $("units-rec-date").value = new Date().toISOString().slice(0, 10);
  $("units-rec-price").value = s.latest_price != null ? String(Math.round(s.latest_price)) : "";
  $("units-rec-fee").value = "";
  updateUnitsRecAmount();
  $("units-modal").hidden = false;
}

function closeUnitsModal() {
  $("units-modal").hidden = true;
  unitsRec = null;
}

function updateUnitsRecAmount() {
  if (!unitsRec) return;
  const u = Math.abs(unitsRec.units - unitsRec.prev);
  const p = parseNumComma($("units-rec-price").value);
  const div = unitsRec.kind === "stock" ? 1 : 10000;
  $("units-rec-amount").textContent = (u > 0 && p > 0)
    ? `受渡金額の目安：約 ${Math.round(u * p / div).toLocaleString()} 円`
      + `（この金額を投資金額に${unitsRec.units > unitsRec.prev ? "足します" : "反映します"}）`
    : "";
}

// 口数が変わったら、まず入力どおり保存し、増減があれば記録するか尋ねる
async function onUnitsChanged(watchId, units) {
  const s = lastSummaries.find((x) => String(x.watch_id) === String(watchId));
  const prev = Number(s ? s.units : 0) || 0;
  await saveUnits(watchId, units);
  if (s && Math.abs(units - prev) > 0) openUnitsRecord(s, prev, units);
}

$("units-rec-price").addEventListener("input", updateUnitsRecAmount);
$("units-rec-close").addEventListener("click", closeUnitsModal);
$("units-rec-skip").addEventListener("click", () => {
  closeUnitsModal();
  toast("口数だけ変更しました（過去の評価額も新しい口数で計算されます）");
});
$("units-modal").addEventListener("click", (e) => {
  if (e.target === $("units-modal")) closeUnitsModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("units-modal").hidden) closeUnitsModal();
});
$("units-rec-save").addEventListener("click", async () => {
  if (!unitsRec) return;
  const body = {
    watch_id: Number(unitsRec.watchId), units: unitsRec.units, prev_units: unitsRec.prev,
    record: {
      date: $("units-rec-date").value,
      price: parseNumComma($("units-rec-price").value),
      fee: parseNumComma($("units-rec-fee").value),
      note: "口数の変更から記録",
    },
  };
  try {
    const d = await (await fetch("/api/watchlist/units", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
    if (!d.ok) { toast(d.error || "記録に失敗しました", "error"); return; }
    closeUnitsModal();
    toast(`✓ ${d.side === "buy" ? "購入" : "売却"}として記録しました`);
    loadWatchlist();
    if (currentView === "price") loadPriceHistory();
  } catch (e) {
    toast("通信エラー: " + e.message, "error");
  }
});

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
    if (s.sold_out) return;   // もう持っていないものを売り時／買い時に出さない
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
  html += `<div class="st-note">※ ここは<strong>短期（〜1ヶ月）</strong>の指標（5日線・25日線・RSI・ボリンジャー）で選んでいます。
    下の一覧の「判定」は<strong>中期</strong>（25日線・75日線・約60営業日のモメンタム）なので、
    <strong>並ぶ銘柄は一致しません</strong>（短期は過熱・売られすぎ、中期はトレンドを見ています）。
    口数・金額はシグナルの強さから算出した機械的な目安です（保有評価額に対する割合。税・手数料・分配金は未考慮）。投資助言ではありません。</div>`;
  el.innerHTML = html;
  el.hidden = false;
}

let showSoldOut = false;   // 売却済みの商品を一覧に出すか（既定は隠す）

// 売却済みの商品は一覧から外すが、実現損益は残る情報なので件数と合計を知らせる。
function renderSoldOutNote(sold) {
  const el = $("sold-out-note");
  if (!el) return;
  if (!sold.length) { el.hidden = true; el.innerHTML = ""; return; }
  const sum = sold.reduce((a, s) => a + (s.realized || 0), 0);
  const sign = sum >= 0 ? "+" : "";
  el.hidden = false;
  el.innerHTML = `✅ <strong>売却済み ${sold.length}件</strong>は一覧から外しています`
    + `（実現損益の合計 <strong class="${sum >= 0 ? "up" : "down"}">${sign}${Math.round(sum).toLocaleString()} 円</strong>）。`
    + `<button type="button" class="link-btn" id="sold-out-toggle">`
    + `${showSoldOut ? "隠す" : "表示する"}</button>`;
  const btn = $("sold-out-toggle");
  if (btn) btn.addEventListener("click", () => { showSoldOut = !showSoldOut; renderWatchTable(); });
}

function renderWatchTable() {
  const body = $("watch-body");
  const empty = $("empty-watch");
  updateSortHeaders();   // 現在のソート列に▲/▼を反映（初回描画でも）
  if (!lastSummaries.length) {
    body.innerHTML = ""; empty.hidden = false; return;
  }
  empty.hidden = true;

  // 全額売却済みはもう持っていないので一覧から外す。ただし黙って消すと
  // 実現損益が見えなくなるので、件数と合計を下に出して開けるようにする。
  const sold = lastSummaries.filter((s) => s.sold_out);
  const live = lastSummaries.filter((s) => !s.sold_out);
  renderSoldOutNote(sold);

  const rows = (showSoldOut ? lastSummaries : live).slice().sort((a, b) => {
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
    // 売買を記録している銘柄は、平均取得単価と実現損益を添える
    const avgSub = s.avg_price
      ? `<div class="avg-sub" title="売買の記録から移動平均法で計算した平均取得単価">平均 ${Number(s.avg_price).toLocaleString()}</div>` : "";
    const realSub = (s.realized)
      ? `<div class="pl-sub ${s.realized >= 0 ? "up" : "down"}" title="売却済みの実現損益（累計）">実現 ${s.realized >= 0 ? "+" : ""}${Math.round(s.realized).toLocaleString()}</div>` : "";
    const aiAdv = aiAdviceByWatch[s.watch_id]
      ? `<div class="ai-fund-advice">🤖 ${escapeHtml(aiAdviceByWatch[s.watch_id])}</div>` : "";
    return `<tr class="${rowCls}" data-id="${s.catalog_id}" data-watch="${s.watch_id}">
      <td class="fund-cell">
        <div class="fund-nm">${escapeHtml(s.name)}${stBadge}</div>
        <div class="fund-sub">${classChip(s.asset_class)}${acctLabelChip(s)}${s.kind === "stock" ? '<span class="kind-chip">株</span>' : ""} ${escapeHtml(s.category || "")}</div>
        ${aiAdv}
      </td>
      <td>${badge}</td>
      <td>${scoreChip(s.score)}</td>
      <td class="num">${price}${avgSub}</td>
      <td class="num"><input class="units-input num-comma" type="text" inputmode="numeric"
            data-watch="${s.watch_id}" value="${fmtInt(s.units)}" placeholder="口数"
            title="保有口数（評価額 = 基準価額 × 口数 ÷ 10,000）"></td>
      <td class="num value-cell">${value}${plSub}${realSub}</td>
      <td class="num"><input class="invested-input num-comma" type="text" inputmode="numeric"
            data-watch="${s.watch_id}" value="${fmtInt(s.invested)}" placeholder="投資金額"
            title="投資金額（元本）。価格推移タブの比率計算に使います"></td>
      <td>${brokerSelect(s.watch_id, s.broker, "broker-select row-broker")}</td>
      <td>${accountSelect(s)}</td>
      <td>${policySelect(s)}</td>
      <td class="num">${chg}</td>
      <td class="spark-cell">${sparkline(s.spark, s.verdict)}</td>
      <td class="row-ops">
        <button class="row-trade" data-watch="${s.watch_id}" title="売買を記録（平均取得単価・実現損益）">📝</button>
        <button class="row-del" data-watch="${s.watch_id}" title="削除">✕</button>
      </td>
    </tr>`;
  }).join("");
}

// 口座名（NISA成長投資枠・つみたて投資枠など）。同じ商品を複数口座で持つときの区別用。
// クリックで編集できる。未設定の銘柄では控えめな表示にする。
function acctLabelChip(s) {
  const has = s.account && s.account !== s.name;
  const title = "クリックで口座名を編集（同じ商品をNISA成長枠・つみたて枠・特定などで分けて持つときの目印）";
  return `<button class="acct-chip acct-edit${has ? "" : " acct-empty"}" data-watch="${s.watch_id}"
      title="${title}">${has ? escapeHtml(s.account) : "口座名"}</button>`;
}

async function saveLabel(watchId, current) {
  const v = prompt("口座名を入力してください（空欄で削除）\n"
    + "例）NISA成長枠 / つみたて枠 / 特定口座", current || "");
  if (v === null) return;
  try {
    const d = await (await fetch("/api/watchlist/label", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watch_id: Number(watchId), label: v }),
    })).json();
    if (!d.ok) { toast(d.error || "保存に失敗しました", "error"); return; }
    toast(d.label ? `口座名を「${d.label}」にしました` : "口座名を削除しました");
    loadWatchlist();
  } catch (_) { toast("保存に失敗しました", "error"); }
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

async function addToWatch(catalogId, force) {
  const resp = await fetch("/api/watchlist", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ catalog_id: Number(catalogId), force: !!force }),
  });
  const data = await resp.json().catch(() => ({}));
  $("search-results").hidden = true;
  $("search-input").value = "";
  if (data && data.added === false) {
    if (force) { toast(RESTART_HINT, "error"); return; }   // 上と同じ理由（サーバーが古い）
    // 同じ商品でも NISA と特定、成長投資枠とつみたて投資枠のように
    // 分けて持つことがあるため、確認のうえ別の保有として追加できるようにする
    if (confirm("すでに同じ商品を保有しています。\n\nNISAと特定口座など、別口座として"
              + "もう1件追加しますか？\n（口座の種別は一覧の「口座」列で設定できます）")) {
      await addToWatch(catalogId, true);
    }
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
// 小数を含む数値の入力を解析する（"3,961.5" → 3961.5）。株価や口数は小数がありうるため、
// 整数しか扱えない parseIntComma とは別に用意する。
function parseNumComma(s) {
  const t = String(s == null ? "" : s).replace(/[,\s]/g, "");
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : 0;
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
  const tr = e.target.closest(".row-trade");
  if (tr) {
    e.stopPropagation();
    openTradeModal(Number(tr.dataset.watch));
    return;
  }
  const lb = e.target.closest(".acct-edit");
  if (lb) {
    e.stopPropagation();
    const s = lastSummaries.find((x) => x.watch_id === Number(lb.dataset.watch));
    saveLabel(lb.dataset.watch, s && s.account !== s.name ? s.account : "");
    return;
  }
  // 入力・設定中は詳細を開かない
  if (e.target.closest(".units-input") || e.target.closest(".invested-input")
      || e.target.closest(".policy-select") || e.target.closest(".row-broker")
      || e.target.closest(".account-select")) return;
  const row = e.target.closest("tr[data-id]");
  if (row && !row.classList.contains("err-row")) openDetail(Number(row.dataset.id));
});

// ============================================================ 売買の記録（モーダル）
let tradeWatchId = null;
let tradeKind = "fund";
let tradeFeeRate = 0;      // この商品の既定手数料率(%)。0なら前回入力額を引き継ぐ
let tradeLastFee = 0;      // 直近に入力した手数料（率が未設定のときの初期値）
let tradeFeeEdited = false; // 手数料を手で直したら自動計算で上書きしない

async function openTradeModal(watchId) {
  tradeWatchId = watchId;
  const s = lastSummaries.find((x) => x.watch_id === watchId) || {};
  tradeKind = s.kind === "stock" ? "stock" : "fund";
  $("trade-fund-name").textContent = (s.name || "") + (s.broker ? `（${s.broker}）` : "");
  // 投信は「口数・基準価額」、株は「株数・株価」と呼び分ける
  $("trade-units-label").childNodes[0].nodeValue = tradeKind === "stock" ? "株数" : "口数";
  $("trade-price-label").childNodes[0].nodeValue = tradeKind === "stock" ? "株価（円）" : "基準価額（円）";
  $("trade-units").placeholder = tradeKind === "stock" ? "例）100" : "例）10,000";
  $("trade-price").placeholder = tradeKind === "stock" ? "例）3,000" : "例）15,000";
  $("trade-date").value = new Date().toISOString().slice(0, 10);
  ["trade-units", "trade-price", "trade-fee", "trade-note"].forEach((id) => { $(id).value = ""; });
  $("trade-side").value = "buy";
  $("trade-amount-preview").textContent = "";
  tradeFeeEdited = false;
  $("trade-modal").hidden = false;
  await loadTrades();
}

// 手数料を自動で埋める。率が設定されていれば「売買金額×率」、無ければ前回入力額。
// 手で直したあとは上書きしない。
function applyFeePreset() {
  if (tradeFeeEdited) return;
  const hint = $("trade-fee-hint");
  const u = parseNumComma($("trade-units").value), p = parseNumComma($("trade-price").value);
  if (tradeFeeRate > 0) {
    if (u > 0 && p > 0) {
      const fee = Math.round(tradeAmount(u, p) * tradeFeeRate / 100);
      $("trade-fee").value = fee ? fee.toLocaleString() : "";
      hint.textContent = `既定 ${tradeFeeRate}% で自動計算`;
    } else {
      $("trade-fee").value = "";
      hint.textContent = `既定 ${tradeFeeRate}%（金額の入力後に計算します）`;
    }
  } else if (tradeLastFee > 0) {
    $("trade-fee").value = tradeLastFee.toLocaleString();
    hint.textContent = "前回入力した手数料";
  } else {
    hint.textContent = "";
  }
}

function closeTradeModal() {
  $("trade-modal").hidden = true;
  tradeWatchId = null;
}

// 口数×単価から受渡金額の目安を出す（投信は1万口あたりなので10000で割る）
function tradeAmount(units, price) {
  return units * price / (tradeKind === "stock" ? 1 : 10000);
}

async function loadTrades() {
  if (tradeWatchId == null) return;
  let d;
  try {
    d = await (await fetch(`/api/trades?watch_id=${tradeWatchId}`)).json();
  } catch (_) { return; }
  if (!d.ok) return;
  tradeFeeRate = Number(d.fee_rate) || 0;
  tradeLastFee = Number(d.last_fee) || 0;
  $("trade-fee-rate").value = tradeFeeRate || "";
  applyFeePreset();
  const p = d.position || {};
  const yen = (n) => Math.round(n).toLocaleString() + " 円";
  const unitLabel = tradeKind === "stock" ? "株" : "口";
  const priceLabel = tradeKind === "stock" ? "1株あたり" : "1万口あたり";
  $("trade-position").innerHTML = p.count
    ? `<div class="trade-pos">
        <div class="trade-pos-item"><span>保有${unitLabel}数</span><b>${Number(p.units).toLocaleString()}</b></div>
        <div class="trade-pos-item"><span>平均取得単価<small>（${priceLabel}）</small></span><b>${Number(p.avg_price).toLocaleString()} 円</b></div>
        <div class="trade-pos-item"><span>取得原価（投資金額）</span><b>${yen(p.cost)}</b></div>
        <div class="trade-pos-item"><span>実現損益<small>（売却済み・累計）</small></span>
          <b class="${p.realized >= 0 ? "up" : "down"}">${p.realized >= 0 ? "+" : ""}${yen(p.realized)}</b></div>
      </div>
      <p class="hint">この保有${unitLabel}数と取得原価は、銘柄一覧の「${unitLabel}数」「投資金額」に自動で反映されています。</p>`
    : `<p class="empty-watch">まだ売買の記録がありません。下のフォームから購入・売却を記録すると、平均取得単価と実現損益を計算します。</p>`;

  const rows = (d.trades || []).slice().reverse();   // 新しい順
  $("trade-list").innerHTML = rows.length ? `
    <table class="trade-table">
      <thead><tr><th>日付</th><th>売買</th><th class="num">${unitLabel}数</th>
        <th class="num">単価</th><th class="num">金額</th><th class="num">手数料</th><th>メモ</th><th></th></tr></thead>
      <tbody>${rows.map((t) => `
        <tr>
          <td>${escapeHtml(t.date)}</td>
          <td><span class="trade-side trade-side-${t.side}">${t.side === "buy" ? "購入" : "売却"}</span></td>
          <td class="num">${Number(t.units).toLocaleString()}</td>
          <td class="num">${Number(t.price).toLocaleString()}</td>
          <td class="num">${Math.round(tradeAmount(t.units, t.price)).toLocaleString()}</td>
          <td class="num${t.fee ? "" : " trade-fee-zero"}">${Number(t.fee || 0).toLocaleString()}</td>
          <td class="trade-note">${escapeHtml(t.note || "")}</td>
          <td><button class="row-del trade-del" data-trade="${t.id}" title="この記録を削除">✕</button></td>
        </tr>`).join("")}</tbody>
    </table>` : "";
}

// 金額の目安をその場で表示する（小数も入力できるよう、カンマ整形はしない）
["trade-units", "trade-price"].forEach((id) => {
  $(id).addEventListener("input", () => {
    const u = parseNumComma($("trade-units").value), p = parseNumComma($("trade-price").value);
    $("trade-amount-preview").textContent = (u > 0 && p > 0)
      ? `受渡金額の目安：約 ${Math.round(tradeAmount(u, p)).toLocaleString()} 円` : "";
    applyFeePreset();   // 率が設定されていれば手数料も追従させる
  });
});
// 手で直したら以降は自動計算で上書きしない（空に戻せば自動計算を再開）
$("trade-fee").addEventListener("input", (e) => {
  tradeFeeEdited = e.target.value.trim() !== "";
  if (!tradeFeeEdited) applyFeePreset();
  else $("trade-fee-hint").textContent = "手入力";
});
// 既定の手数料率を保存する
$("trade-fee-rate").addEventListener("change", async (e) => {
  if (tradeWatchId == null) return;
  const rate = parseFloat(e.target.value) || 0;
  try {
    const d = await (await fetch("/api/watchlist/fee-rate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ watch_id: tradeWatchId, fee_rate: rate }),
    })).json();
    if (!d.ok) { toast(d.error || "保存に失敗しました", "error"); return; }
    tradeFeeRate = d.fee_rate;
    $("trade-fee-rate").value = tradeFeeRate || "";
    $("trade-fee-rate-status").textContent = tradeFeeRate > 0
      ? `✅ 既定 ${tradeFeeRate}% を保存しました。次回から自動で計算します。`
      : "✅ 自動計算をオフにしました（前回入力した手数料を初期値にします）。";
    tradeFeeEdited = false;
    applyFeePreset();
  } catch (_) { toast("保存に失敗しました", "error"); }
});

$("trade-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (tradeWatchId == null) return;
  const body = {
    watch_id: tradeWatchId, date: $("trade-date").value, side: $("trade-side").value,
    units: parseNumComma($("trade-units").value), price: parseNumComma($("trade-price").value),
    fee: parseNumComma($("trade-fee").value), note: $("trade-note").value,
  };
  try {
    const d = await (await fetch("/api/trades", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })).json();
    if (!d.ok) { toast(d.error || "記録に失敗しました", "error"); return; }
    toast("売買を記録しました");
    ["trade-units", "trade-price", "trade-fee", "trade-note"].forEach((id) => { $(id).value = ""; });
    $("trade-amount-preview").textContent = "";
    tradeFeeEdited = false;
    await loadTrades();
    await loadWatchlist();      // 口数・投資金額・損益を更新
  } catch (_) { toast("記録に失敗しました", "error"); }
});

$("trade-list").addEventListener("click", async (e) => {
  const b = e.target.closest(".trade-del");
  if (!b) return;
  if (!confirm("この売買の記録を削除しますか？\n保有口数と投資金額が再計算されます。")) return;
  try {
    const d = await (await fetch("/api/trades", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trade_id: Number(b.dataset.trade), watch_id: tradeWatchId }),
    })).json();
    if (!d.ok) { toast(d.error || "削除に失敗しました", "error"); return; }
    toast("記録を削除しました");
    await loadTrades();
    await loadWatchlist();
  } catch (_) { toast("削除に失敗しました", "error"); }
});

$("trade-close").addEventListener("click", closeTradeModal);
$("trade-modal").addEventListener("click", (e) => {
  if (e.target === $("trade-modal")) closeTradeModal();   // 背景クリックで閉じる
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("trade-modal").hidden) closeTradeModal();
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
  if (units) { clearTimeout(fieldSaveTimer); pendingSave = null; onUnitsChanged(units.dataset.watch, parseIntComma(units.value)); return; }
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
    // 見出しは「判定<span>中期</span>」のようにタグを含むので、初回のHTMLを保存して使い回す
    if (th.dataset.label == null) th.dataset.label = th.innerHTML;
    th.innerHTML = th.dataset.label + (th.dataset.key === sortKey ? (sortDir < 0 ? " ▼" : " ▲") : "");
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
  // 資産プランの前提（取り崩し戦略）の値と、分配金カードを設定画面へ反映
  if (!(await fetchPlanData())) return;
  renderDividends();             // 分配金・配当カード（設定画面内）
  const pl = planData.plan;
  $("set-cash").value = fmtInt(pl.cash || 0);
  $("set-bonds").value = fmtInt(pl.bonds || 0);
  $("set-current-age").value = pl.current_age || "";
  $("set-retire-age").value = pl.retire_age || "";
  $("set-pension-age").value = pl.pension_age || "";
  $("set-pension-monthly").value = fmtInt(pl.pension_monthly || 0);
  $("set-spend-monthly").value = fmtInt(pl.spend_monthly || 0);
  $("set-inflation").value = pl.inflation != null ? pl.inflation : "";
  $("set-pension-slide").value = pl.pension_slide != null ? pl.pension_slide : 0.4;
  $("set-tax").value = pl.tax != null ? pl.tax : 20.315;   // 既定：日本の約20.315%
  $("set-emergency-months").value = pl.emergency_months != null ? pl.emergency_months : 6;
  $("set-near-term").value = fmtInt(pl.near_term || 0);
  $("set-draw-method").value = pl.draw_method || "fixed";
  $("set-draw-rate").value = pl.draw_rate != null ? pl.draw_rate : 4;
  $("set-conc-keep").value = pl.conc_keep != null ? pl.conc_keep : 100;
  renderEmFloorNote();
  renderConcKeepNote();
  renderPensionSlideNote();
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

// ============================================================ 取引履歴CSVの取り込み
let csvPreview = null;   // { rows, groups, holdings, broker }
let csvFile = null;      // 選んだCSV（列を指定して読み直すため保持する）
// 列の対応づけで選べる項目（サーバーの ROLE_LABELS と対応）
const CSV_ROLES = [
  { role: "date", label: "約定日", required: true },
  { role: "name", label: "銘柄・ファンド名", required: true },
  { role: "side", label: "取引（売買）", required: true },
  { role: "units", label: "数量（口数・株数）", required: true },
  { role: "price", label: "単価（基準価額・株価）", required: true },
  { role: "fee", label: "手数料", required: false },
  { role: "acct", label: "口座（特定/NISA）", required: false },
  { role: "div", label: "分配金コース", required: false },
];

function setCsvStatus(msg, kind) {
  const el = $("csv-status");
  if (el) { el.textContent = msg || ""; el.className = "ai-test-status " + (kind || ""); }
}

$("csv-btn").addEventListener("click", () => $("csv-file").click());
$("csv-file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  csvFile = file;
  await readCsv(null);
});

// CSVを読み取る。mapping を渡すと、その列の対応づけで読み直す。
async function readCsv(mapping) {
  if (!csvFile) return;
  setCsvStatus("読み取り中… ⏳");
  $("csv-preview").hidden = true;
  try {
    const fd = new FormData();
    fd.append("file", csvFile);
    if (mapping) fd.append("mapping", JSON.stringify(mapping));
    const d = await (await fetch("/api/trades/import-preview", { method: "POST", body: fd })).json();
    if (!d.ok) { setCsvStatus("⚠️ " + (d.error || "読み取りに失敗しました"), "error"); return; }
    if (d.needs_mapping) {
      csvPreview = null;
      renderCsvMapping(d);
      setCsvStatus("どの列が何にあたるか選んでください", "error");
      return;
    }
    if (!d.rows.length) {
      // 列の指定違いや、取引欄の書き方が想定外のときに気づけるようにする
      csvPreview = null;
      $("csv-preview").hidden = true;
      const why = (d.reasons || []).length
        ? `（除外の理由：${d.reasons.map((r) => `「${r}」`).join("・")}）` : "";
      setCsvStatus(`⚠️ 取り込める売買がありませんでした${why}。列の対応づけを確認してください。`, "error");
      renderCsvMapping({ header: d.header || [], columns: d.columns || {}, broker: d.broker,
                         roles: CSV_ROLES, samples: [] });
      return;
    }
    csvPreview = d;
    renderCsvPreview();
    setCsvStatus(`${d.broker || "証券会社"}のCSVを読み取りました（売買 ${d.rows.length} 件）`
      + (d.mapping_saved ? "。列の対応を保存したので、次回から自動で読み取ります。" : ""));
  } catch (err) {
    setCsvStatus("⚠️ 読み取りに失敗しました: " + err.message, "error");
  }
}

// 列を自動判定できなかったとき、CSVの列を役割に割り当ててもらう
function renderCsvMapping(d) {
  const box = $("csv-preview");
  box.hidden = false;
  const opts = (sel) => `<option value="-1">（なし）</option>` + (d.header || []).map((h, i) =>
    `<option value="${i}"${sel === i ? " selected" : ""}>${i + 1}. ${escapeHtml(h || "(空欄)")}</option>`).join("");
  const rows = (d.roles || []).map((r) => `
    <tr>
      <td>${escapeHtml(r.label)}${r.required ? '<span class="csv-req">必須</span>' : ""}</td>
      <td><select class="csv-col" data-role="${r.role}">${opts((d.columns || {})[r.role])}</select></td>
    </tr>`).join("");
  const sample = (d.samples || []).map((s) =>
    `<tr>${s.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
  box.innerHTML = `
    <p class="hint">このCSVは列名から自動で判別できませんでした（${escapeHtml(d.broker || "対応表未登録の証券会社")}）。
      下でCSVの列を割り当てると取り込めます。一度選べばそのまま読み込みます。</p>
    <div class="csv-table-wrap">
      <table class="csv-table">
        <thead><tr><th>項目</th><th>CSVの列</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <details class="plan-help"><summary>CSVの中身（先頭3行）を見る</summary>
      <div class="csv-table-wrap"><table class="csv-table">
        <thead><tr>${(d.header || []).map((h, i) => `<th>${i + 1}. ${escapeHtml(h || "")}</th>`).join("")}</tr></thead>
        <tbody>${sample}</tbody></table></div>
    </details>
    <div class="backup-row"><button id="csv-remap" type="button">この対応で読み取る</button></div>`;
  $("csv-remap").addEventListener("click", () => {
    const m = {};
    document.querySelectorAll("#csv-preview .csv-col").forEach((s) => { m[s.dataset.role] = Number(s.value); });
    readCsv(m);
  });
}

function renderCsvPreview() {
  const box = $("csv-preview");
  if (!csvPreview) { box.hidden = true; return; }
  box.hidden = false;
  const hs = csvPreview.holdings || [];
  const cat = csvPreview.catalog || [];
  // 「保有から選ぶ」に加え、一覧に無い商品は「追加して取り込む」を選べるようにする
  const opt = (g) => {
    const sel = g.watch_id ? String(g.watch_id) : (g.catalog_id ? `c:${g.catalog_id}` : "");
    const own = hs.map((h) => {
      const acct = h.account_type === "nisa" ? "NISA" : "特定";
      const label = `${h.name}${h.label && h.label !== h.name ? `／${h.label}` : ""}`
        + `［${acct}］${h.broker ? `（${h.broker}）` : ""}`;
      return `<option value="${h.watch_id}"${sel === String(h.watch_id) ? " selected" : ""}>${escapeHtml(label)}</option>`;
    }).join("");
    // 名前が近いものが上に来るように並べ替える（選ぶだけで、自動選択はしない）
    const order = g.catalog_order || [];
    const rank = (c) => { const i = order.indexOf(c.catalog_id); return i < 0 ? 999 : i; };
    const add = cat.slice().sort((a, b) => rank(a) - rank(b)).map((c) =>
      `<option value="c:${c.catalog_id}"${sel === `c:${c.catalog_id}` ? " selected" : ""}>＋ ${escapeHtml(c.name)}</option>`).join("");
    return `<option value=""${sel ? "" : " selected"}>（取り込まない）</option>`
      + (own ? `<optgroup label="保有から選ぶ">${own}</optgroup>` : "")
      + (add ? `<optgroup label="一覧に追加して取り込む">${add}</optgroup>` : "");
  };
  // 口座区分（特定/NISA）ごとに行を分けて取り込む。同じ商品を2口座で持っている場合に
  // 片方の保有へまとめて入ってしまうのを防ぐため。
  const acctChip = (t) => t === "nisa" ? '<span class="csv-acct csv-acct-nisa">NISA</span>'
    : t === "taxable" ? '<span class="csv-acct">特定</span>' : "";
  const rows = (csvPreview.groups || []).map((g) => `
    <tr class="${g.watch_id ? "" : "csv-unmatched"}">
      <td class="csv-name">${escapeHtml(g.name)}${acctChip(g.account_type)}
        <span class="csv-meta">${g.first} 〜 ${g.last}</span></td>
      <td class="num">${g.count}<span class="csv-meta">買${g.buy}／売${g.sell}</span></td>
      <td>${g.watch_id
          ? `<span class="csv-badge csv-auto">${g.how === "partial" ? "自動（部分一致）" : "自動一致"}</span>`
          : g.catalog_id
          ? `<span class="csv-badge csv-add">一覧に無い（追加候補あり）</span>`
          : `<span class="csv-badge csv-need">要確認</span>`}</td>
      <td><select class="csv-map" data-key="${escapeHtml(g.key)}">${opt(g)}</select></td>
      <td class="num csv-meta">${g.duplicates ? `${g.duplicates}件は取込済み` : ""}</td>
    </tr>`).join("");
  const skipped = (csvPreview.skipped || []).length;
  box.innerHTML = `
    <div class="csv-table-wrap">
      <table class="csv-table">
        <thead><tr><th>CSVの商品名</th><th class="num">件数</th><th>判定</th>
          <th>取り込み先の保有</th><th class="num">重複</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="backup-row">
      <button id="csv-import" type="button">この内容で取り込む</button>
      <span class="hint">${skipped ? `※ 売買でない ${skipped} 行（コース変更など）は取り込みません。` : ""}</span>
    </div>`;
  $("csv-import").addEventListener("click", runCsvImport);
}

async function runCsvImport() {
  if (!csvPreview) return;
  const mapping = {};
  document.querySelectorAll("#csv-preview .csv-map").forEach((s) => {
    // "c:12" は「カタログの商品を一覧に追加してから取り込む」指定
    if (s.value) mapping[s.dataset.key] = s.value.startsWith("c:") ? s.value : Number(s.value);
  });
  if (!Object.keys(mapping).length) {
    setCsvStatus("⚠️ 取り込み先の保有が1つも選ばれていません。", "error"); return;
  }
  setCsvStatus("取り込み中… ⏳");
  try {
    const d = await (await fetch("/api/trades/import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: csvPreview.rows, mapping, broker: csvPreview.broker || "" }),
    })).json();
    if (!d.ok) { setCsvStatus("⚠️ " + (d.error || "取り込みに失敗しました"), "error"); return; }
    setCsvStatus(`✅ ${d.added} 件を取り込みました`
      + (d.duplicates ? `（重複 ${d.duplicates} 件は登録済みのため除外）` : "")
      + (d.skipped ? `（対応づけ未選択 ${d.skipped} 件は取り込まず）` : "")
      + `。${d.holdings} 銘柄の口数・投資金額を更新しました。`
      + (d.created ? `新しく ${d.created} 銘柄を一覧に追加しました。` : ""));
    toast("取引履歴を取り込みました");
    $("csv-preview").hidden = true;
    csvPreview = null;
    await loadWatchlist();
  } catch (err) {
    setCsvStatus("⚠️ 取り込みに失敗しました: " + err.message, "error");
  }
}

// ============================================================ バックアップ・復元
function setBackupStatus(msg, kind) {
  const el = $("backup-status");
  if (el) { el.textContent = msg || ""; el.className = "ai-test-status " + (kind || ""); }
}

// バックアップの保存（サーバーが生成したJSONをそのままダウンロード）
$("export-btn").addEventListener("click", async () => {
  setBackupStatus("書き出し中… ⏳");
  try {
    const r = await fetch("/api/export");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    // Content-Disposition のファイル名を使う（無ければ日付から作る）
    const cd = r.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="([^"]+)"/);
    const name = m ? m[1]
      : "fund-timing-backup-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + ".json";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBackupStatus(`✅ ${name} を保存しました`);
  } catch (e) {
    setBackupStatus("⚠️ 保存に失敗しました: " + e.message, "error");
  }
});

// バックアップからの復元（ファイル選択 → 確認 → 取り込み）
$("import-btn").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";                       // 同じファイルを続けて選べるようにする
  if (!file) return;
  if (!confirm("バックアップから復元します。\n\n現在の保有・評価額の履歴・設定は置き換わります。\nよろしいですか？")) {
    setBackupStatus("復元をキャンセルしました");
    return;
  }
  setBackupStatus("復元中… ⏳");
  try {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error("JSONとして読み取れませんでした。ファイルを確認してください。"); }
    const r = await fetch("/api/import", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || "取り込みに失敗しました");
    const c = d.counts || {};
    setBackupStatus(`✅ 復元しました（商品 ${c.catalog || 0} / 保有 ${c.watchlist || 0} / 履歴 ${c.amount_history || 0} 件）`);
    toast("バックアップから復元しました");
    // 画面全体を作り直す（一覧・設定・資産プラン）
    await loadSettings();
    await loadWatchlist();
  } catch (err) {
    setBackupStatus("⚠️ " + err.message, "error");
  }
});

// 資産プランの前提（設定画面）— 入力を /api/plan に保存
function bindPremise(id, key, comma) {
  const el = $(id); if (!el) return;
  el.addEventListener("input", (e) => {
    let v;
    if (comma) { reformatCommaInput(e.target); v = parseIntComma(e.target.value); }
    else { v = parseFloat(e.target.value) || 0; }
    savePlan({ [key]: v });
    renderEmFloorNote();   // 生活防衛資金は現金・生活費・月数のどれを変えても結果が変わる
    renderConcKeepNote();
    renderPensionSlideNote();
  });
}

// 年金の改定率の補足。生活費と同率で増やすと楽観的になることを、金額で示す。
function renderPensionSlideNote() {
  const el = $("pension-slide-note");
  if (!el) return;
  const p = planData.plan || {};
  const infl = (p.inflation || 0) / 100;
  const slide = (p.pension_slide != null ? p.pension_slide : 0.4) / 100;
  const grow = Math.max(0, infl - slide);
  const pen = p.pension_monthly || 0;
  const yen = (n) => Math.round(n).toLocaleString() + "円";
  el.classList.remove("field-note-warn");
  if (!(pen > 0)) {
    el.textContent = "公的年金は物価上昇をそのまま反映せず、マクロ経済スライドで抑えられます。"
      + "インフレ率からこの値を引いた率で年金を増やします（既定 0.4%）。";
    return;
  }
  const at = (yrs) => pen * Math.pow(1 + grow, yrs);
  const naive = pen * Math.pow(1 + infl, 20);
  el.textContent = `インフレ ${(infl * 100).toFixed(1)}% − スライド ${(slide * 100).toFixed(1)}%`
    + ` ＝ 年金は毎年 ${(grow * 100).toFixed(1)}% 増える前提です。`
    + `いま ${yen(pen)}/月 なら 20年後は ${yen(at(20))}/月`
    + `（インフレと同率で増えるとした場合は ${yen(naive)}/月）。`;
  if (slide <= 0) {
    el.textContent += " 0にするとインフレと同率＝年金が目減りしない前提になります。";
    el.classList.add("field-note-warn");
  }
}

// 「集中している銘柄を残す割合」の補足。対象の銘柄名と、いまの設定で何が起きるかを示す。
function renderConcKeepNote() {
  const el = $("conc-keep-note");
  if (!el) return;
  const p = planData.plan || {};
  const pct = p.conc_keep != null ? p.conc_keep : 100;
  const cc = portfolioRisk && portfolioRisk.concentration;
  el.classList.remove("field-note-warn");
  if (!cc || cc.share < CONC_MIN_SHARE) {
    el.textContent = "1銘柄が資産の15%以上を占めているとき、その銘柄を売って分散資産に"
      + "買い替える前提で取り崩し戦略を計算します。100%＝売らずにそのまま保有。"
      + "（いまは対象になる銘柄がありません。取り崩し戦略タブを開くと判定します。）";
    return;
  }
  const yen = (n) => Math.round(n).toLocaleString() + "円";
  const head = `対象は「${cc.name}」（資産の ${cc.share}%）。`;
  if (pct >= cc.share) {
    el.textContent = head + "いまの設定では売らずにそのまま保有する前提です。"
      + "減らす場合は、残したい割合（例：10）を入れてください。";
    el.classList.add("field-note-warn");
  } else {
    // 金額は「比率 × 運用資産」で出す。/api/portfolio-risk の評価額（価格×口数）を
    // そのまま使うと、資産プラン側の評価額と桁が食い違うことがあるため。
    const pool = planData.total_value || 0;
    const amount = pool > 0 ? `（約 ${yen(pool * pct / 100)}）` : "";
    el.textContent = head + `資産の ${Math.round(pct)}%${amount}まで`
      + "年360万円ペースで売り、同額を分散資産に買い直す前提で計算します"
      + "（NISAの残り枠を先に使います）。売却益には課税されます。";
  }
}

// 生活防衛資金は「生活費×月数」だが、手元現金が上限になる。
// 現金で頭打ちになっていると月数を増やしても結果が変わらないため、その旨を明示する。
function renderEmFloorNote() {
  const el = $("em-floor-note");
  if (!el) return;
  const p = planData.plan || {};
  const spend = p.spend_monthly || 0;
  const months = (p.emergency_months != null) ? p.emergency_months : 6;
  const cash = p.cash || 0;
  const yen = (n) => Math.round(n).toLocaleString() + "円";
  if (!(spend > 0)) { el.textContent = "退職後の生活費を入力すると金額を表示します。"; el.classList.remove("field-note-warn"); return; }
  const want = spend * months;
  if (want > cash) {
    el.textContent = `${yen(spend)}×${months}ヶ月＝${yen(want)} を現金で残します。`
      + `手元現金 ${yen(cash)} では ${yen(want - cash)} 足りないため、`
      + "退職後に債券→投信を売って現金に振り替える前提で計算します。";
    el.classList.add("field-note-warn");
  } else {
    el.textContent = `${yen(spend)}×${months}ヶ月＝${yen(want)} を現金で残します（手元現金 ${yen(cash)}）。`;
    el.classList.remove("field-note-warn");
  }
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
bindPremise("set-pension-slide", "pension_slide", false);
bindPremise("set-emergency-months", "emergency_months", false);
bindPremise("set-near-term", "near_term", true);
bindPremise("set-draw-rate", "draw_rate", false);
bindPremise("set-conc-keep", "conc_keep", false);
$("set-draw-method").addEventListener("change", (e) => savePlan({ draw_method: e.target.value }));

// ============================================================ 資産プラン
let planData = { total_value: 0, total_invested: 0, holdings: [], plan: {} };
let planRange = "1y";
let lastPlanTotals = [];   // 直近取得した資産推移 [{date, amount}]
let aiBand = null;         // AI予測の年率 {base, optimistic, pessimistic}（無ければ手動）

// /api/plan を取得して planData に格納する。保存待ちの前提変更があれば先に確定させる
// （設定画面での変更が古い値で上書きされないようにするため）。成功したら true。
async function fetchPlanData() {
  await flushPlanSave();
  try {
    const d = await (await fetch("/api/plan")).json();
    if (!d || !d.ok) return false;
    planData = d;
    planData.plan = planData.plan || {};
    return true;
  } catch (_) { return false; }
}

async function loadPlan() {
  if (await fetchPlanData()) {
    $("plan-goal").value = fmtInt(planData.plan.goal || 0);
    $("plan-monthly").value = fmtInt(planData.plan.monthly || 0);
    $("plan-return").value = planData.plan.return_rate != null ? planData.plan.return_rate : "";
    renderPlanGoal();
    renderCashAdvice();
    renderDividends();
  }
  // AI予測ボタンは設定でAIをオンにしているときだけ表示
  const aiRow = $("plan-ai-row");
  if (aiRow) aiRow.hidden = (aiSettings.ai_model === "off");
  // 集中銘柄の売却計画にも使うので、グラフを描く前に読んでおく。
  // 取り崩し戦略タブを開いたかどうかでグラフが変わってしまうのを防ぐ。
  if (!portfolioRisk) {
    try {
      const r = await (await fetch("/api/portfolio-risk?years=5")).json();
      portfolioRisk = r.ok ? r : null;
    } catch (_) { portfolioRisk = null; }
  }
  await loadPlanHistory();   // ここで lastLifeArgs が確定する（取り崩し戦略ビューが使う）
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

// 現在の税引後総資産（NISAは非課税、特定口座は含み益に課税）。
// 資産推移グラフの起点と同じ考え方にして、進捗ゲージと文言が食い違わないようにする。
function planAfterTaxTotal() {
  const p = planData.plan || {};
  const baseTax = (p.tax != null ? p.tax : 20.315) / 100;
  const taxV = planData.taxable_value || 0, taxI = planData.taxable_invested || 0;
  return planReserve() + planFundValue() - Math.max(0, taxV - taxI) * baseTax;
}

// --- 目標・進捗 ---
// exactTotal を渡すと、資産推移グラフが実際に描いた現在値をそのまま使う（完全に一致させる）
function renderPlanGoal(exactTotal) {
  const goal = planData.plan.goal || 0;
  const fund = planFundValue();
  const reserve = planReserve();
  // グラフ・達成予測と同じ「税引後」の総資産で進捗を判定する
  const cur = (exactTotal != null) ? exactTotal : planAfterTaxTotal();
  const pct = goal > 0 ? (cur / goal * 100) : 0;
  $("fire-fill").style.width = Math.min(100, pct).toFixed(1) + "%";
  $("fire-pct").textContent = goal > 0 ? `達成率 ${pct.toFixed(1)}%` : "目標額を入力してください";
  const remain = goal - cur;
  $("fire-remain").textContent = goal > 0
    ? (remain > 0 ? `あと ${Math.round(remain).toLocaleString()} 円` : "🎉 目標達成！")
    : "";
  let note = "";
  if (goal > 0) {
    // 内訳も cur から逆算して出す（評価額と税引後の値を混ぜると合計が合わなくなるため）
    const fundAT = cur - reserve;       // 投信の税引後評価額
    const tax = fund - fundAT;          // 含み益にかかる税（売却して手にする額との差）
    note = `税引後の総資産 ${Math.round(cur).toLocaleString()} 円 ／ 目標 ${Math.round(goal).toLocaleString()} 円`;
    if (reserve > 0) note += `（内訳：投信 ${Math.round(fundAT).toLocaleString()} 円`
      + (tax > 0.5 ? `［評価額 ${Math.round(fund).toLocaleString()} 円 − 含み益への税 ${Math.round(tax).toLocaleString()} 円］` : "")
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
$("strategy-goto-settings").addEventListener("click", () => switchView("settings"));

// --- 取り崩し戦略の比較とリスク検証 ---
let lastLifeArgs = null;      // 資産推移グラフと同じ前提（renderLifeStages が控える）
let portfolioRisk = null;     // 実際の保有から推定した年率リターン・変動率
let strategyShown = false;    // 検証結果を表示中か（前提が変わったら計算し直すため）
let drawTableReal = false;    // 取り崩し額の表を「今日の価値」で表示するか（既定は実際の金額）
let drawTableStep = 5;        // 取り崩し額の表を何年おきに表示するか（計算自体は常に月単位）

function setStrategyStatus(msg, kind) {
  const el = $("strategy-status");
  if (el) { el.textContent = msg || ""; el.className = "ai-test-status " + (kind || ""); }
}

// 同じ前提で、方法とシナリオだけ差し替えて1本走らせる
function runPath(extra) {
  const a = lastLifeArgs;
  return buildLifePath(a.cur, a.lastDate, a.monthly, a.baseRate, a.lp, a.cash0, a.bonds0,
                       a.basis0, a.taxRate, a.emFloor, a.div,
                       drawOpts(Object.assign({ split: a.split }, extra || {})));
}

// 取り崩し戦略の検証をひととおり走らせる。タブを開いたときと「再計算」ボタンから呼ぶ。
async function runStrategy() {
  if (!lastLifeArgs) {
    setStrategyStatus("⚠️ 先に設定で退職年齢・生活費などの前提を入力してください。", "error");
    return;
  }
  setStrategyStatus("検証中… ⏳");
  try {
    const r = await (await fetch("/api/portfolio-risk?years=5")).json();
    portfolioRisk = r.ok ? r : null;
  } catch (_) { portfolioRisk = null; }
  strategyShown = true;
  const aiBox = $("strategy-ai");
  if (aiBox) { aiBox.hidden = true; aiBox.innerHTML = ""; }   // 前提が変われば古い助言は消す
  renderConcKeepNote();      // 設定タブの補足は、集中銘柄が分かってから書き直す
  renderStrategy();          // ここで集中銘柄の売却計画が確定する
  renderStrategyPremise();   // チップはその計画に合わせて描く
  setStrategyStatus("");
}
$("strategy-run").addEventListener("click", runStrategy);
$("strategy-ai-run").addEventListener("click", loadStrategyAi);

// 検証に使う前提をチップで並べる。どの設定で計算しているのかを一目で分かるようにする。
function renderStrategyPremise() {
  const el = $("strategy-premise");
  if (!el) return;
  const p = planData.plan || {};
  const lp = planLifePlan();
  if (!lp.ok) {
    el.innerHTML = '<p class="empty-watch">設定の「資産プランの前提」で現在の年齢・退職年齢・生活費を入力すると検証できます。</p>';
    return;
  }
  const man = (n) => Math.round((n || 0) / 10000).toLocaleString() + "万円";
  const chips = [
    ["取り崩し方法", DRAW_LABELS[p.draw_method || "fixed"]
      + ((p.draw_method === "percent") ? `（年${p.draw_rate != null ? p.draw_rate : 4}%）` : "")],
    ["退職", `${lp.retire}歳`],
    ["年金", `${lp.penAge}歳〜 ${man(lp.pension)}/月（改定 年${(lp.penGrow * 100).toFixed(1)}%）`],
    ["生活費", `${man(lp.spend)}/月`],
    // 実際に計算へ使う年利を出す（AI予測をオンにしていると設定値ではなくAIの値になる）
    ["想定年利", lastLifeArgs
      ? `${(lastLifeArgs.baseRate * 100).toFixed(2)}%${lastLifeArgs.useAi ? "（AI予測）" : ""}`
      : `${p.return_rate != null ? p.return_rate : 0}%`],
    ["インフレ", `${p.inflation != null ? p.inflation : 0}%`],
    ["売却順序", "NISA温存"],
  ];
  // 1銘柄に偏っているときは「どれだけ残すか」も結果を左右するので前提として並べる。
  // ただし①②が実際にその前提で計算しているとき（売却計画が組めたとき）だけにする。
  const cp = lastConcPlan;
  if (cp) {
    const pct = p.conc_keep != null ? p.conc_keep : 100;
    chips.push([`${cp.cc.name}（現在 ${cp.cc.share}%）`,
                pct >= cp.cc.share ? "そのまま保有" : `${Math.round(pct)}%まで減らす`]);
  }
  el.innerHTML = chips.map(([k, v]) =>
    `<span class="premise-chip"><span class="premise-key">${k}</span>${escapeHtml(String(v))}</span>`).join("");
}

// 取り崩し戦略の画面は、決める材料を2つ（取り崩し方法・集中銘柄を残す割合）にしぼり、
// 結果を「① 年齢ごとの取り崩し額」と「② 値動きのブレを含めた成功確率」の2つに集約する。
// 方法ごと・残す割合ごとの比較は②の中に畳んである。
function renderStrategy() {
  const box = $("strategy-body");
  const a = lastLifeArgs;
  if (!a) { box.innerHTML = ""; strategyShown = false; return; }
  const yen = (n) => Math.round(n).toLocaleString() + " 円";
  const man = (n) => Math.round(n / 10000).toLocaleString() + " 万円";
  const ageOf = (p) => p.depletionAge > 0 ? `${Math.floor(p.depletionAge)}歳で枯渇` : "100歳まで持続";
  const cur = (planData.plan || {}).draw_method || "fixed";
  const curLabel = DRAW_LABELS[cur];
  const rm = projMonthlyRate(a.baseRate);

  // 集中している銘柄を「どれだけ残すか」は設定タブの値を使う（100%＝売らずに現状のまま）
  const cp = concentrationPlan(a, rm);
  lastConcPlan = cp;   // 前提チップは①②が実際に使った計画に合わせる
  const keepOpts = cp ? cp.optsFor(cp.target) : {};
  const path = (extra) => runPath(Object.assign({}, keepOpts, extra));
  const curPath = path({ method: cur });

  // ── ① 年齢ごとの取り崩し額 ─────────────────────────────────────────
  const retAge = Math.ceil(a.retireAge);
  const penAge = Math.ceil(a.lp.penAge);
  const ages = [];
  for (let g = retAge; g <= 100; g += drawTableStep) ages.push(g);
  if (penAge > retAge && penAge < 100 && !ages.includes(penAge)) {
    ages.push(penAge); ages.sort((x, y) => x - y);
  }
  // 年金＋出どころ（現金・債券・分配金・投信）＝生活費、と左から右へ足し上がるように並べる
  const srcCols = [
    ["pension", "年金", "draw-pen"],
    ["cash", "現金", ""], ["bonds", "債券", ""],
    ["div", "分配金・配当", "draw-div"], ["fund", "投信・株<br><small>（売却）</small>", ""],
    ["total", "取り崩し計", "draw-sub"],
    ["living", "生活費", "draw-total"],
  ];
  // 単位は見出しにまとめ、セルは「月額（上段）／年額（下段）」だけにして表を横に詰める
  const yearTxt = (n) => (n >= 100000 ? Math.round(n / 10000).toLocaleString() + "万"
                                      : Math.round(n).toLocaleString());
  const drawCell = (d, key, cls) => {
    if (!d) return `<td class="num draw-none ${cls}">—</td>`;
    const v = d[key];
    const mo = drawTableReal ? v.monthReal : v.month;
    const yr = drawTableReal ? v.yearReal : v.year;
    return `<td class="num draw-cell ${cls}"><b>${Math.round(mo).toLocaleString()}</b>`
      + `<span class="draw-year">年 ${yearTxt(yr)}</span></td>`;
  };
  // 年金の実質的な目減り率（改定が物価に追いつかないぶん）。説明文に使う。
  const penYears = Math.max(0, 100 - Math.ceil(a.lp.penAge));
  const penReal = (Math.pow((1 + (a.lp.penGrow != null ? a.lp.penGrow : a.lp.infl))
                            / (1 + a.lp.infl), penYears) - 1) * 100;
  const drawRows = ages.map((g) => {
    const tag = g === penAge ? '<span class="draw-tag">年金開始</span>'
      : (g < penAge ? '<span class="draw-tag draw-tag-gap">年金なし</span>' : "");
    const d = drawAtAge(curPath, g);
    return `<tr><td>${g}歳${tag}</td>${srcCols.map(([k, , c]) => drawCell(d, k, c)).join("")}</tr>`;
  }).join("");

  // ── ② 値動きのブレを含めた成功確率 ────────────────────────────────
  const succ = renderSuccess(a, cur, rm, cp, path, man, yen, ageOf);

  box.innerHTML = `
    ${cur === "guardrail" ? renderGuardStatus(a, curPath, yen, man) : ""}

    <h3 class="strat-h">① 年齢ごとの取り崩し額（${curLabel}${cp ? "・" + cp.label(cp.target) : ""}）</h3>
    <div class="draw-ctrls">
      <label class="draw-toggle">表示間隔
        <select id="draw-step">
          <option value="5"${drawTableStep === 5 ? " selected" : ""}>5年ごと</option>
          <option value="1"${drawTableStep === 1 ? " selected" : ""}>1年ごと</option>
        </select></label>
      <label class="draw-toggle" title="金額の単位を今日の購買力に直して表示します。計算の前提は変わりません">
        <input type="checkbox" id="draw-real"${drawTableReal ? " checked" : ""}>
        今日の価値で表示する</label>
      <span class="draw-unit">単位：円（上段＝月額／下段＝年額）</span>
    </div>
    <div class="csv-table-wrap"><table class="csv-table strat-table draw-table">
      <thead><tr><th>年齢</th>${srcCols.map(([, label, c]) =>
        `<th class="num ${c}">${label}</th>`).join("")}</tr></thead>
      <tbody>${drawRows}</tbody></table></div>
    <p class="hint"><strong>年金 ＋ 現金 ＋ 債券 ＋ 分配金・配当 ＋ 投信・株 ＝ 生活費</strong>
      になるように並べています（「取り崩し計」は年金以外の小計＝資産から出る額）。
      ${drawTableReal
        ? `金額を<strong>今日の購買力</strong>に直して表示しています。
           <strong>前提は変えていません</strong>（単位の付け替えだけです）。
           ${penReal < -0.5
             ? `年金がだんだん減るのは、改定 年${(a.lp.penGrow * 100).toFixed(1)}% が
                物価上昇 年${(a.lp.infl * 100).toFixed(1)}% に追いつかず、
                <strong>実質的に目減りする</strong>ためです
                （${Math.ceil(a.lp.penAge)}歳から100歳で約${Math.abs(penReal).toFixed(0)}%）。
                これがマクロ経済スライドの効果そのものです。`
             : ""}`
        : `<strong>その年齢のときに実際に引き出す額</strong>（インフレ 年${(a.lp.infl * 100).toFixed(1)}%込み）です。`}
      年金が生活費を上回る月は 0 円、資産が尽きた後は「—」と表示します。
      退職時の想定資産は<strong>${yen(curPath.retireBal)}</strong>、
      資産寿命は<strong>${ageOf(curPath)}</strong>（値動きのブレなし）です。</p>
    <details class="plan-help">
      <summary>この表の細かい前提</summary>
      <ul>
        <li>取り崩しは<strong>現金 → 債券 → 投信</strong>の順。ただし<strong>生活防衛資金（${yen(a.emFloor || 0)}）は使わずに現金で残す</strong>ため、
          現金のうち生活防衛資金を超えるぶんだけが生活費に回ります。
          ${(a.emFloor || 0) > (a.cash0 || 0) + 1
            ? `手元現金（${yen(a.cash0 || 0)}）では足りないぶんは、<strong>債券→投信を売って現金に振り替えます</strong>。この振替は生活費ではないので表には現れませんが、そのぶん投信は減ります。`
            : ""}</li>
        <li>売る口座の順序は<strong>NISA温存</strong>（課税される特定口座から先に売る）で固定しています。</li>
        <li><strong>分配金・配当は投信・株から出たお金</strong>なので、現金ではなくこの欄に数えています。
          「投信・株（売却）」が0円でも、分配金を受け取っていれば商品はそのぶん目減りします。
          その月に使い切らなかった分は現金として積み上がります（翌月以降は「現金」に数えます）。</li>
        <li>分配金は<strong>利回り一定</strong>として運用資産に比例させています。設定の分配金カードの金額は<strong>今の保有額</strong>ベースです。</li>
        <li>金額は<strong>月単位で計算</strong>しており毎月変化します（定額・ガードレールはインフレのぶん増え、定率は残高に連動）。
          各行の月額は、その年齢の12ヶ月を平均した額です。</li>
        ${cp ? `<li>${escapeHtml(cp.cc.name)}は<strong>${cp.label(cp.target)}</strong>の前提で、
          売った代金は使わず<strong>同額を分散資産に買い直します</strong>（NISAの残り枠 ${yen(cp.room)} を先に使用）。
          売却益には ${Math.round(cp.gain * 100)}％ の含み益として課税しています。</li>` : ""}
      </ul>
    </details>

    ${succ}`;

  const stepSel = $("draw-step");
  if (stepSel) stepSel.addEventListener("change", (e) => {
    drawTableStep = Number(e.target.value) || 5;
    renderStrategy();
  });
  const realChk = $("draw-real");
  if (realChk) realChk.addEventListener("change", (e) => {
    drawTableReal = e.target.checked;
    renderStrategy();
  });
  const nowMonth = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const baseBtn = $("guard-base-set");
  if (baseBtn) baseBtn.addEventListener("click", () => {
    const g = guardState(a, curPath);
    // 基準は「設定した生活費といまの資産」で決める（採用中の生活費ではなく元の水準）
    const rate = g.assets > 0 ? Math.max(0, (g.spendSet - g.pension) * 12) / g.assets : 0;
    if (!(rate > 0)) { toast("資産か生活費が未入力のため決められません", "error"); return; }
    savePlan({ guard_base_rate: Number((rate * 100).toFixed(3)), guard_checked: nowMonth() });
    toast(`基準の引出率を ${(rate * 100).toFixed(2)}% にしました`);
    renderStrategy();
  });
  const applyBtn = $("guard-apply");
  if (applyBtn) applyBtn.addEventListener("click", () => {
    const g = guardState(a, curPath);
    // 据え置きの年でも「見直した」こと自体は記録する。そうしないと次回の時期が
    // 更新されず、確認済みなのに「時期です」と出続けてしまう。
    if (g.verdict === "keep") {
      savePlan({ guard_checked: nowMonth() });
      toast("見直しを記録しました（生活費は据え置き）");
    } else {
      savePlan({ guard_spend: Math.round(g.next), guard_checked: nowMonth() });
      toast(`生活費を ${Math.round(g.next).toLocaleString()} 円/月に変更しました`);
    }
    renderStrategy();
  });
}

// ── ガードレール運用の現在地 ────────────────────────────────────────
// 試算とは別に、「いま実際にどのあたりにいるのか」を運用の指針として出す。
// 判定式は buildLifePath の中と同じにしてある（片方だけ直すとズレるので注意）。
//   引出率 =（採用中の生活費 − 年金）× 12 ÷ 税引後の総資産
//   上のレール＝基準×1.2（超えたら生活費を10%減）／下のレール＝基準×0.8（下回ったら10%増）
//   生活費は設定額の70%〜125%の範囲に収める
const GUARD_UP = 1.2, GUARD_DOWN = 0.8, GUARD_STEP = 0.1;
const GUARD_MIN = 0.7, GUARD_MAX = 1.25;

function guardState(a, curPath) {
  const p = planData.plan || {};
  const assets = curPath.pts[0] ? curPath.pts[0].v : 0;      // 税引後の総資産（グラフと同じ値）
  const spendSet = a.lp.spend;                                // 設定した生活費
  const spend = (p.guard_spend > 0) ? p.guard_spend : spendSet;   // いま採用している生活費
  const pension = a.lp.pension;
  const excess = Math.max(0, (spend - pension) * 12);          // 資産から抜く年額
  const rate = assets > 0 ? excess / assets : 0;
  // 基準の引出率。決めていなければ「設定の生活費といまの資産」から自動で置く
  const autoBase = assets > 0 ? Math.max(0, (spendSet - pension) * 12) / assets : 0;
  const base = (p.guard_base_rate > 0) ? p.guard_base_rate / 100 : autoBase;
  const up = base * GUARD_UP, down = base * GUARD_DOWN;
  const clamp = (v) => Math.min(spendSet * GUARD_MAX, Math.max(spendSet * GUARD_MIN, v));
  // レールに当たる資産額（生活費が同じままなら、資産がここまで動くと判定が変わる）
  const cutAt = up > 0 ? excess / up : 0;      // これを下回ると減額
  const raiseAt = down > 0 ? excess / down : 0;  // これを上回ると増額
  let verdict = "keep";
  if (base > 0 && rate > up) verdict = "cut";
  else if (base > 0 && rate < down) verdict = "raise";
  const next = verdict === "cut" ? clamp(spend * (1 - GUARD_STEP))
             : verdict === "raise" ? clamp(spend * (1 + GUARD_STEP)) : spend;
  return { assets, spendSet, spend, pension, excess, rate, base, up, down,
           cutAt, raiseAt, verdict, next, saved: p.guard_base_rate > 0,
           checked: p.guard_checked || "", retired: a.lp.age0 >= a.lp.retire };
}

function renderGuardStatus(a, curPath, yen, man) {
  const g = guardState(a, curPath);
  if (!(g.base > 0) || !(g.assets > 0)) {
    return `<h3 class="strat-h">🚦 ガードレールの現在地</h3>
      <p class="empty-watch">設定で生活費・年金・退職年齢を入力すると、いまの引出率と
        レールまでの余裕を表示します。</p>`;
  }
  const pct = (v) => (v * 100).toFixed(2) + "%";
  // 目盛りは下のレールの0.8倍〜上のレールの1.2倍を描く
  const lo = g.down * 0.8, hi = g.up * 1.2;
  const at = (v) => Math.min(100, Math.max(0, (v - lo) / (hi - lo) * 100));
  const tone = g.verdict === "cut" ? "down" : g.verdict === "raise" ? "up" : "";
  const label = g.verdict === "cut" ? "⬇️ 減額の水準です"
              : g.verdict === "raise" ? "⬆️ 増額できる水準です" : "✅ 帯の中（据え置き）";
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const dueYear = g.checked ? Number(g.checked.slice(0, 4)) + 1 : null;
  const due = dueYear ? `${dueYear}年${g.checked.slice(5, 7)}月` : "未記録";
  const overdue = dueYear && (now.getFullYear() > dueYear
    || (now.getFullYear() === dueYear && now.getMonth() + 1 >= Number(g.checked.slice(5, 7))));

  return `
    <h3 class="strat-h">🚦 ガードレールの現在地</h3>
    ${g.retired ? "" : `<p class="hint">※ まだ退職前なので、これは<strong>いまの資産で退職した場合</strong>の目安です。
      基準は退職時に決め直してください。</p>`}
    <div class="stat-row">
      <div class="stat-tile"><span class="stat-label">基準の引出率</span>
        <b class="stat-value">${pct(g.base)}</b>
        <span class="stat-sub">${g.saved ? "記録済み" : "いまの設定から自動計算"}</span></div>
      <div class="stat-tile"><span class="stat-label">いまの引出率</span>
        <b class="stat-value ${tone}">${pct(g.rate)}</b>
        <span class="stat-sub">（${man(g.spend)}−${man(g.pension)}）×12 ÷ ${man(g.assets)}</span></div>
      <div class="stat-tile"><span class="stat-label">判定</span>
        <b class="stat-value ${tone}">${label}</b>
        <span class="stat-sub">${g.verdict === "keep" ? "生活費はそのまま"
          : `生活費 ${man(g.spend)} → ${man(g.next)}`}</span></div>
    </div>

    <div class="guard-rail">
      <div class="guard-bar">
        <span class="guard-zone guard-zone-lo" style="width:${at(g.down)}%"></span>
        <span class="guard-zone guard-zone-ok" style="left:${at(g.down)}%;width:${at(g.up) - at(g.down)}%"></span>
        <span class="guard-zone guard-zone-hi" style="left:${at(g.up)}%;width:${100 - at(g.up)}%"></span>
        <span class="guard-tick" style="left:${at(g.base)}%"></span>
        <span class="guard-now ${tone}" style="left:${at(g.rate)}%"></span>
      </div>
      <div class="guard-marks">
        <span style="left:${at(g.down)}%">下のレール ${pct(g.down)}</span>
        <span style="left:${at(g.base)}%">基準 ${pct(g.base)}</span>
        <span style="left:${at(g.up)}%">上のレール ${pct(g.up)}</span>
      </div>
    </div>

    <div class="csv-table-wrap"><table class="csv-table strat-table">
      <thead><tr><th>次に判定が変わるのは</th><th class="num">総資産がこの額になったとき</th>
        <th class="num">いまとの差</th><th class="num">そのときの生活費</th></tr></thead>
      <tbody>
        <tr><td>⬇️ 減額（生活費を10%下げる）</td>
          <td class="num">${yen(g.cutAt)}</td>
          <td class="num ${g.assets > g.cutAt ? "" : "down"}">${g.assets > g.cutAt
            ? `あと ${man(g.assets - g.cutAt)} 減ると` : "すでに超えています"}</td>
          <td class="num">${man(Math.min(g.spendSet * GUARD_MAX, Math.max(g.spendSet * GUARD_MIN, g.spend * 0.9)))}/月</td></tr>
        <tr><td>⬆️ 増額（生活費を10%上げる）</td>
          <td class="num">${yen(g.raiseAt)}</td>
          <td class="num ${g.assets < g.raiseAt ? "" : "up"}">${g.assets < g.raiseAt
            ? `あと ${man(g.raiseAt - g.assets)} 増えると` : "すでに超えています"}</td>
          <td class="num">${man(Math.min(g.spendSet * GUARD_MAX, Math.max(g.spendSet * GUARD_MIN, g.spend * 1.1)))}/月</td></tr>
      </tbody></table></div>

    <div class="guard-actions">
      <button id="guard-base-set" type="button" class="ghost-btn">基準をいまの資産で決め直す</button>
      <button id="guard-apply" type="button" class="ghost-btn">
        ${g.verdict === "keep" ? "見直したことを記録する（生活費は据え置き）"
          : `判定を反映する（生活費を ${man(g.next)} にする）`}</button>
      <span class="guard-checked ${overdue ? "guard-due" : ""}">前回の見直し ${g.checked || "未記録"}
        ／ 次回 ${due}${overdue ? "（時期です）" : ""}</span>
    </div>
    <p class="hint">生活費の増減は<strong>年1回だけ</strong>判定します。相場が動くたびに追随すると、
      生活費が落ち着かないためです。生活費は設定額の
      <strong>${Math.round(GUARD_MIN * 100)}%〜${Math.round(GUARD_MAX * 100)}%</strong>
      （${man(g.spendSet * GUARD_MIN)}〜${man(g.spendSet * GUARD_MAX)}）の範囲を超えません。
      <span class="hint-sub">※ 引出率の分母は<strong>税引後の総資産</strong>（投信・株＋現金＋債券）で、
      資産推移グラフの現在値と同じです。年金は受給開始前でも式に含めます
      （長い目で見た水準を基準にするため。受給開始までは実際にはこの率より多く取り崩します）。
      判定式は①②の試算と同じものを使っています。</span></p>`;
}

// ② 値動きのブレを含めた成功確率。
// 選んでいる組み合わせの結果に加えて、「残す割合を変えたら」「方法を変えたら」を
// それぞれ1本の表にして畳んでおく。すべて同じ乱数列で走らせるので差は前提の違いだけ。
function renderSuccess(a, cur, rm, cp, path, man, yen, ageOf) {
  if (!portfolioRisk) {
    return `<h3 class="strat-h">② 値動きのブレを含めた成功確率</h3>
      <p class="empty-watch">変動率を推定できませんでした。銘柄一覧で<strong>口数</strong>を入力し、
        価格が取得できている状態にすると、実際の値動きから成功確率を計算します。</p>`;
  }
  const N = 400;
  // 100歳までの月数ぶん用意する。固定長にすると、若い人ほど末尾が
  // 「同じ乱数の使い回し」になってブレが消えてしまう。
  const HORIZON = Math.max(1, Math.round((100 - a.lp.age0) * 12)) + 2;
  // 種を固定しておく。すべての案が同じ乱数列を共有するので、案どうしの差は前提の違いだけ。
  // 描き直しても同じ結果になるため、設定を変えたときの変化だけを見ればよくなる。
  const rand = makeRng(20260807);
  const draws = [];
  for (let i = 0; i < N; i++) {
    const row = new Float64Array(HORIZON + 2);
    for (let m = 0; m < row.length; m++) row[m] = normFrom(rand);
    draws.push(row);
  }
  const flatSd = (portfolioRisk.annual_vol / 100) / Math.sqrt(12);
  // 集中銘柄があるときは、残す割合に応じた合成の変動率を月ごとに使う
  const sdAt = (target, m) => (cp ? cp.volAt(cp.wAt(target, m)) / Math.sqrt(12) : flatSd);

  const run = (method, target) => {
    const opts = cp ? cp.optsFor(target) : {};
    const det = path(Object.assign({ method }, opts));
    let ok = 0; const ends = [];
    for (let i = 0; i < N; i++) {
      const z = draws[i];
      const p = runPath(Object.assign({ method }, opts, {
        ret: (m) => rm + z[Math.min(m, HORIZON + 1)] * sdAt(target, m),
      }));
      if (p.depletionAge < 0) ok++;
      ends.push(p.endBal);
    }
    ends.sort((x, y) => x - y);
    return { det, rate: Math.round(ok / N * 100), ends,
             pct: (q) => ends[Math.min(ends.length - 1, Math.floor(ends.length * q))] };
  };

  const here = run(cur, cp ? cp.target : 1);
  // AI相談では「他の割合ならどうか」も要る。表には出さないが同じ乱数列で回せるようにしておく
  lastStrategyRun = run;
  lastStrategyCp = cp;
  const cls = (r) => (r >= 90 ? "up" : r >= 70 ? "warn" : "down");

  // 残す割合は設定タブで決めるので、ここでは「いまの設定だとどうなるか」だけを説明する
  const keepNote = cp ? `
    <p class="hint">${escapeHtml(cp.cc.name)}は資産の ${cp.cc.share}% を占めています。
      設定の<strong>「集中している銘柄を残す割合」＝${cp.label(cp.target)}</strong>で計算しており、
      この銘柄の変動率は年<strong>${cp.cc.vol}％</strong>、それ以外の保有は年
      <strong>${cp.cc.rest_vol}％</strong>（相関 ${cp.cc.corr}）です。
      残す割合に応じた<strong>合成の変動率 ${(cp.volAt(cp.wAt(cp.target, 0)) * 100).toFixed(1)}％</strong>
      （いま）でブレを作っています。
      ${cp.reachOf(cp.target) > 0
        ? `その水準まで下げるのに <strong>約${cp.reachOf(cp.target).toFixed(1)}年</strong>かかる計算です。` : ""}
      <span class="hint-sub">売却は「使う」のではなく<strong>同額を分散資産に買い直す</strong>前提で、
      NISAの残り枠 ${yen(cp.room)} を先に使います。
      <strong>勤務先の株なら、給与・退職金も同じ会社に依存している</strong>ぶん、
      ここに出るより実質のリスクは大きくなります（在職中はさらに抑えめが無難）。
      1銘柄・自社株の一般的な目安は金融資産の5〜10%以内とされます。</span></p>` : "";

  // 取り崩し方法を振る（残す割合は選択中のまま）
  const methods = ["fixed", "percent", "guardrail"];
  const keepT = cp ? cp.target : 1;
  const mRows = methods.map((mth) => ({ mth, r: mth === cur ? here : run(mth, keepT) }));
  const methodTable = `
    <details class="plan-help">
      <summary>取り崩し方法を変えると${cp
        ? `（${escapeHtml(cp.cc.name)}は「${cp.label(cp.target)}」のまま）` : ""}</summary>
      <div class="csv-table-wrap"><table class="csv-table strat-table">
        <thead><tr><th>方法</th><th class="num">資産寿命<br><small>（ブレなし）</small></th>
          <th class="num">尽きない<br>確率</th><th class="num">100歳時点<br>（中央値）</th>
          <th class="num">100歳時点<br>（下位10%）</th>
          <th class="num">生活費の下限<br><small>（今日の価値）</small></th></tr></thead>
        <tbody>${mRows.map(({ mth, r }) => `
          <tr class="${mth === cur ? "strat-current" : ""}">
            <td>${DRAW_LABELS[mth]}${mth === cur ? '<span class="strat-badge">設定中</span>' : ""}</td>
            <td class="num ${r.det.depletionAge > 0 ? "down" : "up"}">${ageOf(r.det)}</td>
            <td class="num ${cls(r.rate)}">${r.rate}%</td>
            <td class="num">${man(r.pct(0.5))}</td>
            <td class="num">${man(r.pct(0.1))}</td>
            <td class="num">${yen(r.det.minLiving)}/月</td>
          </tr>`).join("")}</tbody></table></div>
      <p class="hint">定率は枯渇しにくい代わりに<strong>生活費が下がりうる</strong>点に注目してください。
        「生活費の下限」が設定した生活費より低ければ、その分だけ生活水準を落とす前提の計算です。
        方法は<strong>設定タブ</strong>で変更します。</p>
    </details>`;

  // 決め打ちの暴落シナリオ（ブレの平均ではなく、最悪のタイミングを見る）
  const retireM = Math.max(1, Math.round((a.retireAge - a.lp.age0) * 12));
  const scenarios = [
    { name: "退職直後に −30%", ret: (m) => (m === retireM ? -0.30 : rm) },
    { name: "退職直後に −50%", ret: (m) => (m === retireM ? -0.50 : rm) },
    { name: "退職後の5年が不調（年−3%）",
      ret: (m) => (m >= retireM && m < retireM + 60 ? projMonthlyRate(-0.03) : rm) },
  ];
  const scList = [{ name: "想定どおり（ブレなし）", p: here.det }]
    .concat(scenarios.map((s) => ({ name: s.name, p: path({ method: cur, ret: s.ret }) })));
  const scRows = scList.map(({ name, p }) => `<tr>
      <td>${escapeHtml(name)}</td>
      <td class="num ${p.depletionAge > 0 ? "down" : "up"}">${ageOf(p)}</td>
      <td class="num">${p.depletionAge > 0 ? "—" : yen(p.endBal)}</td>
    </tr>`).join("");

  // AIに渡す事実だけを控えておく（画面に出している数字と必ず一致させるため、
  // サーバで計算し直すのではなくここで作った値をそのまま送る）。
  const p = planData.plan || {};
  lastStrategyFacts = {
    前提: {
      現在年齢: a.lp.age0, 退職年齢: a.lp.retire, 年金開始年齢: a.lp.penAge,
      年金_月額: Math.round(a.lp.pension), 生活費_月額: Math.round(a.lp.spend),
      // 率は「%の数値」で統一する。小数(0.02)と%(4)が混在すると桁を取り違えられる
      インフレ率_パーセント: Number((a.lp.infl * 100).toFixed(2)),
      想定年利_パーセント: Number((a.baseRate * 100).toFixed(2)),
      年金の改定率_パーセント: Number(((a.lp.penGrow != null ? a.lp.penGrow : a.lp.infl) * 100).toFixed(2)),
      取り崩し方法: DRAW_LABELS[cur],
      定率のときの率_パーセント: p.draw_rate != null ? p.draw_rate : 4,
      生活防衛資金_円: Math.round(a.emFloor || 0),
      現金_円: Math.round(a.cash0 || 0), 債券_円: Math.round(a.bonds0 || 0),
      運用資産_円: Math.round(a.cur || 0),
      売却順序: "NISA温存（特定口座から先に売る）",
      保有全体の変動率_年率パーセント: portfolioRisk.annual_vol,
      // 集中銘柄を減らす設定なら、実際に使ったのは合成した変動率のほう
      計算に使った変動率_年率パーセント: cp
        ? Number((cp.volAt(cp.wAt(cp.target, 0)) * 100).toFixed(1)) : portfolioRisk.annual_vol,
    },
    集中銘柄: cp ? {
      銘柄: cp.cc.name, 資産に占める割合_パーセント: cp.cc.share,
      含み益の割合_パーセント: Math.round(cp.gain * 100),
      この銘柄の変動率_年率パーセント: cp.cc.vol,
      それ以外の変動率_年率パーセント: cp.cc.rest_vol, 相関: cp.cc.corr,
      設定した方針: cp.label(cp.target),
      その水準まで下げるのにかかる年数: cp.reachOf(cp.target) >= 0
        ? Number(cp.reachOf(cp.target).toFixed(1)) : null,
      NISA生涯枠の残り: Math.round(cp.room),
    } : null,
    methods: mRows.map(({ mth, r }) => ({
      方法: DRAW_LABELS[mth], 設定中: mth === cur,
      資産寿命: r.det.depletionAge > 0 ? `${Math.floor(r.det.depletionAge)}歳で枯渇` : "100歳まで持続",
      尽きない確率: r.rate,
      百歳時点_中央値: Math.round(r.pct(0.5)),
      百歳時点_下位10: Math.round(r.pct(0.1)),
      生活費の下限_月額: Math.round(r.det.minLiving),
      取り崩しで払う税_累計: Math.round(r.det.taxPaid),
    })),
    暴落シナリオ: scList.map(({ name, p: q }) => ({
      シナリオ: name,
      資産寿命: q.depletionAge > 0 ? `${Math.floor(q.depletionAge)}歳で枯渇` : "100歳まで持続",
      百歳時点: q.depletionAge > 0 ? 0 : Math.round(q.endBal),
    })),
    試行回数: N,
  };
  renderStrategyAiButton();

  return `
    <h3 class="strat-h">② 値動きのブレを含めた成功確率（${DRAW_LABELS[cur]}${cp ? "・" + cp.label(cp.target) : ""}・${N}回）</h3>
    <div class="stat-row">
      <div class="stat-tile"><span class="stat-label">100歳まで尽きない確率</span>
        <b class="stat-value ${cls(here.rate)}">${here.rate}%</b></div>
      <div class="stat-tile"><span class="stat-label">100歳時点（中央値）</span>
        <b class="stat-value">${man(here.pct(0.5))}</b></div>
      <div class="stat-tile"><span class="stat-label">100歳時点（下位10%）</span>
        <b class="stat-value">${man(here.pct(0.1))}</b></div>
      <div class="stat-tile"><span class="stat-label">参考：ブレなしの場合</span>
        <b class="stat-value">${here.det.depletionAge > 0 ? ageOf(here.det) : man(here.det.endBal)}</b>
        <span class="stat-sub">資産推移グラフと同じ1本道</span></div>
    </div>
    <p class="hint">中央値が<strong>ブレなしより低い</strong>のは計算違いではありません。
      値動きは掛け算で効くため、平均リターンが同じでも<strong>ブレがあるほど中央値は下がります</strong>
      （＋50%と−50%を繰り返すと平均0%でも資産は減ります）。
      さらに取り崩し中は<strong>下がった年にも売る</strong>ので、その差が広がります。
      よく伸びた一部のケースが平均を押し上げる一方、半数はそこまで伸びない、という形です。
      <span class="hint-sub">※ 変動率が年10%なら中央値はブレなしの約8割、14%なら約6割、18%なら約5割が目安です。
      グラフは「平均どおりに進んだ1本道」、こちらは「${N}通り試した真ん中」を見ています。
      どちらが正しいというより、<strong>グラフは目標の管理に、中央値と下位10%は備えの確認に</strong>使ってください。</span></p>
    <p class="hint">平均リターンは他の項目と揃えて<strong>設定の想定年利 ${(a.baseRate * 100).toFixed(2)}％</strong>
      を使い、ブレ幅だけを実際の保有から推定しています（直近${portfolioRisk.months}ヶ月）。
      ${cp
        ? `いまの残す割合では<strong>変動率 ${(cp.volAt(cp.wAt(cp.target, 0)) * 100).toFixed(1)}％</strong>
           （保有全体では ${portfolioRisk.annual_vol}％。${escapeHtml(cp.cc.name)}を減らすぶん小さくなります）。`
        : `<strong>変動率 ${portfolioRisk.annual_vol}％</strong>としています。`}
      <span class="hint-sub">※ 同じ期間の実績リターンは年率 ${portfolioRisk.annual_return}％ですが、
      直近の相場に引きずられるため平均には使いません。すべての条件を<strong>同じ乱数列</strong>で
      走らせているので、表の行どうしの差は前提の違いだけによるものです。
      乱数の種は固定しているので、<strong>同じ前提なら何度計算しても同じ結果</strong>になります
      （変化したときは前提が変わったときだけです）。${N}回の試行なので、
      成功確率の絶対値には数pt程度の誤差が残ります。</span></p>
    ${keepNote}
    ${methodTable}
    <details class="plan-help">
      <summary>暴落が特定の時期に来た場合（決め打ち）</summary>
      <div class="csv-table-wrap"><table class="csv-table strat-table">
        <thead><tr><th>シナリオ</th><th class="num">資産寿命</th><th class="num">100歳時点</th></tr></thead>
        <tbody>${scRows}</tbody></table></div>
      <p class="hint">同じ平均リターンでも、<strong>暴落が来る時期</strong>で結果は大きく変わります。
        退職直後の下落に耐えられるかが、取り崩し計画のいちばんの勘所です。
        上の成功確率は毎月ランダムに揺らした平均像なので、この表と合わせて見てください。</p>
    </details>`;
}

// ── 取り崩し戦略のAI相談 ────────────────────────────────────────────
// 試算はブラウザ側で終わっているので、AIには「画面に出ている数字」だけを渡す。
// サーバで計算し直すと画面と食い違うため、あえて事実を送る形にしている。
let lastConcPlan = null;      // ①②が使った集中銘柄の売却計画（前提チップと揃えるため）
let lastStrategyFacts = null;
let lastStrategyRun = null;   // (方法, 残す割合) => 試算結果。②と同じ乱数列で回る
let lastStrategyCp = null;    // 集中銘柄の売却計画（無ければ null）

function renderStrategyAiButton() {
  const b = $("strategy-ai-run");
  if (!b) return;
  b.hidden = (aiSettings.ai_model === "off") || !lastStrategyFacts;
}

// 集中銘柄をどれだけ残すかは、いまの設定ぶんしか画面に出していない。
// それだけを渡すとAIは比べようがなく、設定を変えるたびに結論が動いてしまうので、
// 相談のときだけ他の割合も同じ乱数列で試算して、横並びの材料として渡す。
function buildStrategyAiFacts() {
  const facts = Object.assign({}, lastStrategyFacts);
  const cp = lastStrategyCp;
  if (!cp || !lastStrategyRun) return facts;
  const cur = (planData.plan || {}).draw_method || "fixed";
  const targets = [0, 0.05, 0.10, 0.15, 0.20, 1];
  if (!targets.includes(cp.target)) targets.push(cp.target);
  targets.sort((x, y) => x - y);
  facts.残す割合ごとの結果 = targets.map((t) => {
    const r = lastStrategyRun(cur, t);
    return {
      方針: cp.label(t),
      いまの設定: Math.abs(t - cp.target) < 1e-9,
      全体の変動率: Number((cp.volAt(t >= cp.share ? cp.share : t) * 100).toFixed(1)),
      その水準まで下げるのにかかる年数: cp.reachOf(t) >= 0 ? Number(cp.reachOf(t).toFixed(1)) : null,
      尽きない確率: r.rate,
      百歳時点_中央値: Math.round(r.pct(0.5)),
      百歳時点_下位10: Math.round(r.pct(0.1)),
      組み替えで払う税: Math.round(r.det.restructTax || 0),
    };
  });
  return facts;
}

async function loadStrategyAi() {
  const box = $("strategy-ai");
  if (!box || !lastStrategyFacts) return;
  box.hidden = false;
  box.innerHTML = '<div class="ai-head"><span class="ai-ico">🤖</span> 方針ごとの試算をそろえています… ⏳</div>';
  // 追加の試算は重いので、先に画面を描き直してから走らせる
  await new Promise((res) => setTimeout(res, 30));
  const facts = buildStrategyAiFacts();
  box.innerHTML = '<div class="ai-head"><span class="ai-ico">🤖</span> AIが方針を検討中… ⏳</div>';
  try {
    const r = await fetch("/api/ai-strategy", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(facts),
    });
    const d = await r.json();
    if (!d.ok) {
      box.innerHTML = `<div class="ai-head ai-err"><span class="ai-ico">🤖</span> ${escapeHtml(d.error || "AIに相談できませんでした")}</div>`;
      return;
    }
    renderStrategyAi(d.advice, d.model);
  } catch (_) {
    box.innerHTML = '<div class="ai-head ai-err"><span class="ai-ico">🤖</span> AI呼び出しに失敗しました</div>';
  }
}

function renderStrategyAi(advice, model) {
  const box = $("strategy-ai");
  if (!box) return;
  const v = advice || {};
  const list = (xs) => (xs || []).map((x) => `<li>${escapeHtml(String(x))}</li>`).join("");
  let html = `<div class="ai-head"><span class="ai-ico">🤖</span><b>取り崩し方針の相談</b>`
    + `<span class="ai-model">${modelLabel(model)}</span></div>`;
  if (v.recommendation) {
    html += `<div class="ai-block"><div class="ai-block-t">おすすめの方針</div>`
      + `<div class="ai-block-b">${escapeHtml(v.recommendation)}</div></div>`;
  }
  if ((v.why || []).length) {
    html += `<div class="ai-block"><div class="ai-block-t">その理由</div>`
      + `<ul class="ai-block-b ai-list">${list(v.why)}</ul></div>`;
  }
  if (v.tradeoff) {
    html += `<div class="ai-block"><div class="ai-block-t">逆を選んだ場合</div>`
      + `<div class="ai-block-b">${escapeHtml(v.tradeoff)}</div></div>`;
  }
  if ((v.watch || []).length) {
    html += `<div class="ai-block"><div class="ai-block-t">見落としやすい点</div>`
      + `<ul class="ai-block-b ai-list">${list(v.watch)}</ul></div>`;
  }
  html += '<div class="ai-foot">※ 画面に出ている試算値だけをもとにしたコメントです。'
    + '前提を変えれば結論も変わります。投資助言ではありません。</div>';
  box.innerHTML = html;
  box.hidden = false;
}

// 集中している銘柄の「残す割合」ごとの売却計画。無ければ null。
// 決定的な計算では売れば税を払うぶん不利になるので、差が出るのは値動きのブレを入れたとき。
// 残す割合 w に応じた合成の変動率
//   σ = √( w²σ銘柄² + (1-w)²σその他² + 2w(1-w)ρσ銘柄σその他 )
// を月ごとに使う。
function concentrationPlan(a, rm) {
  const cc = portfolioRisk && portfolioRisk.concentration;
  if (!cc || cc.share < CONC_MIN_SHARE || cc.account_type === "nisa") return null;

  const tRate = a.split ? a.split.taxRate : a.taxRate;
  const gain = cc.gain_frac || 0;
  const keep = Math.max(0.01, 1 - gain * tRate);       // 1円売って手元に残る割合
  const room = a.split ? Math.max(0, a.split.nisaRoom) : 0;
  const monthCap = NISA_YEAR_CAP / 12;
  const nisaMonths = room > 0 ? Math.ceil(room / monthCap) : 0;
  const nisaGross = nisaMonths > 0 ? (room / nisaMonths) / keep : 0;
  const HORIZON = Math.max(1, Math.round((100 - a.lp.age0) * 12)) + 2;

  // 比率の分母になる運用資産の推移は、組み替えなしの経路で代用する。
  // 集中銘柄の評価額も、比率(share)から投影の土俵に載せ直す
  // （/api/portfolio-risk は価格×口数、投影は評価額の履歴が元で桁が食い違いうるため）。
  const pool0 = runPath({});
  const poolAt = (m) => {
    const p = pool0.pts[Math.min(m, pool0.pts.length - 1)];
    return p && p.fund > 0 ? p.fund : 1;
  };
  const share = cc.share / 100;
  const concV = share * poolAt(0);

  // target … 残しておきたい割合（0＝全部売る、1＝現状のまま）
  // これからのNISA枠は、どの案でも集中銘柄を売って埋める（いまの方針どおり）。
  // そうしないと「多く残す案ほどNISAを使えない」という別の差が混ざってしまう。
  const cache = new Map();
  const schedule = (target) => {
    if (cache.has(target)) return cache.get(target);
    const sell = [], bal = [];
    let s = concV;
    for (let m = 0; m <= HORIZON; m++) {
      bal.push(s);
      const fill = m < nisaMonths ? Math.min(s, nisaGross) : 0;
      const want = target >= 1 ? Infinity : target * poolAt(m);
      const trim = Math.max(0, Math.min(s - want, monthCap / keep));
      const g = Math.max(fill, trim);
      sell.push(g);
      s = Math.max(0, (s - g) * (1 + rm));
    }
    const r = { sell, bal };
    cache.set(target, r);
    return r;
  };
  // 枠を埋めるだけで無くなる規模なら、どの割合を選んでも同じ計画になる
  if ((schedule(1).bal[Math.min(nisaMonths + 1, HORIZON)] || 0) <= 1) return null;

  const ss = (cc.vol || 0) / 100, sr = (cc.rest_vol || 0) / 100, rho = cc.corr || 0;
  // 設定タブの「集中している銘柄を残す割合（%）」。100（既定）は売らずに現状のまま。
  const pctSet = (planData.plan || {}).conc_keep;
  const target = Math.min(1, Math.max(0, (pctSet != null ? pctSet : 100) / 100));
  return {
    cc, room, gain, share, poolAt, target,
    label: (t) => (t >= share ? "現状のまま持ち続ける"
      : t === 0 ? "全部売る" : `${Math.round(t * 100)}% 残す`),
    volAt: (w) => Math.sqrt(Math.max(0,
      w * w * ss * ss + (1 - w) * (1 - w) * sr * sr + 2 * w * (1 - w) * rho * ss * sr)),
    wAt: (target, m) => Math.max(0, Math.min(1,
      (schedule(target).bal[Math.min(m, HORIZON)] || 0) / poolAt(m))),
    optsFor: (target) => ({ restructure: (m) => schedule(target).sell[m] || 0,
                            restructureGain: gain }),
    reachOf: (target) => {
      const sch = schedule(target);
      for (let m = 0; m <= HORIZON; m++) {
        const w = (sch.bal[m] || 0) / poolAt(m);
        if (w <= (target >= 1 ? 1 : target) + 0.005) return m / 12;
      }
      return -1;
    },
  };
}

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
    await refreshPlanData();   // 合計と資産プランのグラフを再計算
  } catch (_) { toast("保存に失敗しました", "error"); }
}

// /api/plan を取り直して、分配金カードと（表示中なら）資産プラン画面を描き直す
async function refreshPlanData() {
  if (!(await fetchPlanData())) return;
  renderDividends();
  if (currentView === "plan") { renderPlanGoal(); renderCashAdvice(); renderPlanHistory(); }
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
    // 年金の改定率＝インフレ率 −スライド調整。公的年金はマクロ経済スライドにより
    // 物価上昇をそのまま反映しないため、生活費と同率で増やすと楽観的になる。
    // 名目額は下がらない仕組みなので、マイナスにはしない（0で下限）。
    penGrow: Math.max(0, (p.inflation || 0) / 100
                        - (p.pension_slide != null ? p.pension_slide : 0.4) / 100),
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
// opts で取り崩し方法と値動きを差し替えられる：
//   method  … "fixed"（定額・既定）/ "percent"（定率）/ "guardrail"（ガードレール）
//   pctRate … 定率のときの年率（0.04 = 毎年 残高の4%）
//   ret(m)  … その月のリターンを返す関数。省略時は想定年利から一定。
//             暴落シナリオやモンテカルロは、ここに関数を渡して実現する。
//   split   … 運用資産の口座別内訳 {taxV,taxB,nisaV,nisaB,taxRate,nisaRoom}。
//             省略時は全額を特定口座（実効税率）として扱う。
//   guardSpend     … ガードレールで実際に採用している生活費（月額）。省略時は設定の生活費。
//   guardBaseRate  … ガードレールの基準の引出率（小数）。省略時は退職時点から決める。
function buildLifePath(cur, lastDate, monthly, annual, lp, cash0, bonds0, basis0, tax, emFloor, div, opts) {
  const o = opts || {};
  const method = o.method || "fixed";
  const pctRate = (o.pctRate != null) ? o.pctRate : 0.04;
  const rmConst = projMonthlyRate(annual);
  const retOf = (typeof o.ret === "function") ? o.ret : () => rmConst;
  const t = tax || 0;
  const floor = emFloor || 0;   // ①生活防衛資金：緊急時用に現金として残す下限
  const dGrossM = (div && div.grossY ? div.grossY : 0) / 12;   // 受取分配（税引前・月率）
  const dNetM = (div && div.netY ? div.netY : 0) / 12;         // 受取分配（税引後・月率）
  let cash = cash0 || 0, bonds = bonds0 || 0;    // 現金・債券：据え置き・非課税
  // 生活防衛資金の補充で売った投信・債券の代金はいったん現金に入るため、そのまま使うと
  // 「現金から取り崩した」ように見えてしまう。元をたどれるようにして本来の出どころで数える。
  // （分配金はその月に受け取った分だけを分配金として数える。月をまたいで貯まった分は
  //   もう手元の現金なので「現金」として扱う。）
  let cashFromFund = 0, cashFromBonds = 0;
  // 運用資産は「特定口座（課税）」と「NISA（非課税）」に分けて持つ。
  // どちらから先に売るかで生涯の税額が変わるため、口座ごとに評価額と取得原価を追う。
  // opts.split が無いときは全額を特定口座扱い＋実効税率とし、従来と同じ挙動になる。
  const sp = o.split || null;
  let taxV = sp ? (sp.taxV || 0) : cur;                            // 特定口座の評価額
  let taxB = sp ? (sp.taxB || 0) : ((basis0 != null) ? basis0 : cur);   // 同・取得原価
  let nisaV = sp ? (sp.nisaV || 0) : 0;                            // NISAの評価額（非課税）
  let nisaB = sp ? (sp.nisaB || 0) : 0;
  let nisaRoom = sp ? Math.max(0, sp.nisaRoom || 0) : 0;           // NISA生涯投資枠の残り（簿価）
  const tRate = sp ? (sp.taxRate || 0) : t;   // 特定口座にかかる税率（NISAは非課税）
  let taxPaid = 0;                            // 取り崩しで払う譲渡益税の累計

  const fundV = () => taxV + nisaV;           // 運用資産の合計（税引前）
  // 特定口座を「手取りで need 円」になるまで売る。含み益に課税されるぶん多めに売る必要がある。
  const sellTaxable = (need) => {
    if (!(need > 0) || !(taxV > 0)) return 0;
    const gainFr = Math.max(0, taxV - taxB) / taxV;    // 含み益の割合
    const keep = 1 - gainFr * tRate;                   // 1円売って手元に残る割合
    const sell = Math.min(taxV, keep > 0 ? need / keep : need);
    taxB -= sell * (taxB / taxV);
    taxV -= sell;
    if (taxV < 0) taxV = 0;
    if (taxB < 0) taxB = 0;
    const got = sell * keep;
    taxPaid += sell - got;
    return got;
  };
  // NISAは非課税なので、売った額がそのまま手取りになる。
  const sellNisa = (need) => {
    if (!(need > 0) || !(nisaV > 0)) return 0;
    const sell = Math.min(nisaV, need);
    nisaB -= sell * (nisaB / nisaV);
    nisaV -= sell;
    if (nisaV < 0) nisaV = 0;
    if (nisaB < 0) nisaB = 0;
    return sell;
  };
  // 運用資産から「手取り need 円」を取り崩す。手取りで得られた額を返す。
  // 順序は NISA温存（課税される特定口座から先に売り、非課税のNISAを最後まで運用する）で固定。
  // 特定口座は税引後では想定利回りより遅く増えるため、先に使い切るのが生涯の税負担が最も軽い。
  const sellFund = (need) => {
    if (!(need > 0)) return 0;
    const got = sellTaxable(need);
    return got + sellNisa(need - got);
  };
  // 投信の税引後評価額（いま全部売ったら手元に残る額）。NISA分は課税されない。
  const fundAT = () => (taxV - Math.max(0, taxV - taxB) * tRate) + nisaV;
  // 口座の組み替え：特定口座の一部を売って、そのまま買い直す（集中銘柄→分散資産）。
  // 生活費に使うわけではないので資産は市場に残るが、売った時点で含み益に課税されるため
  // 税のぶんだけ運用資産が減る。代わりに取得原価は買値まで上がるので、以後の税は軽くなる。
  // 買い直し先はNISAの枠が残っていればNISA（非課税）、無ければ特定口座。
  let nisaMonthLeft = 0;          // その月にNISAへ入れられる残り（年360万を12等分）
  let restructTax = 0;            // 組み替えで払った税の累計
  // gainOverride … 売るのが特定口座の平均ではなく特定の銘柄のとき、その含み益の割合。
  //                 集中銘柄は口座平均より含み益が大きいことが多く、税額が変わるため。
  const restructure = (gross, gainOverride) => {
    if (!(gross > 0) || !(taxV > 0)) return;
    const sell = Math.min(taxV, gross);
    const gainFr = (gainOverride != null && gainOverride >= 0 && gainOverride <= 1)
      ? gainOverride : Math.max(0, taxV - taxB) / taxV;
    const paid = sell * gainFr * tRate;
    taxB -= Math.min(taxB, sell * (1 - gainFr));
    taxV -= sell;
    if (taxV < 0) taxV = 0;
    if (taxB < 0) taxB = 0;
    const net = sell - paid;
    const toNisa = Math.min(net, nisaRoom, nisaMonthLeft);
    if (toNisa > 0) {
      nisaV += toNisa; nisaB += toNisa; nisaRoom -= toNisa; nisaMonthLeft -= toNisa;
    }
    const toTax = net - toNisa;
    if (toTax > 0) { taxV += toTax; taxB += toTax; }
    restructTax += paid;
    taxPaid += paid;
  };
  const snap = (age, dt) => {
    const fa = fundAT();
    return { age, date: dt, cash: Math.round(cash), bonds: Math.round(bonds),
             fund: Math.round(fa), v: Math.round(fa + cash + bonds) };
  };
  const pts = [snap(lp.age0, lastDate)];
  let depletionAge = -1, penStartAge = -1, retireBal = null;
  // 生活水準の記録：その月に使える額（年金＋取り崩し）を、今日の価値に直して見る。
  // 定率やガードレールは枯渇しにくい代わりに生活費が下がるので、そのトレードオフを測る。
  // ガードレールの出発点。実際に増減させた後なら、その額から続きを計算する
  // （画面の「現在地」と試算がズレないように、同じ値を使う）。
  let minLivingReal = Infinity, initRate = null;
  let guardSpend = (o.guardSpend > 0) ? o.guardSpend : lp.spend;
  const endMonths = Math.max(1, Math.round((100 - lp.age0) * 12));
  for (let m = 1; m <= endMonths; m++) {
    const age = lp.age0 + m / 12;
    const dt = addMonths(lastDate, m);
    // その月に資産から引き出す額と、その出どころ（現金・債券・投信）。
    // 年齢ごとの取り崩し額を出どころ別に表示するために記録する。金額は名目で、
    // 今日の価値に直すときは同じ月の inflNow で割る。
    let drawM = null, dCash = 0, dBonds = 0, dFund = 0, dDiv = 0, inflNow = 1;
    // その月に受け取った分配金・配当（税引後）のうち、まだ生活費に充てていない分。
    // 月をまたいで残った分はもう手元の現金なので、翌月以降は「現金」として数える。
    // （そうしないと積立期に貯まった分配金が退職直後にまとめて計上され、
    //   その年の受取額を超える「分配金」が表示されてしまう。）
    let divAvail = 0;
    let dPen = 0, dLiving = 0;   // 年金のうち生活費に充てた分／その月に使える生活費
    // 現金から amt を使う。分配金や売却代金に由来する分は、その出どころとして数える。
    const useCash = (amt) => {
      if (!(amt > 0)) return;
      let r = amt;
      const d = Math.min(divAvail, r); divAvail -= d; r -= d; dDiv += d;
      const f = Math.min(cashFromFund, r); cashFromFund -= f; r -= f; dFund += f;
      const b = Math.min(cashFromBonds, r); cashFromBonds -= b; r -= b; dBonds += b;
      dCash += r;
      cash -= amt;
    };
    const rM = retOf(m);                 // 運用資産のみ成長（原価は変わらない＝含み益が増える）
    taxV = Math.max(0, taxV * (1 + rM));
    nisaV = Math.max(0, nisaV * (1 + rM));
    // 受取分配金：運用資産から出て、税引後は現金へ（グラフの現金の帯に反映）。
    // 分配は売却ではないので譲渡益税はかからず、保有比率どおりに各口座から出る。
    if (dGrossM > 0 && fundV() > 0) {
      const net = fundV() * dNetM;               // 税引後（現金へ）
      cash += net; divAvail = net;               // 出どころは投信・株なので分配金として記録
      taxV -= taxV * dGrossM;
      nisaV -= nisaV * dGrossM;
    }
    // 集中銘柄の売り替えは、積立や取り崩しより先に済ませる（同じ年間枠を取り合うため）。
    nisaMonthLeft = NISA_YEAR_CAP / 12;
    if (typeof o.restructure === "function") restructure(o.restructure(m), o.restructureGain);
    if (age < lp.retire) {
      // 積立はNISAの生涯投資枠（簿価1,800万円・年360万円）を使い切るまでNISAへ。
      // 枠を超えたぶんは特定口座に積み立てる。
      const toNisa = Math.min(monthly, nisaRoom, nisaMonthLeft);
      if (toNisa > 0) { nisaV += toNisa; nisaB += toNisa; nisaRoom -= toNisa; nisaMonthLeft -= toNisa; }
      const toTax = monthly - toNisa;
      if (toTax > 0) { taxV += toTax; taxB += toTax; }
    } else {
      const bal = fundAT() + cash + bonds;         // 取り崩し前の総資産（税引後）
      const inflF = Math.pow(1 + lp.infl, m / 12);
      // 引出率は「今日の価値」で比べる。生活費(lp.spend/guardSpend)は今日の価値、
      // 資産(bal)は名目なので、資産側を inflF で割って基準を揃える。
      // （揃えないとインフレのぶんだけ引出率が低く見え、ガードレールが増額側に偏る）
      const balReal = inflF > 0 ? bal / inflF : bal;
      if (retireBal === null) {
        retireBal = bal;                           // 退職時点の税引後資産
        // ガードレールの基準：退職時点の「年間引出額 ÷ 資産」を初期の引出率とする
        // 基準の引出率。運用中に記録していればそれを使い、無ければ退職時点から決める
        initRate = (o.guardBaseRate > 0) ? o.guardBaseRate
          : (balReal > 0 ? Math.max(0, (lp.spend - lp.pension) * 12) / balReal : 0);
      }
      // 退職〜年金受給開始の間は年金なし（純粋に資産を取り崩す）
      // 年金は生活費とは別の率で増やす（マクロ経済スライドのぶん伸びが鈍い）
      const penF = Math.pow(1 + (lp.penGrow != null ? lp.penGrow : lp.infl), m / 12);
      const pen = (age >= lp.penAge) ? lp.pension * penF : 0;
      if (lp.penAge > lp.retire && age >= lp.penAge && penStartAge < 0) penStartAge = age;
      const floorNow = floor * inflF;    // ①生活防衛資金：インフレ調整後（実質額を維持）

      let w, living;   // w=資産から引き出す額 / living=その月に使える生活費（年金＋引出）
      if (method === "percent") {
        // 定率：毎年その時点の残高の pctRate を取り崩す。資産が減れば引出額も自動で減るため
        // 枯渇しにくい一方、生活費が変動する。
        w = Math.max(0, bal * pctRate / 12);
        living = w + pen;
      } else if (method === "guardrail") {
        // ガードレール：定額を基本にしつつ、引出率が初期水準から大きくずれた年に増減させる。
        // 年1回だけ見直し、生活費が下がりすぎ／上がりすぎないよう幅を制限する。
        if (m % 12 === 0 && initRate > 0 && balReal > 0) {
          const curRate = Math.max(0, (guardSpend - lp.pension) * 12) / balReal;
          if (curRate > initRate * 1.2) guardSpend *= 0.9;        // 資産の目減りが早い→減額
          else if (curRate < initRate * 0.8) guardSpend *= 1.1;   // 余裕がある→増額
          guardSpend = Math.min(lp.spend * 1.25, Math.max(lp.spend * 0.7, guardSpend));
        }
        living = guardSpend * inflF;
        w = living - pen;
      } else {
        // 定額：生活費をインフレ調整して毎月そのまま引き出す（従来どおり）
        living = lp.spend * inflF;
        w = living - pen;
      }
      if (inflF > 0) minLivingReal = Math.min(minLivingReal, living / inflF);
      inflNow = inflF > 0 ? inflF : 1;
      // 年金が生活費を上回る月は、超過分を運用に回すので「生活費に充てた年金」は生活費と同額。
      const want = Math.max(0, w);              // 資産から引き出したい額
      dPen = Math.max(0, living - want);        // 年金のうち生活費に充てた分
      if (w >= 0) {
        // 生活防衛資金(floorNow)は現金に残す。
        // 取り崩し順：現金(floorNow超)→債券→投信→（最後の手段）生活防衛資金
        let take = Math.min(Math.max(0, cash - floorNow), w); useCash(take); w -= take;
        if (w > 0) { take = Math.min(bonds, w); bonds -= take; w -= take; dBonds += take; }
        if (w > 0) { take = sellFund(w); w -= take; dFund += take; }
        if (w > 0) { take = Math.min(cash, w); useCash(take); w -= take; }   // 最後の手段：生活防衛資金
      } else {              // 年金＞生活費の余剰は運用資産へ（原価扱い）。退職後なので特定口座に積む
        taxV -= w; taxB -= w;
      }
      // 資産が尽きると要求額に届かないので、実際にまかなえた額を記録する。
      // これで 年金 ＋ 現金 ＋ 債券 ＋ 分配金 ＋ 投信 ＝ 生活費 が最後の月まで成り立つ。
      drawM = want - Math.max(0, w);
      dLiving = dPen + drawM;
      // 生活防衛資金をインフレ後の水準まで現金で維持（不足分を債券→投信から少しずつ補充）
      if (cash < floorNow) {
        let need = floorNow - cash;
        let take = Math.min(bonds, need); bonds -= take; cash += take; need -= take;
        cashFromBonds += take;                    // 現金に移っただけなので出どころは債券のまま
        if (need > 0) { const got = sellFund(need); cash += got; cashFromFund += got; }
      }
    }
    const pt = snap(age, dt);
    if (drawM != null) {
      pt.draw = drawM; pt.drawCash = dCash; pt.drawBonds = dBonds; pt.drawFund = dFund;
      pt.drawDiv = dDiv; pt.drawPen = dPen; pt.living = dLiving; pt.inflF = inflNow;
    }
    pts.push(pt);
    if (pt.v <= 0) { depletionAge = age; break; }
  }
  if (retireBal === null) retireBal = fundAT() + cash + bonds;
  const endBal = pts[pts.length - 1].v;
  // 最後まで売らずに残った特定口座の含み益にかかる税。まだ払っていないだけで、
  // 売れば（相続で引き継いでも）いずれ課税される。順序の比較ではこれを含めないと、
  // 「特定口座を売らなかった＝税0円」が有利に見えてしまう。
  const taxDeferred = Math.max(0, taxV - taxB) * tRate;
  return { pts, retireBal, penStartAge, depletionAge, endBal,
           taxPaid: Math.round(taxPaid), taxDeferred: Math.round(taxDeferred),
           taxTotal: Math.round(taxPaid + taxDeferred),
           restructTax: Math.round(restructTax),
           nisaRoomLeft: Math.round(nisaRoom),
           // 生活費の下限（今日の価値）。定額なら生活費そのもの、定率・ガードレールでは下がりうる
           minLiving: Number.isFinite(minLivingReal) ? Math.round(minLivingReal) : Math.round(lp.spend),
           method };
}

// NISAの生涯投資枠（簿価1,800万円）と年間投資枠（360万円）。積立の振り分けに使う。
const NISA_LIFETIME_CAP = 18000000;
const NISA_YEAR_CAP = 3600000;

// これ以上の比率を1銘柄が占めていたら「集中している」として比較を出す
const CONC_MIN_SHARE = 15;

// 指定した年齢の1年間に「資産から引き出す額」を集計する。
// 定率のように月ごとに変わる方式でも実態に合うよう、その歳の各月を平均して月額を出す。
// 枯渇後は月次データ自体が無いので null を返す（表では「—」と表示する）。
function drawAtAge(path, age) {
  const ms = (path.pts || []).filter((q) => q.draw != null && q.age >= age - 1e-6 && q.age < age + 1 - 1e-6);
  if (!ms.length) return null;
  // 出どころ（現金・債券・投信）ごとに月額・年額を、名目と今日の価値の両方で出す
  const of = (key) => {
    const month = ms.reduce((s, q) => s + (q[key] || 0), 0) / ms.length;
    const monthReal = ms.reduce((s, q) => s + (q[key] || 0) / (q.inflF || 1), 0) / ms.length;
    return { month, year: month * 12, monthReal, yearReal: monthReal * 12 };
  };
  return { total: of("draw"), cash: of("drawCash"), bonds: of("drawBonds"), fund: of("drawFund"),
           div: of("drawDiv"), pension: of("drawPen"), living: of("living") };
}

// 設定された取り崩し方法を buildLifePath のオプションにする
function drawOpts(extra) {
  const p = planData.plan || {};
  return Object.assign({
    method: p.draw_method || "fixed",
    pctRate: (p.draw_rate != null ? p.draw_rate : 4) / 100,
    // ガードレールを実際に運用して増減させている場合は、その値から試算を続ける
    guardSpend: p.guard_spend > 0 ? p.guard_spend : 0,
    guardBaseRate: p.guard_base_rate > 0 ? p.guard_base_rate / 100 : 0,
  }, extra || {});
}
const DRAW_LABELS = { fixed: "定額", percent: "定率", guardrail: "ガードレール" };

// 決まった種から同じ順番で乱数を作る（mulberry32）。
// Math.random() のままだと、同じ前提でも描き直すたびに成功確率が数pt動いてしまい、
// 「設定を変えたから変わったのか、乱数がぶれただけなのか」が区別できない。
// 取り崩し戦略のモンテカルロはこちらを使い、同じ前提なら必ず同じ結果にする。
function makeRng(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
// 標準正規分布（平均0・標準偏差1）を1つ返す（Box-Muller法）
function normFrom(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 正規分布の乱数（Box-Muller法）。モンテカルロで月々のリターンを揺らすのに使う。
function randNorm(mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
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
  // 運用資産を「特定口座（課税）」と「NISA（非課税）」に分けた内訳。
  // グラフの現在値(fundCur)に /api/plan の口座別の評価額・投資額を按分して当てはめる。
  const nisaV0 = planData.nisa_value || 0, nisaI0 = planData.nisa_invested || 0;
  const taxV0 = planData.taxable_value || 0, taxI0 = planData.taxable_invested || 0;
  const nisaFrac = tv > 0 ? Math.min(1, Math.max(0, nisaV0 / tv)) : 0;
  const split = {
    nisaV: fundCur * nisaFrac,
    nisaB: fundCur * nisaFrac * (nisaV0 > 0 ? nisaI0 / nisaV0 : 1),
    taxV: fundCur * (1 - nisaFrac),
    taxB: fundCur * (1 - nisaFrac) * (taxV0 > 0 ? taxI0 / taxV0 : 1),
    taxRate: baseTax,                                       // 特定口座は満額課税
    nisaRoom: Math.max(0, NISA_LIFETIME_CAP - nisaI0),      // NISA生涯投資枠の残り（簿価）
  };
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
                       basis0, taxRate, split });
    return;
  }

  // === ライフプラン未設定：実績＋将来予測を1枚のグラフで表示（従来） ===
  // 生涯の試算を行わないので、取り崩しの検証カードも消しておく（古い結果を残さない）
  lastLifeArgs = null;
  if (strategyShown) renderStrategy();
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
  // ①生活防衛資金（生活費×月数）は取り崩さず現金として残す下限。
  // 手元現金が足りなければ、退職後に債券→投信を売って現金に振り替えて確保する
  // （インフレで下限が上がる分も同じ方法で補充するので、扱いを揃えている）。
  const emMonths = (planData.plan.emergency_months != null) ? planData.plan.emergency_months : 6;
  const emFloor = (lp.spend || 0) * emMonths;
  // 「受取」分配金の年率（税引前・税引後／運用資産全体に対する率）。
  const dv = planData.dividends || {};
  const div = { grossY: dv.receive_gross_yield || 0, netY: dv.receive_net_yield || 0 };
  // 設定した取り崩し方法（定額／定率／ガードレール）で描く
  const split = o.split || null;
  // 比較・リスク検証カードから同じ前提で再計算できるよう、引数一式を先に控えておく
  // （集中銘柄の売却計画を組み立てるのに runPath＝この引数一式が要るため、パスより先）
  lastLifeArgs = { cur, lastDate, monthly, baseRate, lp, cash0, bonds0, basis0,
                   taxRate, emFloor, div, split, useAi, retireAge: lp.retire };
  // 設定した取り崩し方法（定額／定率／ガードレール）で描く。
  // 集中銘柄を減らす設定にしているなら、その売却（と税）もグラフに反映させる。
  // ここを抜くと、資産推移グラフだけ売却しない前提になり、取り崩し戦略とズレる。
  const cpPlan = concentrationPlan(lastLifeArgs, projMonthlyRate(baseRate));
  const path = buildLifePath(cur, lastDate, monthly, baseRate, lp, cash0, bonds0, basis0,
                             taxRate, emFloor, div,
                             drawOpts(Object.assign({ split },
                                                    cpPlan ? cpPlan.optsFor(cpPlan.target) : {})));
  const pts = path.pts;
  // 現在の税引後総資産。目標判定も「現在」のマーカーもグラフと同じ経路の値を使い、
  // 「グラフでは目標線を超えているのに文言は未達」といった食い違いが出ないようにする。
  const curTotal = pts[0].v;
  renderPlanGoal(curTotal);   // 進捗ゲージもグラフと同じ現在値にそろえる
  const fa = (a) => Math.round(a);
  const retireAge = lp.retire, penAge = lp.penAge;
  const hasGap = penAge > retireAge + 1e-6;
  const depAge = path.depletionAge;                 // 枯渇年齢（-1なら枯渇しない）
  const endAge = depAge > 0 ? depAge : 100;
  const accMonths = Math.max(1, Math.round((retireAge - lp.age0) * 12));
  // 目標達成：税引後の総資産が目標に到達する月を求める
  // 目標到達月は、単純な複利ではなくグラフと同じ月次経路から求める。
  // （分配金の払い出し・NISAと特定口座の税の違いが反映され、グラフの目標線と一致する）
  let ach = -1;
  if (goal > 0) {
    if (pts[0].v >= goal) ach = 0;
    else {
      const lim = Math.min(accMonths, pts.length - 1);
      for (let m = 1; m <= lim; m++) if (pts[m].v >= goal) { ach = m; break; }
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
  traces.push(area("fund", "投信・株（税引後）", "#5b8def", "rgba(91,141,239,0.38)"));

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
  // どの取り崩し方法で計算したかを明示する（定率などは生活費が下がる前提のため）
  const mth = path.method || "fixed";
  let msg = `取り崩し方法は「${DRAW_LABELS[mth]}」で計算しています`;
  if (mth === "percent") {
    msg += `（毎年 残高の${((planData.plan || {}).draw_rate != null ? planData.plan.draw_rate : 4)}%を引き出す前提。`
      + `資産が減れば引出額も減るため枯渇しにくい一方、生活費は最低 約 ${Math.round(path.minLiving).toLocaleString()} 円/月まで下がる計算です）。`;
  } else if (mth === "guardrail") {
    msg += "（定額を基本に、年1回だけ見直す前提。引出率が退職時の水準より2割高くなったら生活費を1割減らし、"
      + "2割低くなったら1割増やします。増減は当初の生活費の70〜125%の範囲に収めます。"
      + `生活費は最低 約 ${Math.round(path.minLiving).toLocaleString()} 円/月まで下がる計算です）。`;
  } else {
    msg += "（生活費をインフレ調整して毎年同じだけ引き出す前提）。";
  }
  msg += `退職時（${retireAge}歳）の想定資産 約 ${Math.round(path.retireBal).toLocaleString()} 円`;
  msg += reserve > 0 ? `（うち現金・債券 ${reserve.toLocaleString()} 円を含む）。` : "。";
  if (hasGap) msg += `退職〜年金開始（${penAge}歳）までは年金なしで、まず現金→次に債券から取り崩す前提です（グラフの現金・債券の帯がこの間に減っていきます）。`;
  if (emFloor > 0) {
    msg += `なお①生活防衛資金（現在価値 約 ${Math.round(emFloor).toLocaleString()} 円`
      + `＝生活費${emMonths}ヶ月ぶん）は緊急時用に現金で残し、インフレに合わせて実質額を維持する前提です。`;
    // 手元現金が足りない場合は、退職後に債券・投信を売って現金に振り替える
    msg += (emFloor > cash0)
      ? `手元現金 ${Math.round(cash0).toLocaleString()} 円では不足するため、`
        + `退職後に債券→投信を売って差額 約 ${Math.round(emFloor - cash0).toLocaleString()} 円を現金に振り替えます`
        + "（年金受給後も維持）。"
      : "（不足分は運用資産から補充。年金受給後も維持）。";
  }
  // 口座の順序は税額に効くため、NISAを持っている場合だけ前提を明示する
  if ((split && split.nisaV > 0) && (split.taxV > 0)) {
    msg += "運用資産はNISAを温存し、課税される特定口座から先に取り崩す前提です"
      + `（売却時に含み益へ課税。生涯で払う税 約 ${path.taxPaid.toLocaleString()} 円`
      + `＋最後まで売らずに残る含み益への税 約 ${path.taxDeferred.toLocaleString()} 円`
      + ` ＝ 合計 約 ${path.taxTotal.toLocaleString()} 円）。`;
  }
  if ((dv.receive_net || 0) > 0) msg += `また「受取」に設定した分配金・配当（現在の保有で税引後 約 ${Math.round(dv.receive_net).toLocaleString()} 円/年）を税引後キャッシュとして現金の帯に加え、取り崩し時の売却額を軽減しています。`;
  if (lp.spend <= 0) msg += " 退職後の生活費を設定すると、資産寿命の試算が表示されます。";
  else if (depAge > 0) msg += `この前提では、資産は 約 ${Math.floor(depAge)}歳 で尽きる見込みです。`;
  else msg += `この前提でも、資産は 100歳まで持続する見込みです（100歳時点で 約 ${Math.round(path.endBal).toLocaleString()} 円）。`;
  ddSummary.textContent = msg;

  // 検証カードを表示中なら、同じ前提で計算し直す。
  // 設定を変えたのに古い結果が残っていると、表示と実際の設定が食い違うため。
  if (strategyShown) renderStrategy();
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
