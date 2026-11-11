/* MovieDude — Watchlist, Regal und Streaming-Verfügbarkeit.
   Etappe 2: Login per Mail-Link, Daten in Supabase, gemeinsame Liste "Unsere" mit Sarah.
   Ohne Supabase-Zugangsdaten (config.js leer) läuft die App wie in Etappe 1 nur im Browser. */
(() => {
'use strict';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const REGION = 'DE';
const STATE_KEY = 'md.state.v1';          // Etappe 1: kompletter Zustand im Browser
const UI_KEY = 'md.ui.v1';                // Etappe 2: Ansichts-Einstellungen pro Gerät
const CACHE_KEY = 'md.cache.v1';
const FRESH_MS = 2 * 24 * 3600 * 1000;
const STALE_MS = 30 * 24 * 3600 * 1000;
const SNOOZE_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_SERVICES = [/netflix/i, /amazon prime video/i, /^apple tv\+?$/i, /disney/i];
const OURS = 'ours';

const CFG = window.MD_CONFIG || {};
const WANT_CLOUD = !!(CFG.supabaseUrl && CFG.supabaseKey);
const CLOUD = WANT_CLOUD && !!window.supabase;

/* ---------- Speicher ---------- */
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

const UI_FIELDS = ['tab', 'source', 'runtime', 'sort', 'genres', 'feed'];
const SYNC_PREF_FIELDS = ['lists', 'tray', 'lastSeen', 'ratedDone'];
const freshState = () => ({
  apiKey: '',
  services: null,                       // [provider_id]
  lists: [{ id: 'mine', name: 'Meine' }, { id: OURS, name: 'Unsere' }],
  members: {},                          // tmdbId -> [private listIds]  (fehlt = Standard)
  hidden: [], seenLocal: [], unseenLocal: [], extra: [], tray: [],
  snooze: {},
  sharedLocal: {},                      // nur Etappe 1: "Unsere" im Browser
  noovLocal: {},                        // nur Etappe 1: Prime ohne O-Ton
  ratedDone: [],                        // "Nachtragen": als erledigt abgehakt
  lastSeen: 0,
  feed: 'popular', tab: 'mine', source: 'avail', runtime: 0, sort: 'new', genres: [], sortV: 2
});
const state = freshState();
const cache = Object.assign({ match: {}, films: {}, providers: null }, load(CACHE_KEY, {}));
let cacheTimer = null;
const persistCache = () => { clearTimeout(cacheTimer); cacheTimer = setTimeout(() => save(CACHE_KEY, cache), 400); };

/* Wer bin ich? Ohne Login: Besitzer. */
const me = { id: null, email: '', name: 'Tobias', role: 'owner' };
const isOwner = () => me.role === 'owner';
let people = {};                        // user_id -> Name
let house = {};                         // Haushalt: services, tmdb_key, shelf, match
let sb = null;

/* ---------- Helfer ---------- */
const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
  return n;
};
let toastT;
function toast(msg, action) {
  const t = $('#toast'); t.replaceChildren(msg);
  if (action) t.append(el('button', { class: 'toast-act', type: 'button', onclick: () => { t.hidden = true; action.run(); } }, action.label));
  t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, action ? 6000 : 3500);
}
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const uniq = a => [...new Set(a)];
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const ts = s => (s ? Date.parse(s) || 0 : 0);
const otherName = uid => people[uid] || 'Jemand';

/* ---------- TMDB ---------- */
let active = 0; const queue = [];
const MAX_PAR = 6;
function tmdb(path, params = {}) {
  return new Promise((resolve, reject) => { queue.push({ path, params, resolve, reject, tries: 0 }); pump(); });
}
function pump() {
  while (active < MAX_PAR && queue.length) {
    const job = queue.shift(); active++;
    const u = new URL(API + (job.path.startsWith('/') ? job.path : '/' + job.path));
    u.searchParams.set('api_key', state.apiKey);
    for (const [k, v] of Object.entries(job.params)) if (v != null && v !== '') u.searchParams.set(k, v);
    fetch(u).then(async r => {
      if (r.status === 429 && job.tries < 4) { job.tries++; setTimeout(() => { queue.unshift(job); pump(); }, 1500 * job.tries); return; }
      if (!r.ok) { const e = new Error('TMDB ' + r.status); e.status = r.status; throw e; }
      job.resolve(await r.json());
    }).catch(job.reject).finally(() => { active--; pump(); });
  }
}
async function checkKey(key) {
  const u = new URL(API + '/configuration'); u.searchParams.set('api_key', key);
  const r = await fetch(u); return r.ok;
}
async function matchByImdb(imdb) {
  const r = await tmdb('/find/' + imdb, { external_source: 'imdb_id' });
  return r.movie_results?.[0]?.id ?? null;
}
async function matchByTitle(title, year, lang) {
  const tries = year
    ? [{ query: title, primary_release_year: year, language: lang }, { query: title, year, language: lang }, { query: title, language: lang }]
    : [{ query: title, language: lang }];
  for (const p of tries) {
    const r = await tmdb('/search/movie', p);
    const res = r.results || [];
    if (!res.length) continue;
    if (!year) return res[0].id;
    const hit = res.find(m => Math.abs(parseInt((m.release_date || '0').slice(0, 4), 10) - year) <= 1);
    if (hit) return hit.id;
  }
  return null;
}
async function details(id) {
  const d = await tmdb('/movie/' + id, { language: 'de-DE', append_to_response: 'watch/providers,external_ids,videos', include_video_language: 'de,en,null' });
  const pr = d['watch/providers']?.results?.[REGION] || {};
  const vids = (d.videos?.results || []).filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'));
  const ol = d.original_language || null;
  const trLang = ol === 'en' ? 'en' : 'de';          // englische Filme: Original-Trailer, sonst deutsch
  vids.sort((a, b) => (a.iso_639_1 === trLang ? 0 : 1) - (b.iso_639_1 === trLang ? 0 : 1) || (a.type === 'Trailer' ? 0 : 1) - (b.type === 'Trailer' ? 0 : 1));
  return {
    id: d.id, ol,
    t: d.title, o: d.original_title, y: parseInt((d.release_date || '').slice(0, 4), 10) || null,
    r: d.runtime || null, v: Math.round((d.vote_average || 0) * 10) / 10,
    g: (d.genres || []).map(g => g.name), p: d.poster_path || null,
    ov: (d.overview || '').slice(0, 900), imdb: d.external_ids?.imdb_id || d.imdb_id || null,
    tr: vids[0]?.key || null,
    fl: (pr.flatrate || []).concat(pr.free || [], pr.ads || []).map(x => [x.provider_id, x.provider_name, x.logo_path]),
    ts: Date.now()
  };
}
const isFresh = f => !!f && f.ol !== undefined;   // ältere Cache-Einträge kennen Originalsprache und O-Ton-Trailer noch nicht
async function film(id) {
  if (!isFresh(cache.films[id])) { cache.films[id] = await details(id); persistCache(); }
  return cache.films[id];
}
async function loadProviders() {
  if (cache.providers && Date.now() - cache.providers.ts < STALE_MS) return cache.providers.list;
  const r = await tmdb('/watch/providers/movie', { watch_region: REGION, language: 'de-DE' });
  const list = (r.results || [])
    .sort((a, b) => (a.display_priorities?.[REGION] ?? 999) - (b.display_priorities?.[REGION] ?? 999))
    .slice(0, 40).map(p => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path }));
  cache.providers = { ts: Date.now(), list }; persistCache();
  return list;
}

/* ---------- Prime ohne englischen O-Ton (gilt für den Haushalt, mit Datum zum späteren Nachprüfen) ---------- */
const NOOV = 'noov';
let noov = new Map();                   // tmdbId -> { in_list, changed_by, changed_at }
const isPrime = p => /amazon prime/i.test(p[1]);
const noovActive = id => !!noov.get(id)?.in_list;
async function setNoov(id, on) {
  const prev = noov.get(id);
  noov.set(id, { in_list: on, changed_by: me.id, changed_at: new Date().toISOString() });
  if (!CLOUD) { state.noovLocal[id] = noov.get(id); persist(); rebuild(); render(); return; }
  rebuild(); render();
  const { data, error } = await sb.from('shared_items').upsert({ list_id: NOOV, tmdb_id: id, in_list: on }, { onConflict: 'list_id,tmdb_id' }).select().single();
  if (error) { if (prev) noov.set(id, prev); else noov.delete(id); toast('Speichern fehlgeschlagen: ' + error.message); rebuild(); render(); return; }
  if (data) noov.set(id, pickShared(data));
}

/* ---------- Gemeinsame Liste "Unsere" ---------- */
let shared = new Map();                 // tmdbId -> { in_list, added_by, changed_by, changed_at }
const pendingShared = new Map();        // tmdbId -> offene Schreibvorgänge
const inOurs = id => !!shared.get(id)?.in_list;

