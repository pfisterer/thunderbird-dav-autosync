import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, globMatch } from "../addon/src/reconcile.js";

const S = "https://cloud.example.org/remote.php/dav";
const cal = (slug, extra = {}) => ({ kind: "calendar", url: `${S}/calendars/alice/${slug}/`, slug, name: slug, color: "#112233", readOnly: false, shared: false, components: ["VEVENT"], ...extra });
const book = (slug, extra = {}) => ({ kind: "addressbook", url: `${S}/addressbooks/users/alice/${slug}/`, slug, name: slug, readOnly: false, shared: false, ...extra });
const localCal = (id, slug, extra = {}) => ({ id, url: `${S}/calendars/alice/${slug}/`, name: slug, color: "#112233", readOnly: false, ...extra });
const ops = r => r.actions.map(a => `${a.op}:${a.item?.slug || a.name}`).sort();

test("creates everything on first run", () => {
  const r = plan({ remote: { calendars: [cal("personal"), cal("projekte")], addressBooks: [book("contacts")] }, local: { calendars: [], addressBooks: [] } });
  assert.deepEqual(ops(r), ["create:contacts", "create:personal", "create:projekte"]);
});

test("nothing to do when in sync", () => {
  const r = plan({ remote: { calendars: [cal("personal")], addressBooks: [] }, local: { calendars: [localCal("1", "personal")], addressBooks: [] } });
  assert.deepEqual(r.actions, []);
});

test("updates name, color and read-only flag", () => {
  const r = plan({
    remote: { calendars: [cal("personal", { name: "Persönlich", color: "#abcdef", readOnly: true })], addressBooks: [] },
    local: { calendars: [localCal("1", "personal")], addressBooks: [] },
  });
  assert.equal(r.actions.length, 1);
  assert.deepEqual(r.actions[0].changes, { name: "Persönlich", color: "#abcdef", readOnly: true });
});

test("removes only after the configured number of consecutive misses", () => {
  const input = { remote: { calendars: [cal("personal")], addressBooks: [] }, local: { calendars: [localCal("1", "personal"), localCal("2", "alt")], addressBooks: [] } };
  const first = plan(input);
  assert.deepEqual(first.actions, []);
  assert.equal(Object.values(first.state.missing)[0], 1);
  const second = plan({ ...input, state: first.state });
  assert.deepEqual(ops(second), ["remove:alt"]);
  assert.deepEqual(second.state.missing, {});
});

test("a reappearing item resets its miss counter", () => {
  const local = { calendars: [localCal("2", "alt")], addressBooks: [] };
  const first = plan({ remote: { calendars: [cal("other")], addressBooks: [] }, local });
  const back = plan({ remote: { calendars: [cal("other"), cal("alt")], addressBooks: [] }, local, state: first.state });
  assert.deepEqual(back.state.missing, {});
  assert.ok(!back.actions.some(a => a.op === "remove"));
});

test("never removes when the listing failed (null)", () => {
  const r = plan({ remote: { calendars: null, addressBooks: null }, local: { calendars: [localCal("1", "personal")], addressBooks: [] }, state: { missing: {} }, options: { removeAfterMissing: 1 } });
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.warnings.map(w => w.code), ["warnListingUnavailable", "warnListingUnavailable"]);
});

test("never removes when the server suddenly reports nothing", () => {
  const r = plan({ remote: { calendars: [], addressBooks: [] }, local: { calendars: [localCal("1", "a"), localCal("2", "b")], addressBooks: [] }, options: { removeAfterMissing: 1 } });
  assert.deepEqual(r.actions, []);
  assert.equal(r.warnings[0].code, "warnServerEmpty");
  assert.deepEqual(r.warnings[0].params, [{ code: "kindCalendar", params: [] }, "2"]);
});

test("removes duplicates left by an interrupted run", () => {
  const r = plan({ remote: { calendars: [cal("personal")], addressBooks: [] }, local: { calendars: [localCal("1", "personal"), localCal("2", "personal")], addressBooks: [] } });
  assert.deepEqual(r.actions.map(a => [a.op, a.id]), [["remove", "2"]]);
});

