// MovieDude – Smoke-Test
// Liefert das Repo über einen lokalen HTTP-Server aus (wie GitHub Pages), lädt index.html?mdtest im Chromium
// und prüft: keine Konsolenfehler, keine pageerror-Events, window.__mdTest vorhanden, Hauptansichten rendern.
// Supabase, TMDB, CDN und Fonts werden abgefangen, der Test läuft offline.
//
// Start:  bash tests/run.sh   (oder einzeln: node tests/smoke.js, sobald tests/.cache/supabase-js existiert)
const path = require('path'), fs = require('fs'), http = require('http');
const { chromium } = (() => { try { return require('playwright'); } catch { return require('/opt/npm-tools/node_modules/playwright'); } })();

const APP = path.join(__dirname, '..');
const SBJS = path.join(__dirname, '.cache', 'supabase-js', 'package', 'dist', 'umd', 'supabase.js');
const SB = (fs.readFileSync(path.join(APP, 'config.js'), 'utf8').match(/supabaseUrl:\s*'([^']+)'/) || [])[1];
const AUTH_KEY = 'sb-' + new URL(SB).hostname.split('.')[0] + '-auth-token';
const USER = { id: '11111111-1111-1111-1111-111111111111', email: 'tobias@example.com' };

/* ---------- Lokaler Webserver ---------- */
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const fp = path.join(APP, p === '/' ? 'index.html' : p);
  if (!fp.startsWith(APP + path.sep) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

/* ---------- Mock-Supabase (nur Lesen, Schreiben wird quittiert) ---------- */
const db = {
  household: [{ key: 'tmdb_key', val: 'smokekey' }, { key: 'services', val: [8, 9] }],
  prefs: [{ user_id: USER.id, data: { lists: [{ id: 'mine', name: 'Meine' }, { id: 'ours', name: 'Unsere' }], tray: [], lastSeen: 1, ratedDone: [] } }],
  marks: [{ tmdb_id: 300003, kind: 'seen', val: true }],
  shared_items: [{ list_id: 'ours', tmdb_id: 300003, in_list: true, added_by: USER.id, changed_by: USER.id, changed_at: '2026-01-01T00:00:00+00:00' },
    { list_id: 'ours', tmdb_id: 300006, in_list: true, added_by: USER.id, changed_by: USER.id, changed_at: '2026-01-01T00:00:00+00:00' }],
  members: [{ name: 'Tobias', user_id: USER.id }]
};
function rest(route) {
  const req = route.request(), url = new URL(req.url());
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });
  const t = url.pathname.replace('/rest/v1/', '');
  if (t === 'rpc/claim_member') return json(200, { name: 'Tobias', role: 'owner' });
  if (req.method() === 'GET') {
    const rows = db[t] || [];
    if ((req.headers().accept || '').includes('vnd.pgrst.object')) return rows.length === 1 ? json(200, rows[0]) : json(406, { code: 'PGRST116', message: 'no rows' });
    return json(200, rows);
  }
  if (req.method() === 'POST') return json(201, (req.headers().prefer || '').includes('return=representation') ? JSON.parse(req.postData() || '{}') : undefined);
  return json(204);
}

/* ---------- Mock-TMDB: gerade ID = englisch, ID%3: 0 Netflix, 1 Prime, 2 nirgends ---------- */
const hash = s => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 900000; return 100000 + h; };
const PROVIDERS = [
  { provider_id: 8, provider_name: 'Netflix', logo_path: '/n.png', display_priorities: { DE: 1 } },
  { provider_id: 9, provider_name: 'Amazon Prime Video', logo_path: '/a.png', display_priorities: { DE: 2 } }
];
const movie = id => ({
  id, title: 'Film ' + id, original_title: 'Movie ' + id, original_language: id % 2 === 0 ? 'en' : 'fr',
  release_date: (1980 + id % 45) + '-05-01', runtime: 85 + id % 70, vote_average: (id % 90) / 10,
  genres: [{ name: ['Drama', 'Horror', 'Komödie'][id % 3] }], poster_path: '/p' + id + '.jpg', overview: 'Inhalt ' + id,
  external_ids: { imdb_id: 'tt' + String(id).padStart(7, '0') }, videos: { results: [] },
  'watch/providers': { results: { DE: { flatrate: id % 3 === 0 ? [PROVIDERS[0]] : id % 3 === 1 ? [PROVIDERS[1]] : [] } } }
});
function tmdb(route) {
  const url = new URL(route.request().url()), p = url.pathname.replace('/3', '');
  const j = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (p.startsWith('/find/')) return j({ movie_results: [{ id: parseInt(p.split('/')[2].slice(2), 10) }] });
  if (p === '/search/movie') return j({ results: [{ id: hash(url.searchParams.get('query')), title: url.searchParams.get('query'), release_date: (url.searchParams.get('primary_release_year') || 2000) + '-01-01', vote_count: 50 }] });
  if (p.startsWith('/movie/')) return j(movie(+p.split('/')[2]));
  if (p === '/watch/providers/movie') return j({ results: PROVIDERS });
  if (p === '/discover/movie') return j({ total_pages: 2, results: Array.from({ length: 20 }, (_, i) => ({ id: 900000 + +url.searchParams.get('page') * 100 + i })) });
  return j({});
}