async function setOurs(id, on) {
  const prev = shared.get(id);
  if (!!prev?.in_list === on) return;
  const row = { in_list: on, added_by: on ? me.id : (prev?.added_by ?? null), changed_by: me.id, changed_at: prev?.changed_at || '' };
  shared.set(id, row);
  if (!CLOUD) {
    state.sharedLocal[id] = row; persist(); return;
  }
  pendingShared.set(id, (pendingShared.get(id) || 0) + 1);
  try {
    const { data, error } = await sb.from('shared_items')
      .upsert({ list_id: OURS, tmdb_id: id, in_list: on, added_by: row.added_by }, { onConflict: 'list_id,tmdb_id' })
      .select().single();
    if (error) throw error;
    if (pendingShared.get(id) === 1 && data) shared.set(id, pickShared(data));
  } catch (e) {
    if (prev) shared.set(id, prev); else shared.delete(id);
    toast('„Unsere“ konnte nicht gespeichert werden: ' + (e.message || e));
    rebuild(); render();
  } finally {
    const n = (pendingShared.get(id) || 1) - 1;
    if (n > 0) pendingShared.set(id, n); else pendingShared.delete(id);
  }
}
const pickShared = r => ({ in_list: r.in_list, added_by: r.added_by, changed_by: r.changed_by, changed_at: r.changed_at });
function applyRemoteShared(r) {
  if (r && r.list_id === NOOV) { noov.set(r.tmdb_id, pickShared(r)); return true; }
  if (!r || r.list_id !== OURS) return false;
  const id = r.tmdb_id;
  if (pendingShared.has(id)) return false;
  const cur = shared.get(id);
  if (cur && cur.changed_at && ts(r.changed_at) < ts(cur.changed_at)) return false;
  shared.set(id, pickShared(r));
  return true;
}

/* ---------- Persönliche Markierungen (Diff gegen den letzten Stand in der Datenbank) ---------- */
const ARR_KIND = { hidden: 'hidden', seen: 'seenLocal', unseen: 'unseenLocal', extra: 'extra' };
function marksMap() {
  const m = new Map();
  const put = (id, kind, val) => m.set(id + '|' + kind, JSON.stringify(val));
  for (const [kind, key] of Object.entries(ARR_KIND)) for (const id of state[key]) put(id, kind, true);
  const now = Date.now();
  for (const [id, t] of Object.entries(state.snooze)) if (t > now) put(id, 'snooze', t);
  for (const [id, arr] of Object.entries(state.members)) put(id, 'lists', arr.filter(x => x !== OURS));
  return m;
}
function setMark(id, kind, val) {            // val === undefined entfernt
  id = +id;
  if (ARR_KIND[kind]) {
    const k = ARR_KIND[kind];
    state[k] = state[k].filter(x => x !== id);
    if (val !== undefined) state[k].push(id);
  } else if (kind === 'snooze') { if (val === undefined) delete state.snooze[id]; else state.snooze[id] = val; }
  else if (kind === 'lists') { if (val === undefined) delete state.members[id]; else state.members[id] = val; }
}
function marksToState(rows) {
  for (const k of Object.values(ARR_KIND)) state[k] = [];
  state.snooze = {}; state.members = {};
  for (const r of rows) setMark(r.tmdb_id, r.kind, r.val);
}

let synced = new Map();
let pushing = false, pushAgain = false, retryT = null;
async function pushMarks() {
  if (!CLOUD || !me.id) return;
  if (pushing) { pushAgain = true; return; }
  pushing = true;
  try {
    const cur = marksMap();
    const ups = [], dels = {};
    for (const [k, v] of cur) if (synced.get(k) !== v) ups.push([k, v]);
    for (const k of synced.keys()) if (!cur.has(k)) { const [id, kind] = k.split('|'); (dels[kind] = dels[kind] || []).push(+id); }
    for (const part of chunks(ups, 500)) {
      const rows = part.map(([k, v]) => { const [id, kind] = k.split('|'); return { user_id: me.id, tmdb_id: +id, kind, val: JSON.parse(v) }; });
      const { error } = await sb.from('marks').upsert(rows, { onConflict: 'user_id,tmdb_id,kind' });
      if (error) throw error;
      for (const [k, v] of part) synced.set(k, v);
    }
    for (const [kind, ids] of Object.entries(dels)) for (const part of chunks(ids, 200)) {
      const { error } = await sb.from('marks').delete().eq('user_id', me.id).eq('kind', kind).in('tmdb_id', part);
      if (error) throw error;
      for (const id of part) synced.delete(id + '|' + kind);
    }
    setOffline(false);
  } catch (e) {
    setOffline(true, e.message || String(e));
    clearTimeout(retryT); retryT = setTimeout(pushMarks, 15000);
  } finally {
    pushing = false;
    if (pushAgain) { pushAgain = false; pushMarks(); }
  }
}
function applyRemoteMark(row, deleted) {
  const key = row.tmdb_id + '|' + row.kind;
  const local = marksMap().get(key);
  if (local !== synced.get(key)) return false;    // lokale Änderung wartet noch aufs Speichern
  if (deleted) { setMark(row.tmdb_id, row.kind, undefined); synced.delete(key); }
  else { setMark(row.tmdb_id, row.kind, row.val); synced.set(key, JSON.stringify(row.val)); }
  return true;
}

/* Einstellungen, die zwischen Geräten geteilt werden (eigene Listen, Heute Abend, gelesen bis) */
let syncedPrefs = '';
const prefsData = () => Object.fromEntries(SYNC_PREF_FIELDS.map(k => [k, state[k]]));
async function pushPrefs() {
  if (!CLOUD || !me.id) return;
  const data = prefsData(); const json = JSON.stringify(data);
  if (json === syncedPrefs) return;
  const { error } = await sb.from('prefs').upsert({ user_id: me.id, data }, { onConflict: 'user_id' });
  if (error) { setOffline(true, error.message); return; }
  syncedPrefs = json;
}
async function pushHouse(key, val) {
  house[key] = val;
  if (!CLOUD || !isOwner()) return;
  const { error } = await sb.from('household').upsert({ key, val }, { onConflict: 'key' });
  if (error) toast('Speichern fehlgeschlagen: ' + error.message);
}

let persistT = null;
function persist() {
  save(UI_KEY, Object.fromEntries(UI_FIELDS.map(k => [k, state[k]])));
  if (!CLOUD) { save(STATE_KEY, state); return; }
  clearTimeout(persistT);
  persistT = setTimeout(() => { pushMarks(); pushPrefs(); }, 250);
}
function setOffline(off, msg) {
  const box = $('#sync');
  if (off) { box.hidden = false; $('#syncText').textContent = 'Nicht gespeichert, versuche erneut…'; $('#syncBar').style.width = '0'; box.title = msg || ''; }
  else if ($('#syncText').textContent.startsWith('Nicht gespeichert')) { box.hidden = true; box.title = ''; }
}