test("respects exclude patterns, shared flag and components", () => {
  const remote = {
    calendars: [cal("personal"), cal("contact_birthdays"), cal("urlaub_shared_by_bob", { shared: true }), cal("aufgaben", { components: ["VTODO"] })],
    addressBooks: [book("contacts"), book("z-server-generated--system"), book("z-app-generated--contactsinteraction--recent")],
  };
  const r = plan({
    remote,
    local: { calendars: [], addressBooks: [] },
    options: { calendars: { exclude: ["contact_birthdays"], includeShared: false, components: ["VEVENT"] }, addressBooks: { exclude: ["z-*-generated--*"] } },
  });
  assert.deepEqual(ops(r), ["create:contacts", "create:personal"]);
});

test("an excluded item that is managed gets removed (after the misses)", () => {
  const r = plan({
    remote: { calendars: [cal("personal"), cal("contact_birthdays")], addressBooks: [] },
    local: { calendars: [localCal("1", "contact_birthdays")], addressBooks: [] },
    options: { calendars: { exclude: ["contact_birthdays"] }, removeAfterMissing: 1 },
  });
  assert.deepEqual(ops(r), ["create:personal", "remove:contact_birthdays"]);
});

test("disabled kind is left alone", () => {
  const r = plan({ remote: { calendars: [cal("x")], addressBooks: [] }, local: { calendars: [localCal("1", "y")], addressBooks: [] }, options: { calendars: { enabled: false }, removeAfterMissing: 1 } });
  assert.deepEqual(r.actions, []);
});

test("URL comparison ignores encoding, trailing slash and host case", () => {
  const r = plan({
    remote: { calendars: [cal("x", { url: "https://CLOUD.example.org/remote.php/dav/calendars/alice/m%C3%BCll/" })], addressBooks: [] },
    local: { calendars: [{ id: "1", url: "https://cloud.example.org/remote.php/dav/calendars/alice/müll", name: "x", color: "#112233", readOnly: false }], addressBooks: [] },
  });
  assert.deepEqual(r.actions, []);
});

test("glob matching", () => {
  assert.ok(globMatch("z-*-generated--*", "z-server-generated--system"));
  assert.ok(!globMatch("z-*-generated--*", "contacts"));
  assert.ok(globMatch("Contact birthdays", "contact BIRTHDAYS"));
});

test("re-enables a calendar Thunderbird disabled after a server error", () => {
  const r = plan({ remote: { calendars: [cal("personal")], addressBooks: [] }, local: { calendars: [localCal("1", "personal", { disabled: true, autoDisabled: true })], addressBooks: [] } });
  assert.deepEqual(r.actions[0].changes, { enabled: true });
});

test("leaves a calendar the user disabled alone", () => {
  const r = plan({ remote: { calendars: [cal("personal")], addressBooks: [] }, local: { calendars: [localCal("1", "personal", { disabled: true, autoDisabled: false })], addressBooks: [] } });
  assert.deepEqual(r.actions, []);
});

test("reminders off for shared calendars: on creation and once for existing ones", () => {
  const options = { calendars: { remindersForShared: false } };
  const remote = { calendars: [cal("personal"), cal("urlaub_shared_by_bob", { shared: true }), cal("neu_shared_by_bob", { shared: true })], addressBooks: [] };
  const local = { calendars: [localCal("1", "personal"), localCal("2", "urlaub_shared_by_bob")], addressBooks: [] };
  const first = plan({ remote, local, options });
  const create = first.actions.find(a => a.op === "create");
  assert.equal(create.item.slug, "neu_shared_by_bob");
  assert.equal(create.suppressAlarms, true);
  const update = first.actions.find(a => a.op === "update");
  assert.deepEqual([update.id, update.changes], ["2", { suppressAlarms: true }]);
  assert.ok(!first.actions.some(a => a.id === "1"), "own calendar must not be touched");
  // Next run: the user switched reminders on again for "urlaub" – nothing is changed any more.
  const local2 = { calendars: [...local.calendars, localCal("3", "neu_shared_by_bob")], addressBooks: [] };
  const second = plan({ remote, local: local2, state: first.state, options });
  assert.deepEqual(second.actions, []);
});

test("reminders are left alone by default", () => {
  const r = plan({ remote: { calendars: [cal("x", { shared: true })], addressBooks: [] }, local: { calendars: [], addressBooks: [] } });
  assert.equal(r.actions[0].suppressAlarms, undefined);
});
