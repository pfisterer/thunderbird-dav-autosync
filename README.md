# DAV Autosync

> **Status: untested alpha code.** Not yet used in production. Expect bugs and breaking changes, and try it with test profiles before rolling it out.

Thunderbird add-on that keeps CalDAV calendars and CardDAV address books in step with what the server offers. Calendars and address books that appear on the server (own or shared) are added, renamed ones are renamed, removed ones disappear. Works with any standards-compliant CalDAV/CardDAV server; tested with Nextcloud.

Thunderbird itself only discovers calendars once, when an account is set up. TbSync's CalDAV provider, the usual workaround, has been discontinued. This add-on fills that gap for centrally managed installations.

## How it works

- At start-up and then every `intervalMinutes`, the add-on looks up the user's principal, the calendar and address book home sets, and lists all collections (RFC 4791, RFC 6352).
- It compares the result with the calendars and address books it created earlier. These carry the property `davautosync.managedBy`; everything the user added by hand is never touched.
- Safety rules:
  - nothing is removed when a listing fails;
  - an item is removed only after it was missing from `removeAfterMissing` consecutive successful listings;
  - if the server suddenly reports no items at all, nothing is removed;
  - removing only unsubscribes in Thunderbird, it never deletes anything on the server.
- Existing subscriptions with the same URL and username are taken over instead of duplicated. This covers calendars subscribed by hand before the roll-out, and calendars Thunderbird re-creates when the offline cache is toggled (it copies only a fixed list of properties, so the marker is lost).
- When Thunderbird disables a calendar after an error answer (it marks it `auto-enabled` and would only re-enable it at the next start), the add-on switches it back on as soon as the server lists it again. A calendar the user disabled stays off.
- A sync can be triggered at any time with the observer topic `dav-autosync-sync-now` (for example from the browser console: `Services.obs.notifyObservers(null, "dav-autosync-sync-now")`) or with the button on the options page.
- After a rejected login the add-on stops trying with that password until it changes, so the server's brute-force protection does not lock the office IP.

## Login