/* ---------- Quelldaten ---------- */
let SRC = { shelf: [], watchlist: [], watched: [], ratings: [] };
const keyShelf = s => s.imdb ? 'i:' + s.imdb : 's:' + norm(s.title) + '|' + s.year;
const keyLb = s => 'l:' + s.lb;

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
  for (const s of SRC.shelf) {
    const id = cache.match[keyShelf(s)]; if (!id) continue;
    const e = get(id);
    e.shelf = e.shelf && e.shelf !== s.disc ? 'DVD + Blu-ray' : s.disc;
    shelfMap[id] = e.shelf;
    if (s.owner === 'sarah') e.sarah = true; else e.mineShelf = true;
    if (s.seen && !unseen.has(id)) { e.shelfSeen = true; seen.add(id); }
  }
  for (const s of SRC.watchlist) { const id = cache.match[keyLb(s)]; if (!id) continue; const e = get(id); e.wl = true; e.lb = s.lb; e.added = s.added || null; }
  for (const s of SRC.watched) { const id = cache.match[keyLb(s)]; if (id) { seen.add(id); seenLb.add(id); } }
  rated = new Set(SRC.ratings.map(r => cache.match[keyLb(r)]).filter(Boolean));
  shelfSeenOwn = new Set();
  for (const s of SRC.shelf) { const id = cache.match[keyShelf(s)]; if (id && s.seen && s.owner !== 'sarah' && !unseen.has(id)) shelfSeenOwn.add(id); }
  for (const id of state.extra) get(id);
  for (const [id, r] of shared) if (r.in_list) get(id);
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
    if (CLOUD && isOwner()) {
      if (JSON.stringify(shelfMap) !== JSON.stringify(house.shelf || {})) pushHouse('shelf', shelfMap);
      const m = Object.fromEntries(Object.entries(cache.match).filter(([, v]) => v));
      if (Object.keys(m).length !== Object.keys(house.match || {}).length) pushHouse('match', m);
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

/* ---------- Ansicht ---------- */
const svcSet = () => new Set(state.services || []);
function streamable(f) {
  const s = svcSet(), out = [], names = new Set();
  const skipPrime = f.id != null && noovActive(f.id);
  for (const p of f.fl || []) {
    if (!s.has(p[0])) continue;
    if (skipPrime && isPrime(p)) continue;
    const base = p[1].replace(/\s+with ads$/i, '');
    if (names.has(base)) continue;
    names.add(base); out.push(p);
  }
  return out;
}
const allowedTabs = () => isOwner()
  ? [...state.lists.map(l => l.id), 'all', 'discover', 'hidden', 'rate']
  : [OURS, 'discover', 'hidden'];

function addedAt(id) {
  const sh = shared.get(id), e = lib.get(id);
  return Math.max(sh?.in_list ? ts(sh.changed_at) : 0, e?.added ? ts(e.added) : 0);
}
function visibleIds() {
  const tab = state.tab, q = norm($('#q').value);
  const hidden = new Set(state.hidden);
  const out = [];
  for (const id of lib.keys()) {
    const f = cache.films[id]; if (!f) continue;
    const e = lib.get(id);
    if (tab === 'hidden') { if (!hidden.has(id)) continue; }
    else if (tab === OURS) { if (!inOurs(id)) continue; }
    else {
      if (hidden.has(id)) continue;
      if (tab !== 'all' && !membersOf(id).includes(tab)) continue;
    }
    if (q && !norm(f.t + ' ' + f.o).includes(q)) continue;
    const st = streamable(f).length > 0;
    if (state.source === 'avail' && !(e.shelf || st)) continue;
    if (state.source === 'shelf' && !e.shelf) continue;
    if (state.source === 'stream' && !st) continue;
    if (state.runtime && f.r && f.r > state.runtime) continue;
    if (state.genres.length && !state.genres.some(g => f.g.includes(g))) continue;
    out.push(id);
  }
  const F = id => cache.films[id];
  const sorters = {
    rating: (a, b) => F(b).v - F(a).v,
    title: (a, b) => F(a).t.localeCompare(F(b).t, 'de'),
    new: (a, b) => (F(b).y || 0) - (F(a).y || 0) || F(b).v - F(a).v,
    short: (a, b) => (F(a).r || 999) - (F(b).r || 999),
    added: (a, b) => addedAt(b) - addedAt(a) || F(b).v - F(a).v
  };
  return out.sort(sorters[state.sort] || sorters.new);
}

function toRate() {
  if (!isOwner()) return [];
  const done = new Set(state.ratedDone || []);
  const skip = id => rated.has(id) || done.has(id);
  const app = state.seenLocal.filter(id => !skip(id));
  const lb = [...seenLb].filter(id => !skip(id) && !app.includes(id));
  const mm = [...shelfSeenOwn].filter(id => !skip(id) && !seenLb.has(id) && !app.includes(id));
  return [
    { key: 'app', title: 'In der App als gesehen markiert', ids: app, open: true },
    { key: 'lb', title: 'Auf Letterboxd gesehen, aber ohne Bewertung', ids: lb, open: true },
    { key: 'mm', title: 'Laut MyMovies gesehen, nicht auf Letterboxd', ids: mm, open: false }
  ].filter(g => g.ids.length);
}
const rateCount = () => toRate().reduce((n, g) => n + g.ids.length, 0);
let rateOpen = {};
function renderRate() {
  const groups = toRate();
  const box = $('#rateView');
  const missing = groups.flatMap(g => g.ids).filter(id => !cache.films[id]);
  if (missing.length && state.apiKey) Promise.all(missing.slice(0, 60).map(id => film(id).catch(() => null))).then(() => { if (state.tab === 'rate') render(); });
  box.replaceChildren(
    el('p', { class: 'hint' }, 'Filme, die du gesehen, aber auf Letterboxd noch nicht bewertet hast. Mit „Erledigt“ verschwinden sie, beim nächsten Letterboxd-Export räumt sich die Liste zusätzlich selbst auf.'),
    ...groups.map(g => {
      const det = el('details', { class: 'rate-group', open: (rateOpen[g.key] ?? g.open) || null, ontoggle: ev => { rateOpen[g.key] = ev.target.open; } },
        el('summary', {}, `${g.title} `, el('small', {}, String(g.ids.length))),
        g.ids.length > 3 ? el('button', { class: 'mini', type: 'button', onclick: () => {
          const prev = (state.ratedDone || []).slice();
          state.ratedDone = uniq([...prev, ...g.ids]); persist(); render();
          toast(`${g.ids.length} Filme als erledigt markiert.`, { label: 'Rückgängig', run: () => { state.ratedDone = prev; persist(); render(); } });
        } }, 'Alle in dieser Gruppe als erledigt markieren') : null,
        el('ul', { class: 'rate-list' }, g.ids.map(id => {
          const f = cache.films[id];
          return el('li', { class: 'sg' },
            f?.p ? el('img', { src: IMG + 'w92' + f.p, alt: '', loading: 'lazy' }) : el('span', { class: 'sg-noimg' }),
            el('div', { class: 'sg-body' }, el('strong', {}, f ? f.t + (f.y ? ' (' + f.y + ')' : '') : 'Lade …'),
              el('span', { class: 'links' }, el('a', { href: lbLink(id), target: '_blank', rel: 'noopener' }, 'Auf Letterboxd bewerten'))),
            el('button', { class: 'btn ghost', type: 'button', onclick: () => { state.ratedDone = uniq([...(state.ratedDone || []), id]); persist(); render(); } }, 'Erledigt'));
        })));
      return det;
    }));
}

function renderTabs() {
  const nav = $('#tabs'); nav.replaceChildren();
  const hidden = new Set(state.hidden);
  const countIn = lid => {
    let n = 0;
    for (const id of lib.keys()) {
      if (!cache.films[id]) continue;
      if (lid === OURS) { if (inOurs(id)) n++; }
      else if (!hidden.has(id) && membersOf(id).includes(lid)) n++;
    }
    return n;
  };
  const tab = (id, label, count, extra = {}) => nav.append(el('button', Object.assign({
    class: 'tab' + (state.tab === id ? ' on' : ''), type: 'button', onclick: () => setTab(id)
  }, extra), label, count != null ? el('small', {}, String(count)) : null));
  if (isOwner()) {
    for (const l of state.lists) tab(l.id, l.name, countIn(l.id),
      l.id !== 'mine' && l.id !== OURS ? { ondblclick: () => removeList(l) } : {});
    tab('all', 'Alles');
    tab('discover', 'Entdecken');
    if (state.hidden.length) tab('hidden', 'Nie', state.hidden.length);
    nav.append(el('button', { class: 'tab add', type: 'button', onclick: () => $('#newListDlg').showModal() }, '+ Liste'));
    const rc = rateCount();
    if (rc) tab('rate', 'Nachtragen', rc);
  } else {
    tab(OURS, 'Unsere', countIn(OURS));
    tab('discover', 'Entdecken');
    if (state.hidden.length) tab('hidden', 'Nie', state.hidden.length);
  }
}
function setTab(t) { state.tab = t; persist(); render(); }

function renderGenres() {
  const all = new Set();
  for (const id of lib.keys()) for (const g of cache.films[id]?.g || []) all.add(g);
  const box = $('#genres'); box.replaceChildren();
  [...all].sort((a, b) => a.localeCompare(b, 'de')).forEach(g => box.append(el('button', {
    class: 'gchip' + (state.genres.includes(g) ? ' on' : ''), type: 'button',
    onclick: () => { state.genres = state.genres.includes(g) ? state.genres.filter(x => x !== g) : [...state.genres, g]; persist(); render(); }
  }, g)));
}

function lbLink(id) { const e = lib.get(id); return e?.lb || `https://letterboxd.com/tmdb/${id}/`; }
const extLinks = (id, f) => [
  f.imdb ? el('a', { href: 'https://www.imdb.com/title/' + f.imdb + '/', target: '_blank', rel: 'noopener' }, 'IMDb') : null,
  f.tr ? el('a', { href: 'https://www.youtube.com/watch?v=' + f.tr, target: '_blank', rel: 'noopener' }, 'Trailer') : null,
  el('a', { href: lbLink(id), target: '_blank', rel: 'noopener' }, 'Letterboxd')
];

const fmtMonth = iso => { const d = new Date(iso); return isNaN(d) ? '' : String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getFullYear()).slice(2); };
function ovControl(id, f) {
  if (f.ol !== 'en') return null;
  const svc = svcSet();
  const hasPrime = (f.fl || []).some(p => isPrime(p) && svc.has(p[0]));
  const r = noov.get(id);
  if (r?.in_list) return el('span', { class: 'mini muted' }, `Prime ohne O-Ton (${fmtMonth(r.changed_at)}) `,
    el('button', { class: 'mini', type: 'button', title: 'Prime zählt für diesen Film wieder', onclick: () => setNoov(id, false) }, 'aufheben'));
  if (!hasPrime) return null;
  return el('button', { class: 'mini', type: 'button', title: 'Bei Prime gibt es diesen Film nur synchronisiert. Prime zählt dann für diesen Film nicht.', onclick: () => {
    setNoov(id, true); toast(`„${f.t}“: Prime zählt nicht mehr, bis du es aufhebst.`, { label: 'Rückgängig', run: () => setNoov(id, false) });
  } }, 'Prime: kein O-Ton');
}

