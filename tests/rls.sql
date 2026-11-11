-- Zugriffsregeln: wird von tests/rls.sh ausgeführt. Bricht beim ersten Fehler ab.
create function pg_temp.ok(c boolean, msg text) returns void language plpgsql as $$
begin if c is not true then raise exception 'FAIL %', msg; end if; raise notice 'OK   %', msg; end $$;
create function pg_temp.fails(q text, msg text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then raise notice 'OK   % (abgelehnt)', msg; return; end;
  raise exception 'FAIL % (wurde nicht abgelehnt)', msg;
end $$;

-- Tobias
begin; set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","email":"Tobias@Example.com"}', true);
select pg_temp.ok((public.claim_member() ->> 'role') = 'owner', 'Tobias wird als owner erkannt (Groß-/Kleinschreibung egal)');
insert into household(key, val) values ('tmdb_key', '"abc"'), ('services', '[8]');
insert into marks(user_id, tmdb_id, kind, val) values ('11111111-1111-1111-1111-111111111111', 115, 'hidden', 'true');
insert into shared_items(list_id, tmdb_id, in_list, added_by) values ('ours', 550, true, '11111111-1111-1111-1111-111111111111');
insert into prefs(user_id, data) values ('11111111-1111-1111-1111-111111111111', '{"tray":[1]}');
select pg_temp.fails($q$insert into marks(user_id, tmdb_id, kind, val) values ('11111111-1111-1111-1111-111111111111', 1, 'quatsch', 'true')$q$, 'Unbekannte Markierungsart');
commit;

-- Sarah
begin; set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","email":"sarah@example.com"}', true);
select pg_temp.ok((public.claim_member() ->> 'role') = 'partner', 'Sarah wird als partner erkannt');
select pg_temp.ok((select count(*) from household) = 2, 'Sarah liest den Haushalt');
select pg_temp.ok((select count(*) from marks) = 0, 'Sarah sieht Tobias'' Markierungen nicht');
select pg_temp.ok((select count(*) from prefs) = 0, 'Sarah sieht Tobias'' Einstellungen nicht');
insert into shared_items(list_id, tmdb_id, in_list) values ('ours', 550, false)
  on conflict (list_id, tmdb_id) do update set in_list = excluded.in_list;
select pg_temp.ok((select changed_by from shared_items where tmdb_id = 550) = '22222222-2222-2222-2222-222222222222', 'Trigger setzt changed_by auf Sarah');
insert into marks(user_id, tmdb_id, kind, val) values ('22222222-2222-2222-2222-222222222222', 700, 'hidden', 'true');
select pg_temp.fails($q$insert into household(key, val) values ('x', '1')$q$, 'Sarah schreibt in den Haushalt');
update household set val = '"hack"' where key = 'tmdb_key';   -- RLS: wirkt still auf 0 Zeilen
select pg_temp.ok((select val from household where key = 'tmdb_key') = '"abc"', 'Sarahs Änderung am TMDB-Schlüssel bleibt wirkungslos');
select pg_temp.fails($q$insert into marks(user_id, tmdb_id, kind, val) values ('11111111-1111-1111-1111-111111111111', 9, 'hidden', 'true')$q$, 'Sarah schreibt Markierungen für Tobias');
commit;
select pg_temp.ok((select val from household where key = 'tmdb_key') = '"abc"', 'TMDB-Schlüssel unverändert');

-- Fremde Person
begin; set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","email":"fremd@example.com"}', true);
select pg_temp.ok(public.claim_member() is null, 'Fremde Person steht nicht auf der Gästeliste');
select pg_temp.ok((select count(*) from household) + (select count(*) from shared_items) + (select count(*) from members) + (select count(*) from marks) = 0, 'Fremde Person sieht nichts');
select pg_temp.fails($q$insert into shared_items(list_id, tmdb_id) values ('ours', 1)$q$, 'Fremde Person schreibt in Unsere');
commit;

-- Anonym
begin; set local role anon;
select pg_temp.fails('select count(*) from shared_items', 'Anonymer Lesezugriff');
select pg_temp.fails('select public.claim_member()', 'Anonymer Aufruf von claim_member');
commit;
