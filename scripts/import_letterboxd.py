#!/usr/bin/env python3
"""Letterboxd-Export (ZIP) -> data/watchlist.json, data/watched.json, data/ratings.json

Aufruf:  python3 -I scripts/import_letterboxd.py <letterboxd-export.zip>

Die App ordnet die Einträge über Titel + Jahr TMDB zu (Schlüssel = Letterboxd-URI).
Gibt aus, was seit dem letzten Import neu gesehen, neu auf der Watchlist und neu bewertet ist.
"""
import csv, io, json, os, sys, zipfile

DATA = os.path.join(os.path.dirname(__file__), '..', 'data')


def read_csv(z, name):
    with z.open(name) as fh:
        return list(csv.DictReader(io.TextIOWrapper(fh, encoding='utf-8-sig')))


def entries(rows, added=False):
    out = []
    for r in rows:
        d = {'title': r['Name'], 'year': int(r['Year']) if r['Year'] else None, 'lb': r['Letterboxd URI']}
        if added:
            d['added'] = r['Date']
        out.append(d)
    return out


def load(name):
    try:
        return json.load(open(os.path.join(DATA, name), encoding='utf-8'))
    except FileNotFoundError:
        return []


def save(name, data):
    with open(os.path.join(DATA, name), 'w', encoding='utf-8') as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with zipfile.ZipFile(sys.argv[1]) as z:
        watchlist = entries(read_csv(z, 'watchlist.csv'), added=True)
        watched_rows = read_csv(z, 'watched.csv')
        watched = entries(watched_rows)
        rating_rows = read_csv(z, 'ratings.csv')
    ratings = [{'lb': r['Letterboxd URI'], 'r': float(r['Rating'])} for r in rating_rows if r['Rating']]

    names = {x['lb']: f"{x['title']} ({x['year']})" for x in watched + watchlist}
    for r in rating_rows:
        names.setdefault(r['Letterboxd URI'], f"{r['Name']} ({r['Year']})")
    old_wl = {x['lb'] for x in load('watchlist.json')}
    old_w = {x['lb'] for x in load('watched.json')}
    old_r = {x['lb'] for x in load('ratings.json')}
    new_wl = {x['lb'] for x in watchlist}
    fmt = lambda xs: '; '.join(xs) or '-'
    print(f'{len(watched)} gesehen, {len(watchlist)} auf der Watchlist, {len(ratings)} bewertet')
    print('neu gesehen:', fmt([names[x['lb']] for x in watched if x['lb'] not in old_w]))
    print('neu auf der Watchlist:', fmt([names[x['lb']] for x in watchlist if x['lb'] not in old_wl]))
    print('von der Watchlist runter:', fmt([f"{x['title']} ({x['year']})" for x in load('watchlist.json') if x['lb'] not in new_wl]))
    print('neu bewertet:', fmt([f"{names.get(x['lb'], x['lb'])} {x['r']:g}" for x in ratings if x['lb'] not in old_r]))

    save('watchlist.json', watchlist)
    save('watched.json', watched)
    save('ratings.json', ratings)


if __name__ == '__main__':
    main()
