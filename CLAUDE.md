# MovieDude – Projektnotizen für Claude

Details zu Aufbau und Änderungen: `docs/ARCHITEKTUR.md`.

Private Filmauswahl-App von Tobias („Dude“) und seiner Frau Sarah. Sprache im Umgang: Deutsch, locker, kurz.
Live: https://toerdmann.github.io/moviedude/ (GitHub Pages, Branch `main`, Root).

## Aufbau
- Reine statische Seite: `index.html`, `style.css`, `app.js` (kein Build). `config.js` enthält Supabase-URL und publishable key (öffentlich ok).
- Filmdaten live von TMDB im Browser (Key liegt in Supabase `household.tmdb_key`, nie im Code). Verfügbarkeit Region DE (JustWatch über TMDB).
- Supabase (Org „Nubsicorp“, Projekt `moviedude`): Login per Mail-Link oder Passwort. Schema in `supabase/schema.sql`
  (Mail-Adressen dort nur als Platzhalter – echte Adressen nie ins öffentliche Repo).
  - `members`: Gästeliste, Rollen `owner` (Tobias) und `partner` (Sarah).
  - `household`: tmdb_key, services, shelf (Regal-Zuordnung für Sarah), match (TMDB-Zuordnungen), shelf_extra (per „+ Film“ eingetragene Discs).
  - `marks`: persönliche Markierungen pro Film (hidden, seen, unseen, extra, snooze, lists).
  - `prefs`: lists, tray, lastSeen, ratedDone.
  - `shared_items`: `list_id='ours'` = gemeinsame Liste „Unsere“; `list_id='noov'` = Prime ohne englischen O-Ton (mit Datum).
- Ohne Supabase-Config läuft die App im alten Browser-only-Modus (Etappe 1).

## Daten aktualisieren
- Letterboxd: Tobias schickt den ZIP-Export → `data/watchlist.json` (title, year, lb, added), `data/watched.json`, `data/ratings.json` (lb, r) neu erzeugen. Keine Schreib-API zu Letterboxd, kein Scraping.
- MyMovies: `Collection.csv` → `data/shelf.json` (nur Filme/Dokus mit IMDb-ID; Sarahs Filme = Sammlungsnummer 713–745 plus Johnny English → `owner: 'sarah'`, zählen nicht als gesehen).
- Einzelne gekaufte Filme trägt Tobias selbst über „+ Film“ ein.

## Regeln
- Commits immer als `toerdmann <340679489+toerdmann@users.noreply.github.com>`, nie mit Gmail-Adresse.
- Nach Änderungen an `app.js`/`style.css` die `?v=`-Parameter in `index.html` hochzählen (Cache).
- Größere Features erst als Konzept besprechen, dann bauen.
- Verfügbarkeit: „Heute verfügbar“ = eigenes Regal oder aktiver Dienst; Prime zählt nicht bei englischem Original ohne O-Ton (noov).
- Trailer: bei englischem Original englisch, sonst deutsch.

## Offene Ideen
- Homescreen-App (PWA) mit Icon.
- Automatische Prüfung „Prime mit O-Ton?“ (z. B. Streaming Availability API) – Daten dafür sind vorbereitet (noov mit Datum).
- Serien (z. B. Doku-Zweiteiler) unterstützen.
- Sprüche im Kopf irgendwann auf 69 ausbauen.
- Automatischer Letterboxd-Sync bräuchte eine saubere Lösung (offizielle API nicht frei verfügbar).
