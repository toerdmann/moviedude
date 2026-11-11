// MovieDude – Ende-zu-Ende-Test
// Echte App (index.html, app.js, data/*.json) + echtes supabase-js im Chromium.
// Supabase-REST/Auth und TMDB werden hier im Test nachgebaut (inkl. vereinfachter Zugriffsregeln),
// weil die Sandbox weder Supabase noch TMDB erreicht. Realtime wird nicht emuliert; Abgleich zwischen
// Geräten läuft im Test über das Wieder-in-den-Vordergrund-Holen (refresh).
//
// Start:  bash tests/run.sh        (lädt beim ersten Mal supabase-js in tests/.cache)
const path = require('path'), fs = require('fs');
const { chromium } = (() => { try { return require('playwright'); } catch { return require('/opt/npm-tools/node_modules/playwright'); } })();

const APP = path.join(__dirname, '..');
const SBJS = path.join(__dirname, '.cache', 'supabase-js', 'package', 'dist', 'umd');
const SITE = 'https://toerdmann.github.io/moviedude/';
const SB = 'https://mock.supabase.co';
const SHOTS = path.join(__dirname, '.cache', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const SB_VERSION = (fs.readFileSync(path.join(APP, 'index.html'), 'utf8').match(/supabase-js@([\d.]+)/) || [])[1];

/* ------------------------------------------------------------------ Mock-Datenbank */
const T = { sub: '11111111-1111-1111-1111-111111111111', email: 'tobias@example.com' };
const S = { sub: '22222222-2222-2222-2222-222222222222', email: 'sarah@example.com' };
const X = { sub: '33333333-3333-3333-3333-333333333333', email: 'fremd@example.com' };
const db = {
  members: [
    { email: T.email, name: 'Tobias', role: 'owner', user_id: null },
    { email: S.email, name: 'Sarah', role: 'partner', user_id: null }
  ],
  household: [], prefs: [], marks: [], shared_items: []
};
const PK = { household: ['key'], prefs: ['user_id'], marks: ['user_id', 'tmdb_id', 'kind'], shared_items: ['list_id', 'tmdb_id'], members: ['email'] };
const MARK_KINDS = ['hidden', 'seen', 'unseen', 'extra', 'snooze', 'lists'];   // wie check-Constraint in schema.sql
const log = [];
const nowIso = () => new Date().toISOString().replace('Z', '+00:00');
const userOf = req => { try { return JSON.parse(Buffer.from((req.headers().authorization || '').split('.')[1], 'base64url').toString()); } catch { return null; } };
const roleOf = u => u && db.members.find(m => m.email.toLowerCase() === (u.email || '').toLowerCase())?.role;
const canRead = (t, u, row) => !!roleOf(u) && ((t !== 'marks' && t !== 'prefs') || row.user_id === u.sub);
function canWrite(t, u, row) {
  const r = roleOf(u); if (!r) return false;
  if (t === 'household') return r === 'owner';
  if (t === 'marks' || t === 'prefs') return row.user_id === u.sub;
  return t === 'shared_items';
}
function filters(url) {
  const f = [];
  for (const [k, v] of url.searchParams) {
    if (['select', 'on_conflict', 'limit', 'offset', 'order', 'columns'].includes(k)) continue;
    const m = v.match(/^(eq|in)\.(.*)$/); if (!m) continue;
    if (m[1] === 'eq') f.push(r => String(r[k]) === m[2]);
    else { const set = m[2].replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, '')); f.push(r => set.includes(String(r[k]))); }
  }
  return r => f.every(fn => fn(r));
}
async function rest(route) {
  const req = route.request(), url = new URL(req.url()), u = userOf(req);
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });
  const p = url.pathname.replace('/rest/v1/', '');
  log.push(req.method() + ' ' + p);
  if (p === 'rpc/claim_member') {
    const m = u && db.members.find(m => m.email.toLowerCase() === (u.email || '').toLowerCase());
    if (!m) return json(200, null);
    m.user_id = u.sub; return json(200, { name: m.name, role: m.role });
  }
  const t = p; if (!db[t]) return json(404, { message: 'no table ' + t });
  if (!u) return json(401, { message: 'permission denied' });
  const wantObj = (req.headers().accept || '').includes('vnd.pgrst.object');
  const prefer = req.headers().prefer || '';
  if (req.method() === 'GET') {
    let rows = db[t].filter(r => canRead(t, u, r)).filter(filters(url));
    const off = +(url.searchParams.get('offset') || 0), lim = url.searchParams.get('limit');
    rows = rows.slice(off, lim ? off + +lim : undefined);
    if (wantObj) return rows.length === 1 ? json(200, rows[0]) : json(406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${rows.length} rows` });
    return json(200, rows);
  }
  if (req.method() === 'POST') {
    let body = JSON.parse(req.postData() || '[]'); if (!Array.isArray(body)) body = [body];
    const out = [];
    for (const raw of body) {
      const row = Object.assign({}, raw);
      if (t === 'shared_items') { row.list_id = row.list_id || 'ours'; row.changed_by = u.sub; row.changed_at = nowIso(); }
      if (t === 'marks' || t === 'prefs') row.user_id = row.user_id || u.sub;
      if (t === 'marks' && !MARK_KINDS.includes(row.kind)) return json(400, { code: '23514', message: 'new row violates check constraint "marks_kind_check"' });
      if (!canWrite(t, u, row)) return json(403, { code: '42501', message: `new row violates row-level security policy for table "${t}"` });
      const i = db[t].findIndex(r => PK[t].every(c => String(r[c]) === String(row[c])));
      if (i >= 0) { if (!prefer.includes('merge-duplicates')) return json(409, { message: 'duplicate' }); db[t][i] = Object.assign({}, db[t][i], row); out.push(db[t][i]); }
      else { db[t].push(row); out.push(row); }
    }
    return prefer.includes('return=representation') ? json(201, wantObj ? out[0] : out) : json(201);
  }
  if (req.method() === 'DELETE') { const f = filters(url); db[t] = db[t].filter(r => !(f(r) && canWrite(t, u, r))); return json(204); }
  return json(405, { message: 'method' });
}

/* ------------------------------------------------------------------ Mock-TMDB */
const hash = s => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 900000; return 100000 + h; };
const PROVIDERS = [
  { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.png', display_priorities: { DE: 1 } },
  { provider_id: 9, provider_name: 'Amazon Prime Video', logo_path: '/a.png', display_priorities: { DE: 2 } },
  { provider_id: 2100, provider_name: 'Amazon Prime Video with Ads', logo_path: '/a2.png', display_priorities: { DE: 3 } },
  { provider_id: 350, provider_name: 'Apple TV+', logo_path: '/t.png', display_priorities: { DE: 4 } },
  { provider_id: 337, provider_name: 'Disney Plus', logo_path: '/d.png', display_priorities: { DE: 5 } }
];
// Filme: gerade ID = englisches Original. ID%3: 0 Netflix, 1 Prime (+ mit Werbung), 2 nirgends.
function movie(id) {
  id = +id;
  const prov = id % 3 === 0 ? [PROVIDERS[0]] : id % 3 === 1 ? [PROVIDERS[1], PROVIDERS[2]] : [];
  return {
    id, title: 'Film ' + id, original_title: 'Movie ' + id, original_language: id % 2 === 0 ? 'en' : 'fr',
    release_date: (1980 + id % 45) + '-05-01', runtime: 85 + id % 70, vote_average: (id % 90) / 10,
    genres: [{ name: ['Drama', 'Horror', 'Komödie', 'Thriller', 'Dokumentarfilm'][id % 5] }], poster_path: '/p' + id + '.jpg', overview: 'Inhalt ' + id,
    external_ids: { imdb_id: 'tt' + String(id).padStart(7, '0') },
    videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'de' + id, iso_639_1: 'de' }, { site: 'YouTube', type: 'Trailer', key: 'en' + id, iso_639_1: 'en' }] },
    'watch/providers': { results: { DE: { flatrate: prov } } }
  };
}
// Feste Suchergebnisse für den Zuordnungs-Test: mehrere Filme gleichen Namens
const SEARCH_FIXTURES = {
  obsession: [{ id: 501, title: 'Obsession', release_date: '2025-02-01', vote_count: 3 }, { id: 502, title: 'Obsession', release_date: '2025-09-10', vote_count: 900 }, { id: 503, title: 'Obsessions', release_date: '2025-01-01', vote_count: 5000 }],
  'resident evil': [{ id: 510, title: 'Resident Evil', release_date: '2002-03-15', vote_count: 9000 }, { id: 511, title: 'Resident Evil', release_date: '2026-09-18', vote_count: 40 }]
};
let tmdbCalls = 0;
async function tmdb(route) {
  tmdbCalls++;
  const url = new URL(route.request().url()), p = url.pathname.replace('/3', '');
  const j = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (p === '/configuration') return url.searchParams.get('api_key') === 'goodkey' ? j({}) : route.fulfill({ status: 401, body: '{}' });
  if (p.startsWith('/find/')) return j({ movie_results: [{ id: parseInt(p.split('/')[2].slice(2), 10) }] });
  if (p === '/search/movie') {
    const q = url.searchParams.get('query'), y = url.searchParams.get('primary_release_year') || url.searchParams.get('year');
    const fx = SEARCH_FIXTURES[q.toLowerCase()];
    if (fx) return j({ results: y ? fx.filter(m => m.release_date.startsWith(y)) : fx });
    const id = hash(q);
    return j({ results: [{ id, title: q, release_date: (y || 2000) + '-01-01', vote_count: 50 }, { id: id + 1, title: q + ' 2', release_date: '1999-01-01', vote_count: 5 }] });
  }
  if (p.startsWith('/movie/')) return j(movie(p.split('/')[2]));
  if (p === '/watch/providers/movie') return j({ results: PROVIDERS });
  if (p === '/discover/movie') { const pg = +url.searchParams.get('page'); return j({ total_pages: 3, results: Array.from({ length: 20 }, (_, i) => ({ id: 900000 + pg * 100 + i })) }); }
  return j({});
}

/* ------------------------------------------------------------------ Geräte */
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub, email) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub, email, exp: Math.floor(Date.now() / 1000) + 86400, role: 'authenticated', aud: 'authenticated' }) + '.sig';
const session = u => ({ access_token: jwt(u.sub, u.email), refresh_token: 'r', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
  user: { id: u.sub, email: u.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } });
const svgPoster = n => { const h = (+n * 47) % 360; return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="hsl(${h},50%,35%)"/></svg>`; };
const CT = f => f.endsWith('.js') ? 'application/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.json') ? 'application/json' : 'text/html';

