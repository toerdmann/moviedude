#!/usr/bin/env bash
# Prüft supabase/schema.sql gegen ein lokales Postgres mit nachgebauten Supabase-Bausteinen
# (Rollen anon/authenticated, auth.uid(), auth.jwt(), Realtime-Publication).
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=$(ls -d /usr/lib/postgresql/*/bin | tail -1)
DIR=/var/tmp/moviedude-pg
PORT=54329
rm -rf "$DIR"; mkdir -p "$DIR"
RUN=""; if [ "$(id -u)" = 0 ]; then chown postgres "$DIR"; RUN="su postgres -s /bin/bash -c"; fi
pg() { if [ -n "$RUN" ]; then $RUN "$*"; else bash -c "$*"; fi; }
pg "$BIN/initdb -D $DIR/data -U postgres >/dev/null 2>&1"
pg "$BIN/pg_ctl -D $DIR/data -o '-k $DIR -p $PORT -c listen_addresses=' -l $DIR/log start >/dev/null"
trap 'pg "$BIN/pg_ctl -D $DIR/data stop -m fast >/dev/null" || true' EXIT
sleep 1
PSQL="psql -h $DIR -p $PORT -U postgres -v ON_ERROR_STOP=1 -q -X"
$PSQL -c 'create database t' >/dev/null
$PSQL -d t <<'SQL' >/dev/null 2>"$DIR/stubs.log" || { cat "$DIR/stubs.log"; exit 1; }
create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
grant usage on schema auth, public to anon, authenticated;
grant execute on all functions in schema auth to anon, authenticated;
create publication supabase_realtime;
SQL
sed 's/__TOBIAS_EMAIL__/tobias@example.com/; s/__SARAH_EMAIL__/sarah@example.com/' supabase/schema.sql > "$DIR/schema.sql"
for i in 1 2; do   # zweimal: muss wiederholbar sein
  $PSQL -d t -f "$DIR/schema.sql" >/dev/null 2>"$DIR/schema.log" || { cat "$DIR/schema.log"; exit 1; }
done
echo "OK   Schema läuft (auch zweimal)"
$PSQL -d t -f tests/rls.sql 2>&1 | sed -n 's/^.*NOTICE:  //p; s/^.*ERROR:  //p'
