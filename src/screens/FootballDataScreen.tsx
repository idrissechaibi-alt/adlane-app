// Écran « Données Foot » : ce que l'app sait des équipes, des classements et de ses sources.
// Trois volets compacts, données gratuites uniquement :
//  - Équipes : fiche par équipe (forme, domicile / extérieur, moyennes pour / contre, minutes des buts, joueurs, constats) ;
//  - Classements : 5 grands championnats + Ligue des champions (ESPN), un appui ouvre la fiche de l'équipe ;
//  - Sources : état des 6 sources du direct, du fichier des équipes et des classements.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';

import { LEAGUES, LeagueDef, Standings, TeamIndexEntry, TeamIndexFile, TeamSheet, findIndexTeam, getStandings, getTeamIndex, getTeamSheet } from '../core/footballData';
import { getHubStatus } from '../api/footballDataAPIs/liveDataHub';

const C = {
  bg: '#0f172a',
  card: '#151f33',
  line: '#24324a',
  ink: '#e2e8f0',
  ink2: '#94a3b8',
  muted: '#64748b',
  accent: '#3987e5',
  for: '#3987e5',
  against: '#d95926',
  good: '#22c55e',
  warn: '#f59e0b',
  bad: '#ef4444',
};

type Tab = 'teams' | 'standings' | 'sources';

const AVG_ROWS: Array<[string, string, number]> = [
  ['expected_goals_xg', 'xG', 2],
  ['total_shots', 'Tirs', 1],
  ['shots_on_target', 'Tirs cadrés', 1],
  ['big_chances', 'Grosses occasions', 1],
  ['corners', 'Corners', 1],
  ['fouls_committed', 'Fautes', 1],
  ['ball_possession', 'Possession %', 0],
];

const RATE_ROWS: Array<[string, string]> = [
  ['over15', '+1.5 buts'],
  ['over25', '+2.5 buts'],
  ['over35', '+3.5 buts'],
  ['btts', 'Les 2 marquent'],
  ['cleanSheet', 'Clean sheet'],
  ['failedToScore', 'Sans marquer'],
];

const BUCKETS = ['0-15', '16-30', '31-45', '46-60', '61-75', '76-90+'];

function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min)) return '—';
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  if (min < 48 * 60) return `il y a ${Math.round(min / 60)} h`;
  return `il y a ${Math.round(min / 1440)} j`;
}

const pct = (v: number | undefined) => (v == null ? '—' : `${Math.round(v * 100)} %`);

function FormBadges({ form }: { form: string }) {
  return (
    <View style={styles.row}>
      {form.split('').map((r, i) => (
        <View key={i} style={[styles.formBadge, { backgroundColor: r === 'V' ? C.good : r === 'D' ? C.bad : C.muted }]}>
          <Text style={styles.formText}>{r}</Text>
        </View>
      ))}
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{title}</Text>
        {right}
      </View>
      {children}
    </View>
  );
}

/** Barre « pour / contre » : deux demi-barres partant du centre, valeurs écrites de chaque côté. */
function DualBar({ label, values, digits }: { label: string; values: [number, number]; digits: number }) {
  const [f, a] = values;
  const max = Math.max(f, a, 0.01);
  return (
    <View style={styles.dualRow}>
      <Text style={styles.dualVal}>{f.toFixed(digits)}</Text>
      <View style={styles.dualHalfL}>
        <View style={[styles.dualFill, { width: `${(f / max) * 100}%`, backgroundColor: C.for, borderTopLeftRadius: 4, borderBottomLeftRadius: 4 }]} />
      </View>
      <Text style={styles.dualLabel} numberOfLines={1}>{label}</Text>
      <View style={styles.dualHalfR}>
        <View style={[styles.dualFill, { width: `${(a / max) * 100}%`, backgroundColor: C.against, borderTopRightRadius: 4, borderBottomRightRadius: 4 }]} />
      </View>
      <Text style={[styles.dualVal, { textAlign: 'right' }]}>{a.toFixed(digits)}</Text>
    </View>
  );
}

