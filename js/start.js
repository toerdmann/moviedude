/* MovieDude – Start: Ansichten, Supabase-Anmeldung und -Abgleich, Sprüche, Verdrahtung, boot().
   Teilt sich den globalen Gültigkeitsbereich mit den übrigen js/-Dateien; Ladereihenfolge in index.html, Überblick in docs/ARCHITEKTUR.md. */
'use strict';

/* ---------- Ansichten: Login, kein Zugang, App ---------- */
function showView(v, msg) {
  $('#login').hidden = v !== 'login';
  $('#noAccess').hidden = v !== 'noAccess';
  $('#app').hidden = v !== 'app';
  $('#openSettings').hidden = v !== 'app';
  $('#openAdd').hidden = v !== 'app' || !isOwner();
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
    synced = new Map(marks.map(r => [r.tmdb_id + '|' + r.kind, JSON.stringify(r.val)]));   // inkl. abgelaufener Einträge -> werden beim nächsten Speichern gelöscht
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
      for (const k of Object.keys(cache.match)) if (k.startsWith('l:')) delete cache.match[k];
      if (!house.tmdb_key && local?.apiKey) { state.apiKey = local.apiKey; await pushHouse('tmdb_key', local.apiKey); }
      if (house.services == null && local?.services) { state.services = local.services; await pushHouse('services', local.services); }
      if (!marks.length && hasContent(local)) {
        const n = mergeState(local, { takeUi: true });
        toast(`Deine Daten aus diesem Browser sind jetzt in der Datenbank${n ? `, inklusive ${n} Filmen in Unsere` : ''}.`);
      }
    }
    subscribe();
    pushMarks();                                 // räumt Datenleichen (z. B. abgelaufenes "Lass erstmal") auf
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
      await pushHouse('tmdb_key', k);
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
      if (!window.confirm(`Backup vom ${(data.exportedAt || '').slice(0, 10)} mit deinen jetzigen Daten zusammenführen?`)) return;
      const n = mergeState(data.state);
      $('#backupStatus').textContent = `Backup zusammengeführt${n ? `, ${n} Filme in Unsere` : ''}.`;
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
  $('#addForm').addEventListener('submit', addSearch);
  $('#openAdd').addEventListener('click', () => { $('#addDlg').showModal(); $('#addInput').focus(); });
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
  if (!CONFIGURED) { showView('noAccess', 'In config.js fehlen die Supabase-Zugangsdaten.'); return; }
  if (!window.supabase) { showView('noAccess', 'Die Anmeldung konnte nicht geladen werden. Prüf deine Internetverbindung und lad die Seite neu.'); return; }
  await bootCloud();
}
// Nur für die automatischen Tests (tests/e2e.cjs öffnet die Seite mit ?mdtest)
if (/[?&]mdtest\b/.test(location.search)) window.__mdTest = { matchByTitle, norm, discLabel };
boot();
