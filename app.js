/* MovieDude — Etappe 1: alles im Browser, Daten live von TMDB (Verfügbarkeit via JustWatch). */
(() => {
'use strict';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const REGION = 'DE';
const STATE_KEY = 'md.state.v1';
const CACHE_KEY = 'md.cache.v1';
const FRESH_MS = 2 * 24 * 3600 * 1000;     // Verfügbarkeit für Kandidaten alle 2 Tage auffrischen
const STALE_MS = 30 * 24 * 3600 * 1000;    // Rest monatlich
const DEFAULT_SERVICES = [/netflix/i, /amazon prime video/i, /^apple tv\+?$/i, /disney/i];

/* ---------- Speicher ---------- */
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { toast('Speichern im Browser fehlgeschlagen: ' + e.message); return false; } };

const state = Object.assign({
  apiKey: '',
  services: null,                       // [provider_id]; null = noch nicht gewählt
  lists: [{ id: 'mine', name: 'Meine' }, { id: 'ours', name: 'Unsere' }],
  members: {},                          // tmdbId -> [listId]  (fehlt = Standard)
  hidden: [],                           // "Nie" / ausgeblendet
  seenLocal: [],                        // in der App als gesehen markiert
  extra: [],                            // per TMDB-Suche hinzugefügt
  tray: [],                             // Auswahl für heute Abend
  tab: 'mine', source: 'avail', runtime: 0, sort: 'rating', genres: []
}, load(STATE_KEY, {}));
const cache = Object.assign({ match: {}, films: {}, providers: null }, load(CACHE_KEY, {}));
const persist = () => save(STATE_KEY, state);
let cacheTimer = null;
const persistCache = () => { clearTimeout(cacheTimer); cacheTimer = setTimeout(() => save(CACHE_KEY, cache), 400); };

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
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3200); }
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/* ---------- TMDB ---------- */
let active = 0; const queue = [];
const MAX_PAR = 6;
function tmdb(path, params = {}) {
  return new Promise((resolve, reject) => { queue.push({ path, params, resolve, reject, tries: 0 }); pump(); });
}
function pump() {
  while (active < MAX_PAR && queue.length) {
    const job = queue.shift(); active++;
    const u = new URL(API + path_(job.path));
    u.searchParams.set('api_key', state.apiKey);
    for (const [k, v] of Object.entries(job.params)) if (v != null && v !== '') u.searchParams.set(k, v);
    fetch(u).then(async r => {
      if (r.status === 429 && job.tries < 4) { job.tries++; setTimeout(() => { queue.unshift(job); pump(); }, 1500 * job.tries); return; }
      if (!r.ok) { const e = new Error('TMDB ' + r.status); e.status = r.status; throw e; }
      job.resolve(await r.json());
    }).catch(job.reject).finally(() => { active--; pump(); });
  }
}
const path_ = p => p.startsWith('/') ? p : '/' + p;

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
  vids.sort((a, b) => (a.type === 'Trailer' ? 0 : 1) - (b.type === 'Trailer' ? 0 : 1) || (a.iso_639_1 === 'de' ? 0 : 1) - (b.iso_639_1 === 'de' ? 0 : 1));
  return {
    t: d.title, o: d.original_title, y: parseInt((d.release_date || '').slice(0, 4), 10) || null,
    r: d.runtime || null, v: Math.round((d.vote_average || 0) * 10) / 10,
    g: (d.genres || []).map(g => g.name), p: d.poster_path || null,
    ov: (d.overview || '').slice(0, 420), imdb: d.external_ids?.imdb_id || d.imdb_id || null,
    tr: vids[0]?.key || null,
    fl: (pr.flatrate || []).concat(pr.free || [], pr.ads || []).map(x => [x.provider_id, x.provider_name, x.logo_path]),
    ts: Date.now()
  };
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

