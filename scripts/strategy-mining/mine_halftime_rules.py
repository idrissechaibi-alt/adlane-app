import json, math, itertools
rows=json.load(open('rows.json'))
def s2(r,k,idx=None):
    v=r['fh'].get(k); 
    return None if v is None else (v[0]+v[1] if idx is None else v[idx])
def full(r,k):
    v=r['all'].get(k); return None if v is None else v[0]+v[1]
data=[]
for r in rows:
    try:
        htg=r['ht'][0]+r['ht'][1]; ftg=r['ft'][0]+r['ft'][1]
    except: continue
    if ftg<htg: continue
    f={
     'buts_mt':htg,'ecart_mt':abs(r['ht'][0]-r['ht'][1]),
     'tirs':s2(r,'total_shots'),'tirs_cadres':s2(r,'ShotsOnTarget'),'grosses_occasions':s2(r,'big_chance'),
     'tirs_surface':s2(r,'shots_inside_box'),'corners':s2(r,'corners'),
     'cartons':(s2(r,'yellow_cards') or 0)+(s2(r,'red_cards') or 0),'rouges':s2(r,'red_cards'),
     'fautes':s2(r,'fouls'),'touches_surface':s2(r,'touches_opp_box'),
     'desequilibre_possession':abs(r['fh']['BallPossesion'][0]-50) if 'BallPossesion' in r['fh'] else None,
     'xg_mt':s2(r,'expected_goals'),
     'equipe_a_zero': 1 if min(r['ht'])==0 else 0,
    }
    c1,cf=s2(r,'corners'),full(r,'corners'); k1=f['cartons']; kf=(full(r,'yellow_cards') or 0)+(full(r,'red_cards') or 0)
    fo1,fof=s2(r,'fouls'),full(r,'fouls')
    t={
     'but_2e_mt': ftg-htg>=1, 'deux_buts_2e_mt': ftg-htg>=2, 'zero_but_2e_mt': ftg==htg,
     'btts_oui': r['ft'][0]>0 and r['ft'][1]>0,
     'corners_2e_mt>=5': cf is not None and c1 is not None and cf-c1>=5,
     'corners_2e_mt>=6': cf is not None and c1 is not None and cf-c1>=6,
     'corners_2e_mt<=3': cf is not None and c1 is not None and cf-c1<=3,
     'cartons_2e_mt>=3': kf-k1>=3, 'cartons_2e_mt>=2': kf-k1>=2, 'cartons_2e_mt<=1': kf-k1<=1,
     'fautes_2e_mt>=12': fof is not None and fo1 is not None and fof-fo1>=12,
     'corners_2e_mt>=4': cf is not None and c1 is not None and cf-c1>=4,
     'buts_2e_mt<=1': ftg-htg<=1,
    }
    data.append((f,t))
print('matchs', len(data))
N=len(data); test_cut=N//3  # les plus récents = test
FEATS=['buts_mt','ecart_mt','tirs','tirs_cadres','corners','cartons','fautes','desequilibre_possession']
def thresholds(k):
    vals=sorted(v for f,_ in data if (v:=f[k]) is not None)
    if not vals: return []
    qs=sorted(set(vals[int(len(vals)*q)] for q in (0.15,0.25,0.4,0.6,0.75,0.85)))
    return qs
TH={k:thresholds(k) for k in FEATS}
def conds():
    out=[]
    for k in FEATS:
        for th in TH[k]:
            out.append((f'{k}>={th:g}', lambda f,k=k,th=th: f[k] is not None and f[k]>=th))
            out.append((f'{k}<={th:g}', lambda f,k=k,th=th: f[k] is not None and f[k]<=th))
    return out
C=conds()
def wilson(p,n,z=1.64):
    if n==0: return 0
    d=1+z*z/n; c=p+z*z/(2*n); a=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n)); return (c-a)/d
results={}
for tk in data[0][1]:
    base=sum(t[tk] for _,t in data)/N
    best=[]
    singles=[(n,fn) for n,fn in C]
    combos=singles+[ (a[0]+' ET '+b[0], (lambda f,fa=a[1],fb=b[1]: fa(f) and fb(f))) for a,b in itertools.combinations(singles,2) if a[0].split('>=')[0].split('<=')[0]!=b[0].split('>=')[0].split('<=')[0]]
    for name,fn in combos:
        tr=[t[tk] for f,t in data[test_cut:] if fn(f)]; te=[t[tk] for f,t in data[:test_cut] if fn(f)]
        if len(tr)<50 or len(te)<20: continue
        p=sum(tr)/len(tr); lb=wilson(p,len(tr)); pt=sum(te)/len(te)
        if p-base<0.08: continue
        best.append((lb,name,p,len(tr),pt,len(te)))
    best.sort(reverse=True)
    # garder les règles qui tiennent sur la période de test (écart < 8 pts)
    keep=[b for b in best if b[4]>=b[2]-0.08][:4]
    results[tk]={'base':base,'rules':keep}
    print(f'\n=== {tk} (taux de base {base*100:.0f}%)')
    for lb,name,p,n,pt,nt in keep: print(f'  {name}: {p*100:.0f}% sur {n} (test {pt*100:.0f}% sur {nt})')
json.dump({k:{'base':v['base'],'rules':[{'rule':r[1],'train':r[2],'n':r[3],'test':r[4],'ntest':r[5]} for r in v['rules']]} for k,v in results.items()}, open('rules_live.json','w'), ensure_ascii=False, indent=1)
