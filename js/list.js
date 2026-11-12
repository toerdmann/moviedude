/* MovieDude – Listenansicht: Filter, Tabs, Karten, render(), Aktionen, Heute Abend, Nachtragen.
   Teilt sich den globalen Gültigkeitsbereich mit den übrigen js/-Dateien; Ladereihenfolge in index.html, Überblick in docs/ARCHITEKTUR.md. */
'use strict';

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