/* ---------- Quelldaten ---------- */
let SRC = { shelf: [], watchlist: [], watched: [] };
const keyShelf = s => s.imdb ? 'i:' + s.imdb : 's:' + norm(s.title) + '|' + s.year;
const keyLb = s => 'l:' + s.lb;

let lib = new Map();   // tmdbId -> { shelf: disc|null, wl: bool, lb: uri|null }
let seen = new Set();

function rebuild() {
  lib = new Map(); seen = new Set();
  const get = id => { if (!lib.has(id)) lib.set(id, { shelf: null, wl: false, lb: null, shelfSeen: false }); return lib.get(id); };
  for (const s of SRC.shelf) {
    const id = cache.match[keyShelf(s)]; if (!id) continue;
    const e = get(id);
    e.shelf = e.shelf && e.shelf !== s.disc ? 'DVD + Blu-ray' : s.disc;
    if (s.seen) { e.shelfSeen = true; seen.add(id); }
  }
  for (const s of SRC.watchlist) { const id = cache.match[keyLb(s)]; if (!id) continue; const e = get(id); e.wl = true; e.lb = s.lb; }
  for (const s of SRC.watched) { const id = cache.match[keyLb(s)]; if (id) seen.add(id); }
  for (const id of state.seenLocal) seen.add(id);
  for (const id of state.extra) get(id);
}

/* Kandidat = auf Watchlist oder ungesehen im Regal */
const isCandidate = id => { const e = lib.get(id); return e && !seen.has(id) && (e.wl || e.shelf); };
function membersOf(id) {
  if (state.members[id]) return state.members[id];
  return isCandidate(id) ? ['mine'] : [];
}

/* ---------- Abgleich ---------- */
let syncing = false;
async function sync({ force = false } = {}) {
  if (!state.apiKey || syncing) return;
  syncing = true;
  const jobs = [];
  for (const s of SRC.shelf) {
    const k = keyShelf(s);
    if (force || !(k in cache.match)) jobs.push([k, () => s.imdb ? matchByImdb(s.imdb) : matchByTitle(s.orig || s.title, s.year, 'de-DE')]);
  }
  for (const s of SRC.watchlist.concat(SRC.watched)) {
    const k = keyLb(s);
    if (force || !(k in cache.match)) jobs.push([k, () => matchByTitle(s.title, s.year, 'en-US')]);
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
    // Details: Kandidaten + Listen + Extras häufig, Rest selten
    const now = Date.now();
    const want = [];
    for (const id of lib.keys()) {
      const f = cache.films[id];
      const hot = isCandidate(id) || (state.members[id] || []).length || state.tray.includes(id);
      const maxAge = hot ? FRESH_MS : STALE_MS;
      if (force || !f || now - f.ts > maxAge) want.push(id);
    }
    if (want.length) {
      let done = 0; progress('Verfügbarkeit laden', 0, want.length);
      await Promise.all(want.map(id => details(id).then(d => { cache.films[id] = d; }).catch(e => { if (e.status === 401) throw e; })
        .finally(() => { progress('Verfügbarkeit laden', ++done, want.length); if (done % 40 === 0) { persistCache(); render(); } })));
      persistCache();
    }
  } catch (e) {
    toast(e.status === 401 ? 'TMDB lehnt den Schlüssel ab. Bitte in den Einstellungen prüfen.' : 'Abgleich unterbrochen: ' + e.message);
  } finally {
    syncing = false; progress(); render(); stats();
  }
}
function progress(label, n, total) {
  const box = $('#sync');
  if (!label) { box.hidden = true; return; }
  box.hidden = false; $('#syncText').textContent = `${label} ${n}/${total}`;
  $('#syncBar').style.width = (total ? (n / total) * 100 : 0) + '%';
}

/* ---------- Ansicht ---------- */
const svcSet = () => new Set(state.services || []);
function streamable(f) { const s = svcSet(); return (f.fl || []).filter(p => s.has(p[0])); }

