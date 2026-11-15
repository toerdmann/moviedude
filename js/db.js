/* MovieDude – Datenbank: gemeinsame Listen (Unsere, noov), Markierungen, Prefs, Haushalt, Übernahme alter Daten/Backups.
   Teilt sich den globalen Gültigkeitsbereich mit den übrigen js/-Dateien; Ladereihenfolge in index.html, Überblick in docs/ARCHITEKTUR.md. */
'use strict';

/* ---------- Prime ohne englischen O-Ton (gilt für den Haushalt, mit Datum zum späteren Nachprüfen) ---------- */
const NOOV = 'noov';
let noov = new Map();                   // tmdbId -> { in_list, changed_by, changed_at }
const isPrime = p => /amazon prime/i.test(p[1]);
const noovActive = id => !!noov.get(id)?.in_list;
async function setNoov(id, on) {
  const prev = noov.get(id);
  noov.set(id, { in_list: on, changed_by: me.id, changed_at: new Date().toISOString() });
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
/* ---------- Gemeinsames "Heute Abend" (beide sehen die Sterne; Stern legt den Film auch in "Unsere") ---------- */
const TONIGHT = 'tonight';
let tonight = new Map();                // tmdbId -> { in_list, added_by, changed_by, changed_at }
const inTonight = id => !!tonight.get(id)?.in_list;
const tonightIds = () => [...tonight].filter(([, r]) => r.in_list).sort((a, b) => ts(a[1].changed_at) - ts(b[1].changed_at)).map(([id]) => id);
async function setTonight(ids, on) {
  ids = [].concat(ids).filter(id => inTonight(id) !== on);
  if (!ids.length) return;
  const prev = new Map(ids.map(id => [id, tonight.get(id)]));
  const now = new Date().toISOString();
  const rows = ids.map(id => ({ list_id: TONIGHT, tmdb_id: id, in_list: on, added_by: on ? me.id : (prev.get(id)?.added_by ?? null) }));
  for (const r of rows) tonight.set(r.tmdb_id, { in_list: on, added_by: r.added_by, changed_by: me.id, changed_at: now });
  renderTray();
  const { data, error } = await sb.from('shared_items').upsert(rows, { onConflict: 'list_id,tmdb_id' }).select();
  if (error) {
    for (const [id, r] of prev) if (r) tonight.set(id, r); else tonight.delete(id);
    toast('„Heute Abend“ konnte nicht gespeichert werden: ' + error.message); render(); return;
  }
  for (const r of data || []) if (r.tmdb_id != null && r.changed_at) tonight.set(r.tmdb_id, pickShared(r));
}

const pickShared = r => ({ in_list: r.in_list, added_by: r.added_by, changed_by: r.changed_by, changed_at: r.changed_at });
function applyRemoteShared(r) {
  if (r && r.list_id === NOOV) { noov.set(r.tmdb_id, pickShared(r)); return true; }
  if (r && r.list_id === TONIGHT) {
    const cur = tonight.get(r.tmdb_id);
    if (cur && cur.changed_at && ts(r.changed_at) < ts(cur.changed_at)) return false;
    tonight.set(r.tmdb_id, pickShared(r)); return true;
  }
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
  if (!me.id) return;
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

/* Einstellungen, die zwischen Geräten geteilt werden (eigene Listen, gelesen bis) */
let syncedPrefs = '';
const prefsData = () => Object.fromEntries(SYNC_PREF_FIELDS.map(k => [k, state[k]]));
async function pushPrefs() {
  if (!me.id) return;
  const data = prefsData(); const json = JSON.stringify(data);
  if (json === syncedPrefs) return;
  const { error } = await sb.from('prefs').upsert({ user_id: me.id, data }, { onConflict: 'user_id' });
  if (error) { setOffline(true, error.message); return; }
  syncedPrefs = json;
}
async function pushHouse(key, val) {
  house[key] = val;
  if (!isOwner()) return;
  const { error } = await sb.from('household').upsert({ key, val }, { onConflict: 'key' });
  if (error) toast('Speichern fehlgeschlagen: ' + error.message);
}

let persistT = null;
function persist() {
  save(UI_KEY, Object.fromEntries(UI_FIELDS.map(k => [k, state[k]])));
  clearTimeout(persistT);
  persistT = setTimeout(() => { pushMarks(); pushPrefs(); }, 250);
}
function setOffline(off, msg) {
  const box = $('#sync');
  if (off) { box.hidden = false; $('#syncText').textContent = 'Nicht gespeichert, versuche erneut…'; $('#syncBar').style.width = '0'; box.title = msg || ''; }
  else if ($('#syncText').textContent.startsWith('Nicht gespeichert')) { box.hidden = true; box.title = ''; }
}

/* ---------- Übernahme aus Etappe 1 (Browser) bzw. Backup-Datei ---------- */
const hasContent = s => !!(s && ((s.hidden || []).length || (s.seenLocal || []).length || (s.extra || []).length || Object.keys(s.members || {}).length || Object.keys(s.snooze || {}).length || (s.tray || []).length));
function legacyOursIds(s) {
  const ids = [];
  for (const [id, arr] of Object.entries(s.members || {})) if ((arr || []).includes(OURS)) ids.push(+id);
  for (const [id, r] of Object.entries(s.sharedLocal || {})) if (r?.in_list) ids.push(+id);
  return uniq(ids);
}
/* Altes persönliches "Heute Abend" (prefs.tray / Backup) einmalig in die gemeinsame Liste übernehmen */
function migrateTray() {
  const ids = uniq((state.tray || []).map(Number)).filter(Boolean);
  state.tray = [];
  if (!ids.length) return;
  for (const id of ids) if (!inOurs(id)) setOurs(id, true);
  setTonight(ids, true);
  syncedPrefs = '';                          // erzwingt Speichern der Prefs ohne "tray"
  persist();
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
  migrateTray();
  rebuild(); render();
  return ours.length;
}
