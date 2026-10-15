// Locations inside the test Thunderbird in .local/tb, which differ between macOS (app bundle layout) and Linux (tarball layout).
// CommonJS on purpose, so shell scripts can use it via `node -p`.
const { resolve } = require("node:path");

function paths(root = resolve(__dirname, "../..")) {
  const tb = `${root}/.local/tb`;
  if (process.platform === "darwin") {
    return { binary: `${tb}/Contents/MacOS/thunderbird`, distribution: `${tb}/Contents/Resources/distribution` };
  }
  return { binary: `${tb}/thunderbird`, distribution: `${tb}/distribution` };
}

module.exports = { paths };
