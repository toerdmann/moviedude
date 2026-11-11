#!/usr/bin/env python3
"""MyMovies-Export (Collection.csv) -> data/shelf.json

Aufruf:  python3 -I scripts/import_mymovies.py <Collection.csv>

Regeln:
- Nur Filme und Dokus (Media Type Movie/Documentary) mit IMDb-ID; Serien, Boxsets und Bonus-Discs fallen raus.
- Sarahs Filme: Sammlungsnummern in SARAH_RANGE, Tag "sarah" oder IMDb-ID in SARAH_IMDB.
  Sie bekommen owner "sarah" und zählen nie als gesehen (Sarah pflegt MyMovies nicht selbst).
- Gibt eine kurze Zusammenfassung der Änderungen gegenüber der bisherigen shelf.json aus.
"""
import csv, json, os, sys

SARAH_RANGE = range(713, 746)          # 713–745: Sarahs Block im Regal
SARAH_IMDB = {'tt0274166'}             # Johnny English (steht woanders, gehört aber Sarah)
MEDIA = {'Movie', 'Documentary'}
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'shelf.json')


def convert(path):
    out = []
    with open(path, encoding='utf-8-sig', newline='') as fh:
        for r in csv.DictReader(fh):
            if r.get('Media Type') not in MEDIA or not r.get('IMDB Id'):
                continue
            try:
                num = int(float(r.get('Collection Number') or 0))
            except ValueError:
                num = 0
            tags = (r.get('Tags') or '').lower()
            sarah = num in SARAH_RANGE or 'sarah' in tags or r['IMDB Id'] in SARAH_IMDB
            year = r.get('Production Year')
            d = {
                'imdb': r['IMDB Id'],
                'title': r['Title'],
                'orig': r.get('Original Title') or r['Title'],
                'year': int(float(year)) if year else None,
                'disc': r['Disc Type'],
                'seen': r.get('Watched') == 'yes' and not sarah,
            }
            if sarah:
                d['owner'] = 'sarah'
            out.append(d)
    return out


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    new = convert(sys.argv[1])
    try:
        old = json.load(open(OUT, encoding='utf-8'))
    except FileNotFoundError:
        old = []
    key = lambda x: (x['imdb'], x['disc'])
    o, n = {key(x): x for x in old}, {key(x): x for x in new}
    added = [n[k] for k in n if k not in o]
    removed = [o[k] for k in o if k not in n]
    changed = [n[k] for k in n if k in o and n[k] != o[k]]
    fmt = lambda xs: '; '.join(f"{x['title']} ({x['year']}, {x['disc']})" for x in xs) or '-'
    print(f'{len(new)} Filme im Regal, davon {sum(1 for x in new if x.get("owner"))} von Sarah')
    print('neu:', fmt(added))
    print('entfernt:', fmt(removed))
    print('geändert:', fmt(changed))
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(new, fh, ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main()
