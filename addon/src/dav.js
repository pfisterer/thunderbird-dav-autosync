// CalDAV/CardDAV discovery (RFC 4791, RFC 6352, RFC 5397, RFC 3744).
// Runs unchanged in the add-on background page (native fetch/DOMParser) and in Node tests (injected fetch/DOMParser).

const NS = {
  d: "DAV:",
  c: "urn:ietf:params:xml:ns:caldav",
  card: "urn:ietf:params:xml:ns:carddav",
  a: "http://apple.com/ns/ical/",
  cs: "http://calendarserver.org/ns/",
};

const WRITE_PRIVILEGES = ["write", "write-content", "bind", "all"];

export class DavError extends Error {
  /**
   * @param {string} message - English text for logs and developers
   * @param {object} details
   * @param {string} details.code - i18n message code for users (see _locales)
   * @param {string[]} [details.params] - substitutions for that message
   */
  constructor(message, { status = 0, url = "", kind = "error", code = "davUnexpected", params = [] } = {}) {
    super(message);
    this.name = "DavError";
    this.status = status;
    this.url = url;
    // "auth" = credentials rejected, "network" = server unreachable, "error" = anything else
    this.kind = kind;
    this.code = code;
    this.params = params;
  }
}

const PROPFIND_PRINCIPAL = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;

const PROPFIND_HOMES = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><c:calendar-home-set/><card:addressbook-home-set/><d:displayname/></d:prop>
</d:propfind>`;

const PROPFIND_COLLECTIONS = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:resourcetype/><d:displayname/><d:owner/><d:current-user-privilege-set/>
    <a:calendar-color/><c:supported-calendar-component-set/><cs:getctag/>
  </d:prop>
</d:propfind>`;

export class DavClient {
  /**
   * @param {object} options
   * @param {string} options.serverUrl - DAV entry point, e.g. https://cloud.example.org/remote.php/dav/ or just https://cloud.example.org/
   * @param {string} options.username
   * @param {string} options.password
   * @param {Function} [options.fetch] - fetch implementation (defaults to globalThis.fetch)
   * @param {Function} [options.DOMParser] - DOMParser constructor (defaults to globalThis.DOMParser)
   * @param {number} [options.timeoutMs]
   */
  constructor({ serverUrl, username, password, fetch, DOMParser, timeoutMs = 30000 }) {
    this.serverUrl = new URL(serverUrl).href;
    this.username = username;
    this.password = password;
    this.fetch = fetch || globalThis.fetch.bind(globalThis);
    this.DOMParser = DOMParser || globalThis.DOMParser;
    this.timeoutMs = timeoutMs;
  }

  authHeader() {
    const bytes = new TextEncoder().encode(`${this.username}:${this.password}`);
    let binary = "";
    for (const b of bytes) {
      binary += String.fromCharCode(b);
    }
    return "Basic " + btoa(binary);
  }