By default (`credentialSource: "mail"`) the add-on uses the password Thunderbird already stores for the mail account. It saves it as the DAV login (origin + realm of the DAV server, where Thunderbird's calendar and address book code looks for it) and keeps it in step when the mail password changes. With `credentialSource: "stored"` it only uses a DAV login that already exists or was entered on the add-on's options page.

If the DAV server requires two-factor authentication, an app password is needed. Login Flow v2 is not implemented yet.

## Deployment

DAV Autosync is meant for centrally managed Thunderbird installations. It is not on addons.thunderbird.net: ATN currently does not accept new add-ons that use Experiment APIs.

**Use Thunderbird ESR.** From version 153 the monthly Release channel refuses add-ons with Experiment APIs; ESR is not affected. The add-on is tested with ESR 153 and declares `strict_max_version` 153.*, so it is switched off by Thunderbird on a newer major version until a release for that version exists. Check for one before upgrading to the next ESR.

Put a `policies.json` into Thunderbird's `distribution` folder (on Windows `C:\Program Files\Mozilla Thunderbird\distribution\`), or set the same keys through the Thunderbird ADMX templates.

### Pinned version (recommended)

The administrator decides when a new version reaches the clients: change the version in `install_url`, and Thunderbird installs it at the next start. `updates_disabled` stops any other update path.

```json
{
  "policies": {
    "ExtensionSettings": {
      "dav-autosync@e0bef3fb-e03d-4a07-90cb-afbe6f17613e": {
        "installation_mode": "force_installed",
        "install_url": "https://github.com/pfisterer/thunderbird-dav-autosync/releases/download/v0.1.2/dav-autosync-0.1.2.xpi",
        "updates_disabled": true
      }
    },
    "Preferences": {
      "extensions.experiments.allowed": {
        "Value": "tbpro-add-on@thunderbird.net,owl@beonex.com,dav-autosync@e0bef3fb-e03d-4a07-90cb-afbe6f17613e",
        "Status": "locked"
      }
    },
    "3rdparty": {
      "Extensions": {
        "dav-autosync@e0bef3fb-e03d-4a07-90cb-afbe6f17613e": {
          "serverUrl": "https://cloud.example.org/remote.php/dav/",
          "credentialSource": "mail",
          "calendars": { "exclude": ["contact_birthdays"] },
          "addressBooks": { "exclude": ["z-*-generated--*"] }
        }
      }
    }
  }
}
```

`install_url` can also point to a copy on a file share (`file://///server/share/dav-autosync-0.1.2.xpi` for `\\server\share\dav-autosync-0.1.2.xpi`) if the clients should not download from GitHub.

### Automatic updates

Instead of a version, let Thunderbird follow the releases (needs Thunderbird 153.0.2 ESR or later for the per-extension `update_url`):

```json
"dav-autosync@e0bef3fb-e03d-4a07-90cb-afbe6f17613e": {
  "installation_mode": "force_installed",
  "install_url": "https://github.com/pfisterer/thunderbird-dav-autosync/releases/latest/download/dav-autosync.xpi",
  "update_url": "https://github.com/pfisterer/thunderbird-dav-autosync/releases/latest/download/updates.json"
}
```

Every release then reaches all clients without further action. Consider who can publish releases in this repository before choosing this variant: the add-on runs with full access to Thunderbird.

### Experiment allow-list

`extensions.experiments.allowed` keeps the add-on working if Thunderbird switches on its suppression of Experiment add-ons (`extensions.experiments.suppressed`), which it plans for the Release channel. Keep the two IDs Thunderbird ships in that list, otherwise its own add-ons lose their exception. Tested on ESR 153: with suppression on, the add-on is blocked; with its ID in the list, it stays active.

### Verifying a release

Releases are built by GitHub Actions with a build provenance attestation:

```sh
gh attestation verify dav-autosync-0.1.2.xpi --repo pfisterer/thunderbird-dav-autosync
```

`SHA256SUMS` and the `update_hash` in `updates.json` give the checksum as well.

### Permissions

The add-on requests access to all hosts because the DAV server is known only from the configuration. It sends requests to the configured `serverUrl` only; see [PRIVACY.md](PRIVACY.md).

### Configuration keys

| Key | Default | Meaning |
|---|---|---|
| `serverUrl` | – | DAV entry point; for Nextcloud `https://host/remote.php/dav/`. The server root also works if it serves `/.well-known/caldav`. |
| `credentialSource` | `mail` | `mail` = take the password from the mail account; `stored` = use the stored DAV login only |
| `mailHost` | first IMAP/POP account | Incoming server to take the login from |
| `usernameFrom` | `login` | DAV username: `login` (mail login name), `email`, or `localpart` (part before @) |
| `intervalMinutes` | 15 | Sync interval (minimum 5) |
| `removeAfterMissing` | 2 | Consecutive misses before removal |
| `calendars.enabled` / `addressBooks.enabled` | true | Sync this kind at all |
| `calendars.includeShared` / `addressBooks.includeShared` | true | Include collections shared by others |
| `calendars.exclude` / `addressBooks.exclude` | [] | Glob patterns on URL slug or display name |
| `calendars.components` | `["VEVENT","VTODO"]` | Only calendars supporting at least one of these |
| `calendarRefreshMinutes` / `addressBookSyncMinutes` | 30 | Refresh intervals set on created items |
| `cache` | true | Offline cache for calendars |
| `profileId` | `default` | Separates several configurations in one profile |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `scripts/nc-test.sh start` (ephemeral Nextcloud), `npm test`, `scripts/get-thunderbird.sh` and `npm run e2e` (real Thunderbird ESR, configured through `policies.json` like in production), `npm run lint` (Thunderbird's review linter), `scripts/tb-test.sh` for an interactive test Thunderbird with its own profile.

## Layout

- `addon/src/dav.js`: discovery, runs in the add-on and in Node
- `addon/src/reconcile.js`: pure planning step with all safety rules
- `addon/background.js`: configuration, login, scheduling, executing the plan
- `addon/api/`: experiment API, the only part that uses Thunderbird internals
- `test/`: unit, integration and end-to-end tests

## License

Apache License 2.0, see [LICENSE](LICENSE).
