// Messages are kept as { code, params } and translated only when shown, so stored log entries follow a later change of Thunderbird's UI language.
// A param may itself be a message (e.g. the kind "calendar"), which is translated recursively.
// This module has no dependency on the browser API at import time, so src/ stays usable in Node tests.

export function msg(code, ...params) {
  return { code, params };
}

const browserGetMessage = globalThis.browser?.i18n ? (code, subs) => globalThis.browser.i18n.getMessage(code, subs) : null;

export function translate(m, getMessage = browserGetMessage) {
  if (m == null) {
    return "";
  }
  // A list of messages, e.g. the changed properties of a calendar.
  if (Array.isArray(m)) {
    return m.map(x => translate(x, getMessage)).join(", ");
  }
  if (typeof m !== "object") {
    return String(m);
  }
  const subs = (m.params || []).map(p => translate(p, getMessage));
  const text = getMessage ? getMessage(m.code, subs) : "";
  // Unknown code or no i18n available: still show something useful.
  return text || [m.code, ...subs].join(" ");
}

export const kindMsg = kind => msg(kind === "calendar" ? "kindCalendar" : "kindAddressBook");
