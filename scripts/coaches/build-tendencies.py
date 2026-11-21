#!/usr/bin/env python3
"""Assemble les fiches « tendances d'équipe » (inbox/wave8-equipes-*.json) en donnée embarquée
src/core/coaches/data/team-tendencies.json. Usage : python3 scripts/coaches/build-tendencies.py"""
import json, glob, os, sys
here = os.path.dirname(__file__)
dst = os.path.join(here, '..', '..', 'src', 'core', 'coaches', 'data', 'team-tendencies.json')
clubs = {c['club'] for c in json.load(open(os.path.join(os.path.dirname(dst), 'clubs.json')))}
TAGS = {'possession', 'press', 'line', 'counter', 'setPieces', 'crosses', 'solid', 'tempo'}
ENUMS = {'leading': {'bloc_bas', 'continue', 'gere'}, 'trailing': {'pousse', 's_effondre', 'jeu_direct', 'inchange'},
         'start': {'rapide', 'fragile', 'lent'}, 'start2h': {'mou', 'fragile'}, 'late': {'baisse', 'monte'},
         'vsPress': {'bien', 'souffre'}, 'vsBlock': {'bien', 'souffre'}}
out, bad = {}, []
CONF_RANK = {'faible': 0, 'moyenne': 1, 'haute': 2}
for f in sorted(glob.glob(os.path.join(here, 'inbox', 'wave8-equipes-*.json'))):
    for e in json.load(open(f)):
        if 'club' not in e: continue
        c = e['club']
        if c not in clubs: bad.append(('club inconnu', c)); continue
        if e.get('conf') not in ('haute', 'moyenne', 'faible'): bad.append(('conf', c)); continue
        t = {k: round(float(v), 2) for k, v in (e.get('tags') or {}).items() if k in TAGS and isinstance(v, (int, float)) and 0 <= v <= 1}
        r = {'club': c, 'conf': e['conf'], 'sources': e.get('sources', []), 'tags': t}
        if e.get('shape'): r['shape'] = e['shape']
        for k, allowed in ENUMS.items():
            if e.get(k) in allowed: r[k] = e[k]
            elif e.get(k): bad.append((k, c))
        r['notes'] = e.get('notes', '')
        r['patterns'] = e.get('patterns', [])
        if c in out: bad.append(('doublon', c))
        out[c] = r
# Vague 9 (vidéos supplémentaires) : correctifs fusionnés dans les fiches existantes.
# sources réunies ; indicateurs chiffrés fusionnés (moyenne si les deux existent) ; réactions remplacées si renseignées ;
# confiance relevée seulement ; notes et schémas à surveiller complétés (bornés).
patched = 0
for f in sorted(glob.glob(os.path.join(here, 'inbox', 'wave9-equipes-*.json'))):
    for e in json.load(open(f)):
        c = e['club']
        if c not in out:
            bad.append(('correctif sans fiche', c)); continue
        r = out[c]
        r['sources'] = list(dict.fromkeys(r['sources'] + e.get('sources', [])))
        for k, v in (e.get('tags') or {}).items():
            if k in TAGS and isinstance(v, (int, float)) and 0 <= v <= 1:
                r['tags'][k] = round((r['tags'][k] + v) / 2, 2) if k in r['tags'] else round(float(v), 2)
        for k, allowed in ENUMS.items():
            if e.get(k) in allowed: r[k] = e[k]
            elif e.get(k): bad.append((k, c))
        if e.get('shape') and not r.get('shape'): r['shape'] = e['shape']
        if CONF_RANK.get(e.get('conf'), -1) > CONF_RANK[r['conf']]: r['conf'] = e['conf']
        if e.get('notes'): r['notes'] = (r['notes'] + ' ' + e['notes']).strip()
        r['patterns'] = list(dict.fromkeys(r['patterns'] + e.get('patterns', [])))[:6]
        patched += 1
missing = sorted(clubs - set(out))
json.dump(sorted(out.values(), key=lambda x: x['club']), open(dst, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(out), 'équipes,', patched, 'correctifs ;', 'manquantes :', missing, ';', 'anomalies :', bad)
print(sum(1 for x in out.values() if x['tags']), 'avec au moins un indicateur ;', sum(1 for x in out.values() if x['conf'] == 'moyenne'), 'de confiance moyenne')
