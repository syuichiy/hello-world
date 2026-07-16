// ポップアップ：ブロックサイトの一覧表示・追加・削除
(function () {
  "use strict";

  const B = self.SNSBlocker;

  const form = document.getElementById("add-form");
  const input = document.getElementById("site-input");
  const listEl = document.getElementById("site-list");
  const emptyEl = document.getElementById("empty");
  const errorEl = document.getElementById("error");
  const resetBtn = document.getElementById("reset-btn");

  let sites = [];

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  function render() {
    listEl.innerHTML = "";
    if (sites.length === 0) {
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    sites.forEach((host) => {
      const li = document.createElement("li");
      li.className = "site-item";

      const paw = document.createElement("span");
      paw.className = "paw";
      paw.textContent = "🐾";

      const name = document.createElement("span");
      name.className = "host";
      name.textContent = host;

      const remove = document.createElement("button");
      remove.className = "remove-btn";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", host + " を削除");
      remove.addEventListener("click", () => removeSite(host));

      li.appendChild(paw);
      li.appendChild(name);
      li.appendChild(remove);
      listEl.appendChild(li);
    });
  }

  async function save() {
    sites = await B.setBlockedSites(sites);
    render();
  }

  async function addSite(rawValue) {
    showError("");
    const host = B.normalizeHost(rawValue);
    if (!host) {
      showError("正しいサイト名を入力してね（例：x.com）");
      return;
    }
    if (sites.some((s) => s === host)) {
      showError(host + " はもう追加済みだよ");
      return;
    }
    sites = sites.concat(host);
    await save();
    input.value = "";
    input.focus();
  }

  async function removeSite(host) {
    sites = sites.filter((s) => s !== host);
    await save();
  }

  async function resetDefaults() {
    sites = B.DEFAULT_SITES.slice();
    await save();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    addSite(input.value);
  });

  input.addEventListener("input", () => showError(""));

  resetBtn.addEventListener("click", resetDefaults);

  // 初期化
  B.getBlockedSites().then((loaded) => {
    sites = loaded;
    render();
  });
})();
