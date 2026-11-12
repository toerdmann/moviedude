/* MovieDude – TMDB: Warteschlange, Zuordnung, Filmdaten, Dienste.
   Teilt sich den globalen Gültigkeitsbereich mit den übrigen js/-Dateien; Ladereihenfolge in index.html, Überblick in docs/ARCHITEKTUR.md. */
'use strict';

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
  // Bewertet jeden Treffer: gleiches Jahr > ±1 Jahr, exakter Titel, bei Gleichstand der bekanntere Film.
  const nt = norm(title);
  const score = m => {
    const y = parseInt((m.release_date || '').slice(0, 4), 10);
    let sc = 0;
    if (year) { if (y === year) sc += 4; else if (Math.abs(y - year) === 1) sc += 2; else return -1; }
    if (norm(m.title) === nt || norm(m.original_title) === nt) sc += 3;
    return sc + Math.min(2, Math.log10((m.vote_count || 0) + 1) / 2);
  };
  for (const p of tries) {
    const r = await tmdb('/search/movie', p);
    let best = null, bestScore = -1;
    for (const m of r.results || []) { const sc = score(m); if (sc > bestScore) { best = m; bestScore = sc; } }
    if (best && bestScore >= 0) return best.id;
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
