/* MovieDude – Dialoge: + Film, Detailansicht, Vorschlagen, Hinweise, Einstellungen.
   Teilt sich den globalen Gültigkeitsbereich mit den übrigen js/-Dateien; Ladereihenfolge in index.html, Überblick in docs/ARCHITEKTUR.md. */
'use strict';

/* ---------- "+ Film": Film hinzufügen (Meine / Regal) ---------- */
function ownedFormats(id) { return (house.shelf_extra || {})[id] || []; }
async function toggleFormat(id, fmt) {
  const cur = ownedFormats(id);
  const next = cur.includes(fmt) ? cur.filter(x => x !== fmt) : [...cur, fmt];
  const all = Object.assign({}, house.shelf_extra || {});
  if (next.length) all[id] = next; else delete all[id];
  await pushHouse('shelf_extra', all);
  rebuild();
  pushHouse('shelf', shelfMap);
  render(); renderAddResults();
}
function addToMine(id) {
  state.extra = uniq([...state.extra, id]);
  const cur = privateMembers(id);
  if (!cur.includes('mine')) state.members[id] = [...cur, 'mine'];
  persist(); rebuild(); render(); renderAddResults();
}
let addIds = [];
function renderAddResults() {
  const list = $('#addList'); if (!list) return;
  list.replaceChildren(...addIds.filter(id => cache.films[id]).map(id => {
    const f = cache.films[id];
    const inMine = privateMembers(id).includes('mine');
    const own = ownedFormats(id);
    const fromMyMovies = lib.get(id)?.shelf && !own.length;
    return el('li', { class: 'sg' },
      f.p ? el('img', { src: IMG + 'w92' + f.p, alt: '' }) : el('span', { class: 'sg-noimg' }),
      el('div', { class: 'sg-body' },
        el('strong', {}, f.t + (f.y ? ' (' + f.y + ')' : '')),
        el('span', { class: 'meta' }, whereText(id, f) + (seen.has(id) ? ' · schon gesehen' : '')),
        el('span', { class: 'links' }, extLinks(id, f))),
      el('div', { class: 'add-actions' },
        el('button', { class: 'lchip' + (inMine ? ' on' : ''), type: 'button', onclick: () => inMine ? toggleList(id, 'mine') || renderAddResults() : addToMine(id) }, inMine ? 'In Meine' : 'Auf Meine'),
        ...DISC_FORMATS.map(fmt => el('button', { class: 'lchip' + (own.includes(fmt) ? ' on' : ''), type: 'button', title: own.includes(fmt) ? 'Wieder aus dem Regal nehmen' : 'Ins Regal stellen', onclick: () => toggleFormat(id, fmt) }, (own.includes(fmt) ? '✓ ' : '+ ') + fmt)),
        fromMyMovies ? el('span', { class: 'meta' }, 'steht laut MyMovies schon im Regal') : null));
  }));
}
async function addSearch(e) {
  e.preventDefault();
  const input = $('#addInput').value; if (!input.trim()) return;
  const status = $('#addStatus');
  if (!state.apiKey) { status.textContent = 'Erst den TMDB-Schlüssel eintragen.'; return; }
  status.textContent = 'Suche…'; addIds = []; renderAddResults();
  try {
    const ids = await resolveInput(input);
    await Promise.all(ids.map(id => film(id).catch(() => null)));
    addIds = ids.filter(id => cache.films[id]);
    status.textContent = addIds.length ? (addIds.length === 1 ? 'Gefunden:' : 'Welcher ist es?') : 'Nichts gefunden. Probier den Originaltitel oder einen IMDb-Link.';
    renderAddResults();
  } catch (err) { status.textContent = err.message || String(err); }
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
  if (!me.id) return [];
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
  pushHouse('services', ids);
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
  $('#accountText').textContent = `Angemeldet als ${me.name} (${me.email}).`;
  $('#keyBlock').hidden = !isOwner();
  $('#svcBlock').hidden = !isOwner();
  $('#dataBlock').hidden = !isOwner();
  const local = load(STATE_KEY, null);
  $('#mergeLocal').hidden = !(isOwner() && local && hasContent(local));
  if (isOwner()) { renderServices(); stats(); }
  const nl = [...noov].filter(([, r]) => r.in_list);
  $('#noovBlock').hidden = !nl.length;
  $('#noovList').replaceChildren(...nl.map(([id, r]) => el('li', {},
    el('span', {}, (cache.films[id] ? cache.films[id].t : 'Film #' + id) + ` (gemeldet ${fmtMonth(r.changed_at)})`),
    el('button', { class: 'btn ghost', type: 'button', onclick: ev => { setNoov(id, false); ev.target.closest('li').remove(); } }, 'Aufheben'))));
  const v = (document.querySelector('script[src^="js/base.js"]')?.getAttribute('src') || '').split('v=')[1] || '';
  $('#appVersion').textContent = v ? `Version ${v.slice(6, 8)}.${v.slice(4, 6)}. ${v.slice(8, 10)}:${v.slice(10, 12)}` : '';
  $('#settingsDlg').showModal();
}
