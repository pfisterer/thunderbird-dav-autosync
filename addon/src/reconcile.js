// Pure planning step: compares what the server offers with what this add-on created earlier and returns the actions to take.
// No Thunderbird or network access here, so every safety rule can be unit-tested.

import { normalizeUrl } from "./dav.js";
import { msg, kindMsg } from "./i18n.js";

export const DEFAULT_OPTIONS = {
  // remindersForShared: false switches off reminders for calendars shared by others, once per calendar (when it is added,
  // or for calendars added earlier on the first run with the setting). Users can switch them on again; that is kept.
  calendars: { enabled: true, includeShared: true, exclude: [], components: ["VEVENT", "VTODO"], remindersForShared: true },
  addressBooks: { enabled: true, includeShared: true, exclude: [] },
  // A managed item is removed only after it was missing from this many consecutive successful listings.
  removeAfterMissing: 2,
};

/**
 * @param {object} input
 * @param {{calendars: object[]|null, addressBooks: object[]|null}} input.remote - discovery result; null = listing failed, do not touch
 * @param {{calendars: object[], addressBooks: object[]}} input.local - items this add-on manages (calendars: {id,url,name,color,readOnly,disabled,autoDisabled}; address books: {uid,url,name,readOnly})
 * @param {{missing?: Object<string, number>, remindersApplied?: Object<string, boolean>}} [input.state] - persisted between runs
 * @param {object} [input.options]
 * @returns {{actions: object[], state: {missing: Object<string, number>, remindersApplied: Object<string, boolean>}, warnings: {code: string, params: any[]}[]}}
 */
export function plan({ remote, local, state = {}, options = {} }) {
  const opts = mergeOptions(options);
  const missing = { ...(state.missing || {}) };
  const remindersApplied = { ...(state.remindersApplied || {}) };
  const actions = [];
  const warnings = [];

  const kinds = [
    { kind: "calendar", key: "calendars", idField: "id" },
    { kind: "addressbook", key: "addressBooks", idField: "uid" },
  ];

  for (const { kind, key, idField } of kinds) {
    const kindOpts = opts[key];
    const remoteList = remote?.[key];
    const localList = local?.[key] || [];
    if (!kindOpts.enabled) {
      continue;
    }
    if (remoteList == null) {
      warnings.push(msg("warnListingUnavailable", kindMsg(kind)));
      continue;
    }

    const wanted = new Map();
    for (const item of remoteList) {
      if (accept(item, kindOpts)) {
        wanted.set(normalizeUrl(item.url), item);
      }
    }

    // Group local items by URL; more than one per URL means a duplicate from an interrupted earlier run.
    const localByUrl = new Map();
    for (const item of localList) {
      const k = normalizeUrl(item.url);
      if (!localByUrl.has(k)) {
        localByUrl.set(k, []);
      }
      localByUrl.get(k).push(item);
    }

    for (const [k, items] of localByUrl) {
      for (const dup of items.slice(1)) {
        actions.push({ op: "remove", kind, [idField]: dup[idField], url: dup.url, name: dup.name, reason: "duplicate" });
      }
      const item = items[0];
      const remoteItem = wanted.get(k);
      if (remoteItem) {
        delete missing[k];
        const changes = diff(item, remoteItem, kind);
        if (kind === "calendar" && remindersOff(remoteItem, kindOpts) && !remindersApplied[k]) {
          changes.suppressAlarms = true;
          remindersApplied[k] = true;
        }
        if (Object.keys(changes).length) {
          actions.push({ op: "update", kind, [idField]: item[idField], url: item.url, name: item.name, changes });
        }
      }
    }

    // Removals, guarded: an empty server list while we manage items looks like a server or permission problem, not like "everything was deleted".
    const vanished = [...localByUrl.keys()].filter(k => !wanted.has(k));
    if (vanished.length && wanted.size === 0) {
      warnings.push(msg("warnServerEmpty", kindMsg(kind), String(vanished.length)));
    } else {
      for (const k of vanished) {
        const item = localByUrl.get(k)[0];
        missing[k] = (missing[k] || 0) + 1;
        if (missing[k] >= opts.removeAfterMissing) {
          actions.push({ op: "remove", kind, [idField]: item[idField], url: item.url, name: item.name, reason: "goneFromServer" });
          delete missing[k];
        } else {
          warnings.push(msg("warnRemovalDeferred", kindMsg(kind), item.name, String(missing[k]), String(opts.removeAfterMissing)));
        }
      }
    }

    for (const [k, remoteItem] of wanted) {
      if (!localByUrl.has(k)) {
        const action = { op: "create", kind, item: remoteItem };
        if (kind === "calendar" && remindersOff(remoteItem, kindOpts)) {
          action.suppressAlarms = true;
          remindersApplied[k] = true;
        }
        actions.push(action);
      }
    }
  }

  // Forget counters for URLs that are neither managed nor wanted any more.
  const managedUrls = new Set([...(local?.calendars || []), ...(local?.addressBooks || [])].map(i => normalizeUrl(i.url)));
  for (const k of Object.keys(missing)) {
    if (!managedUrls.has(k)) {
      delete missing[k];
    }
  }
  const wantedNow = new Set((remote?.calendars || []).map(i => normalizeUrl(i.url)));
  for (const k of Object.keys(remindersApplied)) {
    if (!managedUrls.has(k) && !wantedNow.has(k)) {
      delete remindersApplied[k];
    }
  }

  return { actions, state: { missing, remindersApplied }, warnings };
}

function remindersOff(item, kindOpts) {
  return kindOpts.remindersForShared === false && Boolean(item.shared);
}

function accept(item, kindOpts) {
  if (item.shared && !kindOpts.includeShared) {
    return false;
  }
  if (kindOpts.exclude.some(pattern => globMatch(pattern, item.slug) || globMatch(pattern, item.name))) {
    return false;
  }
  if (item.kind === "calendar" && item.components?.length && kindOpts.components?.length) {
    if (!item.components.some(c => kindOpts.components.includes(c))) {
      return false;
    }
  }
  return true;
}

function diff(localItem, remoteItem, kind) {
  const changes = {};
  if (remoteItem.name && remoteItem.name !== localItem.name) {
    changes.name = remoteItem.name;
  }
  if (kind === "calendar" && remoteItem.color && remoteItem.color !== (localItem.color || "").toLowerCase()) {
    changes.color = remoteItem.color;
  }
  if (Boolean(remoteItem.readOnly) !== Boolean(localItem.readOnly)) {
    changes.readOnly = Boolean(remoteItem.readOnly);
  }
  // Thunderbird disables a calendar after a 4xx answer and marks it "auto-enabled" (re-enabled at the next start).
  // The server lists it again, so switch it back on now. A calendar the user disabled has no such mark and stays off.
  if (kind === "calendar" && localItem.disabled && localItem.autoDisabled) {
    changes.enabled = true;
  }
  return changes;
}

export function globMatch(pattern, text) {
  if (!text) {
    return false;
  }
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$", "i");
  return re.test(text);
}

function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function mergeOptions(options = {}) {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    calendars: { ...DEFAULT_OPTIONS.calendars, ...(options.calendars || {}) },
    addressBooks: { ...DEFAULT_OPTIONS.addressBooks, ...(options.addressBooks || {}) },
  };
}
