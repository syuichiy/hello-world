// ブロック対象サイトで猫マスコットの「だめ！」オーバーレイを表示する。
(function () {
  "use strict";

  const B = self.SNSBlocker;
  const OVERLAY_ID = "sns-blocker-overlay-root";

  let blockedSites = [];
  // このタブ・このホストに対する一時解除の期限（epoch ms）。0 なら解除なし。
  let snoozeUntil = 0;

  function currentHost() {
    return location.hostname || "";
  }

  function isBlockedNow() {
    const host = currentHost();
    const matched = blockedSites.some((site) => B.hostMatches(host, site));
    if (!matched) return false;
    if (snoozeUntil && Date.now() < snoozeUntil) return false;
    return true;
  }

  // 猫のインラインSVG（シンプル・パステル）
  function catSvg() {
    return (
      '<svg viewBox="0 0 120 120" width="150" height="150" role="img" aria-label="猫" xmlns="http://www.w3.org/2000/svg">' +
      '<g>' +
      '<path d="M28 40 L20 14 L44 30 Z" fill="#ffb7c5"/>' +
      '<path d="M92 40 L100 14 L76 30 Z" fill="#ffb7c5"/>' +
      '<path d="M30 38 L24 20 L42 32 Z" fill="#ff8fa8"/>' +
      '<path d="M90 38 L96 20 L78 32 Z" fill="#ff8fa8"/>' +
      '<circle cx="60" cy="64" r="40" fill="#ffd9e0"/>' +
      '<circle cx="46" cy="60" r="6" fill="#3a3a3a"/>' +
      '<circle cx="74" cy="60" r="6" fill="#3a3a3a"/>' +
      '<circle cx="44.5" cy="58" r="2" fill="#fff"/>' +
      '<circle cx="72.5" cy="58" r="2" fill="#fff"/>' +
      '<path d="M57 72 Q60 75 63 72" fill="none" stroke="#3a3a3a" stroke-width="2.5" stroke-linecap="round"/>' +
      '<path d="M60 68 L57 72 M60 68 L63 72" stroke="#ff8fa8" stroke-width="2" stroke-linecap="round" fill="none"/>' +
      '<circle cx="38" cy="70" r="5" fill="#ffb7c5" opacity="0.6"/>' +
      '<circle cx="82" cy="70" r="5" fill="#ffb7c5" opacity="0.6"/>' +
      '<path d="M20 66 L36 68 M20 72 L36 71" stroke="#c98" stroke-width="1.5" stroke-linecap="round"/>' +
      '<path d="M100 66 L84 68 M100 72 L84 71" stroke="#c98" stroke-width="1.5" stroke-linecap="round"/>' +
      '</g></svg>'
    );
  }

  function buildOverlay() {
    const root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");

    const card = document.createElement("div");
    card.className = "snsb-card";

    const cat = document.createElement("div");
    cat.className = "snsb-cat";
    cat.innerHTML = catSvg();

    const title = document.createElement("h1");
    title.className = "snsb-title";
    title.textContent = "だめ！";

    const msg = document.createElement("p");
    msg.className = "snsb-msg";
    msg.textContent = "ここは見ないお約束だよ 🐾";

    const hostLabel = document.createElement("p");
    hostLabel.className = "snsb-host";
    hostLabel.textContent = currentHost();

    const buttons = document.createElement("div");
    buttons.className = "snsb-buttons";

    const backBtn = document.createElement("button");
    backBtn.className = "snsb-btn snsb-btn-primary";
    backBtn.type = "button";
    backBtn.textContent = "とじる";
    backBtn.addEventListener("click", () => {
      if (history.length > 1) {
        history.back();
      } else {
        location.href = "about:blank";
      }
    });

    const snoozeBtn = document.createElement("button");
    snoozeBtn.className = "snsb-btn snsb-btn-secondary";
    snoozeBtn.type = "button";
    snoozeBtn.textContent = "5分だけ見る";
    snoozeBtn.addEventListener("click", () => {
      snoozeUntil = Date.now() + B.SNOOZE_DURATION_MS;
      removeOverlay();
      scheduleReblock();
    });

    buttons.appendChild(backBtn);
    buttons.appendChild(snoozeBtn);

    card.appendChild(cat);
    card.appendChild(title);
    card.appendChild(msg);
    card.appendChild(hostLabel);
    card.appendChild(buttons);
    root.appendChild(card);
    return root;
  }

  function showOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;
    const overlay = buildOverlay();
    const mount = document.documentElement; // <html> なら <body> 未生成でも載る
    mount.appendChild(overlay);
    // 背後のスクロールを止める
    document.documentElement.classList.add("snsb-lock");
  }

  function removeOverlay() {
    const el = document.getElementById(OVERLAY_ID);
    if (el) el.remove();
    document.documentElement.classList.remove("snsb-lock");
  }

  // 一時解除の期限が切れたら自動で再ブロックする
  let reblockTimer = null;
  function scheduleReblock() {
    if (reblockTimer) clearTimeout(reblockTimer);
    const delay = snoozeUntil - Date.now();
    if (delay <= 0) return;
    reblockTimer = setTimeout(() => {
      apply();
    }, delay + 50);
  }

  function apply() {
    if (isBlockedNow()) {
      showOverlay();
    } else {
      removeOverlay();
    }
  }

  // SPA遷移（pushState/replaceState/popstate）に追従する
  function hookHistory() {
    const wrap = (name) => {
      const original = history[name];
      history[name] = function () {
        const result = original.apply(this, arguments);
        window.dispatchEvent(new Event("snsb:locationchange"));
        return result;
      };
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", () =>
      window.dispatchEvent(new Event("snsb:locationchange"))
    );

    let lastHost = currentHost();
    window.addEventListener("snsb:locationchange", () => {
      // ホストが変わったら一時解除はリセット
      if (currentHost() !== lastHost) {
        lastHost = currentHost();
        snoozeUntil = 0;
      }
      apply();
    });
  }

  function init() {
    hookHistory();
    // 設定変更をリアルタイム反映
    B.onBlockedSitesChanged((sites) => {
      blockedSites = sites;
      apply();
    });
    B.getBlockedSites().then((sites) => {
      blockedSites = sites;
      apply();
    });
  }

  init();
})();
