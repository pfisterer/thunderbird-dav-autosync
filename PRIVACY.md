# Privacy policy

DAV Autosync does not collect, transmit or share any data with the developer or with third parties. There is no telemetry and no remote code.

What the add-on does with data:

- **Server address and settings** come from the administrator's `policies.json` or from what you enter on the add-on's options page.
- **Login data:** the add-on uses the user name and password stored in Thunderbird's password manager for the configured server, or, if configured that way, the password of your mail account. It sends them only to the configured server, as HTTP authentication; use an `https` server address so they are encrypted in transit.
- **Data sent to the server:** requests listing your calendars and address books (names, colours, access rights). Calendar entries and contacts themselves are synchronised by Thunderbird's own CalDAV and CardDAV support, not by this add-on.
- **Data stored locally:** the add-on's status, a log of its last 200 actions (names of calendars and address books, no contents, no passwords) and the configuration, all in Thunderbird's extension storage on your computer.

You can stop all of this by disabling or removing the add-on. Calendars and address books it added stay in Thunderbird until you remove them; nothing is deleted on the server.
