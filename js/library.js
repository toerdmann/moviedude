/* MovieDude – Bibliothek: Quelldaten, rebuild(), Abgleich mit TMDB (sync).
   Teilt sich den globalen Gültigkeitsbereich mit den übrigen js/-Dateien; Ladereihenfolge in index.html, Überblick in docs/ARCHITEKTUR.md. */
'use strict';

/* ---------- Quelldaten ---------- */
let SRC = { shelf: [], watchlist: [], watched: [], ratings: [] };
const keyShelf = s => s.imdb ? 'i:' + s.imdb : 's:' + norm(s.title) + '|' + s.year;
const keyLb = s => 'l2:' + s.lb;                  // l2: bessere Titelsuche (vorher l:)

let lib = new Map();   // tmdbId -> { shelf, wl, lb, … }
let seen = new Set();
let seenLb = new Set();
let shelfMap = {};     // tmdbId -> Disk-Typ, für Sarahs Ansicht
let rated = new Set();
let shelfSeenOwn = new Set();

function rebuild() {
  lib = new Map(); seen = new Set(state.seenLocal); seenLb = new Set();
  const get = id => { if (!lib.has(id)) lib.set(id, { shelf: null, wl: false, lb: null, shelfSeen: false, mineShelf: false, sarah: false }); return lib.get(id); };
  if (!isOwner()) {
    const sh = house.shelf || {};
    for (const [id, r] of shared) if (r.in_list) get(id);
    for (const id of state.extra) get(id);
    for (const [id, e] of lib) e.shelf = sh[id] || null;
    return;
  }
  const unseen = new Set(state.unseenLocal);
  shelfMap = {};
  const discs = new Map();
  const addDisc = (id, d) => { if (!discs.has(id)) discs.set(id, new Set()); discs.get(id).add(d); };
  for (const s of SRC.shelf) {
    const id = cache.match[keyShelf(s)]; if (!id) continue;
    const e = get(id);
    addDisc(id, s.disc);
    if (s.owner === 'sarah') e.sarah = true; else e.mineShelf = true;
    if (s.seen && !unseen.has(id)) { e.shelfSeen = true; seen.add(id); }
  }
  for (const [id, fmts] of Object.entries(house.shelf_extra || {})) {   // per "+ Film" eingetragen
    if (!fmts || !fmts.length) continue;
    const e = get(+id); e.mineShelf = true; e.manualShelf = true;
    fmts.forEach(d => addDisc(+id, d));
  }
  for (const [id, set] of discs) { const label = discLabel(set); lib.get(id).shelf = label; shelfMap[id] = label; }
  for (const s of SRC.watchlist) { const id = cache.match[keyLb(s)]; if (!id) continue; const e = get(id); e.wl = true; e.lb = s.lb; e.added = s.added || null; }
  for (const s of SRC.watched) { const id = cache.match[keyLb(s)]; if (id) { seen.add(id); seenLb.add(id); } }
  rated = new Set(SRC.ratings.map(r => cache.match[keyLb(r)]).filter(Boolean));
  shelfSeenOwn = new Set();
  for (const s of SRC.shelf) { const id = cache.match[keyShelf(s)]; if (id && s.seen && s.owner !== 'sarah' && !unseen.has(id)) shelfSeenOwn.add(id); }
  for (const id of state.extra) get(id);
  for (const [id, r] of shared) if (r.in_list) get(id);
}

const DISC_FORMATS = ['DVD', 'Blu-ray'];          // später z. B. '4K UHD' ergänzen
function discLabel(set) {
  const known = DISC_FORMATS.filter(d => set.has(d));
  const other = [...set].filter(d => !DISC_FORMATS.includes(d));
  return [...known, ...other].join(' + ');
}
const isCandidate = id => { const e = lib.get(id); return e && !seen.has(id) && (e.wl || e.mineShelf); };
function privateMembers(id) {
  if (state.members[id]) return state.members[id].filter(x => x !== OURS);
  return isCandidate(id) ? ['mine'] : [];
}
const membersOf = id => inOurs(id) ? [...privateMembers(id), OURS] : privateMembers(id);

/* ---------- Abgleich mit TMDB ---------- */
let syncing = false;
async function sync({ force = false } = {}) {
  if (!state.apiKey || syncing) return;
  syncing = true;
  const jobs = [];
  if (isOwner()) {
    for (const s of SRC.shelf) {
      const k = keyShelf(s);
      if (force || !(k in cache.match)) jobs.push([k, () => s.imdb ? matchByImdb(s.imdb) : matchByTitle(s.orig || s.title, s.year, 'de-DE')]);
    }
    for (const s of SRC.watchlist.concat(SRC.watched)) {
      const k = keyLb(s);
      if (force || !(k in cache.match)) jobs.push([k, () => matchByTitle(s.title, s.year, 'en-US')]);
    }
  }
  try {
    if (jobs.length) {
      let done = 0;
      progress('Filme zuordnen', 0, jobs.length);
      await Promise.all(jobs.map(([k, fn]) => fn().then(id => { cache.match[k] = id; }).catch(e => { if (e.status === 401) throw e; })
        .finally(() => { progress('Filme zuordnen', ++done, jobs.length); if (done % 50 === 0) persistCache(); })));
      persistCache();
    }
    rebuild();
    const now = Date.now();
    const want = [];
    for (const id of lib.keys()) {
      const f = cache.films[id];
      const hot = !isOwner() || isCandidate(id) || (state.members[id] || []).length || inOurs(id) || state.tray.includes(id);
      if (force || !f || f.ol === undefined || now - f.ts > (hot ? FRESH_MS : STALE_MS)) want.push(id);
    }
    if (want.length) {
      let done = 0; progress('Verfügbarkeit laden', 0, want.length);
      await Promise.all(want.map(id => details(id).then(d => { cache.films[id] = d; }).catch(e => { if (e.status === 401) throw e; })
        .finally(() => { progress('Verfügbarkeit laden', ++done, want.length); if (done % 40 === 0) { persistCache(); render(); } })));
      persistCache();
    }
    if (isOwner()) {
      if (JSON.stringify(shelfMap) !== JSON.stringify(house.shelf || {})) pushHouse('shelf', shelfMap);
      const m = Object.fromEntries(Object.entries(cache.match).filter(([, v]) => v));
      if (JSON.stringify(m) !== JSON.stringify(house.match || {})) pushHouse('match', m);
    }
  } catch (e) {
    toast(e.status === 401 ? 'TMDB lehnt den Schlüssel ab. Bitte in den Einstellungen prüfen.' : 'Abgleich unterbrochen: ' + e.message);
  } finally {
    syncing = false; progress(); render(); stats();
  }
}
function progress(label, n, total) {
  const box = $('#sync');
  if (!label) { if (!$('#syncText').textContent.startsWith('Nicht gespeichert')) box.hidden = true; return; }
  box.hidden = false; $('#syncText').textContent = `${label} ${n}/${total}`;
  $('#syncBar').style.width = (total ? (n / total) * 100 : 0) + '%';
}
