# Contributing

Issues and pull requests are welcome. For larger changes please open an issue first.

## Setup

```sh
npm install
scripts/nc-test.sh start          # ephemeral Nextcloud (Docker) on 127.0.0.1:8088 with test users and shares
eval "$(scripts/nc-test.sh env)"
npm test                          # unit, i18n and integration tests
scripts/get-thunderbird.sh        # Thunderbird ESR into .local/tb (macOS or Linux)
npm run e2e                       # end-to-end test with a real Thunderbird
npm run lint                      # Thunderbird's add-on review linter
```

Nothing touches an installed Thunderbird: the test copy lives in `.local/tb` and uses its own profiles.

## Rules

- Keep the Experiment API (`addon/api/`) small. Everything that does not need Thunderbird internals belongs in `addon/src/` or `addon/background.js`, where it can be tested in Node.
- Every safety rule in `addon/src/reconcile.js` has a unit test. Add one for every new rule.
- No user-visible text in code: add a message to `addon/_locales/en/messages.json` and `addon/_locales/de/messages.json` and use `msg()`. `npm test` fails if a code is missing or placeholders differ.
- `npm test`, `npm run e2e` and `npm run lint` must pass.

## Translations

Copy `addon/_locales/en/messages.json` to `addon/_locales/<language>/messages.json` and translate the `message` texts. Keep codes and placeholders unchanged.

## Releases

1. Update `version` in `addon/manifest.json` and add a section to `CHANGELOG.md`.
2. Commit, then tag `vX.Y.Z` and push the tag. The release workflow tests, builds, attests and publishes the XPI, `updates.json` and `SHA256SUMS`.
