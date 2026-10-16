// End-to-end test: real Thunderbird (.local/tb, fresh profile) + real Nextcloud (scripts/nc-test.sh start).
// The add-on is installed and configured through policies.json, exactly as in production.
// Run: npm run build && node test/e2e/run.mjs
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, openSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { DOMParser } from "@xmldom/xmldom";
import { createRequire } from "node:module";
import { Marionette } from "./marionette.js";
import { DavClient } from "../../addon/src/dav.js";

const ROOT = resolve(import.meta.dirname, "../..");
const { binary: TB, distribution: DISTRIBUTION } = createRequire(import.meta.url)("./thunderbird.cjs").paths(ROOT);
const PROFILE = `${ROOT}/.local/e2e-profile`;
const POLICIES = `${DISTRIBUTION}/policies.json`;
const ADDON_ID = JSON.parse(readFileSync(`${ROOT}/addon/manifest.json`)).browser_specific_settings.gecko.id;
const VERSION = JSON.parse(readFileSync(`${ROOT}/addon/manifest.json`)).version;
const XPI = `${ROOT}/dist/dav-autosync-${VERSION}.xpi`;
const NC = "http://127.0.0.1:8088";
const DAV = `${NC}/remote.php/dav`;
const LOG = openSync(`${ROOT}/.local/e2e-thunderbird.log`, "w");
// Nextcloud keeps deleted calendars in a 30-day trash bin and still shows them to sharees under the old name, so every run uses a fresh slug.
const NEW_SLUG = `neu${Date.now().toString(36)}`;
const pw = user => readFileSync(`${ROOT}/.local/nc/${user}.pw`, "utf8").trim();

// ---------- Nextcloud helpers ----------
async function dav(user, method, path, body, headers = {}) {
  const r = await fetch(`${DAV}/${path}`, {
    method,
    headers: { Authorization: "Basic " + Buffer.from(`${user}:${pw(user)}`).toString("base64"), "Content-Type": "application/xml; charset=utf-8", ...headers },
    body,
  });
  if (r.status >= 400 && !(method === "DELETE" && r.status === 404) && !(method === "MKCALENDAR" && r.status === 405)) {
    throw new Error(`${method} ${path}: HTTP ${r.status} ${await r.text()}`);
  }
}
const share = (owner, path, sharee, rw = false) =>
  dav(owner, "POST", path, `<?xml version="1.0"?><o:share xmlns:d="DAV:" xmlns:o="http://owncloud.org/ns"><o:set><d:href>principal:principals/users/${sharee}</d:href>${rw ? "<o:read-write/>" : ""}</o:set></o:share>`);
const unshare = (owner, path, sharee) =>
  dav(owner, "POST", path, `<?xml version="1.0"?><o:share xmlns:d="DAV:" xmlns:o="http://owncloud.org/ns"><o:remove><d:href>principal:principals/users/${sharee}</d:href></o:remove></o:share>`);
const rename = (user, path, name) =>
  dav(user, "PROPPATCH", path, `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>${name}</d:displayname></d:prop></d:set></d:propertyupdate>`);
const mkcal = (user, slug, name) =>
  dav(user, "MKCALENDAR", `calendars/${user}/${slug}/`, `<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>${name}</d:displayname></d:prop></d:set></c:mkcalendar>`);

// Same discovery the add-on uses, so "visible" means: a real calendar collection, not e.g. a deleted one.
async function aliceSees() {
  const client = new DavClient({ serverUrl: `${DAV}/`, username: "alice", password: pw("alice"), DOMParser });
  const r = await client.discover({ addressBooks: false });
  return r.calendars.map(c => c.slug);
}

// Makes sure the server really is in the expected state before Thunderbird looks at it, so a fixture hiccup is not reported as an add-on bug.
async function ensureServer(present, absent, fix) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const seen = await aliceSees();
    if (present.every(p => seen.includes(p)) && absent.every(a => !seen.includes(a))) {
      return;
    }
    await fix?.();
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`Testserver nicht im erwarteten Zustand: ${(await aliceSees()).join(", ")}`);
}

