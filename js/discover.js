/* MovieDude – Entdecken: Swipe-Feed mit Nie / Meine / Unsere / Lass erstmal.
   Teilt sich den globalen Gültigkeitsbereich mit den übrigen js/-Dateien; Ladereihenfolge in index.html, Überblick in docs/ARCHITEKTUR.md. */
'use strict';

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