function Legend() {
  return (
    <View style={[styles.row, { gap: 12, marginBottom: 6 }]}>
      <View style={styles.row}><View style={[styles.legendDot, { backgroundColor: C.for }]} /><Text style={styles.small}>Pour</Text></View>
      <View style={styles.row}><View style={[styles.legendDot, { backgroundColor: C.against }]} /><Text style={styles.small}>Contre</Text></View>
    </View>
  );
}

function GoalTiming({ timing }: { timing: NonNullable<TeamSheet['goalTiming']> }) {
  const max = Math.max(1, ...BUCKETS.map((b) => Math.max(timing.for[b] ?? 0, timing.against[b] ?? 0)));
  return (
    <View>
      <Legend />
      <View style={styles.timingWrap}>
        {BUCKETS.map((b) => {
          const f = timing.for[b] ?? 0;
          const a = timing.against[b] ?? 0;
          return (
            <View key={b} style={styles.timingCol}>
              <View style={styles.timingBars}>
                <View style={styles.timingBarSlot}>
                  <Text style={styles.timingNum}>{f}</Text>
                  <View style={[styles.timingBar, { height: (f / max) * 56, backgroundColor: C.for }]} />
                </View>
                <View style={styles.timingBarSlot}>
                  <Text style={styles.timingNum}>{a}</Text>
                  <View style={[styles.timingBar, { height: (a / max) * 56, backgroundColor: C.against }]} />
                </View>
              </View>
              <Text style={styles.timingLabel}>{b}'</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function TeamSheetView({ sheet, onBack }: { sheet: TeamSheet; onBack: () => void }) {
  const usual = new Set(sheet.usualXI);
  const keyPlayers = [...sheet.players].sort((x, y) => y.goals + y.assists - (x.goals + x.assists)).slice(0, 8);
  const avgRows = AVG_ROWS.filter(([k]) => Array.isArray(sheet.averages[k]));
  return (
    <View>
      <TouchableOpacity onPress={onBack} style={[styles.row, { marginBottom: 8 }]}>
        <Ionicons name="chevron-back" size={16} color={C.accent} />
        <Text style={{ color: C.accent, fontSize: 13 }}>Toutes les équipes</Text>
      </TouchableOpacity>

      <View style={styles.card}>
        <Text style={styles.teamName}>{sheet.name}</Text>
        <Text style={styles.small}>{sheet.leagues.join(' · ')} · {sheet.matches} matchs cette saison · fichier mis à jour {ago(sheet.updatedAt)}</Text>
        {sheet.form && (
          <View style={[styles.row, { marginTop: 10, justifyContent: 'space-between' }]}>
            <View>
              <Text style={styles.kicker}>5 derniers</Text>
              <FormBadges form={sheet.form.last5} />
            </View>
            <View style={styles.kpi}>
              <Text style={styles.kpiValue}>{sheet.form.record.V}-{sheet.form.record.N}-{sheet.form.record.D}</Text>
              <Text style={styles.kicker}>V-N-D</Text>
            </View>
            <View style={styles.kpi}>
              <Text style={styles.kpiValue}>{sheet.form.ppg?.toFixed(2) ?? '—'}</Text>
              <Text style={styles.kicker}>pts / match</Text>
            </View>
            {sheet.usualFormation && (
              <View style={styles.kpi}>
                <Text style={styles.kpiValue}>{sheet.usualFormation}</Text>
                <Text style={styles.kicker}>système</Text>
              </View>
            )}
          </View>
        )}
      </View>

      <Section title="Domicile / extérieur">
        <View style={styles.tableHead}>
          <Text style={[styles.th, { flex: 1.4, textAlign: 'left' }]}></Text>
          <Text style={styles.th}>MJ</Text>
          <Text style={styles.th}>Pts/m</Text>
          <Text style={styles.th}>Buts +</Text>
          <Text style={styles.th}>Buts −</Text>
        </View>
        {(['home', 'away'] as const).map((v) => {
          const s = sheet.venue[v];
          return (
            <View key={v} style={styles.tr}>
              <Text style={[styles.td, { flex: 1.4, textAlign: 'left' }]}>{v === 'home' ? 'Domicile' : 'Extérieur'}</Text>
              <Text style={styles.td}>{s?.n ?? '—'}</Text>
              <Text style={styles.td}>{s ? s.ppg.toFixed(2) : '—'}</Text>
              <Text style={styles.td}>{s ? s.gf.toFixed(2) : '—'}</Text>
              <Text style={styles.td}>{s ? s.ga.toFixed(2) : '—'}</Text>
            </View>
          );
        })}
      </Section>

      <Section title="Fréquence des scénarios (ses matchs)">
        <View style={styles.rateGrid}>
          {RATE_ROWS.filter(([k]) => sheet.rates[k] != null).map(([k, label]) => (
            <View key={k} style={styles.rateCell}>
              <Text style={styles.rateValue}>{pct(sheet.rates[k])}</Text>
              <Text style={styles.small}>{label}</Text>
              <View style={styles.rateTrack}><View style={[styles.rateFill, { width: `${Math.round(sheet.rates[k] * 100)}%` }]} /></View>
            </View>
          ))}
        </View>
      </Section>

      {avgRows.length > 0 && (
        <Section title="Moyennes par match">
          <Legend />
          {avgRows.map(([k, label, digits]) => (
            <DualBar key={k} label={label} values={sheet.averages[k]} digits={digits} />
          ))}
        </Section>
      )}

      {sheet.goalTiming && (
        <Section title="Minutes des buts (saison)">
          <GoalTiming timing={sheet.goalTiming} />
        </Section>
      )}

      {keyPlayers.length > 0 && (
        <Section title="Joueurs" right={<Text style={styles.small}>● titulaire habituel</Text>}>
          <View style={styles.tableHead}>
            <Text style={[styles.th, { flex: 2.4, textAlign: 'left' }]}>Joueur</Text>
            <Text style={styles.th}>Min</Text>
            <Text style={styles.th}>B</Text>
            <Text style={styles.th}>PD</Text>
            <Text style={styles.th}>TC/90</Text>
            <Text style={styles.th}>J</Text>
          </View>
          {keyPlayers.map((p) => (
            <View key={p.id} style={styles.tr}>
              <Text style={[styles.td, { flex: 2.4, textAlign: 'left' }]} numberOfLines={1}>
                {usual.has(p.id) ? '● ' : '   '}{p.name} <Text style={styles.small}>{p.pos}</Text>
              </Text>
              <Text style={styles.td}>{p.minutes}</Text>
              <Text style={styles.td}>{p.goals}</Text>
              <Text style={styles.td}>{p.assists}</Text>
              <Text style={styles.td}>{p.sotPer90 != null ? p.sotPer90.toFixed(1) : '—'}</Text>
              <Text style={styles.td}>{p.yellow}</Text>
            </View>
          ))}
        </Section>
      )}

      {sheet.insights.length > 0 && (
        <Section title="Ce que l'app retient">
          {sheet.insights.map((t, i) => (
            <View key={i} style={[styles.row, { alignItems: 'flex-start', marginBottom: 4 }]}>
              <Text style={[styles.body, { color: C.accent }]}>•  </Text>
              <Text style={[styles.body, { flex: 1 }]}>{t}</Text>
            </View>
          ))}
        </Section>
      )}

      {sheet.recent.length > 0 && (
        <Section title="Derniers matchs">
          {sheet.recent.map((m, i) => {
            const res = m.goalsFor > m.goalsAgainst ? 'V' : m.goalsFor < m.goalsAgainst ? 'D' : 'N';
            return (
              <View key={i} style={styles.matchRow}>
                <View style={[styles.formBadge, { backgroundColor: res === 'V' ? C.good : res === 'D' ? C.bad : C.muted }]}>
                  <Text style={styles.formText}>{res}</Text>
                </View>
                <View style={{ flex: 1, marginLeft: 8 }}>
                  <Text style={styles.body} numberOfLines={1}>
                    {m.goalsFor}-{m.goalsAgainst} {m.home ? 'vs' : '@'} {m.opponent}
                  </Text>
                  <Text style={styles.small} numberOfLines={2}>
                    {m.date.slice(8, 10)}/{m.date.slice(5, 7)} · {m.competition}{m.note ? ` · ${m.note.replace(/^[VND] \d+-\d+( : )?/, '')}` : ''}
                  </Text>
                </View>
              </View>
            );
          })}
        </Section>
      )}
    </View>
  );
}

export default function FootballDataScreen() {
  const focused = useIsFocused();
  const [tab, setTab] = useState<Tab>('standings');
  const [league, setLeague] = useState<LeagueDef>(LEAGUES[0]);
  const [standings, setStandings] = useState<Record<string, { data: Standings | null; stale: boolean }>>({});
  const [index, setIndex] = useState<TeamIndexFile | null>(null);
  const [indexStale, setIndexStale] = useState(false);
  const [teamLeague, setTeamLeague] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState<TeamSheet | null>(null);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [hub, setHub] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadStandings = useCallback(async (l: LeagueDef, force = false) => {
    setLoading(true);
    const res = await getStandings(l, force);
    setStandings((s) => ({ ...s, [l.espn]: res }));
    setLoading(false);
  }, []);

  const loadIndex = useCallback(async (force = false) => {
    const res = await getTeamIndex(force);
    setIndex(res.data);
    setIndexStale(res.stale);
  }, []);

  useEffect(() => {
    if (!focused) return;
    loadIndex();
    getHubStatus().then(setHub).catch(() => {});
  }, [focused, loadIndex]);

  useEffect(() => {
    if (!standings[league.espn]) loadStandings(league);
  }, [league, standings, loadStandings]);

  const openTeam = useCallback(async (entry: TeamIndexEntry | null, fallbackName?: string) => {
    if (!entry) {
      setMessage(`${fallbackName ?? 'Cette équipe'} n'est pas encore dans le fichier des équipes.`);
      return;
    }
    setMessage(null);
    setTab('teams');
    setSheetLoading(true);
    const s = await getTeamSheet(entry);
    setSheet(s);
    setSheetLoading(false);
    if (!s) setMessage(`Fiche de ${entry.name} indisponible (réseau ?).`);
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      tab === 'standings' ? loadStandings(league, true) : Promise.resolve(),
      loadIndex(true),
      getHubStatus().then(setHub).catch(() => {}),
      sheet && index ? getTeamSheet(index.teams.find((t) => t.id === sheet.id) ?? (sheet as any), true).then((s) => s && setSheet(s)) : Promise.resolve(),
    ]);
    setRefreshing(false);
  }, [tab, league, sheet, index, loadStandings, loadIndex]);

  const teams = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (index?.teams ?? [])
      .filter((t) => !teamLeague || t.leagues.includes(teamLeague))
      .filter((t) => !q || t.name.toLowerCase().includes(q) || (t.shortName ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [index, teamLeague, query]);

  const current = standings[league.espn];

  const renderStandings = () => (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
        {LEAGUES.map((l) => <Chip key={l.key} label={l.short} active={l.key === league.key} onPress={() => setLeague(l)} />)}
      </ScrollView>
      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.cardTitle}>{current?.data?.season || league.name}</Text>
          <Text style={styles.small}>{current?.data ? `ESPN · ${ago(current.data.fetchedAt)}${current.stale ? ' (hors ligne)' : ''}` : ''}</Text>
        </View>
        {loading && !current?.data ? (
          <ActivityIndicator color={C.accent} style={{ marginVertical: 20 }} />
        ) : !current?.data ? (
          <Text style={styles.body}>Classement indisponible (ESPN injoignable). Tire vers le bas pour réessayer.</Text>
        ) : (
          <>
            <View style={styles.tableHead}>
              <Text style={[styles.th, { flex: 0.5 }]}>#</Text>
              <Text style={[styles.th, { flex: 3.2, textAlign: 'left' }]}>Équipe</Text>
              <Text style={styles.th}>J</Text>
              <Text style={[styles.th, { flex: 1.4 }]}>V-N-D</Text>
              <Text style={styles.th}>Diff</Text>
              <Text style={[styles.th, { color: C.ink }]}>Pts</Text>
            </View>
            {current.data.rows.map((r) => {
              const entry = findIndexTeam(index, r.team);
              return (
                <TouchableOpacity key={r.team} style={styles.tr} onPress={() => openTeam(entry, r.team)}>
                  <View style={[styles.zone, { backgroundColor: r.noteColor ?? 'transparent' }]} />
                  <Text style={[styles.td, { flex: 0.45, color: C.ink2 }]}>{r.rank}</Text>
                  <View style={[styles.row, { flex: 3.2 }]}>
                    {r.logo ? <Image source={{ uri: r.logo }} style={styles.logo} /> : <View style={styles.logo} />}
                    <Text style={[styles.td, { textAlign: 'left', flex: 1 }]} numberOfLines={1}>{r.team}</Text>
                    {entry && <Ionicons name="document-text-outline" size={12} color={C.muted} />}
                  </View>
                  <Text style={styles.td}>{r.played}</Text>
                  <Text style={[styles.td, { flex: 1.4, color: C.ink2 }]}>{r.wins}-{r.draws}-{r.losses}</Text>
                  <Text style={[styles.td, { color: C.ink2 }]}>{r.diff > 0 ? `+${r.diff}` : r.diff}</Text>
                  <Text style={[styles.td, { fontWeight: '700' }]}>{r.points}</Text>
                </TouchableOpacity>
              );
            })}
            {current.data.rows.some((r) => r.note) && (
              <View style={{ marginTop: 8 }}>
                {Array.from(new Map(current.data.rows.filter((r) => r.note).map((r) => [r.note, r.noteColor])).entries()).map(([note, color]) => (
                  <View key={note!} style={[styles.row, { marginTop: 2 }]}>
                    <View style={[styles.legendDot, { backgroundColor: color ?? C.muted }]} />
                    <Text style={styles.small}>{note}</Text>
                  </View>
                ))}
              </View>
            )}
            <Text style={[styles.small, { marginTop: 8 }]}>Appuie sur une équipe pour ouvrir sa fiche (icône = fiche disponible).</Text>
          </>
        )}
      </View>
    </View>
  );

  const renderTeams = () => {
    if (sheetLoading) return <ActivityIndicator color={C.accent} style={{ marginVertical: 30 }} />;
    if (sheet) return <TeamSheetView sheet={sheet} onBack={() => setSheet(null)} />;
    return (
      <View>
        <View style={styles.search}>
          <Ionicons name="search" size={14} color={C.muted} />
          <TextInput value={query} onChangeText={setQuery} placeholder="Chercher une équipe" placeholderTextColor={C.muted} style={styles.searchInput} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
          <Chip label="Toutes" active={!teamLeague} onPress={() => setTeamLeague(null)} />
          {LEAGUES.map((l) => <Chip key={l.key} label={l.short} active={teamLeague === l.name} onPress={() => setTeamLeague(l.name)} />)}
        </ScrollView>
        {!index ? (
          <Text style={styles.body}>Fichier des équipes indisponible (réseau ?). Tire vers le bas pour réessayer.</Text>
        ) : (
          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>{teams.length} équipes</Text>
              <Text style={styles.small}>fichier {ago(index.updatedAt)}{indexStale ? ' (hors ligne)' : ''}</Text>
            </View>
            {teams.map((t) => (
              <TouchableOpacity key={t.id} style={styles.tr} onPress={() => openTeam(t)}>
                <Text style={[styles.td, { flex: 3, textAlign: 'left' }]} numberOfLines={1}>{t.name}</Text>
                <Text style={[styles.td, { flex: 2, color: C.ink2, textAlign: 'left' }]} numberOfLines={1}>{t.leagues.join(', ')}</Text>
                <Text style={[styles.td, { color: C.ink2 }]}>{t.matches} m.</Text>
                <Ionicons name="chevron-forward" size={14} color={C.muted} />
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    );
  };

  const renderSources = () => {
    const names = ['LiveScore', 'FotMob', '365Scores', 'ESPN', 'AllSportsApi', 'TheSportsDB'];
    const known = Object.values(standings).filter((s) => s.data);
    return (
      <View>
        <Section title="Direct (6 sources gratuites)">
          {names.map((n) => {
            const s = hub[n];
            const streak = s?.failStreak ?? 0;
            const state = !s ? 'inconnu' : s.ok ? 'ok' : streak >= 3 ? 'en panne' : 'raté';
            const color = state === 'ok' ? C.good : state === 'en panne' ? C.bad : state === 'raté' ? C.warn : C.muted;
            const icon = state === 'ok' ? 'checkmark-circle' : state === 'en panne' ? 'close-circle' : state === 'raté' ? 'alert-circle' : 'help-circle';
            return (
              <View key={n} style={styles.tr}>
                <Ionicons name={icon as any} size={14} color={color} />
                <Text style={[styles.td, { flex: 2, textAlign: 'left', marginLeft: 6 }]}>{n}</Text>
                <Text style={[styles.td, { flex: 1.6, color, textAlign: 'left' }]}>{state}{streak > 0 && !s?.ok ? ` ×${streak}` : ''}</Text>
                <Text style={[styles.td, { color: C.ink2 }]}>{s?.count != null ? `${s.count} m.` : ''}</Text>
                <Text style={[styles.td, { flex: 1.6, color: C.ink2, textAlign: 'right' }]}>{ago(s?.at)}</Text>
              </View>
            );
          })}
          {Object.values(hub).some((s: any) => !s.ok && s.error) && (
            <View style={{ marginTop: 6 }}>
              {names.filter((n) => hub[n] && !hub[n].ok && hub[n].error).map((n) => (
                <Text key={n} style={styles.small} numberOfLines={2}>{n} : {hub[n].error}</Text>
              ))}
            </View>
          )}
          <Text style={[styles.small, { marginTop: 8 }]}>
            Un seul échec est normal (coupure courte, la source est réessayée 2 s après). « En panne » = 3 échecs de suite. Toutes en panne en même temps = réseau du téléphone.
          </Text>
        </Section>
        <Section title="Fichier des équipes">
          <Text style={styles.body}>{index ? `${index.teams.length} équipes · mis à jour ${ago(index.updatedAt)}${indexStale ? ' (copie hors ligne)' : ''}` : 'Non chargé'}</Text>
          <Text style={styles.small}>Compilé chaque nuit (FotMob) + stats live et joueurs ajoutés en fin de match.</Text>
        </Section>
        <Section title="Classements">
          <Text style={styles.body}>{known.length ? `${known.length} compétition(s) chargée(s) · ESPN` : 'Aucun classement chargé pour l’instant'}</Text>
          {known.map((s) => (
            <Text key={s.data!.league} style={styles.small}>{s.data!.league} : {ago(s.data!.fetchedAt)}{s.stale ? ' (hors ligne)' : ''}</Text>
          ))}
        </Section>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <View style={styles.segment}>
        {([['standings', 'Classements', 'podium-outline'], ['teams', 'Équipes', 'people-outline'], ['sources', 'Sources', 'pulse-outline']] as const).map(([k, label, icon]) => (
          <TouchableOpacity key={k} style={[styles.segBtn, tab === k && styles.segBtnActive]} onPress={() => setTab(k)}>
            <Ionicons name={icon as any} size={14} color={tab === k ? C.ink : C.ink2} />
            <Text style={[styles.segText, tab === k && { color: C.ink }]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {message && (
        <TouchableOpacity onPress={() => setMessage(null)} style={styles.message}>
          <Ionicons name="information-circle" size={14} color={C.warn} />
          <Text style={[styles.small, { flex: 1, color: C.ink, marginLeft: 6 }]}>{message}</Text>
        </TouchableOpacity>
      )}
      <ScrollView
        contentContainerStyle={{ padding: 12, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} />}
      >
        {tab === 'standings' ? renderStandings() : tab === 'teams' ? renderTeams() : renderSources()}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  row: { flexDirection: 'row', alignItems: 'center' },
  segment: { flexDirection: 'row', margin: 12, marginBottom: 0, backgroundColor: C.card, borderRadius: 10, padding: 3, borderWidth: 1, borderColor: C.line },
  segBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 7, borderRadius: 8 },
  segBtnActive: { backgroundColor: '#24324a' },
  segText: { color: C.ink2, fontSize: 12, fontWeight: '600' },
  message: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginTop: 8, padding: 8, borderRadius: 8, backgroundColor: '#2a2414' },
  chip: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: 14, borderWidth: 1, borderColor: C.line, marginRight: 6 },
  chipActive: { backgroundColor: C.accent, borderColor: C.accent },
  chipText: { color: C.ink2, fontSize: 12 },
  chipTextActive: { color: '#fff', fontWeight: '600' },
  card: { backgroundColor: C.card, borderRadius: 10, padding: 10, marginBottom: 10, borderWidth: 1, borderColor: C.line },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  cardTitle: { color: C.ink, fontSize: 13, fontWeight: '700' },
  teamName: { color: C.ink, fontSize: 17, fontWeight: '700' },
  kicker: { color: C.muted, fontSize: 10, textTransform: 'uppercase', marginTop: 2 },
  kpi: { alignItems: 'center' },
  kpiValue: { color: C.ink, fontSize: 15, fontWeight: '700' },
  body: { color: C.ink, fontSize: 12, lineHeight: 17 },
  small: { color: C.ink2, fontSize: 11, lineHeight: 15 },
  tableHead: { flexDirection: 'row', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: C.line },
  th: { flex: 1, color: C.muted, fontSize: 10, textAlign: 'center', fontWeight: '600' },
  tr: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  td: { flex: 1, color: C.ink, fontSize: 12, textAlign: 'center' },
  zone: { width: 3, height: 16, borderRadius: 2, marginRight: 3 },
  logo: { width: 16, height: 16, marginRight: 6 },
  formBadge: { width: 18, height: 18, borderRadius: 4, alignItems: 'center', justifyContent: 'center', marginRight: 3 },
  formText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  legendDot: { width: 8, height: 8, borderRadius: 4, marginRight: 5 },
  rateGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  rateCell: { width: '31%', marginBottom: 8 },
  rateValue: { color: C.ink, fontSize: 14, fontWeight: '700' },
  rateTrack: { height: 4, backgroundColor: C.line, borderRadius: 2, marginTop: 3, overflow: 'hidden' },
  rateFill: { height: 4, backgroundColor: C.accent, borderRadius: 2 },
  dualRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 3 },
  dualVal: { width: 34, color: C.ink, fontSize: 11 },
  dualHalfL: { flex: 1, height: 8, flexDirection: 'row', justifyContent: 'flex-end' },
  dualHalfR: { flex: 1, height: 8, flexDirection: 'row', justifyContent: 'flex-start' },
  dualFill: { height: 8 },
  dualLabel: { width: 98, color: C.ink2, fontSize: 10, textAlign: 'center' },
  timingWrap: { flexDirection: 'row', justifyContent: 'space-between' },
  timingCol: { flex: 1, alignItems: 'center' },
  timingBars: { flexDirection: 'row', alignItems: 'flex-end', height: 72, gap: 2 },
  timingBarSlot: { alignItems: 'center', justifyContent: 'flex-end' },
  timingBar: { width: 10, borderTopLeftRadius: 3, borderTopRightRadius: 3, minHeight: 1 },
  timingNum: { color: C.ink2, fontSize: 9, marginBottom: 1 },
  timingLabel: { color: C.muted, fontSize: 9, marginTop: 3 },
  matchRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.line },
  search: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 8, borderWidth: 1, borderColor: C.line, paddingHorizontal: 10, marginBottom: 8 },
  searchInput: { flex: 1, color: C.ink, fontSize: 13, paddingVertical: 7, marginLeft: 6 },
});