async function resetServer() {
  await share("bob", "calendars/bob/urlaub/", "alice");
  await share("bob", "addressbooks/users/bob/lieferanten/", "alice");
  await rename("alice", "calendars/alice/projekte/", "Projekte");
  // Calendars created by earlier runs: unshare (a deleted calendar would stay visible to alice), then delete.
  const bob = new DavClient({ serverUrl: `${DAV}/`, username: "bob", password: pw("bob"), DOMParser });
  for (const c of (await bob.discover({ addressBooks: false })).calendars.filter(c => /^neu/.test(c.slug))) {
    await unshare("bob", `calendars/bob/${c.slug}/`, "alice").catch(() => {});
    await dav("bob", "DELETE", `calendars/bob/${c.slug}/`);
  }
}

// ---------- Thunderbird helpers ----------
function writePolicies(credentialSource = "stored", calendarOptions = {}, extra = {}) {
  mkdirSync(DISTRIBUTION, { recursive: true });
  const base = { policies: { DisableAppUpdate: true, DisableTelemetry: true, OverrideFirstRunPage: "", OverridePostUpdatePage: "" } };
  base.policies.ExtensionSettings = { [ADDON_ID]: { installation_mode: "force_installed", install_url: `file://${XPI}` } };
  base.policies["3rdparty"] = {
    Extensions: {
      [ADDON_ID]: {
        serverUrl: `${DAV}/`,
        credentialSource,
        removeAfterMissing: 2,
        calendars: { exclude: ["contact_birthdays"], ...calendarOptions },
        ...extra,
        addressBooks: { exclude: ["z-*-generated--*"] },
      },
    },
  };
  writeFileSync(POLICIES, JSON.stringify(base, null, 2));
}

let current = null;

async function startThunderbird() {
  const proc = spawn(TB, ["-profile", PROFILE, "-no-remote", "--headless", "--marionette", "--remote-allow-system-access"], { stdio: ["ignore", LOG, LOG], detached: true });
  current = proc;
  const m = new Marionette();
  await m.connect();
  return { m, proc };
}

