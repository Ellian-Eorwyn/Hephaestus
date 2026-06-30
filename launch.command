#!/usr/bin/env bash
#
# Hephaestus — easy launcher for testing.
# Double-click this file in Finder, or run `./launch.command` from a terminal.
# It builds the current source and launches the app (the production build).
#
#   ./launch.command            build (if needed) and launch
#   ./launch.command --build    force a clean rebuild, then launch
#   ./launch.command --dev      run the hot-reload dev server instead
#
set -euo pipefail

# Always operate from the project directory (where this script lives).
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "⚒  Hephaestus launcher"

# Make sure dependencies are installed.
if [ ! -d node_modules ]; then
  echo "→ Installing dependencies (first run)…"
  npm install
fi

# Dev mode: hot-reload, no separate build step.
if [ "${1:-}" = "--dev" ]; then
  echo "→ Starting dev server (hot reload)…"
  exec npm run dev
fi

# Build the current source unless an up-to-date build already exists.
if [ ! -d out ] || [ "${1:-}" = "--build" ]; then
  echo "→ Building…"
  npm run build
else
  # Rebuild if any source file is newer than the last build.
  if [ -n "$(find src electron.vite.config.ts -type f -newer out -print -quit 2>/dev/null)" ]; then
    echo "→ Source changed since last build — rebuilding…"
    npm run build
  else
    echo "→ Using existing build in ./out (pass --build to force a rebuild)."
  fi
fi

echo "→ Launching Hephaestus…"
exec npm run start