async function device(browser, { user, local, cloud = true, viewport = { width: 1280, height: 900 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  const errors = [];
  await ctx.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(SITE)) {
      const f = new URL(url).pathname.replace('/moviedude/', '') || 'index.html';
      if (f === 'config.js') return route.fulfill({ contentType: 'application/javascript', body: cloud ? `window.MD_CONFIG={supabaseUrl:'${SB}',supabaseKey:'sb_publishable_test'};` : 'window.MD_CONFIG={};' });
      const fp = path.join(APP, f);
      return fs.existsSync(fp) ? route.fulfill({ contentType: CT(f), body: fs.readFileSync(fp) }) : route.fulfill({ status: 404, body: '' });
    }
    if (url.includes('cdn.jsdelivr.net/npm/@supabase/supabase-js@')) return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(SBJS, url.split('/').pop())) });
    if (url.startsWith(SB + '/rest/v1/')) return rest(route);
    if (url.startsWith(SB + '/auth/v1/otp')) { log.push('OTP ' + url + ' ' + route.request().postData()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); }
    if (url.startsWith(SB + '/auth/v1/token')) {
      const b = JSON.parse(route.request().postData() || '{}');
      if (b.password !== 'geheim123') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 'invalid_credentials' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session({ sub: '44444444-4444-4444-4444-444444444444', email: b.email })) });
    }
    if (url.startsWith(SB + '/auth/v1/user')) { log.push('SETPW'); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session(T).user) }); }
    if (url.startsWith(SB)) return route.fulfill({ status: 404, body: '' });
    if (url.startsWith('https://api.themoviedb.org/')) return tmdb(route);
    if (url.startsWith('https://image.tmdb.org/')) return route.fulfill({ contentType: 'image/svg+xml', body: svgPoster((url.match(/\d+/g) || ['1']).pop()) });
    return route.abort();
  });
  await ctx.addInitScript(([sess, loc]) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    if (sess) localStorage.setItem('sb-mock-auth-token', JSON.stringify(sess));
    if (loc) localStorage.setItem('md.state.v1', JSON.stringify(loc));
  }, [user ? session(user) : null, local || null]);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/websocket|realtime|net::ERR_FAILED|Failed to load resource/i.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('popup', p => p.close().catch(() => {}));
  await page.goto(SITE + '?mdtest');
  return { ctx, page, errors };
}

