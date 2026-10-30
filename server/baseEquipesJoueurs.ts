// BASE ÉQUIPES ET JOUEURS sur le PC : une copie lisible de tout ce que l'app sait des équipes et des joueurs, remise à jour avec
// la copie du téléphone (restore.ts) et gardée par date dans <serveur>/base-equipes-joueurs/<jour>/ (30 jours), plus un dossier
// « dernier » toujours à jour. Rien n'est inventé ni recalculé ailleurs : les fichiers viennent des données de l'app.
//
//   joueurs.json     un joueur par ligne : équipe, poste, matchs, titularisations, tirs, cadrés, buts, passes, fautes, cartons
//   equipes.json     une équipe par ligne : matchs résumés, buts pour et contre, moyennes par match, observations du serveur
//   brut/            les magasins de l'app tels quels (résumés de matchs, dossiers d'équipe, registre, notes et bilans des entraîneurs)
//   team-stats/      les dossiers d'équipes du dépôt (compositions habituelles, formations, tendances)
//   fiches-clubs/    les fiches des entraîneurs-analystes (club par club)
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataRoot, serverRoot } from './paths';
import { log } from './log';

const KEEP_DAYS = 30;
export const baseDir = () => path.join(serverRoot(), 'base-equipes-joueurs');
const phoneStorage = () => path.join(dataRoot(), 'copie-telephone', 'storage');
const repoRoot = () => path.join(__dirname, '..', '..');

/** Magasins de l'app copiés tels quels (nom du fichier de la copie du téléphone). */
const RAW_STORES = ['_match_digests', '_team_live_lessons', '_team_registry', '_team_aliases', '_team_stats_index', '_team_stats_summaries', '_coach_team_notes_v1', '_coach_reviews_v1', '_coach_analyses_v1', '_coach_shadow_v1'];

