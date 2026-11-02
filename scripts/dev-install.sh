#!/bin/sh
# Rebuilds, packages and installs the VSIX into the local Cursor (or VS Code with CLI=code).
set -eu
cd "$(dirname "$0")/.."
npm run build >/dev/null
npx vsce package --no-dependencies -o threadside-dev.vsix >/dev/null
CLI="${CLI:-/Applications/Cursor.app/Contents/Resources/app/bin/cursor}"
env -u ELECTRON_RUN_AS_NODE "$CLI" --install-extension threadside-dev.vsix --force 2>&1 | grep -v -i deprecat || true
