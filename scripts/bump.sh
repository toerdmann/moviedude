#!/usr/bin/env bash
# Setzt die ?v=-Parameter in index.html auf den aktuellen Zeitpunkt, damit Browser
# nach einem Update die neuen Dateien laden. Wird von tests/run.sh automatisch aufgerufen,
# sobald eine App-Datei (js/, style.css, config.js) gegenüber dem letzten Commit geändert oder neu ist.
# Erfasst jede lokale .js-/.css-Datei mit ?v= (CDN-Adressen haben keins).
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(TZ=Europe/Berlin date +%Y%m%d%H%M)
sed -i -E "s#([A-Za-z0-9_./-]+\.(js|css))\?v=[0-9]+#\1?v=$V#g" index.html
echo "Version in index.html: $V"
