// 共通ロジック：ブロックリストの取得・保存・ホスト名の正規化
// content.js と popup.js の両方から利用する。
(function (global) {
  "use strict";

  const STORAGE_KEY = "blockedSites";

  // 初回に投入する既定のブロックサイト（ユーザーは削除できる）
  const DEFAULT_SITES = [
    "x.com",
    "twitter.com",
    "www.instagram.com",
    "www.facebook.com",
    "www.tiktok.com",
    "www.youtube.com"
  ];

  // 一時解除の既定時間（ミリ秒）: 5分
  const SNOOZE_DURATION_MS = 5 * 60 * 1000;

  // 入力文字列をホスト名に正規化する
  //   "https://x.com/home?a=1" -> "x.com"
  //   "  X.COM/  "             -> "x.com"
  //   "www. example . com"     -> ""（不正）
  function normalizeHost(input) {
    if (!input) return "";
    let value = String(input).trim().toLowerCase();
    if (!value) return "";

    // スキームが無ければ補ってURLとして解釈を試みる
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(value)
      ? value
      : "http://" + value;

    let host = "";
    try {
      host = new URL(withScheme).hostname;
    } catch (e) {
      // URLとして解釈できない場合は、素朴にパス以降を落とす
      host = value.split("/")[0].split("?")[0].split("#")[0];
    }

    // 末尾のドットを除去
    host = host.replace(/\.$/, "");

    // 妥当なホスト名か簡易チェック（ドットを含み、空白や不正文字が無い）
    if (!/^[a-z0-9.-]+$/.test(host)) return "";
    if (host.indexOf(".") === -1) return "";
    return host;
  }

  // 現在のホストが、指定サイトにマッチするか（サブドメインも含める）
  //   host="mobile.twitter.com", site="twitter.com" -> true
  function hostMatches(host, site) {
    if (!host || !site) return false;
    host = host.toLowerCase();
    site = site.toLowerCase();
    return host === site || host.endsWith("." + site);
  }

  // ブロックリストを取得する。未設定なら既定値で初期化して返す。
  function getBlockedSites() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ [STORAGE_KEY]: null }, (res) => {
        let sites = res[STORAGE_KEY];
        if (sites === null || sites === undefined) {
          sites = DEFAULT_SITES.slice();
          chrome.storage.sync.set({ [STORAGE_KEY]: sites });
        }
        resolve(Array.isArray(sites) ? sites : []);
      });
    });
  }

  // ブロックリストを保存する
  function setBlockedSites(sites) {
    return new Promise((resolve) => {
      const unique = Array.from(new Set(sites.filter(Boolean)));
      chrome.storage.sync.set({ [STORAGE_KEY]: unique }, () => resolve(unique));
    });
  }

  // ストレージ変更の購読（他タブや設定画面での変更を反映する）
  function onBlockedSitesChanged(callback) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" && changes[STORAGE_KEY]) {
        const newValue = changes[STORAGE_KEY].newValue || [];
        callback(Array.isArray(newValue) ? newValue : []);
      }
    });
  }

  global.SNSBlocker = {
    STORAGE_KEY,
    DEFAULT_SITES,
    SNOOZE_DURATION_MS,
    normalizeHost,
    hostMatches,
    getBlockedSites,
    setBlockedSites,
    onBlockedSitesChanged
  };
})(typeof self !== "undefined" ? self : window);
