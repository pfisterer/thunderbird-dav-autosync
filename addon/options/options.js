import { msg, translate } from "../src/i18n.js";

const $ = id => document.getElementById(id);
const t = (code, ...params) => translate(msg(code, ...params));

function localizePage() {
  document.documentElement.lang = browser.i18n.getUILanguage();
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
}

async function render() {
  const { status, logEntries = [] } = await browser.storage.local.get(["status", "logEntries"]);
  const el = $("status");
  el.textContent = status ? `${new Date(status.at).toLocaleString()}: ${translate(status.message)}` : t("optionsNoRunYet");
  el.className = "status" + (status && !status.ok ? " bad" : "");
  $("log").replaceChildren(
    ...logEntries
      .slice(-50)
      .reverse()
      .map(e => {
        const tr = document.createElement("tr");
        const time = document.createElement("td");
        time.textContent = new Date(e.at).toLocaleString();
        const text = document.createElement("td");
        text.textContent = translate(e.message);
        text.className = e.level;
        tr.append(time, text);
        return tr;
      })
  );
}

async function renderConfig() {
  const { config, source } = await browser.runtime.sendMessage({ type: "getConfig" });
  const managed = source === "managed";
  $("source").textContent = t(managed ? "optionsSourceManaged" : "optionsSourceLocal");
  $("cfghint").textContent = t(managed ? "optionsConfigManagedHint" : "optionsConfigLocalHint");
  $("cfg").value = JSON.stringify(config, null, 2);
  $("cfg").readOnly = managed;
  $("savecfg").disabled = managed;
}

$("sync").addEventListener("click", async () => {
  $("sync").disabled = true;
  try {
    await browser.runtime.sendMessage({ type: "syncNow" });
  } finally {
    $("sync").disabled = false;
  }
});

$("login").addEventListener("submit", async ev => {
  ev.preventDefault();
  await browser.runtime.sendMessage({ type: "saveLogin", username: $("user").value.trim(), password: $("pw").value });
  $("pw").value = "";
});

$("savecfg").addEventListener("click", async () => {
  let config;
  try {
    config = JSON.parse($("cfg").value);
  } catch (e) {
    alert(t("optionsInvalidJson", e.message));
    return;
  }
  await browser.storage.local.set({ config });
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.status || changes.logEntries)) {
    render();
  }
});

localizePage();
render();
renderConfig();
