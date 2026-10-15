// Writes dist/updates.json and dist/SHA256SUMS for the XPI of the current version.
// updates.json is the update manifest Thunderbird reads when a policy points the add-on's update_url at it.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const REPO = "https://github.com/pfisterer/thunderbird-dav-autosync";
const manifest = JSON.parse(readFileSync(`${ROOT}/addon/manifest.json`, "utf8"));
const { id, strict_min_version, strict_max_version } = manifest.browser_specific_settings.gecko;
const file = `dav-autosync-${manifest.version}.xpi`;
const hash = createHash("sha256").update(readFileSync(`${ROOT}/dist/${file}`)).digest("hex");

const updates = {
  addons: {
    [id]: {
      updates: [
        {
          version: manifest.version,
          update_link: `${REPO}/releases/download/v${manifest.version}/${file}`,
          update_hash: `sha256:${hash}`,
          applications: { gecko: { strict_min_version, strict_max_version } },
        },
      ],
    },
  },
};
writeFileSync(`${ROOT}/dist/updates.json`, JSON.stringify(updates, null, 2) + "\n");
writeFileSync(`${ROOT}/dist/SHA256SUMS`, `${hash}  ${file}\n`);
console.log(`dist/updates.json, dist/SHA256SUMS (${file} sha256:${hash})`);
