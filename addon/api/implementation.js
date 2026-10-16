/* eslint-disable no-var */
"use strict";

// Privileged part of dav-autosync. Kept deliberately small: everything that does not need Thunderbird internals lives in the background page.

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
var { ExtensionError } = ExtensionUtils;
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
var { CardDAVDirectory } = ChromeUtils.importESModule("resource:///modules/CardDAVDirectory.sys.mjs");

// Property names written to calendar.registry.<id>.* and ldap_2.servers.<name>.*
var TAG_PROP = "davautosync.managedBy";
var URL_PROP = "davautosync.url";

var SYNC_TOPIC = "dav-autosync-sync-now";

// Same rules as normalizeUrl() in src/dav.js: no fragment, decoded path with trailing slash, lower-case host.
function normalizeUrl(spec) {
  try {
    const u = new URL(spec);
    let path = decodeURIComponent(u.pathname);
    if (!path.endsWith("/")) {
      path += "/";
    }
    return `${u.protocol}//${u.host.toLowerCase()}${path}`;
  } catch {
    return spec;
  }
}

function newLoginInfo(origin, realm, username, password) {
  const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  login.init(origin, null, realm, username, password, "", "");
  return login;
}

this.davAutosync = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      davAutosync: {
        onSyncRequested: new ExtensionCommon.EventManager({
          context,
          name: "davAutosync.onSyncRequested",
          register: fire => {
            const observer = { observe: () => fire.async() };
            Services.obs.addObserver(observer, SYNC_TOPIC);
            return () => Services.obs.removeObserver(observer, SYNC_TOPIC);
          },
        }).api(),

        async listManaged(tag) {
          const calendars = cal.manager
            .getCalendars()
            .filter(c => c.getProperty(TAG_PROP) === tag)
            .map(c => ({
              id: c.id,
              url: c.getProperty(URL_PROP) || c.uri.spec,
              name: c.name,
              color: c.getProperty("color") || "",
              readOnly: Boolean(c.readOnly),
              username: c.getProperty("username") || "",
              disabled: Boolean(c.getProperty("disabled")),
              autoDisabled: Boolean(c.getProperty("auto-enabled")),
            }));
          const addressBooks = MailServices.ab.directories
            .filter(d => d.dirType === Ci.nsIAbManager.CARDDAV_DIRECTORY_TYPE && d.getStringValue(TAG_PROP, "") === tag)
            .map(d => ({
              uid: d.UID,
              url: d.getStringValue("carddav.url", ""),
              name: d.dirName,
              readOnly: d.getBoolValue("readOnly", false),
              username: d.getStringValue("carddav.username", ""),
            }));
          return { calendars, addressBooks };
        },

        async createCalendar(spec) {
          const calendar = cal.manager.createCalendar("caldav", Services.io.newURI(spec.url));
          calendar.name = spec.name;
          calendar.setProperty("color", spec.color || cal.view.hashColor(spec.url));
          calendar.setProperty("username", spec.username);
          if (!calendar.getProperty("cache.always")) {
            calendar.setProperty("cache.enabled", spec.cache !== false && calendar.getProperty("cache.supported") !== false);
          }
          if (spec.refreshMinutes) {
            calendar.setProperty("refreshInterval", String(spec.refreshMinutes));
          }
          calendar.readOnly = Boolean(spec.readOnly);
          if (spec.suppressAlarms) {
            // Same property as "Show reminders" in the calendar properties dialog.
            calendar.setProperty("suppressAlarms", true);
          }
          calendar.setProperty(TAG_PROP, spec.tag);
          calendar.setProperty(URL_PROP, spec.url);
          calendar.id = cal.getUUID();
          cal.manager.registerCalendar(calendar);
          return calendar.id;
        },

        async updateCalendar(id, changes) {
          const calendar = cal.manager.getCalendarById(id);
          if (!calendar) {
            throw new ExtensionError(`Kalender ${id} nicht gefunden`);
          }
          if ("name" in changes) {
            calendar.name = changes.name;
          }
          if ("color" in changes) {
            calendar.setProperty("color", changes.color);
          }
          if ("readOnly" in changes) {
            calendar.readOnly = Boolean(changes.readOnly);
          }
          if ("suppressAlarms" in changes) {
            calendar.setProperty("suppressAlarms", Boolean(changes.suppressAlarms));
          }
          if (changes.enabled) {
            // Same as Thunderbird's calendar properties dialog.
            calendar.setProperty("disabled", false);
            calendar.deleteProperty("auto-enabled");
          }
        },

        // Calendars lose our marker when Thunderbird re-creates them (e.g. after toggling the offline cache, which copies only a fixed property list),
        // and users may have subscribed by hand before the roll-out. Taking those over avoids duplicates.
        async adoptCalendar(url, username, tag) {
          const want = normalizeUrl(url);
          const calendar = cal.manager
            .getCalendars()
            .find(c => c.type === "caldav" && !c.getProperty(TAG_PROP) && normalizeUrl(c.uri.spec) === want && (c.getProperty("username") || "") === username);
          if (!calendar) {
            return null;
          }
          calendar.setProperty(TAG_PROP, tag);
          calendar.setProperty(URL_PROP, url);
          return calendar.id;
        },

        async removeCalendar(id) {
          const calendar = cal.manager.getCalendarById(id);
          if (!calendar) {
            return false;
          }
          // REMOVE_NO_DELETE: unsubscribe only, even for providers that could delete the calendar on the server.
          cal.manager.removeCalendar(calendar, Ci.calICalendarManager.REMOVE_NO_DELETE);
          return true;
        },

        async createAddressBook(spec) {
          const dirPrefId = MailServices.ab.newAddressBook(spec.name, null, Ci.nsIAbManager.CARDDAV_DIRECTORY_TYPE, null);
          const book = MailServices.ab.getDirectoryFromId(dirPrefId);
          book.setStringValue("carddav.url", spec.url);
          book.setStringValue("carddav.username", spec.username);
          if (spec.syncMinutes) {
            book.setIntValue("carddav.syncinterval", spec.syncMinutes);
          }
          book.setBoolValue("readOnly", Boolean(spec.readOnly));
          book.setStringValue(TAG_PROP, spec.tag);
          const dir = CardDAVDirectory.forFile(book.fileName);
          dir.fetchAllFromServer().catch(e => console.error("dav-autosync: first CardDAV sync failed", e));
          return book.UID;
        },

        async adoptAddressBook(url, username, tag) {
          const want = normalizeUrl(url);
          const book = MailServices.ab.directories.find(
            d =>
              d.dirType === Ci.nsIAbManager.CARDDAV_DIRECTORY_TYPE &&
              !d.getStringValue(TAG_PROP, "") &&
              normalizeUrl(d.getStringValue("carddav.url", "")) === want &&
              d.getStringValue("carddav.username", "") === username
          );
          if (!book) {
            return null;
          }
          book.setStringValue(TAG_PROP, tag);
          return book.UID;
        },

        async updateAddressBook(uid, changes) {
          const book = MailServices.ab.getDirectoryFromUID(uid);
          if (!book) {
            throw new ExtensionError(`Adressbuch ${uid} nicht gefunden`);
          }
          if ("name" in changes) {
            book.dirName = changes.name;
          }
          if ("readOnly" in changes) {
            book.setBoolValue("readOnly", Boolean(changes.readOnly));
          }
        },

        async removeAddressBook(uid) {
          const book = MailServices.ab.getDirectoryFromUID(uid);
          if (!book) {
            return false;
          }
          MailServices.ab.deleteAddressBook(book.URI);
          return true;
        },

        async getLogin(origin, realm, username) {
          await Services.logins.initializationPromise;
          const logins = await Services.logins.searchLoginsAsync({ origin, httpRealm: realm });
          const login = logins.find(l => !username || l.username === username);
          return login ? { username: login.username, password: login.password } : null;
        },

        async setLogin(origin, realm, username, password) {
          await Services.logins.initializationPromise;
          const logins = await Services.logins.searchLoginsAsync({ origin, httpRealm: realm });
          const existing = logins.find(l => l.username === username);
          const updated = newLoginInfo(origin, realm, username, password);
          if (existing) {
            if (existing.password !== password) {
              await Services.logins.modifyLoginAsync(existing, updated);
            }
          } else {
            await Services.logins.addLoginAsync(updated);
          }
        },

        async getMailLogin(host) {
          await Services.logins.initializationPromise;
          for (const account of MailServices.accounts.accounts) {
            const server = account.incomingServer;
            if (!server || !["imap", "pop3"].includes(server.type)) {
              continue;
            }
            // nsIMsgIncomingServer.hostName was renamed to hostname; support both.
            const hostname = server.hostname ?? server.hostName;
            if (host && hostname.toLowerCase() !== host.toLowerCase()) {
              continue;
            }
            const scheme = server.type === "pop3" ? "mailbox" : "imap";
            const logins = await Services.logins.searchLoginsAsync({ origin: `${scheme}://${hostname}` });
            const login = logins.find(l => l.username === server.username);
            if (login) {
              return {
                host: hostname,
                username: server.username,
                password: login.password,
                email: account.defaultIdentity?.email || "",
              };
            }
          }
          return null;
        },
      },
    };
  }
};