function visibleIds() {
  const tab = state.tab, q = norm($('#q').value);
  const hidden = new Set(state.hidden);
  const out = [];
  for (const id of lib.keys()) {
    const f = cache.films[id]; if (!f) continue;
    const e = lib.get(id);
    if (tab === 'hidden') { if (!hidden.has(id)) continue; }
    else {
      if (hidden.has(id)) continue;
      if (tab === 'all') { /* alles */ }
      else if (!membersOf(id).includes(tab)) continue;
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
    new: (a, b) => (F(b).y || 0) - (F(a).y || 0),
    short: (a, b) => (F(a).r || 999) - (F(b).r || 999)
  };
  return out.sort(sorters[state.sort] || sorters.rating);
}

function renderTabs() {
  const nav = $('#tabs'); nav.replaceChildren();
  const hidden = new Set(state.hidden);
  const countIn = lid => { let n = 0; for (const id of lib.keys()) if (!hidden.has(id) && cache.films[id] && membersOf(id).includes(lid)) n++; return n; };
  for (const l of state.lists) {
    nav.append(el('button', { class: 'tab' + (state.tab === l.id ? ' on' : ''), type: 'button', onclick: () => setTab(l.id),
      ondblclick: () => l.id !== 'mine' && l.id !== 'ours' && removeList(l) }, l.name, el('small', {}, String(countIn(l.id)))));
  }
  nav.append(el('button', { class: 'tab' + (state.tab === 'all' ? ' on' : ''), type: 'button', onclick: () => setTab('all') }, 'Alles'));
  if (state.hidden.length) nav.append(el('button', { class: 'tab' + (state.tab === 'hidden' ? ' on' : ''), type: 'button', onclick: () => setTab('hidden') }, 'Nie', el('small', {}, String(state.hidden.length))));
  nav.append(el('button', { class: 'tab add', type: 'button', onclick: () => $('#newListDlg').showModal() }, '+ Liste'));
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

function card(id) {
  const f = cache.films[id], e = lib.get(id);
  const isSeen = seen.has(id);
  const st = streamable(f);
  const mem = membersOf(id);
  const inTray = state.tray.includes(id);
  const stickers = [];
  if (e.shelf) stickers.push(el('span', { class: 'sticker' }, e.shelf));
  if (isSeen) stickers.push(el('span', { class: 'sticker seen' }, 'gesehen'));
  return el('article', { class: 'card', 'data-id': id },
    el('div', { class: 'poster' },
      f.p ? el('img', { src: IMG + 'w342' + f.p, alt: '', loading: 'lazy' }) : el('div', { class: 'noimg' }, f.t),
      el('div', { class: 'stickers' }, stickers),
      el('div', { class: 'provs' }, st.map(p => el('img', { src: IMG + 'w92' + p[2], alt: p[1], title: p[1] }))),
      el('button', { class: 'tonight' + (inTray ? ' on' : ''), type: 'button', title: inTray ? 'Aus Heute Abend entfernen' : 'Für heute Abend vormerken', 'aria-pressed': String(inTray), onclick: () => toggleTray(id) }, inTray ? '★' : '☆')
    ),
    el('div', { class: 'body' },
      el('h3', { class: 'title' }, f.t),
      el('div', { class: 'meta' }, [f.y, f.r ? f.r + ' min' : null, f.v ? '★ ' + f.v.toFixed(1) : null].filter(Boolean).join(' · ')),
      el('div', { class: 'meta' }, f.g.slice(0, 3).join(', ')),
      el('div', { class: 'lists' }, state.lists.map(l => el('button', {
        class: 'lchip' + (mem.includes(l.id) ? ' on' : ''), type: 'button', onclick: () => toggleList(id, l.id)
      }, l.name))),
      el('div', { class: 'links' },
        f.imdb ? el('a', { href: 'https://www.imdb.com/title/' + f.imdb + '/', target: '_blank', rel: 'noopener' }, 'IMDb') : null,
        f.tr ? el('a', { href: 'https://www.youtube.com/watch?v=' + f.tr, target: '_blank', rel: 'noopener' }, 'Trailer') : null,
        el('a', { href: lbLink(id), target: '_blank', rel: 'noopener' }, 'Letterboxd'),
        !isSeen ? el('button', { type: 'button', onclick: () => markSeen(id) }, 'Gesehen') : null,
        state.hidden.includes(id)
          ? el('button', { type: 'button', onclick: () => unhide(id) }, 'Zurückholen')
          : el('button', { class: 'hide', type: 'button', onclick: () => hide(id) }, 'Nie')
      )
    )
  );
}

function render() {
  renderTabs(); renderGenres();
  document.querySelectorAll('#source button').forEach(b => b.classList.toggle('on', b.dataset.v === state.source));
  $('#runtime').value = String(state.runtime); $('#sort').value = state.sort;
  const ids = visibleIds();
  const grid = $('#grid'); grid.replaceChildren(...ids.map(card));
  $('#count').textContent = ids.length + (ids.length === 1 ? ' Film' : ' Filme');
  const empty = $('#empty');
  if (!state.apiKey) { empty.hidden = false; empty.textContent = 'Trag in den Einstellungen deinen TMDB-Schlüssel ein, dann gleicht MovieDude Regal, Watchlist und Streamingdienste ab.'; }
  else if (!ids.length) { empty.hidden = false; empty.textContent = syncing ? 'Abgleich läuft, die Filme tauchen gleich auf.' : 'Keine Filme für diese Filter. Probier „Alle“ statt „Heute verfügbar“ oder entferne ein Genre.'; }
  else empty.hidden = true;
  $('#tmdbSearch').hidden = !($('#q').value.trim().length > 1 && state.apiKey);
  renderTray();
}

/* ---------- Aktionen ---------- */
function toggleList(id, lid) {
  const cur = membersOf(id).slice();
  state.members[id] = cur.includes(lid) ? cur.filter(x => x !== lid) : [...cur, lid];
  persist(); render();
}
function hide(id) { state.hidden = [...new Set([...state.hidden, id])]; state.tray = state.tray.filter(x => x !== id); persist(); render(); toast('Ausgeblendet. Zu finden im Tab „Nie“.'); }
function unhide(id) { state.hidden = state.hidden.filter(x => x !== id); persist(); render(); }
function markSeen(id) {
  state.seenLocal = [...new Set([...state.seenLocal, id])];
  if (!state.members[id]) state.members[id] = [];  // fällt aus der Standardliste
  persist(); rebuild(); render();
  window.open(lbLink(id), '_blank', 'noopener');
  toast('Als gesehen markiert. Hak ihn auf Letterboxd ab, dann bleibt alles synchron.');
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
  $('#tray').hidden = n === 0; $('#trayCount').textContent = n;
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
    await Promise.all(ids.filter(id => !cache.films[id]).map(id => details(id).then(d => cache.films[id] = d)));
    state.extra = [...new Set([...state.extra, ...ids])];
    persist(); persistCache(); rebuild(); state.tab = 'all'; state.source = 'all'; render();
    toast(ids.length ? `${ids.length} Treffer unter „Alles“. Per Listen-Chip übernehmen.` : 'Nichts gefunden.');
  } catch (e) { toast('Suche fehlgeschlagen: ' + e.message); }
}

/* ---------- Einstellungen ---------- */
async function renderServices() {
  const box = $('#services'); box.replaceChildren();
  if (!state.apiKey) { box.append(el('p', { class: 'hint' }, 'Erst Schlüssel speichern.')); return; }
  let list; try { list = await loadProviders(); } catch { box.append(el('p', { class: 'hint' }, 'Dienste konnten nicht geladen werden.')); return; }
  if (state.services == null) { state.services = list.filter(p => DEFAULT_SERVICES.some(rx => rx.test(p.name))).map(p => p.id); persist(); }
  const on = svcSet();
  list.forEach(p => box.append(el('label', { class: 'svc' },
    el('input', { type: 'checkbox', checked: on.has(p.id), onchange: ev => {
      state.services = ev.target.checked ? [...new Set([...state.services, p.id])] : state.services.filter(x => x !== p.id);
      persist(); render();
    } }),
    p.logo ? el('img', { src: IMG + 'w92' + p.logo, alt: '' }) : null, el('span', {}, p.name))));
}
function stats() {
  const matched = [...SRC.shelf.map(keyShelf), ...SRC.watchlist.map(keyLb), ...SRC.watched.map(keyLb)];
  const miss = matched.filter(k => k in cache.match && !cache.match[k]).length;
  const cand = [...lib.keys()].filter(isCandidate).length;
  $('#stats').textContent = `${lib.size} Filme bekannt, ${cand} ungesehene Kandidaten, ${seen.size} gesehen. ${miss} Einträge ließen sich nicht zuordnen.`;
}

function wire() {
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  $('#openSettings').addEventListener('click', () => { $('#apiKey').value = state.apiKey; renderServices(); stats(); $('#settingsDlg').showModal(); });
  $('#saveKey').addEventListener('click', async () => {
    const k = $('#apiKey').value.trim(); $('#keyStatus').textContent = 'Prüfe…';
    try {
      if (!(await checkKey(k))) { $('#keyStatus').textContent = 'TMDB lehnt den Schlüssel ab. Nimm den kurzen „API-Schlüssel“, nicht das lange Token.'; return; }
      state.apiKey = k; persist(); $('#keyStatus').textContent = 'Passt. Abgleich startet.';
      renderServices(); sync();
    } catch (e) { $('#keyStatus').textContent = 'TMDB nicht erreichbar: ' + e.message; }
  });
  $('#refreshProv').addEventListener('click', () => { for (const id of Object.keys(cache.films)) cache.films[id].ts = 0; $('#settingsDlg').close(); sync(); });
  $('#rematch').addEventListener('click', () => { $('#settingsDlg').close(); sync({ force: true }); });
  document.querySelectorAll('#source button').forEach(b => b.addEventListener('click', () => { state.source = b.dataset.v; persist(); render(); }));
  $('#runtime').addEventListener('change', e => { state.runtime = +e.target.value; persist(); render(); });
  $('#sort').addEventListener('change', e => { state.sort = e.target.value; persist(); render(); });
  let qT; $('#q').addEventListener('input', () => { clearTimeout(qT); qT = setTimeout(render, 150); });
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && !visibleIds().length) tmdbSearch(); });
  $('#tmdbSearchBtn').addEventListener('click', tmdbSearch);
  $('#dice').addEventListener('click', () => {
    const cards = [...document.querySelectorAll('#grid .card')];
    if (!cards.length) { toast('Nichts zum Würfeln da.'); return; }
    const roll = Math.floor(Math.random() * 20) + 1;
    const c = cards[Math.floor(Math.random() * cards.length)];
    c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    c.classList.remove('flash'); void c.offsetWidth; c.classList.add('flash');
    toast(roll === 20 ? 'Natürliche 20! ' + c.querySelector('.title').textContent : roll === 1 ? 'Kritischer Patzer… trotzdem: ' + c.querySelector('.title').textContent : 'Gewürfelt: ' + c.querySelector('.title').textContent);
  });
  $('#trayOpen').addEventListener('click', openTray);
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
    const [shelf, watchlist, watched] = await Promise.all(['shelf', 'watchlist', 'watched'].map(n => fetch('data/' + n + '.json').then(r => r.json())));
    SRC = { shelf, watchlist, watched };
  } catch (e) { toast('Datendateien konnten nicht geladen werden.'); }
  rebuild(); render();
  if (!state.apiKey) { $('#settingsDlg').showModal(); renderServices(); }
  else { if (state.services == null) await renderServices(); sync(); }
}
boot();
})();