// Never leave a Thunderbird behind: a stale instance would answer the next run's Marionette connection.
function killCurrent() {
  if (current && current.exitCode === null) {
    // Negative pid: the whole process group, including Gecko's content and helper processes.
    try {
      process.kill(-current.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}
process.on("exit", killCurrent);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(130));
}
process.on("uncaughtException", e => {
  console.error(e);
  process.exit(1);
});

async function stopThunderbird({ m, proc }) {
  await m.quit();
  await new Promise(r => (proc.exitCode !== null ? r() : proc.once("exit", r)));
}

const SNAPSHOT = `
  const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
  const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
  const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
  const addon = await AddonManager.getAddonByID(args.id);
  return {
    addon: addon ? { version: addon.version, active: addon.isActive } : null,
    calendars: cal.manager.getCalendars().map(c => ({ id: c.id, name: c.name, type: c.type, readOnly: Boolean(c.readOnly), suppressAlarms: Boolean(c.getProperty("suppressAlarms")), refresh: Number(c.getProperty("refreshInterval")), disabled: Boolean(c.getProperty("disabled")), cache: Boolean(c.getProperty("cache.enabled")), managed: c.getProperty("davautosync.managedBy") || "", username: c.getProperty("username") || "" })),
    books: MailServices.ab.directories.map(d => ({ name: d.dirName, carddav: d.dirType == Ci.nsIAbManager.CARDDAV_DIRECTORY_TYPE, readOnly: d.getBoolValue("readOnly", false), managed: d.getStringValue("davautosync.managedBy", ""), cards: d.childCardCount, sync: d.getIntValue("carddav.syncinterval", 0) })),
  };`;

async function snapshot(m) {
  try {
    return await m.run(SNAPSHOT, { id: ADDON_ID });
  } catch (e) {
    // Directly after start-up some services (AddonManager, calendar) are not ready yet.
    return { error: e.message, calendars: [], books: [] };
  }
}

async function waitFor(m, predicate, what, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await snapshot(m);
    if (predicate(last)) {
      return last;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.error(JSON.stringify(last, null, 2));
  throw new Error(`Zeitüberschreitung: ${what}`);
}

// Nextcloud localises the default calendar name according to the request language.
const managedCals = s => s.calendars.filter(c => c.managed).map(c => (c.name === "Persönlich" ? "Personal" : c.name)).sort();
const managedBooks = s => s.books.filter(b => b.managed).map(b => (b.name === "Kontakte" ? "Contacts" : b.name)).sort();

async function step(title, fn) {
  process.stdout.write(`• ${title} … `);
  await fn();
  console.log("ok");
}

// ---------- Scenario ----------
await resetServer();
await ensureServer(["urlaub_shared_by_bob", "montage_shared_by_bob"], []);
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
copyFileSync(`${ROOT}/test/e2e/user.js`, `${PROFILE}/user.js`);
writePolicies();

let tb = await startThunderbird();
await step("Add-on per policies.json installiert, Login und eigener lokaler Kalender angelegt", async () => {
  await waitFor(tb.m, s => s.addon?.active, "Add-on aktiv", 60000);
  await tb.m.run(`
    const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
    const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
    login.init(args.origin, null, "Nextcloud", "alice", args.pw, "", "");
    await Services.logins.initializationPromise;
    await Services.logins.addLoginAsync(login);
    const own = cal.manager.createCalendar("storage", Services.io.newURI("moz-storage-calendar://"));
    own.name = "Mein eigener Kalender";
    cal.manager.registerCalendar(own);
    // Subscribed by hand before the roll-out: must be taken over, not duplicated.
    const manual = cal.manager.createCalendar("caldav", Services.io.newURI(args.projekte));
    manual.name = "Projekte (von Hand)";
    manual.setProperty("username", "alice");
    manual.id = cal.getUUID();
    cal.manager.registerCalendar(manual);`, { origin: NC, pw: pw("alice"), projekte: `${DAV}/calendars/alice/projekte/` });
});
await stopThunderbird(tb);

tb = await startThunderbird();
await step("Erster Abgleich: eigene und geteilte Kalender und Adressbücher erscheinen", async () => {
  const s = await waitFor(tb.m, s => managedCals(s).length >= 5 && managedBooks(s).length >= 2 && s.books.find(b => b.name === "Lieferanten (Bob)")?.cards === 1, "erster Abgleich");
  assert.deepEqual(managedCals(s), ["Aufgaben", "Montagetermine (Bob)", "Personal", "Projekte", "Urlaubsplan (Bob)"]);
  assert.deepEqual(managedBooks(s), ["Contacts", "Lieferanten (Bob)"]);
  assert.equal(s.calendars.filter(c => c.type === "caldav" && /^Projekte/.test(c.name)).length, 1, "von Hand abonnierter Kalender wurde dupliziert statt übernommen");
  assert.equal(s.calendars.find(c => c.name === "Urlaubsplan (Bob)").readOnly, true);
  assert.equal(s.calendars.find(c => c.name === "Montagetermine (Bob)").readOnly, false);
  assert.equal(s.books.find(b => b.name === "Lieferanten (Bob)").readOnly, true);
  assert.ok(s.calendars.every(c => !c.managed || c.username === "alice"));
  assert.ok(s.calendars.some(c => c.name === "Mein eigener Kalender" && !c.managed));
  assert.ok(s.calendars.filter(c => c.managed).every(c => c.refresh === 15), "Kalender-Takt nicht 15: " + JSON.stringify(s.calendars.filter(c => c.managed).map(c => [c.name, c.refresh])));
  assert.ok(s.books.filter(b => b.managed).every(b => b.sync === 15), "Adressbuch-Takt nicht 15");
});
await stopThunderbird(tb);

await mkcal("bob", NEW_SLUG, "Neue Baustelle");
await share("bob", `calendars/bob/${NEW_SLUG}/`, "alice");
await unshare("bob", "calendars/bob/urlaub/", "alice");
await unshare("bob", "addressbooks/users/bob/lieferanten/", "alice");
await rename("alice", "calendars/alice/projekte/", "Projekte 2027");
await ensureServer([`${NEW_SLUG}_shared_by_bob`], ["urlaub_shared_by_bob"]);

tb = await startThunderbird();
await step("Zweiter Abgleich: neuer Kalender da, Umbenennung übernommen, entzogene Freigaben noch da (1/2)", async () => {
  const s = await waitFor(tb.m, s => managedCals(s).includes("Neue Baustelle (Bob)") && managedCals(s).includes("Projekte 2027"), "zweiter Abgleich");
  assert.ok(managedCals(s).includes("Urlaubsplan (Bob)"), "Urlaubsplan zu früh entfernt");
  assert.ok(managedBooks(s).includes("Lieferanten (Bob)"), "Lieferanten zu früh entfernt");
});
await stopThunderbird(tb);

tb = await startThunderbird();
await step("Dritter Abgleich: entzogene Freigaben entfernt, eigener Kalender unberührt", async () => {
  const s = await waitFor(tb.m, s => !managedCals(s).includes("Urlaubsplan (Bob)") && !managedBooks(s).includes("Lieferanten (Bob)"), "dritter Abgleich");
  assert.deepEqual(managedCals(s), ["Aufgaben", "Montagetermine (Bob)", "Neue Baustelle (Bob)", "Personal", "Projekte 2027"]);
  assert.deepEqual(managedBooks(s), ["Contacts"]);
  assert.ok(s.calendars.some(c => c.name === "Mein eigener Kalender" && !c.managed));
});

const requestSync = () => tb.m.run(`Services.obs.notifyObservers(null, "dav-autosync-sync-now");`);
const byName = (s, re) => s.calendars.find(c => re.test(c.name));

await step("Von Thunderbird nach Serverfehler abgeschaltet → wieder an; vom Nutzer abgeschaltet → bleibt aus", async () => {
  await tb.m.run(`
    const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
    for (const c of cal.manager.getCalendars()) {
      if (c.name === "Aufgaben") { c.setProperty("disabled", true); c.setProperty("auto-enabled", true); }
      if (c.name === "Personal" || c.name === "Persönlich") { c.setProperty("disabled", true); }
    }`);
  await requestSync();
  const s = await waitFor(tb.m, s => byName(s, /^Aufgaben$/) && !byName(s, /^Aufgaben$/).disabled, "Wiedereinschalten");
  assert.equal(byName(s, /^(Personal|Persönlich)$/).disabled, true, "vom Nutzer abgeschalteter Kalender wurde eingeschaltet");
});

await step("Offline-Cache umgeschaltet (Thunderbird baut den Kalender neu auf) → übernommen, kein Duplikat", async () => {
  const before = byName(await snapshot(tb.m), /^Montagetermine/);
  await tb.m.run(`
    const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
    const c = cal.manager.getCalendarById(args.id);
    c.setProperty("cache.enabled", !c.getProperty("cache.enabled"));`, { id: before.id });
  const recreated = await waitFor(tb.m, s => byName(s, /^Montagetermine/)?.id !== before.id, "Neuaufbau durch Thunderbird");
  assert.equal(byName(recreated, /^Montagetermine/).managed, "", "Thunderbird hat die Markierung doch kopiert, Test prüft nichts mehr");
  await requestSync();
  const s = await waitFor(tb.m, s => byName(s, /^Montagetermine/)?.managed, "Übernahme nach Neuaufbau");
  assert.equal(s.calendars.filter(c => /^Montagetermine/.test(c.name)).length, 1, "Duplikat nach Cache-Umschaltung");
});
await stopThunderbird(tb);

// Anmeldung vom Mailkonto: IMAP-Konto mit gespeichertem Kennwort (hier gleich dem Nextcloud-Kennwort), DAV-Login veraltet.
writePolicies("mail");
tb = await startThunderbird();
await step("Login vom Mailkonto übernommen, veraltetes DAV-Kennwort ersetzt, Abgleich läuft", async () => {
  await tb.m.run(`
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    const am = MailServices.accounts;
    const server = am.createIncomingServer("alice", "imap.example.invalid", "imap");
    const identity = am.createIdentity();
    identity.email = "alice@example.invalid";
    const account = am.createAccount();
    account.incomingServer = server;
    account.addIdentity(identity);
    await Services.logins.initializationPromise;
    const neu = (o, r, u, p) => { const l = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo); l.init(o, null, r, u, p, "", ""); return l; };
    await Services.logins.addLoginAsync(neu("imap://imap.example.invalid", "imap://imap.example.invalid", "alice", args.pw));
    const [dav] = await Services.logins.searchLoginsAsync({ origin: args.origin, httpRealm: "Nextcloud" });
    await Services.logins.modifyLoginAsync(dav, neu(args.origin, "Nextcloud", "alice", "veraltet"));`, { origin: NC, pw: pw("alice") });
  await requestSync();
  const deadline = Date.now() + 60000;
  let davPw;
  while (Date.now() < deadline) {
    davPw = await tb.m.run(`await Services.logins.initializationPromise; const [l] = await Services.logins.searchLoginsAsync({ origin: args.origin, httpRealm: "Nextcloud" }); return l?.password;`, { origin: NC });
    if (davPw === pw("alice")) {
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  assert.equal(davPw, pw("alice"), "DAV-Kennwort nicht vom Mailkonto übernommen");
  const s = await snapshot(tb.m);
  assert.ok(managedCals(s).length >= 5, "nach Übernahme kein Abgleich");
});
await stopThunderbird(tb);

// Erinnerungen für geteilte Kalender nachträglich abschalten (einmalig je Kalender); Takt zentral auf 5 Minuten
writePolicies("mail", { remindersForShared: false }, { calendarRefreshMinutes: 5, addressBookSyncMinutes: 5 });
tb = await startThunderbird();
await step("Erinnerungen geteilt aus/eigen an, Nutzerwahl bleibt; geänderter Takt bei vorhandenen nachgezogen", async () => {
  await requestSync();
  let s = await waitFor(tb.m, s => byName(s, /^Montagetermine/)?.suppressAlarms, "Erinnerungen aus");
  assert.equal(byName(s, /^Neue Baustelle/)?.suppressAlarms, true);
  assert.equal(byName(s, /^(Personal|Persönlich)$/).suppressAlarms, false, "eigener Kalender verändert");
  assert.equal(byName(s, /^Aufgaben$/).suppressAlarms, false, "eigener Kalender verändert");
  const montage = byName(s, /^Montagetermine/);
  await tb.m.run(`const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs"); cal.manager.getCalendarById(args.id).setProperty("suppressAlarms", false);`, { id: montage.id });
  await requestSync();
  await new Promise(r => setTimeout(r, 5000));
  s = await snapshot(tb.m);
  assert.equal(byName(s, /^Montagetermine/).suppressAlarms, false, "Nutzereinstellung überschrieben");
  assert.ok(s.calendars.filter(c => c.managed).every(c => c.refresh === 5), "vorhandene Kalender nicht auf 5 Minuten nachgezogen");
  assert.ok(s.books.filter(b => b.managed).every(b => b.sync === 5), "vorhandene Adressbücher nicht auf 5 Minuten nachgezogen");
});
await stopThunderbird(tb);

await resetServer();
console.log("Alle Ende-zu-Ende-Schritte bestanden.");
