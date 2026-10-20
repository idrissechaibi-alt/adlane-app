// MODULE DE COLLECTE WEB (serveur PC) : lit les sites que l'utilisateur déclare dans <serveur>/sites.json, les relève
// toutes les 30 s (ou davantage), garde ce qui a changé et le publie pour le téléphone toutes les 60 s dans
// data/server/web/<id>/<jour>/<tranche de 10 min>.json (lu par src/core/serverFeed.ts → pullServerWebFeed).
//
// Règles de bonne conduite, non négociables : une page lue comme un navigateur ordinaire la lirait, depuis la connexion de
// l'utilisateur. Si un site refuse (403, 429, captcha, « accès refusé », blocage par pays), le module S'ARRÊTE pour ce site
// (nouvel essai espacé de 5 min à 1 h) : aucun VPN, aucun proxy, aucune imitation de navigateur ou de comportement humain,
// aucune connexion à un compte. L'adresse des sites n'est jamais publiée (seuls l'identifiant et les valeurs lues le sont).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cheerio from 'cheerio';
import { repoDelete, repoList, repoPut } from './github';
import { log } from './log';
import { serverRoot } from './paths';

export const WEB_DIR = 'data/server/web';

/** Un site à lire. */
export interface SiteSource {
  /** Identifiant court sans espace (sert de dossier). */
  id: string;
  name?: string;
  url: string;
  /** Secondes entre deux relevés (30 minimum). */
  every?: number;
  /** 'json' (défaut si la réponse en est un), 'html' ou 'text'. */
  format?: 'json' | 'html' | 'text';
  /**
   * json : `items` = chemin pointé vers une liste (ex. "events"), `fields` = nom → chemin relatif à chaque élément.
   * html : `items` = sélecteur CSS de chaque ligne, `fields` = nom → "sélecteur" (texte) ou "sélecteur@attribut".
   * text : `regex` à groupes nommés, appliquée en global.
   * Sans règle : le contenu brut (tronqué) est gardé.
   */
  items?: string;
  fields?: Record<string, string>;
  regex?: string;
  /** En-têtes ajoutés par l'utilisateur (jamais publiés). */
  headers?: Record<string, string>;
  enabled?: boolean;
}

interface Snapshot {
  at: string;
  items: unknown;
}

interface State {
  nextAt: number;
  failures: number;
  blockedUntil: number;
  lastHash: string;
  lastCheckAt: string | null;
  status: 'ok' | 'bloqué' | 'erreur' | 'attente';
  pending: Snapshot[];
}

const MIN_EVERY = 30;
const MAX_SNAPSHOT_CHARS = 20_000;
const states = new Map<string, State>();
const sitesFile = () => path.join(serverRoot(), 'sites.json');

export function loadSites(): SiteSource[] {
  try {
    const list = JSON.parse(fs.readFileSync(sitesFile(), 'utf8').replace(/^﻿/, ''));
    return (Array.isArray(list) ? list : list.sites ?? []).filter((s: SiteSource) => s?.id && s?.url && s.enabled !== false);
  } catch {
    return [];
  }
}

const getPath = (obj: any, p: string): any => p.split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);

const BLOCK_RE = /access denied|acc[eè]s refus[eé]|captcha|just a moment|verify you are human|are you a robot|forbidden|pays interdits|blocked/i;

class Blocked extends Error {}

async function fetchText(s: SiteSource): Promise<{ text: string; type: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(s.url, {
      headers: { 'User-Agent': 'adlane-collector/1.0 (usage personnel)', Accept: 'application/json,text/html;q=0.9,*/*;q=0.5', ...(s.headers ?? {}) },
      signal: ctrl.signal,
    });
    const text = await r.text();
    if ([401, 403, 429, 451].includes(r.status) || (r.status >= 500 && r.status < 600 && BLOCK_RE.test(text)) || (r.status === 203 && BLOCK_RE.test(text.slice(0, 3000)))) {
      throw new Blocked(`HTTP ${r.status}`);
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (text.length < 4000 && BLOCK_RE.test(text)) throw new Blocked('page de refus');
    if (r.url && /\/(block|captcha|denied)\b/i.test(new URL(r.url).pathname)) throw new Blocked('redirigé vers une page de refus');
    return { text, type: r.headers.get('content-type') ?? '' };
  } finally {
    clearTimeout(timer);
  }
}

