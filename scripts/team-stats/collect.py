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



# ---------------------------------------------------------------------------
# Analyse par équipe : calculée (jamais devinée) à partir des matchs enregistrés,
# recalculée à chaque passage. Sert de résumé des raisons et performances observées.
ANALYSIS_VERSION = 2


def _avg(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _r(x, n=2):
    return None if x is None else round(x, n)


def _stat(m, period, key):
    v = (m.get('stats') or {}).get(period, {}).get(key)
    return v if v else None


def _cards(m, period):
    y, r = _stat(m, period, 'yellow_cards'), _stat(m, period, 'red_cards')
    if not y:
        return None
    return [y[0] + (r[0] if r else 0), y[1] + (r[1] if r else 0)]


def _result(m):
    f, a = m['goals']['for'], m['goals']['against']
    return 'V' if f > a else 'N' if f == a else 'D'


def match_note(m):
    """Résumé d'un match : ce qui explique le résultat (seulement ce que les stats montrent)."""
    f, a = m['goals']['for'], m['goals']['against']
    res = _result(m)
    parts = []
    xg = _stat(m, 'ft', 'expected_goals_xg')
    if xg:
        d = xg[0] - xg[1]
        if res != 'V' and d >= 1.0:
            parts.append(f"{'défaite' if res == 'D' else 'nul'} malgré une nette supériorité (xG {xg[0]:.1f}-{xg[1]:.1f})")
        elif res == 'V' and d <= -1.0:
            parts.append(f"victoire contre le cours du jeu (xG {xg[0]:.1f}-{xg[1]:.1f})")
        elif abs(d) < 0.5:
            parts.append(f"match équilibré (xG {xg[0]:.1f}-{xg[1]:.1f})")
        elif d > 0:
            parts.append(f"domination (xG {xg[0]:.1f}-{xg[1]:.1f})")
        else:
            parts.append(f"dominée (xG {xg[0]:.1f}-{xg[1]:.1f})")
        if f - xg[0] >= 1.5:
            parts.append(f"très efficace devant le but ({f} buts pour {xg[0]:.1f} xG)")
        elif f - xg[0] <= -1.5:
            parts.append(f"gâchis offensif ({f} but{'s' if f > 1 else ''} pour {xg[0]:.1f} xG)")
        if a - xg[1] >= 1.5:
            parts.append("adversaire très réaliste")
    bcm = _stat(m, 'ft', 'big_chances_missed')
    if bcm and bcm[0] >= 3:
        parts.append(f"{int(bcm[0])} grosses occasions manquées")
    co = _stat(m, 'ft', 'corners')
    if co and abs(co[0] - co[1]) >= 5:
        parts.append(f"corners {int(co[0])}-{int(co[1])}")
    cd = _cards(m, 'ft')
    if cd and cd[0] + cd[1] >= 6:
        parts.append(f"match tendu ({int(cd[0] + cd[1])} cartons)")
    if m.get('redCards') and m['redCards'][0]:
        parts.append("carton rouge contre elle")
    elif m.get('redCards') and m['redCards'][1]:
        parts.append("adversaire réduit à dix")
    ht = m['halftime']
    if ht['for'] < ht['against'] and f > a:
        parts.append("retournement après la pause")
    elif ht['for'] > ht['against'] and f < a:
        parts.append("avance perdue après la pause")
    late = [x for x in m['goalMinutes']['against'] if x >= 80]
    if late:
        parts.append("but encaissé dans le dernier quart d'heure")
    head = f"{res} {f}-{a}"
    return head + (' : ' + ' ; '.join(parts[:4]) if parts else '')


def build_analysis(matches):
    n = len(matches)
    if not n:
        return {'version': ANALYSIS_VERSION, 'matches': 0, 'insights': []}
    ms = sorted(matches, key=lambda m: m['date'] or '')
    last5 = ms[-5:]
    wdl = lambda lst: {'V': sum(1 for m in lst if _result(m) == 'V'), 'N': sum(1 for m in lst if _result(m) == 'N'), 'D': sum(1 for m in lst if _result(m) == 'D')}
    tot = [m['goals']['for'] + m['goals']['against'] for m in ms]
    rates = {
        'win': _r(sum(1 for m in ms if _result(m) == 'V') / n),
        'over15': _r(sum(1 for t in tot if t >= 2) / n),
        'over25': _r(sum(1 for t in tot if t >= 3) / n),
        'over35': _r(sum(1 for t in tot if t >= 4) / n),
        'btts': _r(sum(1 for m in ms if m['goals']['for'] > 0 and m['goals']['against'] > 0) / n),
        'cleanSheet': _r(sum(1 for m in ms if m['goals']['against'] == 0) / n),
        'failedToScore': _r(sum(1 for m in ms if m['goals']['for'] == 0) / n),
    }

    def venue(flag):
        v = [m for m in ms if m['home'] == flag]
        if not v:
            return None
        pts = sum(3 if _result(m) == 'V' else 1 if _result(m) == 'N' else 0 for m in v)
        return {'matches': len(v), 'pointsPerGame': _r(pts / len(v)), 'goalsFor': _r(_avg([m['goals']['for'] for m in v])), 'goalsAgainst': _r(_avg([m['goals']['against'] for m in v]))}

    # Timing des buts
    gf = [x for m in ms for x in m['goalMinutes']['for']]
    ga = [x for m in ms for x in m['goalMinutes']['against']]
    buckets = ['0-15', '16-30', '31-45', '46-60', '61-75', '76-90+']

    def bucket_counts(lst):
        edges = [15, 30, 45, 60, 75, 10**6]
        out = [0] * 6
        for x in lst:
            for i, e in enumerate(edges):
                if x <= e:
                    out[i] += 1
                    break
        return dict(zip(buckets, out))
    timing = {'for': bucket_counts(gf), 'against': bucket_counts(ga),
              'secondHalfShareFor': _r(sum(1 for x in gf if x > 45) / len(gf)) if gf else None,
              'secondHalfShareAgainst': _r(sum(1 for x in ga if x > 45) / len(ga)) if ga else None,
              'lateShareAgainst': _r(sum(1 for x in ga if x >= 76) / len(ga)) if ga else None}

    # Stats moyennes (matchs avec stats détaillées)
    withs = [m for m in ms if (m.get('stats') or {}).get('ft')]
    def pair_avg(period, key, f=None):
        vals = [(_stat(m, period, key) if f is None else f(m, period)) for m in withs]
        vals = [v for v in vals if v]
        if not vals:
            return None
        return [_r(_avg([v[0] for v in vals])), _r(_avg([v[1] for v in vals]))]
    averages = {k: pair_avg('ft', k) for k in ['ball_possession', 'expected_goals_xg', 'xg_on_target_xgot', 'total_shots', 'shots_on_target', 'big_chances', 'big_chances_missed', 'corners', 'fouls_committed', 'accurate_crosses', 'accurate_long_balls', 'tackles', 'interceptions', 'keeper_saves', 'offsides']}
    averages['cards'] = pair_avg('ft', None, _cards)
    averages['corners_1h'] = pair_avg('h1', 'corners')
    averages['cards_1h'] = pair_avg('h1', None, _cards)
    averages['fouls_1h'] = pair_avg('h1', 'fouls_committed')
    averages = {k: v for k, v in averages.items() if v}

    # Fréquence des lignes sur le TOTAL du match (équipe + adversaire)
    def total_of(m, period, key=None, f=None):
        v = f(m, period) if f else _stat(m, period, key)
        return v[0] + v[1] if v else None
    def line_rates(period, key, lines, f=None):
        vals = [total_of(m, period, key, f) for m in withs]
        vals = [v for v in vals if v is not None]
        if len(vals) < 4:
            return None
        return {str(l): {'over': sum(1 for v in vals if v > l), 'of': len(vals)} for l in lines}
    goals_1h = [m['halftime']['for'] + m['halftime']['against'] for m in ms]
    lines = {
        'goals_ft': {str(l): {'over': sum(1 for t in tot if t > l), 'of': n} for l in (1.5, 2.5, 3.5)},
        'goals_1h': {str(l): {'over': sum(1 for t in goals_1h if t > l), 'of': n} for l in (0.5, 1.5)},
        'corners_ft': line_rates('ft', 'corners', (8.5, 9.5, 10.5, 11.5)),
        'corners_1h': line_rates('h1', 'corners', (3.5, 4.5, 5.5)),
        'cards_ft': line_rates('ft', None, (3.5, 4.5, 5.5), _cards),
        'cards_1h': line_rates('h1', None, (1.5, 2.5), _cards),
        'fouls_ft': line_rates('ft', 'fouls_committed', (21.5, 24.5, 27.5)),
    }
    lines = {k: v for k, v in lines.items() if v}

    # Efficacité : buts réels − xG
    xg_pairs = [(m['goals']['for'], m['goals']['against'], _stat(m, 'ft', 'expected_goals_xg')) for m in withs]
    xg_pairs = [p for p in xg_pairs if p[2]]
    finishing = _r(_avg([p[0] - p[2][0] for p in xg_pairs])) if xg_pairs else None
    defending = _r(_avg([p[2][1] - p[1] for p in xg_pairs])) if xg_pairs else None  # >0 = encaisse moins que prévu

    pts = lambda lst: sum(3 if _result(m) == 'V' else 1 if _result(m) == 'N' else 0 for m in lst)
    form5 = ''.join(_result(m) for m in last5)
    ppg_season, ppg_last5 = pts(ms) / n, pts(last5) / len(last5)
    home, away = venue(True), venue(False)

    ins = []
    ins.append(f"Forme sur les {len(last5)} derniers matchs : {form5} ({pts(last5)} pts), {sum(m['goals']['for'] for m in last5)} buts marqués, {sum(m['goals']['against'] for m in last5)} encaissés.")
    if len(ms) >= 8 and abs(ppg_last5 - ppg_season) >= 0.8:
        ins.append(f"Dynamique {'en hausse' if ppg_last5 > ppg_season else 'en baisse'} : {ppg_last5:.1f} pt/match sur les 5 derniers contre {ppg_season:.1f} sur la saison.")
    if home and away and home['matches'] >= 3 and away['matches'] >= 3 and abs(home['pointsPerGame'] - away['pointsPerGame']) >= 1.0:
        better = 'à domicile' if home['pointsPerGame'] > away['pointsPerGame'] else "à l'extérieur"
        ins.append(f"Nettement plus performante {better} ({home['pointsPerGame']} pt/match à domicile, {away['pointsPerGame']} à l'extérieur).")
    if timing['secondHalfShareFor'] is not None and len(gf) >= 6:
        s2 = timing['secondHalfShareFor']
        if s2 >= 0.62:
            ins.append(f"Marque surtout après la pause ({round(s2 * 100)} % de ses buts en 2e mi-temps).")
        elif s2 <= 0.38:
            ins.append(f"Marque surtout avant la pause ({round((1 - s2) * 100)} % de ses buts en 1ère mi-temps).")
    if timing['lateShareAgainst'] is not None and len(ga) >= 5 and timing['lateShareAgainst'] >= 0.3:
        ins.append(f"Concède souvent tard : {round(timing['lateShareAgainst'] * 100)} % de ses buts encaissés après la 75e minute.")
    if finishing is not None and len(xg_pairs) >= 5:
        if finishing >= 0.4:
            ins.append(f"Surperforme son xG ({finishing:+.1f} but/match) : efficacité probablement difficile à tenir.")
        elif finishing <= -0.4:
            ins.append(f"Sous-performe son xG ({finishing:+.1f} but/match) : crée plus qu'elle ne marque, rebond possible.")
    if rates['btts'] >= 0.65 and n >= 6:
        ins.append(f"Les deux équipes marquent dans {round(rates['btts'] * 100)} % de ses matchs.")
    elif rates['btts'] <= 0.35 and n >= 6:
        ins.append(f"Les deux équipes marquent dans seulement {round(rates['btts'] * 100)} % de ses matchs.")
    if rates['over25'] >= 0.65 and n >= 6:
        ins.append(f"Plus de 2.5 buts dans {round(rates['over25'] * 100)} % de ses matchs.")
    elif rates['over25'] <= 0.35 and n >= 6:
        ins.append(f"Moins de 2.5 buts dans {round((1 - rates['over25']) * 100)} % de ses matchs.")
    if rates['cleanSheet'] >= 0.4 and n >= 6:
        ins.append(f"Garde sa cage inviolée dans {round(rates['cleanSheet'] * 100)} % de ses matchs.")
    if rates['failedToScore'] >= 0.3 and n >= 6:
        ins.append(f"Ne marque pas dans {round(rates['failedToScore'] * 100)} % de ses matchs.")
    if 'corners' in averages and averages['corners'][0] >= 6.0:
        ins.append(f"Équipe à corners : {averages['corners'][0]} par match ({averages['corners'][1]} concédés).")
    if 'cards' in averages and averages['cards'][0] >= 2.4:
        ins.append(f"Équipe à cartons : {averages['cards'][0]} par match.")
    if 'fouls_committed' in averages and averages['fouls_committed'][0] >= 14:
        ins.append(f"Joue dur : {averages['fouls_committed'][0]} fautes par match.")
    if 'ball_possession' in averages and averages['ball_possession'][0] >= 57:
        ins.append(f"Style de possession ({averages['ball_possession'][0]} %).")
    elif 'ball_possession' in averages and averages['ball_possession'][0] <= 43:
        ins.append(f"Style de contre ({averages['ball_possession'][0]} % de possession).")
    # Lignes très régulières (>= 75 % et au moins 6 matchs)
    labels = {'goals_ft': 'buts', 'goals_1h': 'buts en 1ère MT', 'corners_ft': 'corners', 'corners_1h': 'corners en 1ère MT', 'cards_ft': 'cartons', 'cards_1h': 'cartons en 1ère MT', 'fouls_ft': 'fautes'}
    for key, lns in lines.items():
        # Une seule ligne « Plus de » (la plus haute encore régulière) et une seule « Moins de »
        # (la plus basse encore régulière) par marché : le reste serait redondant.
        over_ok = [(float(l), v) for l, v in lns.items() if v['of'] >= 6 and v['over'] / v['of'] >= 0.75]
        under_ok = [(float(l), v) for l, v in lns.items() if v['of'] >= 6 and v['over'] / v['of'] <= 0.25]
        if over_ok:
            l, v = max(over_ok, key=lambda x: x[0])
            ins.append(f"Plus de {l:g} {labels[key]} dans {v['over']} de ses {v['of']} matchs (total des deux équipes).")
        if under_ok:
            l, v = min(under_ok, key=lambda x: x[0])
            ins.append(f"Moins de {l:g} {labels[key]} dans {v['of'] - v['over']} de ses {v['of']} matchs (total des deux équipes).")

    return {
        'version': ANALYSIS_VERSION,
        'matches': n,
        'matchesWithStats': len(withs),
        'form': {'last5': form5, 'pointsLast5': pts(last5), 'pointsPerGameLast5': _r(ppg_last5), 'pointsPerGameSeason': _r(ppg_season), 'record': wdl(ms)},
        'home': home, 'away': away,
        'rates': rates,
        'goalTiming': timing,
        'averages': averages,
        'lineRates': lines,
        'finishing': {'goalsMinusXgPerMatch': finishing, 'xgAgainstMinusGoalsAgainstPerMatch': defending},
        'insights': ins,
        'recent': [{'date': (m['date'] or '')[:10], 'opponent': m['opponent']['name'], 'home': m['home'], 'competition': m['competition'], 'note': m.get('note') or match_note(m)} for m in last5],
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
    # 4) écriture : notes de match + analyse recalculées ; un fichier inchangé n'est pas réécrit
    now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    prev_index = None
    try:
        with open(os.path.join(ROOT, 'index.json')) as f:
            prev_index = json.load(f)
    except Exception:  # noqa: BLE001
        prev_index = None
    prev_by_id = {t['id']: t for t in (prev_index or {}).get('teams', [])}
    index = {'updatedAt': (prev_index or {}).get('updatedAt', now), 'source': 'FotMob', 'seasonStart': args.season_start, 'teams': []}
    changed_any = False
    for tid in ids:
        ms = sorted(store[tid]['matches'], key=lambda m: m['date'] or '')
        for m in ms:
            m['note'] = match_note(m)
        analysis = build_analysis(ms)
        previous = prev_by_id.get(tid)
        changed = (not previous or previous.get('matches') != len(ms) or previous.get('analysisVersion') != ANALYSIS_VERSION
                   or previous.get('lastMatch') != (ms[-1]['date'] if ms else None))
        store[tid].update({'name': teams[tid]['name'], 'shortName': teams[tid]['shortName'], 'leagues': teams[tid]['leagues'],
                           'updatedAt': now if changed else (previous or {}).get('updatedAt', now), 'analysis': analysis, 'matches': ms})
        if changed:
            changed_any = True
            with open(os.path.join(ROOT, 'teams', f'{tid}.json'), 'w') as f:
                json.dump(store[tid], f, separators=(',', ':'), ensure_ascii=False)
        index['teams'].append({'id': tid, 'name': teams[tid]['name'], 'shortName': teams[tid]['shortName'], 'leagues': teams[tid]['leagues'],
                               'matches': len(ms), 'lastMatch': ms[-1]['date'] if ms else None, 'analysisVersion': ANALYSIS_VERSION,
                               'updatedAt': store[tid]['updatedAt']})
    if changed_any or not prev_index:
        index['updatedAt'] = now
        with open(os.path.join(ROOT, 'index.json'), 'w') as f:
            json.dump(index, f, separators=(',', ':'), ensure_ascii=False)
    print(f'terminé : {fetched} matchs téléchargés, {sum(t["matches"] for t in index["teams"])} enregistrements équipe-match')


if __name__ == '__main__':
    main()
