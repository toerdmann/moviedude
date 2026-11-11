#!/usr/bin/env bash
# Setzt die ?v=-Parameter in index.html auf den aktuellen Zeitpunkt, damit Browser
# nach einem Update die neuen Dateien laden. Wird von tests/run.sh automatisch aufgerufen,
# sobald app.js, style.css oder config.js gegenüber dem letzten Commit geändert sind.
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(TZ=Europe/Berlin date +%Y%m%d%H%M)
sed -i -E "s#(app\.js|style\.css|config\.js)\?v=[0-9]+#\1?v=$V#g" index.html
echo "Version in index.html: $V"
