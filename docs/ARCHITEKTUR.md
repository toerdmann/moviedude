# MovieDude – Architektur und Änderungsleitfaden

Kurzfassung für alle, die (auch in neuen Chats) an der App arbeiten. Ergänzt `CLAUDE.md`.

## Dateien
| Datei | Inhalt |
|---|---|
| `index.html` | Gesamtes Markup inkl. aller Dialoge. Lädt `config.js`, supabase-js (jsDelivr, gepinnt) und die Skripte aus `js/` in fester Reihenfolge – alle lokalen Dateien mit `?v=`-Cache-Parameter. |
| `style.css` | Design-Tokens oben (`:root`, Dark Mode), danach Bausteine; neuere Abschnitte sind unten angehängt. |
| `js/*.js` | Die Logik, thematisch aufgeteilt (siehe unten). Klassische Skripte, kein Build, keine Module. |
| `config.js` | Supabase-URL + publishable key. Leer = App zeigt nur einen Hinweis. |
| `data/*.json` | Exporte: `shelf` (MyMovies), `watchlist`, `watched`, `ratings` (Letterboxd). |
| `supabase/schema.sql` | Idempotentes Schema inkl. RLS. Mail-Platzhalter `__TOBIAS_EMAIL__`, `__SARAH_EMAIL__`. |
| `scripts/import_*.py` | Exporte von Letterboxd (ZIP) und MyMovies (CSV) in `data/*.json` umwandeln. |
| `scripts/bump.sh` | Setzt `?v=` aller lokalen `.js`/`.css` in `index.html` auf den aktuellen Zeitpunkt. |
| `tests/run.sh` | Alle Tests: `node --check` + `'use strict'` je Datei in `js/`, `smoke.js` (lokaler HTTP-Server, keine Konsolenfehler, Hauptansichten rendern), `e2e.cjs` (Playwright, Supabase/TMDB nachgebaut, beide Rollen) und `rls.sh`/`rls.sql` (Schema + Zugriffsregeln gegen lokales Postgres). |

## Skripte in js/ (Ladereihenfolge)
| Datei | Inhalt |
|---|---|
| `base.js` | Konstanten, Config, `load`/`save`, `state`/`freshState`, `cache`, `me`/`people`/`house`/`sb`, Helfer (`$`, `el`, `toast`, `norm`, `uniq`, `ts` …) |
| `tmdb.js` | Warteschlange (`tmdb`), `checkKey`, `matchByImdb`, `matchByTitle`, `details`, `isFresh`, `film`, `loadProviders` |
| `db.js` | Prime ohne O-Ton (`noov`, `setNoov`), „Unsere“ (`shared`, `setOurs`, `applyRemoteShared`), Markierungen (`marksMap`, `setMark`, `pushMarks`, `applyRemoteMark`), `pushPrefs`, `pushHouse`, `persist`, `setOffline`, Übernahme aus Etappe 1/Backup (`hasContent`, `mergeState`) |
| `library.js` | Quelldaten `SRC`, `lib`/`seen`/…, `rebuild()`, `DISC_FORMATS`/`discLabel`, `privateMembers`/`membersOf`, `sync()`, `progress` |
| `list.js` | Listenansicht: `streamable`, `allowedTabs`, `visibleIds`, Nachtragen (`toRate`, `renderRate`), `renderTabs`, `renderGenres`, `card`, `render`, Aktionen (`toggleList`, `markSeen`, `hide` …), Heute Abend, `tmdbSearch` |
| `dialogs.js` | „+ Film“, Detailansicht (`openFilm`), Vorschlagen (`resolveInput`, `whereText`, `suggest`), Hinweise (`renderNotice`), Einstellungen (`renderServices`, `stats`, `openSettings`) |
| `discover.js` | Entdecken: `fillFeed`, `renderDeck`, `swipeCard`, `decide`, `undoDecision` |
| `start.js` | `showView`, Supabase (`start`, `subscribe`, `refresh`, `bootCloud`), Sprüche, `wire()`, `boot()`, `?mdtest` – als letzte Datei, ruft `boot()` auf |