export function extract(s: SiteSource, text: string, type: string): unknown {
  const format = s.format ?? (/json/i.test(type) || /^\s*[[{]/.test(text) ? 'json' : 'html');
  if (format === 'json') {
    const data = JSON.parse(text);
    if (!s.items && !s.fields) return data;
    const base = s.items ? getPath(data, s.items) : data;
    const pick = (o: any) => (s.fields ? Object.fromEntries(Object.entries(s.fields).map(([k, p]) => [k, getPath(o, p)])) : o);
    return Array.isArray(base) ? base.map(pick) : pick(base);
  }
  if (format === 'html') {
    const $ = cheerio.load(text);
    if (!s.items && !s.fields) return $('body').text().replace(/\s+/g, ' ').trim();
    const read = (el: any, spec: string) => {
      const [sel, attr] = spec.split('@');
      const node = sel ? $(el).find(sel).first() : $(el);
      return (attr ? node.attr(attr) : node.text().replace(/\s+/g, ' ').trim()) ?? null;
    };
    const rows = s.items ? $(s.items).toArray() : [$.root().get(0)];
    return rows.map((el) => (s.fields ? Object.fromEntries(Object.entries(s.fields).map(([k, spec]) => [k, read(el, spec)])) : $(el).text().replace(/\s+/g, ' ').trim()));
  }
  if (s.regex) return [...text.matchAll(new RegExp(s.regex, 'g'))].map((m) => ({ ...m.groups }));
  return text;
}

/** Relève les sites échus (appelé toutes les 10 s) : un site à la fois en parallèle, sans jamais accumuler de retard. */
export async function collectDueSites(): Promise<number> {
  const now = Date.now();
  let done = 0;
  await Promise.all(
    loadSites().map(async (s) => {
      const st = states.get(s.id) ?? { nextAt: 0, failures: 0, blockedUntil: 0, lastHash: '', lastCheckAt: null, status: 'attente' as const, pending: [] };
      states.set(s.id, st);
      if (now < st.nextAt || now < st.blockedUntil) return;
      st.nextAt = now + Math.max(MIN_EVERY, s.every ?? MIN_EVERY) * 1000;
      try {
        const { text, type } = await fetchText(s);
        let items = extract(s, text, type);
        let json = JSON.stringify(items);
        if (json.length > MAX_SNAPSHOT_CHARS) {
          items = { tronque: true, debut: json.slice(0, MAX_SNAPSHOT_CHARS) };
          json = JSON.stringify(items);
        }
        st.failures = 0;
        st.status = 'ok';
        st.lastCheckAt = new Date().toISOString();
        // Seul ce qui a changé est gardé : le dépôt ne grossit pas de relevés identiques.
        if (json !== st.lastHash) {
          st.lastHash = json;
          st.pending.push({ at: st.lastCheckAt, items });
          done++;
        }
      } catch (e: any) {
        st.failures++;
        if (e instanceof Blocked) {
          st.status = 'bloqué';
          // Refus du site : on ne force rien, on espace (5 min, 10, 20… jusqu'à 1 h).
          st.blockedUntil = now + Math.min(60, 5 * 2 ** Math.min(st.failures - 1, 4)) * 60_000;
          if (st.failures === 1 || st.failures % 6 === 0) log(`Site « ${s.id} » : accès refusé par le site (${e.message}) — rien n'est contourné, nouvel essai dans ${Math.round((st.blockedUntil - now) / 60_000)} min.`);
        } else {
          st.status = 'erreur';
          if (st.failures === 1 || st.failures % 10 === 0) log(`Site « ${s.id} » : ${e?.message ?? e} (essai ${st.failures}).`);
        }
      }
    })
  );
  return done;
}

const sliceCache = new Map<string, { path: string; snapshots: Snapshot[] }>();

/** Publie ce qui a changé (tranche de 10 min par site, réécrite tant qu'elle est en cours). */
export async function publishWeb(): Promise<boolean> {
  const sites = new Map(loadSites().map((s) => [s.id, s]));
  const d = new Date();
  const day = d.toISOString().slice(0, 10);
  const slice = `${String(d.getUTCHours()).padStart(2, '0')}${String(Math.floor(d.getUTCMinutes() / 10) * 10).padStart(2, '0')}`;
  let ok = true;
  for (const [id, st] of states) {
    const site = sites.get(id);
    if (!site || (st.pending.length === 0 && st.status === 'ok')) continue;
    const file = `${WEB_DIR}/${id}/${day}/${slice}.json`;
    const prev = sliceCache.get(id);
    const snapshots = [...(prev && prev.path === file ? prev.snapshots : []), ...st.pending];
    const body = { id, name: site.name ?? id, slice: `${day} ${slice}`, status: st.status, lastCheckAt: st.lastCheckAt, snapshots };
    const done = await repoPut(file, JSON.stringify(body), `[serveur PC] Web ${id} ${day} ${slice}`).catch(() => false);
    if (done) {
      sliceCache.set(id, { path: file, snapshots });
      st.pending = [];
    } else ok = false;
  }
  return ok;
}

/** Nettoyage quotidien : les relevés web de plus de 3 jours sont retirés du dépôt (il ne doit pas grossir sans fin). */
export async function pruneWebFeed(): Promise<void> {
  const limit = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  for (const dir of await repoList(WEB_DIR)) {
    for (const dayDir of await repoList(`${WEB_DIR}/${dir.name}`)) {
      if (dayDir.name >= limit) continue;
      for (const f of await repoList(`${WEB_DIR}/${dir.name}/${dayDir.name}`)) await repoDelete(f.path, f.sha, '[serveur PC] Nettoyage des relevés web').catch(() => false);
    }
  }
}

/** Résumé pour le battement de cœur : état de chaque site. */
export function webStatus(): Record<string, { status: string; lastCheckAt: string | null }> {
  return Object.fromEntries([...states.entries()].map(([id, st]) => [id, { status: st.status, lastCheckAt: st.lastCheckAt }]));
}
