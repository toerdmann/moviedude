#!/usr/bin/env bash
# Startet alle Tests. Aufruf aus dem Repo-Ordner:  bash tests/run.sh
#   smoke – App über lokalen HTTP-Server laden: keine Konsolenfehler, Hauptansichten rendern
#   e2e  – Browser-Test (Playwright, Supabase/TMDB nachgebaut)
#   rls  – Zugriffsregeln der Datenbank gegen ein lokales Postgres (falls installiert)
set -euo pipefail
cd "$(dirname "$0")/.."
CACHE=tests/.cache
mkdir -p "$CACHE"

# supabase-js in der Version, die index.html lädt, einmalig herunterladen
VER=$(grep -o 'supabase-js@[0-9.]*' index.html | head -1 | cut -d@ -f2)
if [ ! -f "$CACHE/supabase-js/package/dist/umd/supabase.js" ] || [ "$(cat "$CACHE/supabase-js/VERSION" 2>/dev/null)" != "$VER" ]; then
  rm -rf "$CACHE/supabase-js" && mkdir -p "$CACHE/supabase-js"
  (cd "$CACHE/supabase-js" && npm pack "@supabase/supabase-js@$VER" --silent >/dev/null && tar xzf supabase-supabase-js-*.tgz && echo "$VER" > VERSION)
fi

node --check app.js
# Geänderte App-Dateien? Dann Cache-Version in index.html hochsetzen.
if ! git diff --quiet HEAD -- app.js style.css config.js 2>/dev/null; then bash scripts/bump.sh; fi
echo "### Smoke-Test"
node tests/smoke.js
echo "### Browser-Test"
node tests/e2e.cjs
if ls /usr/lib/postgresql/*/bin/initdb >/dev/null 2>&1; then
  echo "### Datenbank-Regeln"
  bash tests/rls.sh
else
  echo "### Datenbank-Regeln übersprungen (kein lokales Postgres)"
fi