Innerhalb der Dateien trennen weiterhin `/* ---------- Name ---------- */` die Abschnitte.

**Gemeinsamer Gültigkeitsbereich**: Die Dateien sind klassische Skripte (kein `type="module"`). Top-level-`const`/`let`/`function` landen im gemeinsamen globalen Skript-Scope und sind in allen anderen Dateien sichtbar und (bei `let`) neu zuweisbar – deshalb funktionieren z. B. `lib = new Map()` in `library.js` und `lib.get()` in `list.js` ohne Import. Folgen:
- Jeder Top-level-Name darf nur einmal vorkommen (sonst SyntaxError beim Laden – fällt im Smoke-Test sofort auf).
- Funktionen werden erst zur Laufzeit aufgerufen (`boot()` in `start.js`), Querverweise zwischen Dateien sind daher egal. Nur **Top-level-Initialisierer** (z. B. `const cache = Object.assign(…, load(…))`) brauchen Dinge aus früher geladenen Dateien.
- Jede Datei beginnt mit `'use strict';` (prüft `tests/run.sh`).

## Zentrale Datenflüsse
1. **Quelldaten → `lib`**: `rebuild()` baut aus `SRC` (JSON-Dateien), `cache.match` (Export-Eintrag → TMDB-ID), `house.shelf_extra`, `state.extra` und `shared` die Map `lib` (tmdbId → {shelf, wl, lb, added, sarah, mineShelf, …}) sowie die Sets `seen`, `seenLb`, `rated`, `shelfSeenOwn`. **Nach jeder Zustandsänderung, die Herkunft/gesehen betrifft: `rebuild()` vor `render()`.**
2. **Zuordnung**: Schlüssel in `cache.match`: `i:<imdb>` (MyMovies), `l2:<letterboxd-uri>` (Letterboxd; Präfix bei Algorithmus-Änderung hochzählen → erzwingt Neuabgleich). `null` = nicht gefunden (wird ohne „Alles neu abgleichen“ nicht erneut gesucht).
3. **Filmdaten**: `cache.films[id]` (kompakt: t, o, y, r, v, g, p, ov, imdb, tr, fl, ol, ts). `isFresh()` erzwingt Neuladen alter Einträge; neue Pflichtfelder dort ergänzen. `sync()` lädt nur `lib`-Filme, `film(id)` alles andere bei Bedarf.
4. **Persönliche Markierungen** (`marks`): Der In-Memory-State (`hidden`, `seenLocal`, `unseenLocal`, `extra`, `snooze`, `members`) wird per `marksMap()` in Zeilen übersetzt; `pushMarks()` schreibt nur den Diff gegen `synced`. Fremde Änderungen (Realtime/`refresh`) werden nur übernommen, wenn lokal nichts Ungespeichertes ansteht.
5. **Gemeinsames** (`shared_items`): `setOurs`/`setNoov` schreiben sofort, optimistisch, mit Rücknahme bei Fehler. `changed_by/changed_at` setzt ein DB-Trigger.
6. **Haushalt** (`household`, nur Tobias schreibt): `tmdb_key`, `services`, `shelf` (für Sarah), `match`, `shelf_extra`. Letzter Schreiber gewinnt.
7. **Prefs** (`prefs`): `lists`, `tray`, `lastSeen`, `ratedDone` als ein JSON-Blob – letzter Schreiber gewinnt.
8. **Pro Gerät** (localStorage): `md.ui.v1` (Tab, Filter, Sortierung), `md.cache.v1` (TMDB-Cache). `md.state.v1` = alter Etappe-1-Zustand, wird nur noch gelesen (einmalige Übernahme, Knopf „Daten aus diesem Browser übernehmen“).
9. **Aufräumen**: Beim Start gilt der Datenbank-Stand als `synced`; was lokal nicht mehr existiert (z. B. abgelaufenes „Lass erstmal“), löscht der erste `pushMarks()`.