/* ---------- Gerät ---------- */
async function device(browser, { loggedIn }) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [], local = [];
  await ctx.routeWebSocket(/realtime/, ws => ws.onMessage(m => {     // Realtime: Beitritt und Herzschlag quittieren
    const [joinRef, ref, topic] = JSON.parse(m);                     // Protokoll 2.0: [join_ref, ref, topic, event, payload]
    ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: [] } }]));
  }));
  await ctx.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('http://127.0.0.1')) { local.push(new URL(url).pathname); return route.continue(); }
    if (url.includes('cdn.jsdelivr.net/npm/@supabase/supabase-js@')) return route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(SBJS) });
    if (url.startsWith(SB + '/rest/v1/')) return rest(route);
    if (url.startsWith(SB)) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    if (url.startsWith('https://api.themoviedb.org/')) return tmdb(route);
    if (url.startsWith('https://image.tmdb.org/')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>' });
    if (url.startsWith('https://fonts.')) return route.fulfill({ contentType: 'text/css', body: '' });
    errors.push('unerwartete Anfrage: ' + url);
    return route.abort();
  });
  if (loggedIn) {
    const now = Math.floor(Date.now() / 1000);
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: USER.id, email: USER.email, exp: now + 86400, role: 'authenticated', aud: 'authenticated' }) + '.sig';
    const sess = { access_token: token, refresh_token: 'r', token_type: 'bearer', expires_in: 86400, expires_at: now + 86400,
      user: { id: USER.id, email: USER.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
    await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), [AUTH_KEY, JSON.stringify(sess)]);
  }
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('popup', p => p.close().catch(() => {}));
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.goto(base + 'index.html?mdtest');
  return { ctx, page, errors, local };
}

let fails = 0, base = '';
const check = (cond, msg) => { console.log((cond ? 'OK   ' : 'FAIL ') + msg); if (!cond) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function idle(page) { await sleep(300); for (let i = 0; i < 240 && !(await page.locator('#sync').isHidden()); i++) await sleep(250); }
const visible = (page, sel) => page.locator(sel).first().isVisible();

(async () => {
  if (!fs.existsSync(SBJS)) { console.error('supabase-js fehlt – bitte über tests/run.sh starten.'); process.exit(2); }
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  try {
    console.log('\n== Ohne Anmeldung ==');
    const a = await device(browser, { loggedIn: false });
    await a.page.waitForSelector('#login:not([hidden])', { timeout: 15000 });
    check(await a.page.evaluate(() => !!(window.__mdTest && window.__mdTest.matchByTitle && window.__mdTest.norm && window.__mdTest.discLabel)), 'window.__mdTest vorhanden');
    check(await visible(a.page, '#loginForm'), 'Login-Ansicht rendert');
    check(a.errors.length === 0, 'keine Konsolen-/Seitenfehler ' + a.errors.join(' | '));
    await a.ctx.close();

    console.log('\n== Angemeldet (Tobias) ==');
    const t = await device(browser, { loggedIn: true });
    await t.page.waitForSelector('#tabs .tab', { timeout: 20000 });
    await idle(t.page);
    check(await t.page.evaluate(() => !!window.__mdTest), 'window.__mdTest vorhanden');
    const tabs = await t.page.locator('#tabs .tab').allTextContents();
    check(['Meine', 'Unsere', 'Alles', 'Entdecken'].every(n => tabs.some(x => x.startsWith(n))), 'Tabs: ' + tabs.join(' | '));
    check(await t.page.locator('#grid .card').count() > 0, 'Liste "Meine" rendert Karten (' + await t.page.locator('#grid .card').count() + ')');
    await t.page.click('#tabs .tab:has-text("Unsere")');
    check(await t.page.locator('#grid .card').count() === 2, 'Liste "Unsere" rendert');
    await t.page.click('#tabs .tab:has-text("Alles")');
    await t.page.click('#source button[data-v="all"]');
    check(await t.page.locator('#grid .card').count() > 100, 'Liste "Alles" rendert');
    await t.page.locator('#grid .card .poster').first().click();
    check(await visible(t.page, '#filmDlg[open] .fd-ov'), 'Detailansicht rendert');
    await t.page.click('#filmDlg [data-close]');
    await t.page.locator('#grid .card .tonight').first().click();
    await t.page.click('#trayOpen');
    check(await t.page.locator('#trayList li').count() === 1, 'Heute Abend rendert');
    await t.page.click('#trayDlg [data-close]');
    await t.page.click('#tabs .tab:has-text("Entdecken")');
    await t.page.waitForSelector('#deck .swipe:not(.back)', { timeout: 10000 });
    check(await visible(t.page, '#deck .swipe:not(.back) .title'), 'Entdecken rendert eine Karte');
    if (tabs.some(x => x.startsWith('Nachtragen'))) {
      await t.page.click('#tabs .tab:has-text("Nachtragen")');
      check(await t.page.locator('#rateView .rate-group').count() > 0, 'Nachtragen rendert');
    }
    await t.page.click('#openSettings');
    await t.page.waitForSelector('#services .svc');
    check(await visible(t.page, '#settingsDlg[open]') && /Version/.test(await t.page.textContent('#appVersion')), 'Einstellungen rendern (inkl. Versionsanzeige)');
    await t.page.click('#settingsDlg [data-close]');
    await t.page.click('#openAdd');
    check(await visible(t.page, '#addDlg[open]'), '"+ Film" rendert');
    const missing = [...new Set(t.local)].filter(p => p.endsWith('.js') && !fs.existsSync(path.join(APP, p)));
    check(!missing.length, 'alle App-Skripte vom Server geladen ' + missing.join(' '));
    await sleep(500);
    check(t.errors.length === 0, 'keine Konsolen-/Seitenfehler ' + t.errors.join(' | '));
    await t.ctx.close();
  } catch (e) { console.log('FAIL Abbruch: ' + e.message); fails++; }
  await browser.close(); server.close();
  console.log(fails ? `\n${fails} Smoke-Check(s) fehlgeschlagen.` : '\nSmoke-Test grün.');
  process.exit(fails ? 1 : 0);
})();
