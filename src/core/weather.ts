// Météo du match (Open-Meteo, gratuit, sans clé — liste public-apis) : pluie, vent et chaleur au stade.
// Ville du stade : ESPN ; coordonnées : géocodage Open-Meteo, gardées en mémoire. Les trois variables entrent dans le
// modèle de situation (deltaLearning) : leur effet sur les buts / corners / cartons est APPRIS puis plafonné, jamais fixé.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { hubDateKey, hubVenueCity } from '../api/footballDataAPIs/liveDataHub';
import { normalizeTeamName } from './teamNameMatch';

const GEO_KEY = '@venue_geo';
const TTL_MS = 30 * 60_000;
const TIMEOUT_MS = 10_000;

export interface MatchWeather {
  city: string;
  temperatureC: number;
  rainMm: number;
  windKmh: number;
}

let geo: Record<string, { lat: number; lon: number } | null> | null = null;
const cache = new Map<string, { at: number; weather: MatchWeather | null }>();

async function getJson(url: string): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function coordinates(city: string): Promise<{ lat: number; lon: number } | null> {
  if (!geo) {
    try {
      geo = JSON.parse((await AsyncStorage.getItem(GEO_KEY)) ?? '{}');
    } catch {
      geo = {};
    }
  }
  if (city in geo!) return geo![city];
  const d = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`);
  const r = d?.results?.[0];
  const value = r ? { lat: r.latitude, lon: r.longitude } : null;
  if (d) {
    geo![city] = value;
    try {
      await AsyncStorage.setItem(GEO_KEY, JSON.stringify(geo));
    } catch {
      // best-effort
    }
  }
  return value;
}

/** Météo actuelle au stade, ou null si la ville ou la source manquent. */
export async function getMatchWeather(homeTeam: string, awayTeam: string): Promise<MatchWeather | null> {
  const key = `${normalizeTeamName(homeTeam)}|${normalizeTeamName(awayTeam)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.weather;
  let weather: MatchWeather | null = null;
  try {
    const city = await hubVenueCity(homeTeam, awayTeam, hubDateKey());
    const where = city ? await coordinates(city) : null;
    if (city && where) {
      const d = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${where.lat}&longitude=${where.lon}&current=temperature_2m,precipitation,wind_speed_10m`);
      const c = d?.current;
      if (c && Number.isFinite(c.temperature_2m)) weather = { city, temperatureC: c.temperature_2m, rainMm: c.precipitation ?? 0, windKmh: c.wind_speed_10m ?? 0 };
    }
  } catch {
    weather = null;
  }
  cache.set(key, { at: Date.now(), weather });
  return weather;
}

/** Variables de situation : pluie (0-1, 4 mm/h = 1), vent (0-1, 40 km/h = 1), écart à 15 °C (0-1, 15 °C d'écart = 1). 0 = inconnu. */
export async function weatherFeatures(homeTeam: string, awayTeam: string): Promise<[number, number, number]> {
  const w = await getMatchWeather(homeTeam, awayTeam);
  if (!w) return [0, 0, 0];
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  return [clamp(w.rainMm / 4), clamp(w.windKmh / 40), clamp(Math.abs(w.temperatureC - 15) / 15)];
}