let fails = 0;
const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function idle(page, ms = 90000) { const t0 = Date.now(); await sleep(500); while (Date.now() - t0 < ms) { if (await page.locator('#sync').isHidden()) return; await sleep(250); } }
async function foreground(page) {     // simuliert "App wieder geöffnet" -> refresh()
  await sleep(5200);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(1500);
}
const num = s => +((s || '').match(/\d+/) || [0])[0];
const tabText = async (page, name) => { const t = page.locator(`#tabs .tab:has-text("${name}")`); return (await t.count()) ? t.first().textContent() : null; };

(async () => {
  if (!SB_VERSION || !fs.existsSync(SBJS)) { console.error('supabase-js fehlt – bitte über tests/run.sh starten.'); process.exit(2); }
  const browser = await chromium.launch(fs.existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {});
  const legacy = {   // Zustand aus Etappe 1 im Browser des iMac
    apiKey: 'goodkey', services: [9, 2100, 350],
    lists: [{ id: 'mine', name: 'Meine' }, { id: 'ours', name: 'Unsere' }, { id: 'lhal', name: 'Halloween' }],
    members: { '118715': ['ours'], '333371': ['mine', 'ours'], '500001': ['lhal'] },
    hidden: [1485796, 4242], seenLocal: [30694], unseenLocal: [], extra: [500001], tray: [118715],
    snooze: { '777': Date.now() + 1e9 }, tab: 'mine', source: 'all', sort: 'new', runtime: 0, genres: [], feed: 'popular'
  };

  console.log('\n== Hilfsfunktionen ==');
  {
    const d = await device(browser, {});
    await d.page.waitForFunction(() => window.__mdTest);
    const r = await d.page.evaluate(async () => {
      const t = window.__mdTest;
      return {
        obsession: await t.matchByTitle('Obsession', 2025, 'en-US'),
        resident: await t.matchByTitle('Resident Evil', 2026, 'en-US'),
        wrongYear: await t.matchByTitle('Resident Evil', 1990, 'en-US'),
        norm: t.norm('Amélie – Café!'),
        disc: t.discLabel(new Set(['Blu-ray', 'DVD']))
      };
    });
    check(r.obsession === 502, 'Zuordnung: bei Namensgleichheit gewinnt der bekanntere Film (' + r.obsession + ')');
    check(r.resident === 511, 'Zuordnung: exaktes Jahr schlägt Remake/Original (' + r.resident + ')');
    check(r.wrongYear === null, 'Zuordnung: falsches Jahr ergibt keinen Treffer');
    check(r.norm === 'amelie cafe', 'Titel-Normalisierung (' + r.norm + ')');
    check(r.disc === 'DVD + Blu-ray', 'Disc-Beschriftung (' + r.disc + ')');
    await d.ctx.close();
  }

  console.log('\n== Fremde Adresse ==');
  {
    const x = await device(browser, { user: X });
    await x.page.waitForSelector('#noAccess:not([hidden])', { timeout: 15000 });
    check(/fremd@example.com/.test(await x.page.textContent('#noAccessText')), 'Fremder sieht "Kein Zugang"');
    check(await x.page.locator('#app').isHidden(), 'App bleibt verborgen');
    await x.ctx.close();
  }

  console.log('\n== Anmeldung ==');
  {
    const l = await device(browser, {});
    await l.page.waitForSelector('#login:not([hidden])', { timeout: 15000 });
    await l.page.fill('#loginEmail', T.email);
    await l.page.click('#loginBtn');
    await l.page.waitForFunction(() => /unterwegs|geklappt/.test(document.querySelector('#loginStatus').textContent), null, { timeout: 10000 });
    check(log.some(x => x.startsWith('OTP') && x.includes(T.email) && x.includes('moviedude')), 'Mail-Link mit Rücksprung zur App angefordert');
    db.members.push({ email: 'test@example.com', name: 'Sarah (Test)', role: 'partner', user_id: null });
    await l.page.fill('#loginEmail', 'test@example.com');
    await l.page.fill('#loginPassword', 'falsch');
    check((await l.page.textContent('#loginBtn')) === 'Anmelden', 'Knopf wechselt bei Passwort auf "Anmelden"');
    await l.page.click('#loginBtn'); await sleep(800);
    check(/stimmen nicht/.test(await l.page.textContent('#loginStatus')), 'Falsches Passwort wird erklärt');
    await l.page.fill('#loginPassword', 'geheim123'); await l.page.click('#loginBtn');
    await l.page.waitForSelector('#app:not([hidden])', { timeout: 10000 });
    check(/^Unsere/.test((await l.page.locator('#tabs .tab').allTextContents())[0] || ''), 'Passwort-Login als Partnerin');
    await l.page.click('#openSettings');
    await l.page.fill('#newPassword', 'neuespasswort'); await l.page.click('#pwForm button'); await sleep(600);
    check(/gespeichert/.test(await l.page.textContent('#pwStatus')) && log.includes('SETPW'), 'Passwort festlegen');
    db.members = db.members.filter(m => m.email !== 'test@example.com');
    check(l.errors.length === 0, 'keine JS-Fehler ' + l.errors.join(' | '));
    await l.ctx.close();
  }

  console.log('\n== Tobias iMac: Übernahme aus Etappe 1 ==');
  const t1 = await device(browser, { user: T, local: legacy });
  await t1.page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
  await idle(t1.page); await sleep(1500);
  {
    const hh = Object.fromEntries(db.household.map(r => [r.key, r.val]));
    check(hh.tmdb_key === 'goodkey', 'TMDB-Schlüssel in den Haushalt übernommen');
    check(JSON.stringify(hh.services) === '[9,2100,350]', 'Dienste übernommen');
    check(Object.keys(hh.shelf || {}).length > 500, 'Regal-Zuordnung für Sarah hochgeladen (' + Object.keys(hh.shelf || {}).length + ')');
    check(Object.keys(hh.match || {}).length > 1000 && Object.keys(hh.match).every(k => !k.startsWith('l:')), 'Zuordnungen hochgeladen, nur neue Schlüssel');
    const tm = db.marks.filter(m => m.user_id === T.sub);
    check(tm.filter(m => m.kind === 'hidden').length === 2 && tm.some(m => m.kind === 'seen' && m.tmdb_id === 30694) && tm.some(m => m.kind === 'snooze' && m.tmdb_id === 777), 'Nie, Gesehen, Lass erstmal übernommen');
    const l333 = tm.find(m => m.kind === 'lists' && m.tmdb_id === 333371);
    check(l333 && JSON.stringify(l333.val) === '["mine"]', 'Private Listen ohne "ours" gespeichert');
    check(JSON.stringify(db.shared_items.filter(r => r.in_list).map(r => r.tmdb_id).sort()) === '[118715,333371]', 'Unsere in die gemeinsame Liste verschoben');
    const pr = db.prefs.find(p => p.user_id === T.sub);
    check(pr && pr.data.lists.some(l => l.id === 'lhal') && pr.data.tray.includes(118715), 'Eigene Listen und Heute Abend synchronisiert');
    const tabs = await t1.page.locator('#tabs .tab').allTextContents();
    check(['Meine', 'Unsere', 'Halloween', 'Alles', 'Entdecken'].every(n => tabs.some(t => t.startsWith(n))), 'Tabs: ' + tabs.join(' | '));
    check(await t1.page.locator('#openAdd').isVisible(), '"+ Film" sichtbar für Tobias');
    check(t1.errors.length === 0, 'keine JS-Fehler ' + t1.errors.join(' | '));
  }

  console.log('\n== Tobias Handy: frisches Gerät ==');
  const before = tmdbCalls;
  db.marks.push({ user_id: T.sub, tmdb_id: 888, kind: 'snooze', val: Date.now() - 1000 });   // abgelaufenes "Lass erstmal"
  const t2 = await device(browser, { user: T, viewport: { width: 390, height: 844 } });
  await t2.page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
  await idle(t2.page);
  {
    check(await t2.page.locator('#settingsDlg[open]').count() === 0, 'Kein Schlüssel-Dialog');
    check(!db.marks.some(m => m.tmdb_id === 888), 'Abgelaufenes "Lass erstmal" wird aus der Datenbank geräumt');
    check(tmdbCalls - before < 1500, 'Zuordnungen aus dem Haushalt übernommen statt neu gesucht (' + (tmdbCalls - before) + ' TMDB-Aufrufe)');
    check(await t2.page.locator('.filters').isHidden() && await t2.page.locator('#filterToggle').isVisible(), 'Filter am Handy eingeklappt');
    await t2.page.click('#filterToggle');
    await t2.page.click('#tabs .tab:has-text("Unsere")');
    await t2.page.click('#source button[data-v="all"]');
    check(await t2.page.locator('#grid .card').count() === 2, 'Handy zeigt dieselben 2 Filme in Unsere');
    check(await t2.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Kein Querscrollen am Handy');
    check(t2.errors.length === 0, 'keine JS-Fehler ' + t2.errors.join(' | '));
  }

  console.log('\n== Sarah ==');
  const s = await device(browser, { user: S, viewport: { width: 390, height: 844 } });
  await s.page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
  await idle(s.page); await sleep(800);
  {
    const tabs = await s.page.locator('#tabs .tab').allTextContents();
    check(tabs.length === 2 && tabs[0].startsWith('Unsere') && tabs[1].startsWith('Entdecken'), 'Nur Unsere + Entdecken: ' + tabs.join(' | '));
    check(await s.page.locator('#grid .card').count() === 2, 'Sieht die 2 Filme in Unsere');
    check(await s.page.locator('.filters').isHidden() && await s.page.locator('#suggest').isVisible(), 'Filter eingeklappt, Vorschlagsfeld oben');
    check(await s.page.locator('#tray').isHidden() && await s.page.locator('#openAdd').isHidden(), 'Tobias\' Heute Abend und "+ Film" sind für sie unsichtbar');
    await s.page.screenshot({ path: path.join(SHOTS, 'sarah-unsere.png') });
    await s.page.click('#openSettings');
    check(await s.page.locator('#keyBlock').isHidden() && await s.page.locator('#svcBlock').isHidden() && await s.page.locator('#dataBlock').isHidden(), 'Keine Schlüssel-, Dienste- und Datenverwaltung');
    await s.page.click('#settingsDlg [data-close]');

    await s.page.fill('#suggestInput', 'https://m.imdb.com/title/tt0099999/?ref_=share');
    await s.page.click('#suggestForm button');
    await s.page.waitForSelector('#suggestList li', { timeout: 10000 });
    check(/Film 99999/.test(await s.page.textContent('#suggestList')), 'IMDb-Link aufgelöst');
    await s.page.click('#suggestList li button'); await sleep(500);
    const r99 = db.shared_items.find(r => r.tmdb_id === 99999);
    check(r99 && r99.in_list && r99.added_by === S.sub, 'Vorschlag gespeichert, von Sarah');
    await s.page.fill('#suggestInput', 'https://letterboxd.com/film/the-big-lebowski/');
    await s.page.click('#suggestForm button');
    await s.page.waitForFunction(() => !/Suche/.test(document.querySelector('#suggestStatus').textContent), null, { timeout: 10000 });
    check(await s.page.locator('#suggestList li').count() >= 1, 'Letterboxd-Link liefert Treffer');
    await s.page.fill('#suggestInput', 'https://boxd.it/29Go');
    await s.page.click('#suggestForm button'); await sleep(300);
    check(/Kurzlinks/.test(await s.page.textContent('#suggestStatus')), 'boxd.it-Kurzlink wird erklärt');

    const n = await s.page.locator('#grid .card').count();
    await s.page.locator('#grid .card[data-id="118715"] button:has-text("Raus aus Unsere")').click(); await sleep(500);
    check(db.shared_items.find(r => r.tmdb_id === 118715).in_list === false && await s.page.locator('#grid .card').count() === n - 1, 'Rausnehmen wirkt sofort und wird gespeichert');

    await s.page.click('#tabs .tab:has-text("Entdecken")');
    await s.page.waitForSelector('.swipe:not(.back)', { timeout: 10000 });
    check(await s.page.locator('[data-act="ours"]').isHidden() && (await s.page.textContent('[data-act="mine"]')) === 'Vorschlagen', 'Swipe-Knöpfe angepasst');
    const top = +(await s.page.getAttribute('.swipe:not(.back)', 'data-id'));
    await s.page.click('[data-act="mine"]'); await sleep(700);
    check(db.shared_items.some(r => r.tmdb_id === top && r.in_list && r.added_by === S.sub), 'Rechts = Vorschlag in Unsere');
    await s.page.waitForSelector('.swipe:not(.back)', { timeout: 10000 });
    const nie = +(await s.page.getAttribute('.swipe:not(.back)', 'data-id'));
    await s.page.click('[data-act="nie"]'); await sleep(700);
    check(db.marks.some(m => m.user_id === S.sub && m.kind === 'hidden' && m.tmdb_id === nie) && !db.marks.some(m => m.user_id === T.sub && m.tmdb_id === nie), 'Sarahs Nie gilt nur für sie');
    const tr = await s.page.locator('.swipe:not(.back) a:has-text("Trailer")').getAttribute('href');
    const cur = +(await s.page.getAttribute('.swipe:not(.back)', 'data-id'));
    check(tr.endsWith((cur % 2 === 0 ? 'en' : 'de') + cur), 'Trailer im Entdecken-Feed in der richtigen Sprache');
    check(s.errors.length === 0, 'keine JS-Fehler ' + s.errors.join(' | '));
  }

  console.log('\n== Tobias sieht Sarahs Änderungen ==');
  await foreground(t1.page);
  {
    check(/Sarah hat 2 Filme in Unsere gelegt und 1 rausgenommen/.test(await t1.page.textContent('#noticeText')), 'Hinweis: ' + await t1.page.textContent('#noticeText'));
    await t1.page.click('#noticeShow');
    await t1.page.waitForSelector('#noticeList li button', { timeout: 10000 });
    await t1.page.click('#noticeList li button'); await sleep(600);
    check(db.shared_items.find(r => r.tmdb_id === 118715).in_list === true, 'Zurückholen aus dem Hinweis');
    await t1.page.click('#noticeDlg [data-close]'); await sleep(600);
    check(await t1.page.locator('#notice').isHidden(), 'Hinweis verschwindet nach dem Ansehen');
    await t1.page.click('#tabs .tab:has-text("Unsere")');
    await t1.page.click('#source button[data-v="all"]');
    check(/Vorschlag von Sarah/.test(await t1.page.textContent('#grid')), 'Karte zeigt "Vorschlag von Sarah"');
  }

  console.log('\n== Gesehen auf dem iMac, Handy zieht nach ==');
  {
    await t1.page.locator('#grid .card[data-id="333371"] button:has-text("Gesehen")').click(); await sleep(800);
    check(db.marks.some(m => m.user_id === T.sub && m.kind === 'seen' && m.tmdb_id === 333371), 'Gesehen gespeichert');
    check(db.shared_items.find(r => r.tmdb_id === 333371).in_list === false, 'Gesehen nimmt den Film aus Unsere');
    await foreground(t2.page);
    await t2.page.click('#tabs .tab:has-text("Meine")');
    check(await t2.page.locator('#grid .card[data-id="333371"]').count() === 0, 'Handy: Film ist auch dort raus');
    await t2.page.click('#tabs .tab:has-text("Alles")');
    const any = await t2.page.locator('#grid .card').first().getAttribute('data-id');
    await t2.page.locator(`#grid .card[data-id="${any}"] button.hide`).click(); await sleep(800);
    await foreground(t1.page);
    check(num(await tabText(t1.page, 'Nie')) === 3, 'iMac übernimmt "Nie" vom Handy');
  }

  console.log('\n== Dienste, O-Ton, Details, Sortierung ==');
  {
    const P = t1.page;
    await P.click('#openSettings'); await P.waitForSelector('#services .svc');
    await P.locator('#services .svc:has-text("Netflix") input').check(); await sleep(600);
    check(JSON.stringify(db.household.find(r => r.key === 'services').val) === '[9,2100,350,8]', 'Netflix im Haushalt aktiviert');
    check(/Version/.test(await P.textContent('#appVersion')), 'Versionsanzeige in den Einstellungen');
    check(await P.locator('#account').isVisible() && /Tobias/.test(await P.textContent('#accountText')), 'Konto-Bereich sichtbar');
    await P.click('#settingsDlg [data-close]');
    await foreground(s.page);
    await s.page.click('#tabs .tab:has-text("Unsere")');
    check(await s.page.locator('#grid .provs img[alt="Netflix"]').count() > 0, 'Sarah sieht die neuen Dienste');

    await P.click('#tabs .tab:has-text("Alles")'); await P.click('#source button[data-v="all"]');
    const enPrime = await P.evaluate(() => [...document.querySelectorAll('#grid .card')].map(c => +c.dataset.id).find(id => id % 6 === 4));
    const card = () => P.locator(`#grid .card[data-id="${enPrime}"]`);
    check(await card().locator('.provs img').count() === 1, 'Prime nur einmal als Logo, obwohl zweimal gelistet');
    check((await card().locator('a:has-text("Trailer")').getAttribute('href')).endsWith('en' + enPrime), 'Englischer Film: englischer Trailer');
    await card().locator('button.mini:has-text("Prime: kein O-Ton")').evaluate(b => b.click()); await sleep(700);
    check(db.shared_items.some(r => r.list_id === 'noov' && r.tmdb_id === enPrime && r.in_list), 'O-Ton-Meldung gespeichert');
    check(await card().locator('.provs img').count() === 0 && /Prime ohne O-Ton \(\d\d\/\d\d\)/.test(await card().textContent()), 'Prime-Logo weg, Meldedatum sichtbar');
    await card().locator('button.mini:has-text("aufheben")').evaluate(b => b.click()); await sleep(700);
    check(db.shared_items.find(r => r.list_id === 'noov' && r.tmdb_id === enPrime).in_list === false && await card().locator('.provs img').count() === 1, 'Aufheben');

    await card().locator('.poster > img').click();
    await P.waitForSelector('#filmDlg[open]', { timeout: 5000 });
    check(/Inhalt \d+/.test(await P.textContent('#filmBody')), 'Detailansicht mit Inhaltsangabe');
    await P.click('#filmDlg [data-close]');
    await P.click('#tabs .tab:has-text("Unsere")');
    await P.selectOption('#sort', 'added'); await sleep(300);
    check(await P.locator('#grid .card').count() > 0, 'Sortierung "Zuletzt hinzugefügt"');
  }

  console.log('\n== + Film und Nachtragen ==');
  {
    const P = t1.page;
    await P.click('#openAdd'); await P.fill('#addInput', 'tt0055555'); await P.click('#addForm button');
    await P.waitForSelector('#addList li');
    const li = P.locator('#addList li').first();
    await li.locator('button:has-text("Blu-ray")').click(); await sleep(400);
    await li.locator('button:has-text("DVD")').click(); await sleep(400);
    const extra = db.household.find(r => r.key === 'shelf_extra')?.val || {};
    check(JSON.stringify(extra['55555']) === '["Blu-ray","DVD"]', 'Discs im Haushalt gespeichert');
    check(/DVD \+ Blu-ray/.test(await li.textContent()), 'Beschriftung "DVD + Blu-ray"');
    await P.click('#addDlg [data-close]');
    await P.click('#tabs .tab:has-text("Meine")'); await P.click('#source button[data-v="shelf"]');
    check(await P.locator('#grid .card[data-id="55555"]').count() === 1, 'Gekaufter Film steht ungesehen in Meine mit Regal-Filter');

    const rateTab = P.locator('#tabs .tab:has-text("Nachtragen")');
    check(await rateTab.count() === 1, 'Tab Nachtragen sichtbar');
    const c0 = num(await rateTab.textContent());
    await rateTab.click(); await sleep(800);
    await P.locator('.rate-group').first().locator('li button:has-text("Erledigt")').first().click(); await sleep(800);
    check(num(await tabText(P, 'Nachtragen')) === c0 - 1, 'Erledigt zählt runter');
    check((db.prefs.find(p => p.user_id === T.sub).data.ratedDone || []).length === 1, 'Erledigt synchronisiert');
    check(t1.errors.length === 0 && t2.errors.length === 0 && s.errors.length === 0, 'keine JS-Fehler ' + [...t1.errors, ...t2.errors, ...s.errors].join(' | '));
  }

  console.log('\n== Ohne Supabase-Zugangsdaten ==');
  {
    const d = await device(browser, { cloud: false });
    await d.page.waitForSelector('#noAccess:not([hidden])', { timeout: 10000 });
    check(/config\.js/.test(await d.page.textContent('#noAccessText')) && await d.page.locator('#app').isHidden(), 'Klare Meldung statt halber App');
    check(d.errors.length === 0, 'keine JS-Fehler ' + d.errors.join(' | '));
    await d.ctx.close();
  }

  await browser.close();
  console.log(`\n${fails ? 'FEHLGESCHLAGEN: ' + fails : 'Alles grün.'}  Screenshots: ${SHOTS}`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
