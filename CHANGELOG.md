# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.3.0]

- `calendarRefreshMinutes` and `addressBookSyncMinutes` are now applied to managed calendars and address books created earlier as well, not only when they are added. Thunderbird re-arms its refresh timers immediately.
- Default for both is now 15 minutes (was 30).
- Taking over an existing subscription also sets the polling interval.

## [0.2.0]

- New option `calendars.remindersForShared`: with `false`, calendars shared by others get "Show reminders" switched off, once per calendar, also for calendars added before the setting. Users can switch reminders on again; the add-on keeps their choice.

## [0.1.2]

- Fix: taking the login from the mail account (`credentialSource: "mail"`) never found the mail server on Thunderbird 153, because `nsIMsgIncomingServer.hostName` is now `hostname`.
- Fix: updating a stored login after a password change failed on Thunderbird 153, which removed `modifyLogin`; now uses `modifyLoginAsync`.
- End-to-end test covers the mail-account login path, including replacing an outdated DAV password.

## [0.1.1]

- Build is now reproducible across machines: the XPI is written by `scripts/build.mjs` with uncompressed entries, fixed order, timestamps and attributes. Builds of 0.1.0 from macOS and Linux differed in their compressed data.

## [0.1.0]

First release.

- Discovers all CalDAV calendars and CardDAV address books of an account (own and shared) and keeps Thunderbird in step: new ones are added, renamed ones renamed, removed ones unsubscribed.
- Safety rules: no removal when a listing fails, removal only after repeated misses, no removal when the server suddenly reports nothing, unsubscribing never deletes anything on the server.
- Takes over existing subscriptions with the same URL instead of duplicating them, including calendars Thunderbird re-creates when the offline cache is toggled.
- Switches calendars back on that Thunderbird disabled after a server error; calendars the user disabled stay off.
- Login from the mail account (kept in step when the password changes) or a stored DAV login; stops after a rejected login.
- Central configuration through `policies.json` (managed storage); options page with status, log and manual sync.
- English and German.