function card(id) {
  const f = cache.films[id], e = lib.get(id);
  const isSeen = seen.has(id);
  const isHidden = state.hidden.includes(id);
  const st = streamable(f);
  const inTray = state.tray.includes(id);
  const sh = shared.get(id);
  const stickers = [];
  if (e.shelf) stickers.push(el('span', { class: 'sticker' }, e.shelf));
  if (e.sarah) stickers.push(el('span', { class: 'sticker sarah' }, 'Sarahs'));
  if (isSeen) stickers.push(el('span', { class: 'sticker seen' }, 'gesehen'));
  if (isHidden && state.tab === OURS) stickers.push(el('span', { class: 'sticker seen' }, 'bei dir: Nie'));
  const src = [];
  if (e.wl) src.push('Watchlist' + (e.added ? ' seit ' + e.added.slice(5, 7) + '/' + e.added.slice(0, 4) : ''));
  if (e.shelf && isOwner()) src.push(e.sarah && !e.mineShelf ? 'Regal (Sarahs)' : 'Regal');
  if (sh?.in_list && sh.added_by && sh.added_by !== me.id) src.push('Vorschlag von ' + otherName(sh.added_by));
  if (isOwner() && !src.length && state.extra.includes(id)) src.push('per Suche hinzugefügt');

  let actions;
  if (isOwner()) {
    const mem = membersOf(id);
    actions = [
      el('div', { class: 'lists' }, state.lists.map(l => el('button', {
        class: 'lchip' + (mem.includes(l.id) ? ' on' : ''), type: 'button', onclick: () => toggleList(id, l.id)
      }, l.name))),
      el('div', { class: 'links' }, extLinks(id, f),
        !isSeen ? el('button', { type: 'button', onclick: () => markSeen(id) }, 'Gesehen')
          : !seenLb.has(id) ? el('button', { type: 'button', onclick: () => unmarkSeen(id) }, 'Doch nicht gesehen') : null,
        isHidden
          ? el('button', { type: 'button', onclick: () => unhide(id) }, 'Zurückholen')
          : el('button', { class: 'hide', type: 'button', onclick: () => hide(id) }, 'Nie'))
    ];
  } else {
    actions = [
      el('div', { class: 'links' }, extLinks(id, f),
        state.tab === 'hidden'
          ? el('button', { type: 'button', onclick: () => unhide(id) }, 'Zurückholen')
          : inOurs(id)
            ? el('button', { class: 'hide', type: 'button', onclick: () => removeFromOurs(id) }, 'Raus aus Unsere')
            : el('button', { type: 'button', onclick: () => addToOurs(id) }, 'Zu Unsere'))
    ];
  }
  return el('article', { class: 'card', 'data-id': id },
    el('div', { class: 'poster', onclick: ev => { if (!ev.target.closest('button')) openFilm(id); } },
      f.p ? el('img', { src: IMG + 'w342' + f.p, alt: '', loading: 'lazy' }) : el('div', { class: 'noimg' }, f.t),
      el('div', { class: 'stickers' }, stickers),
      el('div', { class: 'provs' }, st.map(p => el('img', { src: IMG + 'w92' + p[2], alt: p[1], title: p[1] }))),
      el('button', { class: 'tonight' + (inTray ? ' on' : ''), type: 'button', title: inTray ? 'Aus Heute Abend entfernen' : 'Für heute Abend vormerken', 'aria-pressed': String(inTray), onclick: () => toggleTray(id) }, inTray ? '★' : '☆')
    ),
    el('div', { class: 'body' },
      el('h3', { class: 'title' }, f.t),
      f.o && norm(f.o) !== norm(f.t) ? el('div', { class: 'meta orig' }, f.o) : null,
      el('div', { class: 'meta' }, [f.y, f.r ? f.r + ' min' : null, f.v ? '★ ' + f.v.toFixed(1) : null].filter(Boolean).join(' · ')),
      el('div', { class: 'meta' }, f.g.slice(0, 3).join(', ')),
      src.length ? el('div', { class: 'meta src' }, src.join(' · ')) : null,
      actions,
      ovControl(id, f)
    )
  );
}

let appShown = false;
let filtersOpen = false;
function render() {
  if (!appShown) return;
  if (!allowedTabs().includes(state.tab)) state.tab = isOwner() ? 'mine' : OURS;
  renderTabs(); renderNotice();
  const disc = state.tab === 'discover';
  $('#discover').hidden = !disc; $('#main').hidden = disc; document.querySelector('.filters').hidden = disc;
  if (disc) { $('#filterToggle').hidden = true; $('#suggest').hidden = true; $('#rateView').hidden = true; renderTray(); renderDeck(); return; }
  const rate = state.tab === 'rate';
  $('#rateView').hidden = !rate;
  ['#grid', '#count', '#empty', '#tmdbSearch'].forEach(sel => { if (rate) $(sel).hidden = true; });
  if (rate) {
    if (!rateCount()) { state.tab = 'mine'; return render(); }
    $('#filterToggle').hidden = true; $('#suggest').hidden = true; document.querySelector('.filters').hidden = true;
    $('#count').hidden = true; renderRate(); renderTray(); return;
  }
  $('#grid').hidden = false; $('#count').hidden = false;
  renderGenres();
  $('#suggest').hidden = state.tab !== OURS;
  const collapse = !isOwner() || window.matchMedia('(max-width: 700px)').matches;
  const active = (state.source !== 'all' ? 1 : 0) + (state.runtime ? 1 : 0) + state.genres.length + ($('#q').value.trim() ? 1 : 0);
  $('#filterToggle').hidden = !collapse;
  $('#filterToggle').textContent = (filtersOpen ? 'Filter ausblenden' : 'Filter') + (active ? ` (${active} aktiv)` : '');
  $('#filterToggle').setAttribute('aria-expanded', String(filtersOpen));
  document.querySelector('.filters').hidden = collapse && !filtersOpen;
  document.querySelectorAll('#source button').forEach(b => b.classList.toggle('on', b.dataset.v === state.source));
  $('#runtime').value = String(state.runtime); $('#sort').value = state.sort;
  const ids = visibleIds();
  $('#grid').replaceChildren(...ids.map(card));
  $('#count').textContent = ids.length + (ids.length === 1 ? ' Film' : ' Filme');
  const empty = $('#empty');
  if (!state.apiKey) {
    empty.hidden = false;
    empty.textContent = isOwner()
      ? 'Trag in den Einstellungen deinen TMDB-Schlüssel ein, dann gleicht MovieDude Regal, Watchlist und Streamingdienste ab.'
      : 'Tobias muss in der App noch einmal den TMDB-Schlüssel hinterlegen. Danach geht es hier los.';
  } else if (!ids.length) {
    empty.hidden = false;
    empty.textContent = syncing ? 'Abgleich läuft, die Filme tauchen gleich auf.'
      : state.tab === OURS && ![...shared.values()].some(r => r.in_list) ? 'Noch nichts in „Unsere“. Schlag oben einen Film vor oder wisch im Tab „Entdecken“ nach rechts.'
      : 'Keine Filme für diese Filter. Probier „Auch nicht verfügbar“ oder entferne ein Genre.';
  } else empty.hidden = true;
  $('#tmdbSearch').hidden = !(isOwner() && $('#q').value.trim().length > 1 && state.apiKey);
  renderTray();
}
let renderT = null;
const renderSoon = () => { clearTimeout(renderT); renderT = setTimeout(() => { rebuild(); render(); }, 120); };

/* ---------- Aktionen ---------- */
function toggleList(id, lid) {
  if (lid === OURS) { setOurs(id, !inOurs(id)).then(() => render()); rebuild(); render(); return; }
  const cur = privateMembers(id);
  state.members[id] = cur.includes(lid) ? cur.filter(x => x !== lid) : [...cur, lid];
  persist(); render();
}
function addToOurs(id) { setOurs(id, true); rebuild(); render(); }
function removeFromOurs(id) {
  setOurs(id, false); rebuild(); render();
  const f = cache.films[id];
  toast(`„${f ? f.t : 'Film'}“ ist raus aus Unsere.`, { label: 'Rückgängig', run: () => addToOurs(id) });
}
function hide(id) { state.hidden = uniq([...state.hidden, id]); state.tray = state.tray.filter(x => x !== id); persist(); render(); toast('Ausgeblendet. Zu finden im Tab „Nie“.'); }
function unhide(id) { state.hidden = state.hidden.filter(x => x !== id); persist(); render(); }
function markSeen(id) {
  const prev = state.members[id];
  const wasOurs = inOurs(id);
  state.seenLocal = uniq([...state.seenLocal, id]);
  state.unseenLocal = state.unseenLocal.filter(x => x !== id);
  state.members[id] = [];                      // raus aus allen Listen
  state.tray = state.tray.filter(x => x !== id);
  if (wasOurs) setOurs(id, false);
  persist(); rebuild(); render();
  window.open(lbLink(id), '_blank', 'noopener');
  toast('Gesehen. Raus aus allen Listen. Auf Letterboxd abhaken nicht vergessen.', { label: 'Rückgängig', run: () => { unmarkSeen(id, prev); if (wasOurs) addToOurs(id); } });
}
function unmarkSeen(id, prevMembers) {
  state.seenLocal = state.seenLocal.filter(x => x !== id);
  if (lib.get(id)?.shelfSeen) state.unseenLocal = uniq([...state.unseenLocal, id]);
  if (prevMembers !== undefined) state.members[id] = prevMembers;
  else if (state.members[id] && !state.members[id].length) delete state.members[id];
  persist(); rebuild(); render();
  toast('Wieder in der Liste.');
}
function toggleTray(id) {
  state.tray = state.tray.includes(id) ? state.tray.filter(x => x !== id) : [...state.tray, id];
  persist(); render();
}
function removeList(l) {
  const n = Object.values(state.members).filter(m => m.includes(l.id)).length;
  if (!window.confirm(`Liste „${l.name}“ löschen? ${n} Filme verlieren nur die Zuordnung.`)) return;
  state.lists = state.lists.filter(x => x.id !== l.id);
  for (const k of Object.keys(state.members)) state.members[k] = state.members[k].filter(x => x !== l.id);
  if (state.tab === l.id) state.tab = 'mine';
  persist(); render();
}

function renderTray() {
  const n = state.tray.filter(id => cache.films[id]).length;
  $('#tray').hidden = n === 0 || !appShown; $('#trayCount').textContent = n;
}
function trayText() {
  const lines = state.tray.filter(id => cache.films[id]).map((id, i) => {
    const f = cache.films[id], e = lib.get(id) || {};
    const where = [e.shelf ? 'Regal' : null, ...streamable(f).map(p => p[1])].filter(Boolean).join(', ');
    return `${i + 1}. ${f.t} (${f.y}${f.r ? ', ' + f.r + ' min' : ''})${where ? ' – ' + where : ''}\n${f.imdb ? 'https://www.imdb.com/title/' + f.imdb + '/' : ''}`;
  });
  return 'Filmabend? Meine Vorschläge:\n\n' + lines.join('\n\n');
}
function openTray() {
  const ol = $('#trayList'); ol.replaceChildren(...state.tray.filter(id => cache.films[id]).map(id =>
    el('li', {}, el('span', {}, cache.films[id].t + ' (' + cache.films[id].y + ')'), el('button', { type: 'button', onclick: () => { toggleTray(id); openTray(); } }, 'Entfernen'))));
  $('#trayText').value = trayText();
  if (!$('#trayDlg').open) $('#trayDlg').showModal();
  if (!state.tray.length) $('#trayDlg').close();
}

