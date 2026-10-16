import { DavClient, probeRealm } from "./src/dav.js";
import { plan, mergeOptions } from "./src/reconcile.js";
import { msg, translate, kindMsg } from "./src/i18n.js";

const ALARM = "dav-autosync";
const LOG_LIMIT = 200;
const DEFAULT_CONFIG = {
  serverUrl: "",
  // "mail": take the password of the mail account and keep the DAV login in step with it; "stored": use the stored DAV login only.
  credentialSource: "mail",
  // Which incoming mail server to take the login from (default: first IMAP/POP account).
  mailHost: "",
  // DAV username derived from the mail account: "login" = mail login name, "email" = address, "localpart" = part before @.
  usernameFrom: "login",
  profileId: "default",
  intervalMinutes: 15,
  calendarRefreshMinutes: 15,
  addressBookSyncMinutes: 15,
  cache: true,
  removeAfterMissing: 2,
  calendars: {},
  addressBooks: {},
};

let running = null;

async function loadConfig() {
  let managed = {};
  try {
    managed = await browser.storage.managed.get();
  } catch {
    // No managed storage for this add-on (no policy set).
  }
  if (managed && managed.serverUrl) {
    return { config: { ...DEFAULT_CONFIG, ...managed }, source: "managed" };
  }
  const { config } = await browser.storage.local.get("config");
  return { config: { ...DEFAULT_CONFIG, ...(config || {}) }, source: config ? "local" : "none" };
}

/** @param {{code: string, params: any[]}} message - translated when shown, see src/i18n.js */
async function log(level, message) {
  const { logEntries = [] } = await browser.storage.local.get("logEntries");
  logEntries.push({ at: new Date().toISOString(), level, message });
  await browser.storage.local.set({ logEntries: logEntries.slice(-LOG_LIMIT) });
  (level === "error" ? console.error : console.log)(`dav-autosync: ${translate(message)}`);
}

async function setStatus(status) {
  await browser.storage.local.set({ status: { ...status, at: new Date().toISOString() } });
}