function readStore(name: string): any | null {
  try {
    const raw = fs.readFileSync(path.join(phoneStorage(), name), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface PlayerAgg {
  joueur: string;
  equipe: string;
  poste: string;
  matchs: number;
  titularisations: number;
  tirs: number;
  tirs_cadres: number;
  buts: number;
  passes_decisives: number;
  fautes: number;
  jaunes: number;
  rouges: number;
  dernier_match: string;
}

interface TeamAgg {
  equipe: string;
  matchs: number;
  buts_pour: number;
  buts_contre: number;
  corners: number;
  cartons: number;
  fautes: number;
  tirs: number;
  tirs_cadres: number;
}

/** Joueurs et équipes agrégés à partir des résumés de matchs terminés de l'app. */
function aggregate(digests: Record<string, any>): { players: PlayerAgg[]; teams: TeamAgg[] } {
  const players = new Map<string, PlayerAgg>();
  const teams = new Map<string, TeamAgg>();
  for (const d of Object.values(digests)) {
    const i = typeof d?.match === 'string' ? d.match.indexOf(' - ') : -1;
    if (i < 0) continue;
    const names: [string, string] = [d.match.slice(0, i), d.match.slice(i + 3)];
    const sides = [d.sides?.h, d.sides?.a] as Array<number[] | undefined>;
    names.forEach((team, k) => {
      const t = teams.get(team) ?? { equipe: team, matchs: 0, buts_pour: 0, buts_contre: 0, corners: 0, cartons: 0, fautes: 0, tirs: 0, tirs_cadres: 0 };
      t.matchs++;
      t.buts_pour += d.score?.[k] ?? 0;
      t.buts_contre += d.score?.[1 - k] ?? 0;
      if (sides[k]) {
        t.tirs += sides[k]![0] ?? 0;
        t.tirs_cadres += sides[k]![1] ?? 0;
        t.corners += sides[k]![2] ?? 0;
        t.cartons += sides[k]![3] ?? 0;
        t.fautes += sides[k]![4] ?? 0;
      }
      teams.set(team, t);
    });
    for (const [k, list] of [[0, d.players?.h], [1, d.players?.a]] as Array<[number, any[] | undefined]>) {
      for (const p of list ?? []) {
        const key = `${names[k]}|${p[0]}`;
        const a = players.get(key) ?? { joueur: String(p[0]), equipe: names[k], poste: String(p[1] ?? ''), matchs: 0, titularisations: 0, tirs: 0, tirs_cadres: 0, buts: 0, passes_decisives: 0, fautes: 0, jaunes: 0, rouges: 0, dernier_match: '' };
        a.matchs++;
        a.titularisations += p[2] ? 1 : 0;
        a.tirs += p[3] ?? 0;
        a.tirs_cadres += p[4] ?? 0;
        a.buts += p[5] ?? 0;
        a.passes_decisives += p[6] ?? 0;
        a.fautes += p[7] ?? 0;
        a.jaunes += p[8] ?? 0;
        a.rouges += p[9] ?? 0;
        if (d.day > a.dernier_match) a.dernier_match = d.day;
        players.set(key, a);
      }
    }
  }
  return {
    players: [...players.values()].sort((x, y) => y.buts - x.buts || y.tirs_cadres - x.tirs_cadres || x.joueur.localeCompare(y.joueur)),
    teams: [...teams.values()].sort((x, y) => x.equipe.localeCompare(y.equipe)),
  };
}

function copyDir(from: string, to: string): number {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(from)) {
    const src = path.join(from, f);
    if (fs.statSync(src).isDirectory()) n += copyDir(src, path.join(to, f));
    else {
      fs.copyFileSync(src, path.join(to, f));
      n++;
    }
  }
  return n;
}

/** Écrit la base du jour. Renvoie un résumé, ou null si la copie du téléphone est absente. */
export function backupPlayersAndTeams(): { dir: string; players: number; teams: number; raw: number } | null {
  if (!fs.existsSync(phoneStorage())) {
    log('Base équipes et joueurs : pas encore de copie du téléphone.');
    return null;
  }
  const day = new Date().toISOString().slice(0, 10);
  const out = path.join(baseDir(), day);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'brut'), { recursive: true });

  const digests = readStore('_match_digests') ?? {};
  const { players, teams } = aggregate(digests);
  fs.writeFileSync(path.join(out, 'joueurs.json'), JSON.stringify(players, null, 1));
  fs.writeFileSync(path.join(out, 'equipes.json'), JSON.stringify(teams, null, 1));

  let raw = 0;
  for (const name of RAW_STORES) {
    const f = path.join(phoneStorage(), name);
    if (!fs.existsSync(f)) continue;
    fs.copyFileSync(f, path.join(out, 'brut', `${name.replace(/^_/, '')}.json`));
    raw++;
  }
  // Stats des joueurs relevées en direct, jour par jour.
  for (const f of fs.readdirSync(phoneStorage())) {
    if (/^_real_live_players_\d{4}-\d{2}-\d{2}$/.test(f)) {
      fs.copyFileSync(path.join(phoneStorage(), f), path.join(out, 'brut', `${f.replace(/^_/, '')}.json`));
      raw++;
    }
  }
  const stats = copyDir(path.join(repoRoot(), 'data', 'team-stats'), path.join(out, 'team-stats'));
  const fiches = copyDir(path.join(repoRoot(), 'src', 'core', 'coaches', 'data'), path.join(out, 'fiches-clubs'));
  fs.writeFileSync(path.join(out, 'LISEZ-MOI.txt'), `Base équipes et joueurs adlane — ${new Date().toISOString()}\njoueurs.json : ${players.length} joueurs · equipes.json : ${teams.length} équipes · brut : ${raw} magasins · team-stats : ${stats} fichiers · fiches-clubs : ${fiches} fichiers\nSource : copie de la sauvegarde du téléphone (copie-telephone) et dépôt.\n`);

  // Dossier « dernier » : toujours la version la plus récente.
  const latest = path.join(baseDir(), 'dernier');
  fs.rmSync(latest, { recursive: true, force: true });
  copyDir(out, latest);

  // Rotation : au-delà de 30 jours, les dossiers datés les plus anciens partent.
  const limit = Date.now() - KEEP_DAYS * 86_400_000;
  for (const f of fs.readdirSync(baseDir())) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(f) && Date.parse(f) < limit) fs.rmSync(path.join(baseDir(), f), { recursive: true, force: true });
  }
  log(`Base équipes et joueurs : ${players.length} joueurs, ${teams.length} équipes → ${out}`);
  return { dir: out, players: players.length, teams: teams.length, raw };
}
