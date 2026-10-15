import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { msg, translate } from "../addon/src/i18n.js";
import { plan } from "../addon/src/reconcile.js";

const ADDON = resolve(import.meta.dirname, "../addon");
const LOCALES = readdirSync(join(ADDON, "_locales"));
const messages = Object.fromEntries(LOCALES.map(l => [l, JSON.parse(readFileSync(join(ADDON, "_locales", l, "messages.json"), "utf8"))]));

// Same substitution rules as WebExtension i18n.getMessage: named $PLACEHOLDER$ → placeholders[name].content → $1..$9.
function getMessageFor(locale) {
  return (code, subs = []) => {
    const entry = messages[locale][code];
    if (!entry) {
      return "";
    }
    return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (_, name) => {
      const ph = entry.placeholders?.[name.toLowerCase()];
      return ph ? ph.content.replace(/\$(\d)/g, (__, n) => subs[n - 1] ?? "") : "";
    });
  };
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      return e.name === "_locales" ? [] : sourceFiles(p);
    }
    return /\.(js|html|json)$/.test(e.name) ? [p] : [];
  });
}

test("all locales have the same codes and placeholders as English", () => {
  const en = messages.en;
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(messages[locale]).sort(), Object.keys(en).sort(), `${locale}: andere Kennungen als en`);
    for (const [code, entry] of Object.entries(en)) {
      assert.deepEqual(messages[locale][code].placeholders || {}, entry.placeholders || {}, `${locale}/${code}: Platzhalter weichen ab`);
    }
  }
});

test("every placeholder used in a text is defined", () => {
  for (const locale of LOCALES) {
    for (const [code, entry] of Object.entries(messages[locale])) {
      for (const [, name] of entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)) {
        assert.ok(entry.placeholders?.[name.toLowerCase()], `${locale}/${code}: $${name}$ nicht definiert`);
      }
    }
  }
});

test("every message code used in the add-on exists", () => {
  const used = new Set();
  const patterns = [/\bmsg\(\s*"([A-Za-z0-9_]+)"/g, /\bt\(\s*"([A-Za-z0-9_]+)"/g, /\bcode:\s*"([A-Za-z0-9_]+)"/g, /data-i18n(?:-placeholder)?="([A-Za-z0-9_]+)"/g, /__MSG_([A-Za-z0-9_]+)__/g, /\bmsg\(\s*\w+\s*\?\s*"([A-Za-z0-9_]+)"\s*:\s*"([A-Za-z0-9_]+)"/g];
  for (const file of sourceFiles(ADDON)) {
    const text = readFileSync(file, "utf8");
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        m.slice(1).filter(Boolean).forEach(c => used.add(c));
      }
    }
  }
  assert.ok(used.size > 40, `nur ${used.size} Kennungen gefunden, Suchmuster prüfen`);
  const missing = [...used].filter(c => !messages.en[c]);
  assert.deepEqual(missing, [], "im Code verwendet, aber nicht in _locales/en");
});

test("planner warnings render in German and English", () => {
  const r = plan({
    remote: { calendars: [], addressBooks: [{ kind: "addressbook", url: "https://x/ab/b/", slug: "b", name: "b" }] },
    local: { calendars: [], addressBooks: [{ uid: "1", url: "https://x/ab/a/", name: "Lieferanten" }] },
    options: { removeAfterMissing: 3 },
  });
  assert.equal(translate(r.warnings[0], getMessageFor("de")), "Adressbuch „Lieferanten“ fehlt auf dem Server (1/3), wird noch nicht entfernt.");
  assert.equal(translate(r.warnings[0], getMessageFor("en")), "Address book “Lieferanten” is missing on the server (1/3), not removed yet.");
});

test("lists of nested messages are joined", () => {
  const m = msg("logUpdated", msg("kindCalendar"), "Projekte", [msg("changeName", "Projekte 2027"), msg("changeEnabled")]);
  assert.equal(translate(m, getMessageFor("de")), "Kalender „Projekte“ aktualisiert (Name: Projekte 2027, wieder eingeschaltet)");
});

test("old log entries stored as plain text still display", () => {
  assert.equal(translate("Kalender „x“ hinzugefügt", getMessageFor("en")), "Kalender „x“ hinzugefügt");
});

test("unknown code falls back to code and values instead of an empty line", () => {
  assert.equal(translate(msg("doesNotExist", "a"), getMessageFor("en")), "doesNotExist a");
});