async function fingerprint(...parts) {
  const data = new TextEncoder().encode(parts.join("\u0000"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function davUsername(config, mail) {
  if (config.usernameFrom === "email" && mail.email) {
    return mail.email;
  }
  if (config.usernameFrom === "localpart") {
    return (mail.email || mail.username).split("@")[0];
  }
  return mail.username;
}

/** Returns { origin, realm, username, password } or null; keeps the stored DAV login in step with the mail password if configured. */
async function resolveLogin(config, state) {
  const origin = new URL(config.serverUrl).origin;
  const realm = (await probeRealm(config.serverUrl)) || state.realm || "Nextcloud";
  if (config.credentialSource === "mail") {
    const mail = await browser.davAutosync.getMailLogin(config.mailHost || undefined);
    if (mail) {
      const username = davUsername(config, mail);
      const stored = await browser.davAutosync.getLogin(origin, realm, username);
      if (!stored || stored.password !== mail.password) {
        await browser.davAutosync.setLogin(origin, realm, username, mail.password);
        await log("info", msg(stored ? "logLoginFromMailChanged" : "logLoginFromMail", username));
      }
      return { origin, realm, username, password: mail.password };
    }
  }
  const stored = await browser.davAutosync.getLogin(origin, realm, state.username || undefined);
  return stored ? { origin, realm, ...stored } : null;
}

async function sync(trigger) {
  if (running) {
    return running;
  }
  running = (async () => {
    const { config, source } = await loadConfig();
    if (!config.serverUrl) {
      await setStatus({ ok: false, message: msg("statusNotConfigured") });
      return;
    }
    const tag = `${config.profileId}|${new URL(config.serverUrl).origin}`;
    const { syncState = {} } = await browser.storage.local.get("syncState");

    const login = await resolveLogin(config, syncState);
    if (!login) {
      await setStatus({ ok: false, message: msg("statusNoCredentials") });
      return;
    }

    // After a rejected login, wait for different credentials instead of hammering the server (brute-force protection would lock the office IP).
    const fp = await fingerprint(login.origin, login.username, login.password);
    if (syncState.authFailed === fp) {
      await setStatus({ ok: false, message: msg("statusAuthBlocked", login.username) });
      return;
    }

    const client = new DavClient({ serverUrl: config.serverUrl, username: login.username, password: login.password });
    let remote;
    try {
      remote = await client.discover({ calendars: config.calendars.enabled !== false, addressBooks: config.addressBooks.enabled !== false });
    } catch (e) {
      const reason = e.code ? msg(e.code, ...(e.params || [])) : msg("davUnexpected");
      if (e.kind === "auth") {
        await browser.storage.local.set({ syncState: { ...syncState, authFailed: fp } });
        await log("error", msg("logAuthStopped", login.username));
      } else {
        await log("error", msg("logDiscoveryFailed", trigger, reason));
      }
      await setStatus({ ok: false, message: reason });
      return;
    }

    const local = await browser.davAutosync.listManaged(tag);
    const options = mergeOptions({
      calendars: { ...config.calendars, refreshMinutes: config.calendarRefreshMinutes },
      addressBooks: { ...config.addressBooks, syncMinutes: config.addressBookSyncMinutes },
      removeAfterMissing: config.removeAfterMissing,
    });
    const result = plan({ remote, local, state: syncState, options });
    for (const w of result.warnings) {
      await log("warn", w);
    }

    let done = 0;
    let failed = 0;
    for (const action of result.actions) {
      try {
        await execute(action, { tag, login, config });
        done++;
      } catch (e) {
        failed++;
        await log("error", msg("logActionFailed", describe(action), e.message));
      }
    }

    await browser.storage.local.set({
      syncState: { missing: result.state.missing, remindersApplied: result.state.remindersApplied, realm: login.realm, username: login.username, authFailed: null },
    });
    const summary = msg("statusSummary", String((remote.calendars || []).length), String((remote.addressBooks || []).length), String(done), String(failed));
    await setStatus({ ok: failed === 0, message: summary, source });
  })();
  try {
    await running;
  } catch (e) {
    await log("error", msg("statusUnexpected", e.message));
    await setStatus({ ok: false, message: msg("statusUnexpected", e.message) });
  } finally {
    running = null;
  }
}

async function execute(action, { tag, login, config }) {
  const api = browser.davAutosync;
  if (action.kind === "calendar") {
    if (action.op === "create") {
      const i = action.item;
      const adopted = await api.adoptCalendar(i.url, login.username, tag);
      if (adopted) {
        await api.updateCalendar(adopted, { name: i.name, color: i.color, readOnly: i.readOnly, refreshMinutes: config.calendarRefreshMinutes, ...(action.suppressAlarms ? { suppressAlarms: true } : {}) });
        await log("info", msg("logAdoptedCalendar", i.name));
        return;
      }
      await api.createCalendar({ url: i.url, name: i.name, color: i.color, readOnly: i.readOnly, username: login.username, tag, cache: config.cache, refreshMinutes: config.calendarRefreshMinutes, suppressAlarms: Boolean(action.suppressAlarms) });
    } else if (action.op === "update") {
      await api.updateCalendar(action.id, action.changes);
    } else if (action.op === "remove") {
      await api.removeCalendar(action.id);
    }
  } else if (action.op === "create") {
    const i = action.item;
    const adopted = await api.adoptAddressBook(i.url, login.username, tag);
    if (adopted) {
      await api.updateAddressBook(adopted, { name: i.name, readOnly: i.readOnly, syncMinutes: config.addressBookSyncMinutes });
      await log("info", msg("logAdoptedAddressBook", i.name));
      return;
    }
    await api.createAddressBook({ url: i.url, name: i.name, readOnly: i.readOnly, username: login.username, tag, syncMinutes: config.addressBookSyncMinutes });
  } else if (action.op === "update") {
    await api.updateAddressBook(action.uid, action.changes);
  } else if (action.op === "remove") {
    await api.removeAddressBook(action.uid);
  }
  await log("info", describe(action));
}

function describe(action) {
  const kind = kindMsg(action.kind);
  const name = action.item?.name || action.name;
  switch (action.op) {
    case "create":
      return msg("logCreated", kind, name);
    case "update":
      return msg("logUpdated", kind, name, Object.entries(action.changes).map(([k, v]) => describeChange(k, v)));
    default:
      return msg("logRemoved", kind, name, msg(action.reason === "duplicate" ? "reasonDuplicate" : "reasonGoneFromServer"));
  }
}

function describeChange(key, value) {
  switch (key) {
    case "name":
      return msg("changeName", value);
    case "color":
      return msg("changeColor", value);
    case "readOnly":
      return msg(value ? "changeReadOnly" : "changeWritable");
    case "enabled":
      return msg("changeEnabled");
    case "refreshMinutes":
    case "syncMinutes":
      return msg("changeInterval", String(value));
    case "suppressAlarms":
      return msg(value ? "changeRemindersOff" : "changeRemindersOn");
    default:
      return `${key}: ${value}`;
  }
}

async function schedule() {
  const { config } = await loadConfig();
  await browser.alarms.clear(ALARM);
  browser.alarms.create(ALARM, { delayInMinutes: 0.1, periodInMinutes: Math.max(5, Number(config.intervalMinutes) || 15) });
}

browser.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM) {
    sync(msg("triggerSchedule"));
  }
});

browser.davAutosync.onSyncRequested.addListener(() => sync(msg("triggerRequested")));

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "managed" || (area === "local" && changes.config)) {
    schedule();
  }
});

// Not an async listener: returning a Promise would claim every message, including ones meant for other listeners.
browser.runtime.onMessage.addListener(message => {
  switch (message?.type) {
    case "syncNow":
      return syncNow();
    case "saveLogin":
      return saveLogin(message.username, message.password);
    case "getConfig":
      return loadConfig();
    default:
      return false;
  }
});

async function syncNow() {
  const { syncState = {} } = await browser.storage.local.get("syncState");
  await browser.storage.local.set({ syncState: { ...syncState, authFailed: null } });
  await sync(msg("triggerManual"));
  return true;
}

async function saveLogin(username, password) {
  const { config } = await loadConfig();
  const origin = new URL(config.serverUrl).origin;
  const realm = (await probeRealm(config.serverUrl)) || "Nextcloud";
  await browser.davAutosync.setLogin(origin, realm, username, password);
  const { syncState = {} } = await browser.storage.local.get("syncState");
  await browser.storage.local.set({ syncState: { ...syncState, username, authFailed: null } });
  await log("info", msg("logLoginSaved", username));
  await sync(msg("triggerNewLogin"));
  return true;
}

schedule();
