#!/usr/bin/env bash
# Install the cv-auto CLI onto the appliance PATH as a symlink to the repo.
# Read-only: the CLI never writes config or database state.
# CV_INSTALL_PREFIX overrides the /usr/local default (used by tests/containers).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(dirname "$here")"
target="$repo_root/dist/cli/cv-auto.js"

[ -f "$target" ] || { echo "dist/cli/cv-auto.js missing — run npm run build first"; exit 1; }

prefix="${CV_INSTALL_PREFIX:-/usr/local}"
mkdir -p "$prefix/bin"
cat >"$prefix/bin/cv-auto" <<EOF
#!/bin/sh
exec node "$target" "\$@"
EOF
chmod +x "$prefix/bin/cv-auto"
echo "installed: $prefix/bin/cv-auto -> $target"
echo "try: cv-auto status | cv-auto diagnose | cv-auto help"
