import json, urllib.request, concurrent.futures, sys, os, datetime
UA={'User-Agent':'Mozilla/5.0 (Linux; Android 14) Chrome/126 Mobile Safari/537.36','Accept':'application/json'}
def get(u):
    try:
        with urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=25) as r: return json.load(r)
    except Exception as e: return None
days=[(datetime.date(2026,10,9)-datetime.timedelta(days=i)).strftime('%Y%m%d') for i in range(int(sys.argv[1]))]
ids=[]
for d in days:
    j=get(f'https://www.fotmob.com/api/data/matches?date={d}&timezone=UTC')
    if not j: continue
    for L in j['leagues']:
        for m in L['matches']:
            st=m.get('status',{})
            if st.get('finished') and not st.get('cancelled'): ids.append((m['id'],L.get('name'),L.get('ccode')))
print('matchs terminés', len(ids), file=sys.stderr)
def stats_of(period):
    out={}
    for g in (period or {}).get('stats',[]):
        for s in g.get('stats',[]):
            v=s.get('stats')
            if isinstance(v,list) and len(v)==2 and s.get('key') not in out:
                try: out[s['key']]=[float(str(x).replace('%','')) for x in v]
                except: pass
    return out
def one(t):
    mid,league,cc=t
    d=get(f'https://www.fotmob.com/api/data/matchDetails?matchId={mid}')
    if not d: return None
    P=(d.get('content',{}).get('stats') or {}).get('Periods',{})
    fh,al=stats_of(P.get('FirstHalf')),stats_of(P.get('All'))
    if not fh or not al: return None
    ev=d.get('content',{}).get('matchFacts',{}).get('events',{}).get('events',[]) or []
    ht=next((e for e in ev if e.get('type')=='Half' and e.get('halfStrShort')=='HT'),None)
    teams=d['header']['teams']
    if ht is None: return None
    return {'id':mid,'league':league,'cc':cc,'home':teams[0]['name'],'away':teams[1]['name'],
            'ft':[teams[0].get('score'),teams[1].get('score')],'ht':[ht.get('homeScore'),ht.get('awayScore')],'fh':fh,'all':al}
rows=[]
with concurrent.futures.ThreadPoolExecutor(10) as ex:
    for r in ex.map(one, ids):
        if r: rows.append(r)
json.dump(rows, open(sys.argv[2],'w'))
print('avec stats 1MT', len(rows), file=sys.stderr)