## Rollen
`me.role` = `owner` (Tobias) oder `partner` (Sarah). Partner: nur Tabs Unsere/Entdecken/Nie, `lib` nur aus `shared` + `extra`, Regal-Info aus `house.shelf`, keine Einstellungen außer Konto/Passwort. Rechte erzwingt die Datenbank (RLS), die UI blendet nur aus.

## Häufige Änderungen – wo?
- **Neues Disc-Format (z. B. 4K UHD)**: `DISC_FORMATS` in `library.js` ergänzen. Fertig.
- **Neue Art persönlicher Markierung**: `ARR_KIND`/`setMark`/`marksMap` in `db.js` erweitern **und** den `check`-Constraint von `marks.kind` per SQL-Migration erweitern (sonst schlägt das Speichern fehl).
- **Neue gemeinsame Liste**: weitere `list_id` in `shared_items` (keine Schemaänderung nötig), Laden in `start()`/`refresh()` (`start.js`), Routing in `applyRemoteShared()` (`db.js`).
- **Neues synchronisiertes Prefs-Feld**: `SYNC_PREF_FIELDS` + `freshState()` in `base.js`.
- **Neues Feld aus TMDB**: `details()` + `isFresh()` in `tmdb.js` (damit alte Caches nachladen).
- **Neuer Tab**: `allowedTabs()`, `renderTabs()`, Zweig in `render()` – alles in `list.js`.
- **Neuer Knopf/Dialog**: Markup in `index.html`, Logik in `dialogs.js`, Event-Handler in `wire()` (`start.js`).
- **Neuer Spruch**: `TAGLINES` in `start.js`.
- **Neue JS-Datei**: `<script src="js/….js?v=…">` in `index.html` an der passenden Stelle der Reihenfolge eintragen (vor `start.js`), Kopf mit `'use strict';`. `bump.sh` und `run.sh` erfassen sie automatisch.
- **Schema-Änderung**: SQL idempotent formulieren, an `schema.sql` anhängen und Tobias den Block zum Ausführen im Supabase SQL Editor geben (Claude hat keinen Zugriff auf Supabase).

## Stolperfallen
- `?v=` in `index.html` setzt `scripts/bump.sh` für alle lokalen Dateien (läuft automatisch in `tests/run.sh`, sobald etwas in `js/`, `style.css` oder `config.js` geändert oder neu ist). GitHub Pages cacht HTML trotzdem bis ~10 Min.
- Die Versionsanzeige in den Einstellungen liest `?v=` von `js/base.js`.
- Die App braucht HTTP (GitHub Pages oder lokaler Server); über `file://` scheitern schon die Datendateien.
- Supabase-Mailversand: max. 2 Mails/Stunde → Passwort-Login als Ausweg.
- Deployment kann bei GitHub-Störungen mit `startup_failure` scheitern → `gh api repos/toerdmann/moviedude/actions/runs` prüfen, ggf. leerer Commit.
- Aus der Sandbox sind TMDB, Supabase und github.io nicht erreichbar; getestet wird mit `bash tests/run.sh`. Der Mock in `tests/e2e.cjs` bildet die Zugriffsregeln nur vereinfacht nach – Änderungen an `schema.sql` zusätzlich in `tests/rls.sql` prüfen.
- `?mdtest` in der URL stellt `window.__mdTest` (matchByTitle, norm, discLabel) für Tests bereit.
- Mock-TMDB im Test: gerade ID = englisches Original, ID%3 → 0 Netflix, 1 Prime (+ Werbung), 2 nirgends.
- Letterboxd-Titelzuordnung ist heuristisch (`matchByTitle`); Fehlzuordnungen zeigen sich als „ungesehen“ obwohl gesehen.
