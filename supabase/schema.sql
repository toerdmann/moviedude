-- MovieDude – Datenbank-Setup
-- Einmal komplett im Supabase SQL Editor ausführen (New query → einfügen → Run).
-- Kann gefahrlos mehrfach ausgeführt werden.

-- ---------------------------------------------------------------------------
-- Gästeliste: nur diese Adressen sehen überhaupt Daten
-- ---------------------------------------------------------------------------
create table if not exists public.members (
  email   text primary key,
  name    text not null,
  role    text not null check (role in ('owner', 'partner')),
  user_id uuid unique
);

insert into public.members (email, name, role) values
  ('__TOBIAS_EMAIL__',      'Tobias', 'owner'),
  ('__SARAH_EMAIL__',      'Sarah',  'partner')
on conflict (email) do update set name = excluded.name, role = excluded.role;

-- Rolle der eingeloggten Person (null = nicht auf der Gästeliste)
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.members
  where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

-- Verknüpft die eingeloggte Person mit ihrem Gästelisten-Eintrag
create or replace function public.claim_member() returns json
language plpgsql security definer set search_path = public as $$
declare
  m public.members;
begin
  update public.members set user_id = auth.uid()
   where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  returning * into m;
  if not found then
    return null;
  end if;
  return json_build_object('name', m.name, 'role', m.role);
end
$$;

-- ---------------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------------
-- Haushalt: TMDB-Schlüssel, Streamingdienste, Regal-Zuordnung
create table if not exists public.household (
  key        text primary key,
  val        jsonb,
  updated_at timestamptz not null default now()
);

-- Persönliche Einstellungen (Sortierung, eigene Listen, Heute Abend …)
create table if not exists public.prefs (
  user_id    uuid primary key default auth.uid(),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Persönliche Markierungen pro Film: Nie, gesehen, Listen, Lass erstmal …
create table if not exists public.marks (
  user_id    uuid not null default auth.uid(),
  tmdb_id    integer not null,
  kind       text not null check (kind in ('hidden', 'seen', 'unseen', 'extra', 'snooze', 'lists')),
  val        jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, tmdb_id, kind)
);

-- Gemeinsame Liste "Unsere"
create table if not exists public.shared_items (
  list_id    text not null default 'ours',
  tmdb_id    integer not null,
  in_list    boolean not null default true,
  added_by   uuid,
  changed_by uuid default auth.uid(),
  changed_at timestamptz not null default now(),
  primary key (list_id, tmdb_id)
);

-- Wer zuletzt geändert hat, setzt immer die Datenbank, nicht die App
create or replace function public.touch_shared() returns trigger
language plpgsql as $$
begin
  new.changed_by := auth.uid();
  new.changed_at := now();
  return new;
end
$$;
drop trigger if exists shared_items_touch on public.shared_items;
create trigger shared_items_touch before insert or update on public.shared_items
  for each row execute function public.touch_shared();

create or replace function public.touch_updated() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;
drop trigger if exists marks_touch on public.marks;
create trigger marks_touch before insert or update on public.marks
  for each row execute function public.touch_updated();
drop trigger if exists prefs_touch on public.prefs;
create trigger prefs_touch before insert or update on public.prefs
  for each row execute function public.touch_updated();
drop trigger if exists household_touch on public.household;
create trigger household_touch before insert or update on public.household
  for each row execute function public.touch_updated();

-- ---------------------------------------------------------------------------
-- Zugriffsregeln (Row Level Security)
-- ---------------------------------------------------------------------------
alter table public.members      enable row level security;
alter table public.household    enable row level security;
alter table public.prefs        enable row level security;
alter table public.marks        enable row level security;
alter table public.shared_items enable row level security;

drop policy if exists members_read on public.members;
create policy members_read on public.members
  for select to authenticated using (public.my_role() is not null);

drop policy if exists household_read on public.household;
create policy household_read on public.household
  for select to authenticated using (public.my_role() is not null);
drop policy if exists household_insert on public.household;
create policy household_insert on public.household
  for insert to authenticated with check (public.my_role() = 'owner');
drop policy if exists household_update on public.household;
create policy household_update on public.household
  for update to authenticated using (public.my_role() = 'owner') with check (public.my_role() = 'owner');

drop policy if exists prefs_own on public.prefs;
create policy prefs_own on public.prefs
  for all to authenticated
  using (user_id = auth.uid() and public.my_role() is not null)
  with check (user_id = auth.uid() and public.my_role() is not null);

drop policy if exists marks_own on public.marks;
create policy marks_own on public.marks
  for all to authenticated
  using (user_id = auth.uid() and public.my_role() is not null)
  with check (user_id = auth.uid() and public.my_role() is not null);

drop policy if exists shared_read on public.shared_items;
create policy shared_read on public.shared_items
  for select to authenticated using (public.my_role() is not null);
drop policy if exists shared_insert on public.shared_items;
create policy shared_insert on public.shared_items
  for insert to authenticated with check (public.my_role() is not null);
drop policy if exists shared_update on public.shared_items;
create policy shared_update on public.shared_items
  for update to authenticated using (public.my_role() is not null) with check (public.my_role() is not null);

-- ---------------------------------------------------------------------------
-- Rechte für die App (nur eingeloggte Personen, nie anonym)
-- ---------------------------------------------------------------------------
revoke all on public.members, public.household, public.prefs, public.marks, public.shared_items from anon;
grant select on public.members to authenticated;
grant select, insert, update on public.household to authenticated;
grant select, insert, update, delete on public.prefs, public.marks to authenticated;
grant select, insert, update on public.shared_items to authenticated;
revoke execute on function public.my_role(), public.claim_member() from anon, public;
grant execute on function public.my_role(), public.claim_member() to authenticated;

-- ---------------------------------------------------------------------------
-- Live-Updates zwischen Geräten
-- ---------------------------------------------------------------------------
alter table public.marks        replica identity full;
alter table public.shared_items replica identity full;

do $$
begin
  begin
    alter publication supabase_realtime add table public.marks;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.shared_items;
  exception when duplicate_object then null;
  end;
end
$$;
