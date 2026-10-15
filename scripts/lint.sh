#!/bin/sh
# Runs Thunderbird's add-on review linter (https://github.com/thunderbird/webext-linter) on addon/.
# --allow-experiments: ATN currently rejects Experiments in general; the remaining review rules still apply and fail the run on errors.
set -eu
cd "$(dirname "$0")/.."
L=.local/webext-linter
if [ ! -d "$L" ]; then
  git clone -q --depth 1 https://github.com/thunderbird/webext-linter.git "$L"
fi
(cd "$L" && npm install --silent --no-audit --no-fund >/dev/null)
# The linter writes its cache into the current directory and working copies next to the checked folder, so check a copy inside .local.
rm -rf .local/lint-work
mkdir -p .local/lint-work
cp -R addon .local/lint-work/addon
(cd .local/lint-work && node ../webext-linter/verify.js addon --allow-experiments) > .local/lint-report.txt 2>&1 && status=0 || status=$?
grep -E "\[fail\]|error\(s\)" .local/lint-report.txt || true
echo "Vollständiger Bericht: .local/lint-report.txt"
exit $status