async function tmdbSearch() {
  const q = $('#q').value.trim(); if (!q) return;
  try {
    const r = await tmdb('/search/movie', { query: q, language: 'de-DE' });
    const ids = (r.results || []).slice(0, 8).map(m => m.id);
    await Promise.all(ids.map(id => film(id)));
    state.extra = uniq([...state.extra, ...ids]);
    persist(); rebuild(); state.tab = 'all'; state.source = 'all'; render();
    toast(ids.length ? `${ids.length} Treffer unter „Alles“. Per Listen-Chip übernehmen.` : 'Nichts gefunden.');
  } catch (e) { toast('Suche fehlgeschlagen: ' + e.message); }
}

/* ---------- Detailansicht ---------- */
function openFilm(id) {
  const f = cache.films[id]; if (!f) return;
  const box = $('#filmBody');
  box.replaceChildren(
    f.p ? el('img', { class: 'fd-poster', src: IMG + 'w342' + f.p, alt: '' }) : null,
    el('div', { class: 'fd-body' },
      el('h2', {}, f.t),
      f.o && norm(f.o) !== norm(f.t) ? el('div', { class: 'meta' }, f.o) : null,
      el('div', { class: 'meta' }, [f.y, f.r ? f.r + ' min' : null, f.v ? '★ ' + f.v.toFixed(1) : null].filter(Boolean).join(' · ')),
      f.g.length ? el('div', { class: 'meta' }, f.g.join(', ')) : null,
      el('p', { class: 'fd-ov' }, f.ov || 'Keine Inhaltsangabe vorhanden.'),
      el('p', { class: 'meta' + (streamable(f).length || lib.get(id)?.shelf ? '' : ' warn') }, whereText(id, f)),
      el('div', { class: 'links' }, extLinks(id, f)),
      ovControl(id, f)));
  $('#filmDlg').showModal();
}