  async propfind(url, depth, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetch(url, {
        method: "PROPFIND",
        headers: {
          Authorization: this.authHeader(),
          Depth: String(depth),
          "Content-Type": "application/xml; charset=utf-8",
        },
        body,
        credentials: "omit",
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (e) {
      throw new DavError(`Server unreachable: ${e.message}`, { url, kind: "network", code: "davNetwork", params: [e.message] });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401 || response.status === 403) {
      throw new DavError(`Login rejected (HTTP ${response.status})`, { status: response.status, url, kind: "auth", code: "davAuth", params: [String(response.status)] });
    }
    if (response.status !== 207) {
      throw new DavError(`Unexpected answer HTTP ${response.status}`, { status: response.status, url, code: "davStatus", params: [String(response.status)] });
    }
    const text = await response.text();
    const doc = new this.DOMParser().parseFromString(text, "application/xml");
    if (!doc || !doc.documentElement || doc.documentElement.localName !== "multistatus") {
      throw new DavError("Answer is not a WebDAV multistatus", { url, code: "davNotMultistatus" });
    }
    return parseMultistatus(doc, response.url || url);
  }

  /** Finds the principal URL, trying the configured URL first and then the well-known locations. */
  async findPrincipal() {
    const candidates = [this.serverUrl, new URL("/.well-known/caldav", this.serverUrl).href, new URL("/.well-known/carddav", this.serverUrl).href];
    let lastError;
    for (const url of candidates) {
      try {
        const responses = await this.propfind(url, 0, PROPFIND_PRINCIPAL);
        for (const r of responses) {
          const href = firstHref(r.props, NS.d, "current-user-principal");
          if (href) {
            return new URL(href, r.href).href;
          }
        }
      } catch (e) {
        if (e.kind === "auth" || e.kind === "network") {
          throw e;
        }
        lastError = e;
      }
    }
    throw lastError || new DavError("No current-user-principal found", { url: this.serverUrl, code: "davNoPrincipal" });
  }

  /** Returns { principal, calendarHomes: [url], addressBookHomes: [url] } */
  async findHomes() {
    const principal = await this.findPrincipal();
    const responses = await this.propfind(principal, 0, PROPFIND_HOMES);
    const calendarHomes = [];
    const addressBookHomes = [];
    for (const r of responses) {
      for (const h of allHrefs(r.props, NS.c, "calendar-home-set")) {
        calendarHomes.push(new URL(h, r.href).href);
      }
      for (const h of allHrefs(r.props, NS.card, "addressbook-home-set")) {
        addressBookHomes.push(new URL(h, r.href).href);
      }
    }
    return { principal, calendarHomes: unique(calendarHomes), addressBookHomes: unique(addressBookHomes) };
  }

  /** Lists all calendar or address book collections below the given home sets. */
  async listCollections(homes, kind, principal) {
    const result = [];
    for (const home of homes) {
      const responses = await this.propfind(home, 1, PROPFIND_COLLECTIONS);
      for (const r of responses) {
        const types = r.props.resourcetype || [];
        const isCalendar = types.some(t => t.ns === NS.c && t.name === "calendar");
        const isAddressBook = types.some(t => t.ns === NS.card && t.name === "addressbook");
        if ((kind === "calendar" && !isCalendar) || (kind === "addressbook" && !isAddressBook)) {
          continue;
        }
        const url = new URL(r.href, home).href;
        const owner = firstHref(r.props, NS.d, "owner");
        const ownerUrl = owner ? new URL(owner, url).href : "";
        const privileges = r.props.privileges;
        const item = {
          kind,
          url,
          slug: decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || ""),
          name: r.props.displayname || "",
          owner: ownerUrl,
          shared: Boolean(ownerUrl && principal && normalizeUrl(ownerUrl) !== normalizeUrl(principal)),
          // Without a privilege set we cannot tell, so assume writable like Thunderbird does.
          readOnly: privileges ? !WRITE_PRIVILEGES.some(p => privileges.includes(p)) : false,
          ctag: r.props.getctag || "",
        };
        if (kind === "calendar") {
          item.color = normalizeColor(r.props.color);
          item.components = r.props.components || [];
        }
        if (!item.name) {
          item.name = item.slug || url;
        }
        result.push(item);
      }
    }
    return result;
  }

  /** Full discovery: { principal, calendars: [...] | null, addressBooks: [...] | null }. null = that part could not be listed. */
  async discover({ calendars = true, addressBooks = true } = {}) {
    const homes = await this.findHomes();
    const out = { principal: homes.principal, calendars: null, addressBooks: null };
    if (calendars && homes.calendarHomes.length) {
      out.calendars = await this.listCollections(homes.calendarHomes, "calendar", homes.principal);
    }
    if (addressBooks && homes.addressBookHomes.length) {
      out.addressBooks = await this.listCollections(homes.addressBookHomes, "addressbook", homes.principal);
    }
    return out;
  }
}

/** Reads the HTTP auth realm the server announces, needed to store the login where Thunderbird looks for it. */
export async function probeRealm(serverUrl, fetchImpl = globalThis.fetch.bind(globalThis)) {
  try {
    const response = await fetchImpl(serverUrl, { method: "PROPFIND", headers: { Depth: "0" }, credentials: "omit" });
    const header = response.headers.get("www-authenticate") || "";
    const m = /realm="([^"]*)"/i.exec(header);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function parseMultistatus(doc, baseUrl) {
  const out = [];
  for (const response of childrenNS(doc.documentElement, NS.d, "response")) {
    const hrefEl = childrenNS(response, NS.d, "href")[0];
    if (!hrefEl) {
      continue;
    }
    const props = {};
    for (const propstat of childrenNS(response, NS.d, "propstat")) {
      const status = textOf(childrenNS(propstat, NS.d, "status")[0]);
      if (status && !/\s2\d\d\s/.test(status + " ")) {
        continue;
      }
      const prop = childrenNS(propstat, NS.d, "prop")[0];
      if (!prop) {
        continue;
      }
      for (const el of elementChildren(prop)) {
        readProp(el, props);
      }
    }
    out.push({ href: new URL(textOf(hrefEl).trim(), baseUrl).href, props });
  }
  return out;
}

function readProp(el, props) {
  const key = `${el.namespaceURI}|${el.localName}`;
  switch (key) {
    case `${NS.d}|resourcetype`:
      props.resourcetype = elementChildren(el).map(t => ({ ns: t.namespaceURI, name: t.localName }));
      break;
    case `${NS.d}|displayname`:
      props.displayname = textOf(el).trim();
      break;
    case `${NS.a}|calendar-color`:
      props.color = textOf(el).trim();
      break;
    case `${NS.cs}|getctag`:
      props.getctag = textOf(el).trim();
      break;
    case `${NS.c}|supported-calendar-component-set`:
      props.components = childrenNS(el, NS.c, "comp").map(c => c.getAttribute("name"));
      break;
    case `${NS.d}|current-user-privilege-set`:
      props.privileges = [];
      for (const priv of childrenNS(el, NS.d, "privilege")) {
        for (const p of elementChildren(priv)) {
          props.privileges.push(p.localName);
        }
      }
      break;
    default:
      // Href-valued properties (owner, current-user-principal, *-home-set)
      props[key] = childrenNS(el, NS.d, "href").map(h => textOf(h).trim());
  }
}

function firstHref(props, ns, name) {
  return allHrefs(props, ns, name)[0] || null;
}

function allHrefs(props, ns, name) {
  return props[`${ns}|${name}`] || [];
}

function elementChildren(el) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) {
      out.push(n);
    }
  }
  return out;
}

function childrenNS(el, ns, name) {
  return elementChildren(el).filter(c => c.namespaceURI === ns && c.localName === name);
}

function textOf(el) {
  return el ? el.textContent || "" : "";
}

function unique(list) {
  return [...new Set(list)];
}

export function normalizeUrl(url) {
  const u = new URL(url);
  u.hash = "";
  let path = decodeURIComponent(u.pathname);
  if (!path.endsWith("/")) {
    path += "/";
  }
  return `${u.protocol}//${u.host.toLowerCase()}${path}`;
}

function normalizeColor(color) {
  if (!color) {
    return "";
  }
  // Some servers send #RRGGBBAA; Thunderbird expects #RRGGBB.
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  return m ? `#${m[1].toLowerCase()}` : "";
}
