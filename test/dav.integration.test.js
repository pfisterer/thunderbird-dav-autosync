// Runs against a real server. Set DAV_URL, DAV_USER and DAV_PASSWORD, e.g. via scripts/nc-test.sh; skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DOMParser } from "@xmldom/xmldom";
import { DavClient, probeRealm } from "../addon/src/dav.js";

const { DAV_URL, DAV_USER, DAV_PASSWORD } = process.env;
const skip = !(DAV_URL && DAV_USER && DAV_PASSWORD) && "DAV_URL/DAV_USER/DAV_PASSWORD nicht gesetzt";

test("discovers own and shared calendars and address books", { skip }, async () => {
  const client = new DavClient({ serverUrl: DAV_URL, username: DAV_USER, password: DAV_PASSWORD, DOMParser });
  const r = await client.discover();
  const bySlug = Object.fromEntries([...r.calendars, ...r.addressBooks].map(i => [i.slug, i]));

  assert.ok(r.principal.endsWith(`/principals/users/${DAV_USER}/`));
  assert.equal(bySlug.projekte.color, "#1e88e5");
  assert.deepEqual(bySlug.aufgaben.components, ["VTODO"]);
  assert.equal(bySlug.urlaub_shared_by_bob.shared, true);
  assert.equal(bySlug.urlaub_shared_by_bob.readOnly, true);
  assert.equal(bySlug.montage_shared_by_bob.readOnly, false);
  assert.equal(bySlug.personal.shared, false);
  assert.equal(bySlug.lieferanten_shared_by_bob.kind, "addressbook");
  assert.equal(bySlug.lieferanten_shared_by_bob.readOnly, true);
  assert.equal(bySlug.contacts.readOnly, false);
});

test("wrong password is reported as auth error", { skip }, async () => {
  const client = new DavClient({ serverUrl: DAV_URL, username: DAV_USER, password: "falsch", DOMParser });
  await assert.rejects(client.discover(), e => e.kind === "auth");
});

test("unreachable server is reported as network error", { skip }, async () => {
  const client = new DavClient({ serverUrl: "http://127.0.0.1:9/", username: "x", password: "y", DOMParser, timeoutMs: 3000 });
  await assert.rejects(client.discover(), e => e.kind === "network");
});

test("probes the auth realm", { skip }, async () => {
  assert.equal(await probeRealm(DAV_URL), "Nextcloud");
});
