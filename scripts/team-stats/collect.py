#!/usr/bin/env python3
"""Compile les stats de CHAQUE match de la saison pour chaque équipe des 5 grands
championnats + Ligue des champions (toutes compétitions officielles, sans amicaux
ni sélections), via les endpoints publics FotMob (sans clé).

Sortie : data/team-stats/index.json + data/team-stats/teams/<teamId>.json
(un fichier par équipe : un enregistrement par match, vu de l'équipe, avec le match
entier + 1ère MT + 2e MT, stats « pour » / « contre »).

Incrémental : un match déjà présent dans le fichier d'une équipe n'est pas
re-téléchargé. Usage : python3 collect.py [--season-start 2026-07-01] [--limit-teams N]
"""
import argparse, json, os, re, sys, time, urllib.request
from datetime import datetime, timezone

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'data', 'team-stats')
BASE = 'https://www.fotmob.com/api/data'
LEAGUES = {47: 'Premier League', 87: 'LaLiga', 54: 'Bundesliga', 55: 'Serie A', 53: 'Ligue 1', 42: 'Champions League'}
UA = {'user-agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36'}
PERIODS = {'All': 'ft', 'FirstHalf': 'h1', 'SecondHalf': 'h2'}
_last = [0.0]


def get(path, tries=4):
    for i in range(tries):
        wait = 0.35 - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()
        try:
            req = urllib.request.Request(f'{BASE}/{path}', headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                print(f'  ! {path}: {e}', file=sys.stderr)
                return None
            time.sleep(2 * (i + 1))


def slug(title):
    return re.sub(r'[^a-z0-9]+', '_', title.lower()).strip('_')


def parse_val(v):
    """'437 (85%)' -> (437.0, 85.0) ; 12 -> (12.0, None) ; '2.33' -> (2.33, None)."""
    if v is None:
        return None, None
    if isinstance(v, (int, float)):
        return float(v), None
    m = re.match(r'\s*(-?[\d.]+)\s*(?:\((\d+)%\))?', str(v))
    if not m:
        return None, None
    return float(m.group(1)), (float(m.group(2)) if m.group(2) else None)


def flatten_period(block):
    out = {}
    # « Top stats » d'abord : possession, corners, grosses occasions et xG n'existent que là.
    groups = sorted(block.get('stats', []), key=lambda g: 0 if g.get('title') == 'Top stats' else 1)
    for grp in groups:
        for s in grp.get('stats', []):
            vals = s.get('stats')
            if not isinstance(vals, list) or len(vals) != 2 or vals[0] is None and vals[1] is None:
                continue
            a, pa = parse_val(vals[0])
            b, pb = parse_val(vals[1])
            if a is None or b is None:
                continue
            key = slug(s.get('title', ''))
            if key in out:
                continue  # même stat déjà prise (Top stats puis détail)
            out[key] = [a, b]
            if pa is not None and pb is not None:
                out[key + '_pct'] = [pa, pb]
    return out


def goals_of(d):
    """[(minute, 'home'|'away')] — buts réellement marqués par chaque côté."""
    ev = (d.get('header') or {}).get('events') or {}
    res = []
    for side in ('homeTeamGoals', 'awayTeamGoals'):
        for _, items in (ev.get(side) or {}).items():
            for g in items:
                if g.get('isPenaltyShootoutEvent'):
                    continue
                scorer = 'home' if side == 'homeTeamGoals' else 'away'
                if g.get('ownGoal'):
                    scorer = 'away' if scorer == 'home' else 'home'
                res.append((g.get('time') or 0, scorer))
    return sorted(res)


def match_record(d, team_id, meta):
    gen = d['general']
    home_id = int(gen['homeTeam']['id'])
    is_home = home_id == team_id
    mine, theirs = ('home', 'away') if is_home else ('away', 'home')
    opp = gen['awayTeam'] if is_home else gen['homeTeam']
    idx = 0 if is_home else 1
    periods = {}
    for p, short in PERIODS.items():
        block = (((d.get('content') or {}).get('stats') or {}).get('Periods') or {}).get(p)
        if not block:
            continue
        flat = flatten_period(block)
        periods[short] = {k: [v[idx], v[1 - idx]] for k, v in flat.items()}
    goals = goals_of(d)
    gf = sum(1 for _, s in goals if s == mine)
    ga = sum(1 for _, s in goals if s == theirs)
    hf = sum(1 for m, s in goals if s == mine and m <= 45)
    ha = sum(1 for m, s in goals if s == theirs and m <= 45)
    status = (d.get('header') or {}).get('status') or {}
    sc = re.match(r'\s*(\d+)\s*-\s*(\d+)', status.get('scoreStr') or '')
    if sc:  # le score officiel prime (prolongations/tirs au but exclus du comptage des buts ci-dessus)
        gf, ga = (int(sc.group(1)), int(sc.group(2))) if is_home else (int(sc.group(2)), int(sc.group(1)))
    return {
        'matchId': int(gen['matchId']),
        'date': gen.get('matchTimeUTCDate') or meta.get('date'),
        'competition': gen.get('leagueName') or meta.get('competition'),
        'round': gen.get('leagueRoundName') or gen.get('matchRound'),
        'home': is_home,
        'opponent': {'id': int(opp['id']), 'name': opp['name']},
        'goals': {'for': gf, 'against': ga},
        'halftime': {'for': hf, 'against': ha},
        'goalMinutes': {'for': [m for m, s in goals if s == mine], 'against': [m for m, s in goals if s == theirs]},
        'redCards': [status.get('numberOfHomeRedCards', 0), status.get('numberOfAwayRedCards', 0)][::1 if is_home else -1],
        'stats': periods,
    }


def load_team(tid):
    p = os.path.join(ROOT, 'teams', f'{tid}.json')
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season-start', default='2026-07-01')
    ap.add_argument('--limit-teams', type=int, default=0)
    args = ap.parse_args()
    os.makedirs(os.path.join(ROOT, 'teams'), exist_ok=True)

    # 1) équipes : tableaux des 5 championnats + Ligue des champions
    teams = {}
    for lid, lname in LEAGUES.items():
        d = get(f'leagues?id={lid}')
        if not d:
            continue
        tables = d.get('table') or []
        rows = []
        for t in tables:
            data = t.get('data') or {}
            tb = data.get('table')
            if isinstance(tb, dict):
                rows += tb.get('all', [])
            for sub in (data.get('tables') or []):
                rows += (sub.get('table') or {}).get('all', [])
        for r in rows:
            tid = int(r['id'])
            e = teams.setdefault(tid, {'id': tid, 'name': r['name'], 'shortName': r.get('shortName') or r['name'], 'leagues': []})
            if lname not in e['leagues']:
                e['leagues'].append(lname)
        print(f'{lname}: {len(rows)} équipes')
    ids = sorted(teams)
    if args.limit_teams:
        ids = ids[:args.limit_teams]
    print(f'{len(ids)} équipes au total')

    # 2) calendriers (toutes compétitions) : matchs terminés de la saison, hors amicaux
    wanted = {}  # matchId -> {team ids, meta}
    for n, tid in enumerate(ids, 1):
        d = get(f'teams?id={tid}')
        if not d:
            continue
        fx = (((d.get('fixtures') or {}).get('allFixtures') or {}).get('fixtures')) or []
        for m in fx:
            st = m.get('status') or {}
            tn = (m.get('tournament') or {}).get('name', '')
            if not st.get('finished') or st.get('cancelled') or 'friendl' in tn.lower():
                continue
            utc = st.get('utcTime', '')
            if utc[:10] < args.season_start:
                continue
            w = wanted.setdefault(int(m['id']), {'teams': set(), 'meta': {'date': utc, 'competition': tn}})
            w['teams'].add(tid)
        if n % 20 == 0:
            print(f'  calendriers {n}/{len(ids)} — {len(wanted)} matchs')
    print(f'{len(wanted)} matchs à couvrir')

    # 3) stats des matchs manquants
    store = {tid: (load_team(tid) or {'teamId': tid, 'name': teams[tid]['name'], 'matches': []}) for tid in ids}
    have = {tid: {m['matchId'] for m in store[tid]['matches']} for tid in ids}
    fetched = 0
    now_iso = datetime.now(timezone.utc).isoformat()
    for mid, w in sorted(wanted.items()):
        todo = [t for t in w['teams'] if mid not in have[t]]
        if not todo:
            continue
        d = get(f'matchDetails?matchId={mid}')
        if not d or not (d.get('header') or {}).get('status', {}).get('finished'):
            continue
        for tid in todo:
            rec = match_record(d, tid, w['meta'])
            if not rec['stats'].get('ft'):
                # Pas de stats détaillées : jamais inventées. Match récent → réessayé
                # la nuit suivante ; plus ancien → gardé avec le seul score/minutes des buts.
                age = (datetime.now(timezone.utc) - datetime.fromisoformat((rec['date'] or now_iso).replace('Z', '+00:00'))).days
                if age < 3:
                    continue
                rec['stats'] = {}
            store[tid]['matches'].append(rec)
            have[tid].add(mid)
        fetched += 1
        if fetched % 50 == 0:
            print(f'  matchs téléchargés : {fetched}')
    # 4) écriture
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    index = {'updatedAt': now, 'source': 'FotMob', 'seasonStart': args.season_start, 'teams': []}
    for tid in ids:
        ms = sorted(store[tid]['matches'], key=lambda m: m['date'] or '')
        store[tid].update({'name': teams[tid]['name'], 'shortName': teams[tid]['shortName'], 'leagues': teams[tid]['leagues'], 'updatedAt': now, 'matches': ms})
        with open(os.path.join(ROOT, 'teams', f'{tid}.json'), 'w') as f:
            json.dump(store[tid], f, separators=(',', ':'), ensure_ascii=False)
        index['teams'].append({'id': tid, 'name': teams[tid]['name'], 'shortName': teams[tid]['shortName'], 'leagues': teams[tid]['leagues'],
                               'matches': len(ms), 'lastMatch': ms[-1]['date'] if ms else None})
    with open(os.path.join(ROOT, 'index.json'), 'w') as f:
        json.dump(index, f, separators=(',', ':'), ensure_ascii=False)
    print(f'terminé : {fetched} matchs téléchargés, {sum(t["matches"] for t in index["teams"])} enregistrements équipe-match')


if __name__ == '__main__':
    main()
