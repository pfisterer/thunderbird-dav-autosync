# Security policy

DAV Autosync handles login data and runs with full access to Thunderbird's internals (Experiment API). Please report security problems privately, not in a public issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: on the repository page open *Security* → *Report a vulnerability*. Please include the add-on version, the Thunderbird version and steps to reproduce.

You get an answer within a week. Fixes are published as a new release; the advisory names the affected versions.

## Supported versions

Only the latest release receives security fixes.

## Design notes relevant to security

- Passwords are kept only in Thunderbird's password manager. The add-on reads the mail account's stored password if `credentialSource` is `mail` and stores the DAV login there; it never writes passwords to its own storage or log.
- Network requests go only to the configured `serverUrl`. The broad host permission exists because that server is not known when the add-on is built.
- Removing a calendar or address book only unsubscribes in Thunderbird; the add-on never deletes collections on the server.
- Releases are built by GitHub Actions from a tagged commit, with a build provenance attestation and SHA-256 checksums. Verify a download with `gh attestation verify dav-autosync-<version>.xpi --repo pfisterer/thunderbird-dav-autosync`.
