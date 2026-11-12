/* MovieDude — Watchlist, Regal und Streaming-Verfügbarkeit.
   Login per Mail-Link oder Passwort, Daten in Supabase, gemeinsame Liste "Unsere" mit Sarah.
   Grundlagen: Konstanten, Zustand, Speicher, Helfer.
   Teilt sich den globalen Gültigkeitsbereich mit den übrigen js/-Dateien; Ladereihenfolge in index.html, Überblick in docs/ARCHITEKTUR.md. */
'use strict';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const REGION = 'DE';
const STATE_KEY = 'md.state.v1';          // alter Browser-Zustand (Etappe 1), nur noch zum Übernehmen gelesen
const UI_KEY = 'md.ui.v1';                // Etappe 2: Ansichts-Einstellungen pro Gerät
const CACHE_KEY = 'md.cache.v1';
const FRESH_MS = 2 * 24 * 3600 * 1000;
const STALE_MS = 30 * 24 * 3600 * 1000;
const SNOOZE_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_SERVICES = [/netflix/i, /amazon prime video/i, /^apple tv\+?$/i, /disney/i];
const OURS = 'ours';

const CFG = window.MD_CONFIG || {};
const CONFIGURED = !!(CFG.supabaseUrl && CFG.supabaseKey);

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
const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const uniq = a => [...new Set(a)];
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const ts = s => (s ? Date.parse(s) || 0 : 0);
const otherName = uid => people[uid] || 'Jemand';
