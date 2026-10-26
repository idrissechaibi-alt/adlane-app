#!/usr/bin/env python3
"""Assemble les fichiers de recherche (dossier de travail) en données embarquées dans l'app.
Usage : python3 scripts/coaches/build-knowledge.py <dossier_recherche>   (contient out/*.json et clubs.json)
Les fiches « wave2-*.json » remplacent celles de la vague 1 quand leur confiance est meilleure ou égale."""
import json, sys, glob, os, re
root = sys.argv[1]
out = os.path.join(root, 'out')
dst = os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'core', 'coaches', 'data')
os.makedirs(dst, exist_ok=True)
rank = {'haute': 3, 'moyenne': 2, 'faible': 1, None: 0}
ref = {c['club']: c for c in json.load(open(os.path.join(root, 'clubs.json')))}

def load(p):
    try: return json.load(open(p))
    except Exception: return None

clubs = {}
for f in sorted(glob.glob(os.path.join(out, 'clubs-*.json'))):
    for c in load(f) or []:
        clubs[c['club']] = c
for f in sorted(glob.glob(os.path.join(out, 'wave2-*.json'))):
    d = load(f)
    if isinstance(d, list):
        for c in d:
            if isinstance(c, dict) and c.get('club') and ('style_fr' in c or 'formation_main' in c):
                old = clubs.get(c['club'])
                if not old or rank.get(c.get('confidence'), 0) >= rank.get(old.get('confidence'), 0):
                    clubs[c['club']] = c
unknown = [k for k in clubs if k not in ref]
missing = [k for k in ref if k not in clubs]
leagues = {}
for f in sorted(glob.glob(os.path.join(out, 'league-*.json'))):
    d = load(f)
    if d: leagues[d.get('league', os.path.basename(f))] = d
facts = []
for name in ('facts-tactique', 'facts-evenements', 'facts-rapports', 'wave2-facts'):
    for x in load(os.path.join(out, name + '.json')) or []:
        if isinstance(x, dict) and x.get('fact_fr'):
            x['origin'] = name
            facts.append(x)
for i, x in enumerate(facts, 1): x['id'] = f'F{i}'
gl = load(os.path.join(out, 'glossary.json')) or []
res = load(os.path.join(out, 'open-resources.json')) or []
metrics = load(os.path.join(out, 'wave2-metrics.json'))
def dump(name, obj):
    with open(os.path.join(dst, name), 'w', encoding='utf-8') as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(',', ':'))
dump('clubs.json', sorted(clubs.values(), key=lambda c: (ref.get(c['club'], {}).get('league', ''), c['club'])))
dump('leagues.json', leagues)
dump('facts.json', facts)
dump('glossary.json', gl)
dump('resources.json', res)
if metrics: dump('metrics.json', metrics)
print('clubs', len(clubs), 'inconnus', unknown, 'manquants', missing)
print('ligues', list(leagues), 'faits', len(facts), 'glossaire', len(gl), 'ressources', len(res))
