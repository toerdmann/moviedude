# MovieDude – Architektur und Änderungsleitfaden

Kurzfassung für alle, die (auch in neuen Chats) an der App arbeiten. Ergänzt `CLAUDE.md`.

## Dateien
| Datei | Inhalt |
|---|---|
| `index.html` | Gesamtes Markup inkl. aller Dialoge. Lädt `config.js`, supabase-js (jsDelivr, gepinnt), `app.js` – alle mit `?v=`-Cache-Parameter. |
| `style.css` | Design-Tokens oben (`:root`, Dark Mode), danach Bausteine; neuere Abschnitte sind unten angehängt. |
| `app.js` | Die komplette Logik in einer IIFE, Abschnitte mit `/* ---------- Name ---------- */` getrennt. |
| `config.js` | Supabase-URL + publishable key. Leer = Browser-only-Modus (Etappe 1). |
| `data/*.json` | Exporte: `shelf` (MyMovies), `watchlist`, `watched`, `ratings` (Letterboxd). |
| `supabase/schema.sql` | Idempotentes Schema inkl. RLS. Mail-Platzhalter `__TOBIAS_EMAIL__`, `__SARAH_EMAIL__`. |

## Abschnitte in app.js (Reihenfolge)
Konstanten/State → Helfer (`el`, `toast`, `norm`) → TMDB (Warteschlange, `matchByImdb`, `matchByTitle`, `details`, `film`) → Prime ohne O-Ton (`noov`) → „Unsere“ (`shared`, `setOurs`) → Persönliche Markierungen (`marksMap`, `pushMarks`) → Prefs/Haushalt → Quelldaten + `rebuild()` → `sync()` → Ansicht (`visibleIds`, `card`, `render`) → Aktionen → Heute Abend → „+ Film“ → Detailansicht → Vorschlagen → Hinweise → Entdecken → Einstellungen → Übernahme aus Etappe 1 → Ansichten → Supabase (`start`, `subscribe`, `refresh`) → Sprüche → `wire()` → `boot()`.

## Zentrale Datenflüsse
1. **Quelldaten → `lib`**: `rebuild()` baut aus `SRC` (JSON-Dateien), `cache.match` (Export-Eintrag → TMDB-ID), `house.shelf_extra`, `state.extra` und `shared` die Map `lib` (tmdbId → {shelf, wl, lb, added, sarah, mineShelf, …}) sowie die Sets `seen`, `seenLb`, `rated`, `shelfSeenOwn`. **Nach jeder Zustandsänderung, die Herkunft/gesehen betrifft: `rebuild()` vor `render()`.**
2. **Zuordnung**: Schlüssel in `cache.match`: `i:<imdb>` (MyMovies), `l2:<letterboxd-uri>` (Letterboxd; Präfix bei Algorithmus-Änderung hochzählen → erzwingt Neuabgleich). `null` = nicht gefunden (wird ohne „Alles neu abgleichen“ nicht erneut gesucht).
3. **Filmdaten**: `cache.films[id]` (kompakt: t, o, y, r, v, g, p, ov, imdb, tr, fl, ol, ts). `isFresh()` erzwingt Neuladen alter Einträge; neue Pflichtfelder dort ergänzen. `sync()` lädt nur `lib`-Filme, `film(id)` alles andere bei Bedarf.
4. **Persönliche Markierungen** (`marks`): Der In-Memory-State (`hidden`, `seenLocal`, `unseenLocal`, `extra`, `snooze`, `members`) wird per `marksMap()` in Zeilen übersetzt; `pushMarks()` schreibt nur den Diff gegen `synced`. Fremde Änderungen (Realtime/`refresh`) werden nur übernommen, wenn lokal nichts Ungespeichertes ansteht.
5. **Gemeinsames** (`shared_items`): `setOurs`/`setNoov` schreiben sofort, optimistisch, mit Rücknahme bei Fehler. `changed_by/changed_at` setzt ein DB-Trigger.
6. **Haushalt** (`household`, nur Tobias schreibt): `tmdb_key`, `services`, `shelf` (für Sarah), `match`, `shelf_extra`. Letzter Schreiber gewinnt.
7. **Prefs** (`prefs`): `lists`, `tray`, `lastSeen`, `ratedDone` als ein JSON-Blob – letzter Schreiber gewinnt.
8. **Pro Gerät** (localStorage): `md.ui.v1` (Tab, Filter, Sortierung), `md.cache.v1` (TMDB-Cache). `md.state.v1` nur Etappe 1 / Migration.

## Rollen
`me.role` = `owner` (Tobias) oder `partner` (Sarah). Partner: nur Tabs Unsere/Entdecken/Nie, `lib` nur aus `shared` + `extra`, Regal-Info aus `house.shelf`, keine Einstellungen außer Konto/Passwort. Rechte erzwingt die Datenbank (RLS), die UI blendet nur aus.

## Häufige Änderungen – wo?
- **Neues Disc-Format (z. B. 4K UHD)**: `DISC_FORMATS` ergänzen. Fertig.
- **Neue Art persönlicher Markierung**: `ARR_KIND`/`setMark`/`marksMap` erweitern **und** den `check`-Constraint von `marks.kind` per SQL-Migration erweitern (sonst schlägt das Speichern fehl).
- **Neue gemeinsame Liste**: weitere `list_id` in `shared_items` (keine Schemaänderung nötig), Laden in `start()`/`refresh()`, Routing in `applyRemoteShared()`.
- **Neues synchronisiertes Prefs-Feld**: `SYNC_PREF_FIELDS` + `freshState()`.
- **Neues Feld aus TMDB**: `details()` + `isFresh()` (damit alte Caches nachladen).
- **Neuer Tab**: `allowedTabs()`, `renderTabs()`, Zweig in `render()`.
- **Neuer Spruch**: `TAGLINES`.
- **Schema-Änderung**: SQL idempotent formulieren, an `schema.sql` anhängen und Tobias den Block zum Ausführen im Supabase SQL Editor geben (Claude hat keinen Zugriff auf Supabase).

## Stolperfallen
- Nach Änderungen an `app.js`/`style.css` den `?v=` in `index.html` erhöhen. GitHub Pages cacht HTML bis ~10 Min.
- Supabase-Mailversand: max. 2 Mails/Stunde → Passwort-Login als Ausweg.
- Deployment kann bei GitHub-Störungen mit `startup_failure` scheitern → `gh api repos/toerdmann/moviedude/actions/runs` prüfen, ggf. leerer Commit.
- Aus der Sandbox sind TMDB, Supabase und github.io nicht erreichbar; testen nur mit Mock (Playwright + emuliertes Supabase/TMDB).
- Letterboxd-Titelzuordnung ist heuristisch (`matchByTitle`); Fehlzuordnungen zeigen sich als „ungesehen“ obwohl gesehen.