/* ---------- Vorschlagen per Link oder Titel ---------- */
async function resolveInput(s) {
  s = s.trim(); let m;
  if ((m = s.match(/tt\d{5,10}/))) { const id = await matchByImdb(m[0]); return id ? [id] : []; }
  if ((m = s.match(/themoviedb\.org\/movie\/(\d+)/))) return [+m[1]];
  if ((m = s.match(/letterboxd\.com\/(?:[^/]+\/)?film\/([a-z0-9-]+)/i))) {
    let slug = m[1], year = null;
    const y = slug.match(/-(\d{4})$/); if (y) { year = +y[1]; slug = slug.slice(0, -5); }
    const r = await tmdb('/search/movie', { query: slug.replace(/-/g, ' '), language: 'de-DE', ...(year ? { primary_release_year: year } : {}) });
    return (r.results || []).slice(0, 5).map(x => x.id);
  }
  if (/boxd\.it\//i.test(s)) throw new Error('Letterboxd-Kurzlinks (boxd.it) kann ich nicht öffnen. Nimm den langen Link aus dem Browser oder tipp einfach den Titel.');
  if (/^https?:\/\//i.test(s)) throw new Error('Mit diesem Link kann ich nichts anfangen. IMDb- und Letterboxd-Filmlinks gehen, sonst einfach den Titel tippen.');
  const r = await tmdb('/search/movie', { query: s, language: 'de-DE' });
  return (r.results || []).slice(0, 6).map(x => x.id);
}
function whereText(id, f) {
  const parts = [];
  const shelf = lib.get(id)?.shelf || (house.shelf || {})[id];
  if (shelf) parts.push('Im Regal (' + shelf + ')');
  const st = streamable(f).map(p => p[1]);
  if (st.length) parts.push('Läuft bei ' + st.join(', '));
  return parts.length ? parts.join(' · ') : 'Läuft gerade bei keinem eurer Dienste';
}
async function suggest(e) {
  e.preventDefault();
  const input = $('#suggestInput').value; if (!input.trim()) return;
  const status = $('#suggestStatus'), list = $('#suggestList');
  if (!state.apiKey) { status.textContent = 'Erst muss der TMDB-Schlüssel hinterlegt sein.'; return; }
  status.textContent = 'Suche…'; list.replaceChildren();
  try {
    const ids = await resolveInput(input);
    const films = await Promise.all(ids.map(id => film(id).then(f => [id, f]).catch(() => null)));
    const ok = films.filter(Boolean);
    status.textContent = ok.length ? (ok.length === 1 ? 'Gefunden:' : 'Welcher ist es?') : 'Nichts gefunden. Probier den Originaltitel oder einen IMDb-Link.';
    list.replaceChildren(...ok.map(([id, f]) => {
      const inside = inOurs(id);
      const avail = streamable(f).length || lib.get(id)?.shelf || (house.shelf || {})[id];
      return el('li', { class: 'sg' },
        f.p ? el('img', { src: IMG + 'w92' + f.p, alt: '' }) : el('span', { class: 'sg-noimg' }),
        el('div', { class: 'sg-body' },
          el('strong', {}, f.t + (f.y ? ' (' + f.y + ')' : '')),
          el('span', { class: 'meta' + (avail ? '' : ' warn') }, whereText(id, f)),
          el('span', { class: 'links' }, extLinks(id, f))),
        el('button', { class: 'btn' + (inside ? ' ghost' : ''), type: 'button', disabled: inside, onclick: ev => {
          state.extra = uniq([...state.extra, id]);
          addToOurs(id); persist();
          ev.target.textContent = 'Drin'; ev.target.disabled = true; ev.target.classList.add('ghost');
          toast(`„${f.t}“ ist jetzt in Unsere.`);
        } }, inside ? 'Schon drin' : 'Zu Unsere'));
    }));
  } catch (err) { status.textContent = err.message || String(err); }
}

/* ---------- Hinweise: Was hat die andere Person in "Unsere" geändert? ---------- */
function foreignChanges() {
  if (!CLOUD || !me.id) return [];
  const out = [];
  for (const [id, r] of shared) if (r.changed_by && r.changed_by !== me.id && ts(r.changed_at) > (state.lastSeen || 0)) out.push([id, r]);
  return out.sort((a, b) => ts(b[1].changed_at) - ts(a[1].changed_at));
}
function renderNotice() {
  const ch = foreignChanges();
  const box = $('#notice');
  if (!ch.length) { box.hidden = true; return; }
  const by = otherName(ch[0][1].changed_by);
  const add = ch.filter(([, r]) => r.in_list).length, rem = ch.length - add;
  const parts = [];
  if (add) parts.push(`${add} ${add === 1 ? 'Film' : 'Filme'} in Unsere gelegt`);
  if (rem) parts.push(`${rem} rausgenommen`);
  $('#noticeText').textContent = `${by} hat ${parts.join(' und ')}.`;
  box.hidden = false;
}
async function openNotice() {
  const ch = foreignChanges();
  const ul = $('#noticeList');
  ul.replaceChildren(el('li', {}, 'Lade…'));
  $('#noticeDlg').showModal();
  await Promise.all(ch.map(([id]) => film(id).catch(() => null)));
  ul.replaceChildren(...ch.map(([id, r]) => {
    const f = cache.films[id];
    const name = f ? `${f.t}${f.y ? ' (' + f.y + ')' : ''}` : 'Film #' + id;
    return el('li', {},
      el('span', {}, (r.in_list ? 'Neu: ' : 'Rausgenommen: ') + name),
      !r.in_list && !inOurs(id) ? el('button', { class: 'btn ghost', type: 'button', onclick: ev => { addToOurs(id); ev.target.replaceWith('Zurückgeholt'); } }, 'Zurückholen') : null);
  }));
}
function ackNotice() {
  const ch = foreignChanges();
  const max = Math.max(state.lastSeen || 0, ...ch.map(([, r]) => ts(r.changed_at)));
  state.lastSeen = max; persist(); renderNotice();
}

/* ---------- Entdecken (Swipe-Feed) ---------- */
let feed = { key: '', page: 0, ids: [], loading: false, done: false };
let lastDecision = null;
const feedKey = () => state.feed + '|' + (state.services || []).join(',');

function eligible(id) {
  if (seen.has(id) || state.hidden.includes(id) || inOurs(id)) return false;
  if (noovActive(id) && cache.films[id] && !streamable(cache.films[id]).length) return false;
  if (isOwner() && lib.has(id)) return false;
  const s = state.snooze[id]; return !(s && s > Date.now());
}
async function fillFeed() {
  if (feed.loading || feed.done || !state.apiKey || !(state.services || []).length) return;
  feed.loading = true;
  const key = feed.key;
  try {
    while (feed.key === key && feed.ids.length < 6 && !feed.done) {
      feed.page++;
      const p = {
        watch_region: REGION, with_watch_providers: state.services.join('|'),
        with_watch_monetization_types: 'flatrate|free|ads', language: 'de-DE', page: feed.page, include_adult: 'false'
      };
      if (state.feed === 'recent') Object.assign(p, { sort_by: 'primary_release_date.desc', 'primary_release_date.lte': new Date().toISOString().slice(0, 10), 'vote_count.gte': 10 });
      else Object.assign(p, { sort_by: 'popularity.desc' });
      const r = await tmdb('/discover/movie', p);
      for (const m of r.results || []) if (eligible(m.id) && !feed.ids.includes(m.id)) feed.ids.push(m.id);
      if (feed.page >= Math.min(r.total_pages || 0, 40)) feed.done = true;
    }
    if (feed.key !== key) return;
    await Promise.all(feed.ids.slice(0, 3).map(id => film(id)));
  } catch (e) { toast('Feed konnte nicht geladen werden: ' + e.message); feed.done = true; }
  finally { if (feed.key === key) { feed.loading = false; if (state.tab === 'discover') renderDeck(); } }
}
function renderDeck() {
  document.querySelectorAll('#feedMode button').forEach(b => b.classList.toggle('on', b.dataset.v === state.feed));
  $('[data-act="undo"]').disabled = !lastDecision;
  $('[data-act="ours"]').hidden = !isOwner();
  $('[data-act="mine"]').textContent = isOwner() ? 'Meine' : 'Vorschlagen';
  $('#discHint').textContent = isOwner()
    ? 'Wischen: links Nie, rechts Meine. Am Rechner: Pfeiltasten ← Nie, → Meine, ↑ Unsere, ↓ Lass erstmal.'
    : 'Wischen: links Nie, rechts als Vorschlag in Unsere. „Lass erstmal“ zeigt den Film in 30 Tagen nochmal.';
  const deck = $('#deck'); const info = $('#discInfo');
  if (feed.key !== feedKey()) feed = { key: feedKey(), page: 0, ids: [], loading: false, done: false };
  const names = (cache.providers?.list || []).filter(p => (state.services || []).includes(p.id)).map(p => p.name);
  info.textContent = names.length ? 'Auf: ' + names.join(', ') : '';
  const msg = t => { deck.replaceChildren(el('div', { class: 'empty' }, t)); document.querySelectorAll('#discActions .act:not([data-act="undo"])').forEach(b => b.disabled = true); };
  if (!state.apiKey) return msg(isOwner() ? 'Erst den TMDB-Schlüssel in den Einstellungen eintragen.' : 'Tobias muss erst den TMDB-Schlüssel hinterlegen.');
  if (!(state.services || []).length) return msg(isOwner() ? 'Wähl in den Einstellungen mindestens einen Streamingdienst aus.' : 'Es sind noch keine Streamingdienste ausgewählt.');
  feed.ids = feed.ids.filter(eligible);
  const top = feed.ids[0];
  if (feed.ids.length < 4) fillFeed();
  if (!top) return msg(feed.loading || !feed.done ? 'Feed wird geladen…' : 'Durch! Für diesen Feed ist nichts Neues mehr da.');
  if (!isFresh(cache.films[top])) { msg('Lade Film…'); film(top).then(renderDeck).catch(() => { feed.ids.shift(); renderDeck(); }); return; }
  document.querySelectorAll('#discActions .act').forEach(b => { if (b.dataset.act !== 'undo') b.disabled = false; });
  const next = feed.ids[1] && cache.films[feed.ids[1]];
  const kids = [];
  if (next) kids.push(el('div', { class: 'swipe back' }, el('div', { class: 'poster' }, next.p ? el('img', { src: IMG + 'w500' + next.p, alt: '' }) : null)));
  kids.push(swipeCard(top));
  deck.replaceChildren(...kids);
  feed.ids.slice(1, 4).filter(id => !isFresh(cache.films[id])).forEach(id => film(id).catch(() => {}));
}
function swipeCard(id) {
  const f = cache.films[id];
  const st = streamable(f);
  const c = el('article', { class: 'swipe', 'data-id': id },
    el('div', { class: 'poster' },
      f.p ? el('img', { src: IMG + 'w500' + f.p, alt: '' }) : el('div', { class: 'noimg' }, f.t),
      el('div', { class: 'provs' }, st.map(p => el('img', { src: IMG + 'w92' + p[2], alt: p[1], title: p[1] }))),
      el('span', { class: 'stamp yes' }, isOwner() ? 'Meine' : 'Vorschlag'), el('span', { class: 'stamp no' }, 'Nie')),
    el('div', { class: 'body' },
      el('h3', { class: 'title' }, f.t),
      f.o && norm(f.o) !== norm(f.t) ? el('div', { class: 'meta' }, f.o) : null,
      el('div', { class: 'meta' }, [f.y, f.r ? f.r + ' min' : null, f.v ? '★ ' + f.v.toFixed(1) : null, f.g.slice(0, 3).join(', ')].filter(Boolean).join(' · ')),
      f.ov ? el('p', { class: 'ov' }, f.ov) : null,
      el('div', { class: 'links' }, extLinks(id, f))));
  let x0 = null, dx = 0;
  const yes = c.querySelector('.stamp.yes'), no = c.querySelector('.stamp.no');
  c.addEventListener('pointerdown', e => { if (e.target.closest('a')) return; x0 = e.clientX; dx = 0; c.classList.add('dragging'); c.setPointerCapture(e.pointerId); });
  c.addEventListener('pointermove', e => {
    if (x0 == null) return; dx = e.clientX - x0;
    c.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
    yes.style.opacity = Math.max(0, Math.min(1, dx / 100)); no.style.opacity = Math.max(0, Math.min(1, -dx / 100));
  });
  const end = () => {
    if (x0 == null) return; x0 = null; c.classList.remove('dragging');
    if (dx > 100) decide('mine'); else if (dx < -100) decide('nie');
    else { c.style.transform = ''; yes.style.opacity = no.style.opacity = 0; }
  };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  return c;
}
function decide(act) {
  if (act === 'undo') return undoDecision();
  if (!isOwner() && act === 'mine') act = OURS;
  const id = feed.ids[0]; if (!id || !cache.films[id]) return;
  lastDecision = { id, extra: state.extra.slice(), member: state.members[id], hidden: state.hidden.slice(), seenLocal: state.seenLocal.slice(), snooze: state.snooze[id], ours: inOurs(id) };
  const cardEl = document.querySelector('.swipe:not(.back)');
  const dir = act === 'mine' || act === OURS ? 1 : act === 'nie' ? -1 : 0;
  if (cardEl) { cardEl.style.transform = dir ? `translateX(${dir * 600}px) rotate(${dir * 25}deg)` : 'translateY(-40px) scale(.9)'; cardEl.style.opacity = 0; }
  const addExtra = () => { if (!state.extra.includes(id)) state.extra.push(id); };
  if (act === 'mine') { addExtra(); state.members[id] = ['mine']; }
  if (act === OURS) { addExtra(); if (isOwner() && !state.members[id]) state.members[id] = []; setOurs(id, true); }
  if (act === 'nie') { addExtra(); state.hidden = uniq([...state.hidden, id]); }
  if (act === 'seen') { addExtra(); state.seenLocal = uniq([...state.seenLocal, id]); state.members[id] = []; }
  if (act === 'later') state.snooze[id] = Date.now() + SNOOZE_MS;
  feed.ids.shift();
  persist(); rebuild();
  setTimeout(() => { renderTabs(); renderDeck(); }, cardEl ? 220 : 0);
}
function undoDecision() {
  const d = lastDecision; if (!d) return;
  state.extra = d.extra; state.hidden = d.hidden; state.seenLocal = d.seenLocal;
  if (d.member === undefined) delete state.members[d.id]; else state.members[d.id] = d.member;
  if (d.snooze === undefined) delete state.snooze[d.id]; else state.snooze[d.id] = d.snooze;
  if (inOurs(d.id) !== d.ours) setOurs(d.id, d.ours);
  lastDecision = null; persist(); rebuild();
  feed.ids.unshift(d.id); renderTabs(); renderDeck();
}

/* ---------- Einstellungen ---------- */
async function renderServices() {
  const box = $('#services'); box.replaceChildren();
  if (!state.apiKey) { box.append(el('p', { class: 'hint' }, 'Erst Schlüssel speichern.')); return; }
  let list; try { list = await loadProviders(); } catch { box.append(el('p', { class: 'hint' }, 'Dienste konnten nicht geladen werden.')); return; }
  if (state.services == null) setServices(list.filter(p => DEFAULT_SERVICES.some(rx => rx.test(p.name))).map(p => p.id));
  const on = svcSet();
  list.forEach(p => box.append(el('label', { class: 'svc' },
    el('input', { type: 'checkbox', checked: on.has(p.id), onchange: ev => {
      setServices(ev.target.checked ? uniq([...state.services, p.id]) : state.services.filter(x => x !== p.id));
      render();
    } }),
    p.logo ? el('img', { src: IMG + 'w92' + p.logo, alt: '' }) : null, el('span', {}, p.name))));
}
function setServices(ids) {
  state.services = ids;
  if (CLOUD) pushHouse('services', ids); else persist();
}
function stats() {
  if (!isOwner()) { $('#stats').textContent = ''; return; }
  const keys = [...SRC.shelf.map(keyShelf), ...SRC.watchlist.map(keyLb), ...SRC.watched.map(keyLb)];
  const miss = keys.filter(k => k in cache.match && !cache.match[k]).length;
  const cand = [...lib.keys()].filter(isCandidate).length;
  $('#stats').textContent = `${lib.size} Filme bekannt, ${cand} ungesehene Kandidaten, ${seen.size} gesehen. ${miss} Einträge ließen sich nicht zuordnen.`;
}
function openSettings() {
  $('#apiKey').value = state.apiKey;
  $('#account').hidden = !CLOUD;
  if (CLOUD) $('#accountText').textContent = `Angemeldet als ${me.name} (${me.email}).`;
  $('#keyBlock').hidden = !isOwner();
  $('#svcBlock').hidden = !isOwner();
  $('#dataBlock').hidden = !isOwner();
  const local = load(STATE_KEY, null);
  $('#mergeLocal').hidden = !(CLOUD && isOwner() && local && hasContent(local));
  $('#backupHint').textContent = CLOUD
    ? 'Alles liegt in der Datenbank und ist auf all deinen Geräten gleich. Ein Backup als Datei schadet trotzdem nicht.'
    : 'Deine Listen, Entscheidungen und Einstellungen liegen nur in diesem Browser. Sichere sie ab und zu als Datei.';
  if (isOwner()) { renderServices(); stats(); }
  const nl = [...noov].filter(([, r]) => r.in_list);
  $('#noovBlock').hidden = !nl.length;
  $('#noovList').replaceChildren(...nl.map(([id, r]) => el('li', {},
    el('span', {}, (cache.films[id] ? cache.films[id].t : 'Film #' + id) + ` (gemeldet ${fmtMonth(r.changed_at)})`),
    el('button', { class: 'btn ghost', type: 'button', onclick: ev => { setNoov(id, false); ev.target.closest('li').remove(); } }, 'Aufheben'))));
  const v = (document.querySelector('script[src^="app.js"]')?.getAttribute('src') || '').split('v=')[1] || '';
  $('#appVersion').textContent = v ? `Version ${v.slice(6, 8)}.${v.slice(4, 6)}. ${v.slice(8, 10)}:${v.slice(10, 12)}` : '';
  $('#settingsDlg').showModal();
}

/* ---------- Übernahme aus Etappe 1 (Browser) bzw. Backup-Datei ---------- */
const hasContent = s => !!(s && ((s.hidden || []).length || (s.seenLocal || []).length || (s.extra || []).length || Object.keys(s.members || {}).length || Object.keys(s.snooze || {}).length || (s.tray || []).length));
function legacyOursIds(s) {
  const ids = [];
  for (const [id, arr] of Object.entries(s.members || {})) if ((arr || []).includes(OURS)) ids.push(+id);
  for (const [id, r] of Object.entries(s.sharedLocal || {})) if (r?.in_list) ids.push(+id);
  return uniq(ids);
}
function mergeState(src, { takeUi = false } = {}) {
  const num = a => (a || []).map(Number);
  for (const [kind, key] of Object.entries(ARR_KIND)) state[key] = uniq([...state[key], ...num(src[key])]);
  for (const [id, t] of Object.entries(src.snooze || {})) if (!(id in state.snooze)) state.snooze[id] = t;
  for (const [id, arr] of Object.entries(src.members || {})) if (!(id in state.members)) state.members[id] = (arr || []).filter(x => x !== OURS);
  for (const l of src.lists || []) if (!state.lists.some(x => x.id === l.id)) state.lists.push(l);
  state.tray = uniq([...state.tray, ...num(src.tray)]);
  if (takeUi) for (const k of UI_FIELDS) if (src[k] !== undefined) state[k] = src[k];
  const ours = legacyOursIds(src);
  persist();
  for (const id of ours) if (!inOurs(id)) setOurs(id, true);
  rebuild(); render();
  return ours.length;
}
function migrateLocalOurs() {                 // Etappe 1: "ours" aus members in sharedLocal verschieben
  for (const [id, arr] of Object.entries(state.members)) {
    if (!(arr || []).includes(OURS)) continue;
    state.sharedLocal[id] = { in_list: true, added_by: null, changed_by: null, changed_at: '' };
    state.members[id] = arr.filter(x => x !== OURS);
  }
  shared = new Map(Object.entries(state.sharedLocal).map(([id, r]) => [+id, r]));
  noov = new Map(Object.entries(state.noovLocal || {}).map(([id, r]) => [+id, r]));
}

/* ---------- Ansichten: Login, kein Zugang, App ---------- */
function showView(v, msg) {
  $('#login').hidden = v !== 'login';
  $('#noAccess').hidden = v !== 'noAccess';
  $('#app').hidden = v !== 'app';
  $('#openSettings').hidden = v !== 'app';
  appShown = v === 'app';
  if (v === 'login' && msg) $('#loginStatus').textContent = msg;
  if (v === 'noAccess' && msg) $('#noAccessText').textContent = msg;
  renderTray();
}

/* ---------- Supabase ---------- */
let started = false;
async function fetchAll(table, cols) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
async function loadPeople() {
  const { data, error } = await sb.from('members').select('name,user_id');
  if (error) throw error;
  people = Object.fromEntries((data || []).filter(m => m.user_id).map(m => [m.user_id, m.name]));
}
async function loadHouse() {
  const { data, error } = await sb.from('household').select('key,val');
  if (error) throw error;
  house = Object.fromEntries(data.map(r => [r.key, r.val]));
}
async function start(session) {
  if (started) return; started = true;
  me.id = session.user.id; me.email = session.user.email || '';
  try {
    const { data: who, error } = await sb.rpc('claim_member');
    if (error) throw error;
    if (!who) { showView('noAccess', `${me.email} steht nicht auf der Gästeliste von MovieDude.`); return; }
    me.name = who.name; me.role = who.role;
    const [, prefsRes, marks, sharedRows] = await Promise.all([
      loadHouse(),
      sb.from('prefs').select('data').eq('user_id', me.id).maybeSingle(),
      fetchAll('marks', 'tmdb_id,kind,val'),
      fetchAll('shared_items', 'list_id,tmdb_id,in_list,added_by,changed_by,changed_at'),
      loadPeople()
    ]);
    if (prefsRes.error) throw prefsRes.error;

    Object.assign(state, freshState(), load(UI_KEY, {}));
    const pd = prefsRes.data?.data || {};
    for (const k of SYNC_PREF_FIELDS) if (pd[k] !== undefined) state[k] = pd[k];
    if (!state.lists.some(l => l.id === OURS)) state.lists.splice(1, 0, { id: OURS, name: 'Unsere' });
    marksToState(marks);
    synced = marksMap();
    syncedPrefs = JSON.stringify(prefsData());
    shared = new Map(sharedRows.filter(r => r.list_id === OURS).map(r => [r.tmdb_id, pickShared(r)]));
    noov = new Map(sharedRows.filter(r => r.list_id === NOOV).map(r => [r.tmdb_id, pickShared(r)]));
    state.apiKey = house.tmdb_key || '';
    state.services = house.services ?? null;

    if (!prefsRes.data && !isOwner()) { state.tab = OURS; state.source = 'all'; }
    if (!state.lastSeen) state.lastSeen = Math.max(Date.now(), ...[...shared.values()].map(r => ts(r.changed_at)));

    if (isOwner()) {
      const local = load(STATE_KEY, null);
      if (house.match) cache.match = Object.assign({}, house.match, cache.match);
      if (!house.tmdb_key && local?.apiKey) { state.apiKey = local.apiKey; await pushHouse('tmdb_key', local.apiKey); }
      if (house.services == null && local?.services) { state.services = local.services; await pushHouse('services', local.services); }
      if (!marks.length && hasContent(local)) {
        const n = mergeState(local, { takeUi: true });
        toast(`Deine Daten aus diesem Browser sind jetzt in der Datenbank${n ? `, inklusive ${n} Filmen in Unsere` : ''}.`);
      }
    }
    subscribe();
    showView('app'); rebuild(); render();
    if (state.apiKey) { if (isOwner() && state.services == null) await renderServices(); sync(); }
    else if (isOwner()) openSettings();
  } catch (e) {
    started = false;
    showView('noAccess', 'Verbindung zur Datenbank fehlgeschlagen: ' + (e.message || e) + '. Lad die Seite neu.');
  }
}
function subscribe() {
  sb.channel('md-' + me.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'shared_items' }, p => {
      if (applyRemoteShared(p.new)) {
        const who = p.new.changed_by;
        if (who && !people[who]) loadPeople().then(renderSoon, renderSoon); else renderSoon();
      }
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'marks', filter: 'user_id=eq.' + me.id }, p => {
      const del = p.eventType === 'DELETE';
      if (applyRemoteMark(del ? p.old : p.new, del)) renderSoon();
    })
    .subscribe();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
}
let lastRefresh = 0;
async function refresh() {
  if (!me.id || Date.now() - lastRefresh < 5000) return;
  lastRefresh = Date.now();
  try {
    const [marks, sharedRows, prefsRes] = await Promise.all([
      fetchAll('marks', 'tmdb_id,kind,val'),
      fetchAll('shared_items', 'list_id,tmdb_id,in_list,added_by,changed_by,changed_at'),
      sb.from('prefs').select('data').eq('user_id', me.id).maybeSingle(),
      loadHouse(),
      loadPeople()
    ]);
    const local = marksMap();
    const remote = new Map(marks.map(r => [r.tmdb_id + '|' + r.kind, r]));
    for (const [k, r] of remote) if (local.get(k) === synced.get(k)) { setMark(r.tmdb_id, r.kind, r.val); synced.set(k, JSON.stringify(r.val)); }
    for (const k of [...synced.keys()]) if (!remote.has(k) && local.get(k) === synced.get(k)) { const [id, kind] = k.split('|'); setMark(id, kind, undefined); synced.delete(k); }
    for (const r of sharedRows) applyRemoteShared(r);
    const pd = prefsRes.data?.data;
    if (pd && JSON.stringify(prefsData()) === syncedPrefs) { for (const k of SYNC_PREF_FIELDS) if (pd[k] !== undefined) state[k] = pd[k]; syncedPrefs = JSON.stringify(prefsData()); }
    state.apiKey = house.tmdb_key || state.apiKey;
    state.services = house.services ?? state.services;
    rebuild(); render();
  } catch { /* nächstes Mal */ }
}
async function bootCloud() {
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const hashErr = new URLSearchParams(location.hash.slice(1)).get('error_description');
  sb.auth.onAuthStateChange((ev, session) => {
    if (ev === 'SIGNED_IN' && session && !started) setTimeout(() => start(session), 0);
  });
  const { data } = await sb.auth.getSession();
  if (data.session) await start(data.session);
  else showView('login', hashErr ? 'Der Link hat nicht geklappt (' + hashErr + '). Fordere einfach einen neuen an.' : '');
}

/* ---------- Sprüche im Kopf ---------- */
const TAGLINES = [
  'Was läuft heute?', 'Weniger scrollen, mehr schauen.', 'Kein Film ist auch keine Lösung.',
  'The Dude abides. Die Watchlist auch.', 'Nur noch ein Trailer …', 'Ein Film, sie alle zu knechten.',
  'Ein Service der Nubsicorp.', 'Schau mir in die Watchlist, Kleines.', 'Nobody puts Popcorn in the corner.',
  'Wir brauchen ein größeres Sofa.', 'Möge die Fernbedienung mit dir sein.', 'Bis zum Abspann und noch viel weiter.',
  "Here's to watchin' with you, kid.", 'May the remote be with you.', "I'll be back. With snacks.",
  'Houston, we have a movie night.', 'You had me at “Play”.', 'Show me the popcorn!',
  'Just keep streaming.', "There's no place like the couch.", "Frankly, my dear, I'll pick the movie.",
  'Life is like a box of movies.', 'To infinity and the end credits.', "A movie you can't refuse."
];
function nextTagline() {
  const t = $('#tagline'), cur = t.textContent;
  let n; do { n = TAGLINES[Math.floor(Math.random() * TAGLINES.length)]; } while (n === cur);
  t.textContent = n;
}

/* ---------- Verdrahtung ---------- */
function wire() {
  nextTagline();
  $('#tagline').addEventListener('click', nextTagline);
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#openSettings').addEventListener('click', openSettings);
  $('#saveKey').addEventListener('click', async () => {
    const k = $('#apiKey').value.trim(); $('#keyStatus').textContent = 'Prüfe…';
    try {
      if (!(await checkKey(k))) { $('#keyStatus').textContent = 'TMDB lehnt den Schlüssel ab. Nimm den kurzen „API-Schlüssel“, nicht das lange Token.'; return; }
      state.apiKey = k;
      if (CLOUD) await pushHouse('tmdb_key', k); else persist();
      $('#keyStatus').textContent = 'Passt. Abgleich startet.';
      renderServices(); sync();
    } catch (e) { $('#keyStatus').textContent = 'TMDB nicht erreichbar: ' + e.message; }
  });
  $('#exportBtn').addEventListener('click', () => {
    const { apiKey, ...rest } = state;
    rest.sharedLocal = Object.fromEntries([...shared].filter(([, r]) => r.in_list).map(([id, r]) => [id, r]));
    const blob = new Blob([JSON.stringify({ app: 'moviedude', version: 2, exportedAt: new Date().toISOString(), state: rest }, null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'moviedude-backup-' + new Date().toISOString().slice(0, 10) + '.json' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    $('#backupStatus').textContent = 'Backup heruntergeladen. Der TMDB-Schlüssel ist bewusst nicht enthalten.';
  });
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = ''; if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'moviedude' || !data.state) throw new Error('Das ist kein MovieDude-Backup.');
      if (CLOUD) {
        if (!window.confirm(`Backup vom ${(data.exportedAt || '').slice(0, 10)} mit deinen jetzigen Daten zusammenführen?`)) return;
        const n = mergeState(data.state);
        $('#backupStatus').textContent = `Backup zusammengeführt${n ? `, ${n} Filme in Unsere` : ''}.`;
      } else {
        if (!window.confirm(`Backup vom ${(data.exportedAt || '').slice(0, 10)} einspielen? Deine aktuellen Listen und Entscheidungen in diesem Browser werden ersetzt.`)) return;
        const key = state.apiKey;
        Object.assign(state, freshState(), data.state, { apiKey: key });
        migrateLocalOurs(); persist(); rebuild(); render();
        $('#backupStatus').textContent = 'Backup eingespielt.';
      }
      sync();
    } catch (err) { $('#backupStatus').textContent = 'Einspielen fehlgeschlagen: ' + err.message; }
  });
  $('#mergeLocal').addEventListener('click', () => {
    const local = load(STATE_KEY, null); if (!hasContent(local)) return;
    const n = mergeState(local);
    $('#mergeStatus').textContent = `Übernommen und mit der Datenbank zusammengeführt${n ? `, ${n} Filme in Unsere` : ''}.`;
  });
  $('#refreshProv').addEventListener('click', () => { for (const id of Object.keys(cache.films)) cache.films[id].ts = 0; $('#settingsDlg').close(); sync(); });
  $('#rematch').addEventListener('click', () => { $('#settingsDlg').close(); sync({ force: true }); });
  $('#logoutBtn').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });
  $('#noAccessLogout').addEventListener('click', async () => { if (sb) await sb.auth.signOut(); location.reload(); });
  $('#loginPassword').addEventListener('input', e => { $('#loginBtn').textContent = e.target.value ? 'Anmelden' : 'Link schicken'; });
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim(); if (!email) return;
    const password = $('#loginPassword').value;
    if (password) {
      $('#loginStatus').textContent = 'Melde an…';
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) $('#loginStatus').textContent = /invalid/i.test(error.message)
        ? 'Mail oder Passwort stimmen nicht. Ohne Passwort bekommst du einen Link per Mail.'
        : 'Das hat nicht geklappt: ' + error.message;
      return;                                    // Erfolg läuft über onAuthStateChange
    }
    $('#loginStatus').textContent = 'Schicke Link…';
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    $('#loginStatus').textContent = !error
      ? 'Link ist unterwegs. Öffne ihn auf diesem Gerät, am besten im selben Browser.'
      : /rate limit/i.test(error.message)
        ? 'Gerade wurden zu viele Mails verschickt (Supabase erlaubt nur 2 pro Stunde). Versuch es später nochmal oder melde dich mit Passwort an.'
        : 'Das hat nicht geklappt: ' + error.message;
  });
  $('#pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const password = $('#newPassword').value;
    $('#pwStatus').textContent = 'Speichere…';
    const { error } = await sb.auth.updateUser({ password });
    $('#pwStatus').textContent = error ? 'Das hat nicht geklappt: ' + error.message : 'Passwort gespeichert. Auf neuen Geräten einfach Mail und Passwort eintragen.';
    if (!error) $('#newPassword').value = '';
  });
  $('#suggestForm').addEventListener('submit', suggest);
  $('#filterToggle').addEventListener('click', () => { filtersOpen = !filtersOpen; render(); });
  $('#noticeShow').addEventListener('click', openNotice);
  $('#noticeOk').addEventListener('click', ackNotice);
  $('#noticeDlg').addEventListener('close', ackNotice);
  document.querySelectorAll('#source button').forEach(b => b.addEventListener('click', () => { state.source = b.dataset.v; persist(); render(); }));
  $('#runtime').addEventListener('change', e => { state.runtime = +e.target.value; persist(); render(); });
  $('#sort').addEventListener('change', e => { state.sort = e.target.value; persist(); render(); });
  let qT; $('#q').addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(render, 150); });
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && isOwner() && !visibleIds().length) tmdbSearch(); });
  $('#tmdbSearchBtn').addEventListener('click', tmdbSearch);
  $('#dice').addEventListener('click', () => {
    const cards = [...document.querySelectorAll('#grid .card')];
    if (!cards.length) { toast('Nichts zum Würfeln da.'); return; }
    const roll = Math.floor(Math.random() * 20) + 1;
    const c = cards[Math.floor(Math.random() * cards.length)];
    c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
    const t = c.querySelector('.title').textContent;
    toast(roll === 20 ? 'Natürliche 20! ' + t : roll === 1 ? 'Kritischer Patzer… trotzdem: ' + t : 'Gewürfelt: ' + t);
  });
  $('#trayOpen').addEventListener('click', openTray);
  document.querySelectorAll('#feedMode button').forEach(b => b.addEventListener('click', () => { state.feed = b.dataset.v; persist(); renderDeck(); }));
  document.querySelectorAll('#discActions .act').forEach(b => b.addEventListener('click', () => decide(b.dataset.act)));
  document.addEventListener('keydown', e => {
    if (!appShown || state.tab !== 'discover' || document.querySelector('dialog[open]') || e.target.matches('input, textarea, select')) return;
    const map = { ArrowLeft: 'nie', ArrowRight: 'mine', ArrowDown: 'later', ArrowUp: OURS };
    if (map[e.key]) { e.preventDefault(); decide(map[e.key]); }
    else if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); decide('undo'); }
  });
  $('#trayCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#trayText').value); toast('Kopiert. Ab damit per WhatsApp.'); }
    catch { $('#trayText').select(); toast('Text markiert, jetzt kopieren.'); }
  });
  $('#trayClear').addEventListener('click', () => { state.tray = []; persist(); render(); $('#trayDlg').close(); });
  $('#newListForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = $('#newListName').value.trim(); if (!name) return;
    const id = 'l' + Date.now().toString(36);
    state.lists.push({ id, name }); state.tab = id; persist();
    $('#newListName').value = ''; $('#newListDlg').close(); render();
    toast(`Liste „${name}“ angelegt. Filme per Chip hinzufügen. Doppelklick auf den Tab löscht sie.`);
  });
}

async function boot() {
  wire();
  try {
    const [shelf, watchlist, watched, ratings] = await Promise.all(['shelf', 'watchlist', 'watched', 'ratings'].map(n => fetch('data/' + n + '.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : [])));
    SRC = { shelf: shelf.filter(s => s.imdb), watchlist, watched, ratings };
  } catch { toast('Datendateien konnten nicht geladen werden.'); }
  if (WANT_CLOUD && !CLOUD) { showView('noAccess', 'Die Anmeldung konnte nicht geladen werden. Prüf deine Internetverbindung und lad die Seite neu.'); return; }
  if (CLOUD) { await bootCloud(); return; }
  Object.assign(state, load(STATE_KEY, {}));
  migrateLocalOurs();
  if (!state.lists.some(l => l.id === OURS)) state.lists.splice(1, 0, { id: OURS, name: 'Unsere' });
  showView('app'); rebuild(); render();
  if (!state.apiKey) openSettings();
  else { if (state.services == null) await renderServices(); sync(); }
}
boot();
})();
