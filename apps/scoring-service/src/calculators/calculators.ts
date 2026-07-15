import { GameId } from '@esfl/contracts';

/**
 * Scoring v1 (système Z-score cross-game). Chaque statistique brute est
 * standardisée (Z = (x − μ)/σ) sur la population récente du même jeu (isolée par
 * rôle en LoL), gommant l'asymétrie inter-jeux. On en dérive 4 piliers
 * universels (Impact, Létalité, Soutien, Constance), pondérés (matrice éditable
 * ci-dessous, par rôle en LoL), puis convertis en note 0-100 (50 + 15·Z_total).
 *
 * Contraintes de données du tier gratuit :
 * - CS2 (Grid open-access) : pas de dégâts/utilitaire → pas d'utility_damage ni
 *   flash_duration. Létalité = kills, Soutien = assists, Impact = firstKills +
 *   objectifs (plants/defuses).
 * - Aucun provider gratuit ne distingue le « baiting » du « clutch » (pas de
 *   contexte de round) : Constance = survie/KAST, limite assumée.
 */
export const SCORING_VERSION = 'v1';

/** Taille d'échantillon minimale d'une distribution pour l'utiliser (sinon Z=0). */
export const MIN_DISTRIBUTION_SAMPLE = 30;

export interface ScoreResult {
  points: number;
  breakdown: Record<string, number>;
}

/** Sous-ensemble du match nécessaire au comptage des maps jouées. */
export interface MatchMapsInfo {
  gamesSummary?: Array<{ position: number; winner: 'A' | 'B' | null }> | null;
  scoreA?: number | null;
  scoreB?: number | null;
}

/**
 * Nombre de maps jouées : manches décidées de gamesSummary, sinon scoreA+scoreB,
 * sinon 1. Sert à normaliser les compteurs par map (comparabilité Bo1/Bo3/Bo5).
 */
export function mapsPlayed(match: MatchMapsInfo): number {
  const decided = (match.gamesSummary ?? []).filter((game) => game.winner != null).length;
  if (decided > 0) return decided;
  const fromScore = (match.scoreA ?? 0) + (match.scoreB ?? 0);
  return fromScore > 0 ? fromScore : 1;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function num(normalized: Record<string, unknown>, key: string): number | null {
  const value = normalized[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

type MetricKind = 'counter' | 'rate';
interface MetricSpec {
  key: string;
  kind: MetricKind;
  get: (normalized: Record<string, unknown>) => number | null;
}

/**
 * Métriques brutes par jeu et leur nature : `counter` = ramené à la moyenne par
 * map avant standardisation ; `rate` = déjà un taux moyenné (adr, kast, bpm,
 * ratios LoL), pris tel quel.
 */
const METRIC_SPECS: Record<GameId, MetricSpec[]> = {
  cs2: [
    { key: 'firstKills', kind: 'counter', get: (n) => num(n, 'firstKills') },
    { key: 'kills', kind: 'counter', get: (n) => num(n, 'kills') },
    { key: 'assists', kind: 'counter', get: (n) => num(n, 'assists') },
    { key: 'deaths', kind: 'counter', get: (n) => num(n, 'deaths') },
    {
      key: 'objectives',
      kind: 'counter',
      get: (n) => {
        const plants = num(n, 'plants');
        const defuses = num(n, 'defuses');
        return plants == null && defuses == null ? null : (plants ?? 0) + (defuses ?? 0);
      },
    },
  ],
  valorant: [
    { key: 'firstKills', kind: 'counter', get: (n) => num(n, 'firstKills') },
    { key: 'firstDeaths', kind: 'counter', get: (n) => num(n, 'firstDeaths') },
    { key: 'adr', kind: 'rate', get: (n) => num(n, 'adr') },
    { key: 'assists', kind: 'counter', get: (n) => num(n, 'assists') },
    { key: 'kast', kind: 'rate', get: (n) => num(n, 'kast') },
  ],
  lol: [
    { key: 'killParticipation', kind: 'rate', get: (n) => num(n, 'killParticipation') },
    { key: 'damageShare', kind: 'rate', get: (n) => num(n, 'damageShare') },
    { key: 'visionScore', kind: 'counter', get: (n) => num(n, 'visionScore') },
    { key: 'assists', kind: 'counter', get: (n) => num(n, 'assists') },
    { key: 'deaths', kind: 'counter', get: (n) => num(n, 'deaths') },
  ],
  rl: [
    { key: 'shots', kind: 'counter', get: (n) => num(n, 'shots') },
    { key: 'demosInflicted', kind: 'counter', get: (n) => num(n, 'demosInflicted') },
    { key: 'goals', kind: 'counter', get: (n) => num(n, 'goals') },
    { key: 'saves', kind: 'counter', get: (n) => num(n, 'saves') },
    { key: 'assists', kind: 'counter', get: (n) => num(n, 'assists') },
    { key: 'boostBpm', kind: 'rate', get: (n) => num(n, 'boostBpm') },
  ],
};

interface Pillars {
  impact: number;
  lethality: number;
  support: number;
  consistency: number;
}

/** Composition des 4 piliers à partir des Z-scores des métriques. */
const PILLARS: Record<GameId, (z: Record<string, number>) => Pillars> = {
  cs2: (z) => ({
    impact: ((z.firstKills ?? 0) + (z.objectives ?? 0)) / 2,
    lethality: z.kills ?? 0,
    support: z.assists ?? 0,
    consistency: -(z.deaths ?? 0),
  }),
  valorant: (z) => ({
    impact: (z.firstKills ?? 0) - (z.firstDeaths ?? 0),
    lethality: z.adr ?? 0,
    support: z.assists ?? 0,
    consistency: z.kast ?? 0,
  }),
  lol: (z) => ({
    impact: z.killParticipation ?? 0,
    lethality: z.damageShare ?? 0,
    support: ((z.visionScore ?? 0) + (z.assists ?? 0)) / 2,
    consistency: -(z.deaths ?? 0),
  }),
  rl: (z) => ({
    impact: ((z.shots ?? 0) + (z.demosInflicted ?? 0)) / 2,
    lethality: z.goals ?? 0,
    support: ((z.saves ?? 0) + (z.assists ?? 0)) / 2,
    consistency: z.boostBpm ?? 0,
  }),
};

export interface PillarWeights {
  impact: number;
  lethality: number;
  support: number;
  consistency: number;
}

// ─── Matrice de pondération (ÉDITABLE) — la somme doit valoir 1.0 ───────────
/** Jeux unifiés (CS2, Valorant, RL) : désavantage la passivité. */
export const DEFAULT_WEIGHTS: PillarWeights = {
  impact: 0.35,
  lethality: 0.3,
  support: 0.2,
  consistency: 0.15,
};

/** LoL : pondération par rôle (le rôle dicte l'objectif). */
export const LOL_ROLE_WEIGHTS: Record<string, PillarWeights> = {
  TOP: { impact: 0.25, lethality: 0.25, support: 0.25, consistency: 0.25 },
  JUN: { impact: 0.4, lethality: 0.2, support: 0.25, consistency: 0.15 },
  MID: { impact: 0.3, lethality: 0.4, support: 0.1, consistency: 0.2 },
  ADC: { impact: 0.2, lethality: 0.5, support: 0.05, consistency: 0.25 },
  SUP: { impact: 0.3, lethality: 0.05, support: 0.5, consistency: 0.15 },
};
// ────────────────────────────────────────────────────────────────────────────

/** Rôle LoL canonique (clé de distribution + de pondération). */
export function canonicalLolRole(role: string | null | undefined): string {
  const r = (role ?? '').toLowerCase();
  if (/top/.test(r)) return 'TOP';
  if (/jun|jgl|jng/.test(r)) return 'JUN';
  if (/mid|middle/.test(r)) return 'MID';
  if (/bot|adc|carry/.test(r)) return 'ADC';
  if (/sup/.test(r)) return 'SUP';
  return 'Autre';
}

/** Clé de rôle d'une distribution : rôle LoL canonique, sinon '' (global). */
export function distributionRole(gameId: GameId, role: string | null | undefined): string {
  return gameId === 'lol' ? canonicalLolRole(role) : '';
}

/**
 * Valeurs des métriques d'un joueur pour un match, normalisées par map pour les
 * compteurs (rates inchangés). Base commune au calcul des distributions et des
 * Z-scores. Les métriques absentes ne sont pas incluses.
 */
export function extractMetrics(
  gameId: GameId,
  normalized: unknown,
  maps: number,
): Record<string, number> {
  const source = (normalized ?? {}) as Record<string, unknown>;
  const values: Record<string, number> = {};
  for (const spec of METRIC_SPECS[gameId] ?? []) {
    const raw = spec.get(source);
    if (raw == null) continue;
    values[spec.key] = spec.kind === 'counter' ? raw / Math.max(1, maps) : raw;
  }
  return values;
}

export interface Distribution {
  mean: number;
  stddev: number;
  sampleSize: number;
}
export type DistributionLookup = (
  gameId: string,
  role: string,
  metric: string,
) => Distribution | undefined;

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

/**
 * Note 0-100 d'un joueur pour un match : standardise chaque métrique (Z),
 * compose les piliers, pondère selon le jeu/rôle, convertit et borne.
 */
export function computePlayerScore(
  gameId: GameId,
  normalized: unknown,
  maps: number,
  role: string | null | undefined,
  lookup: DistributionLookup,
): ScoreResult | null {
  if (!METRIC_SPECS[gameId]) return null;
  const roleKey = distributionRole(gameId, role);
  const values = extractMetrics(gameId, normalized, maps);

  const z: Record<string, number> = {};
  for (const spec of METRIC_SPECS[gameId]) {
    const value = values[spec.key];
    const dist = lookup(gameId, roleKey, spec.key);
    z[spec.key] =
      value != null && dist && dist.stddev > 1e-9 && dist.sampleSize >= MIN_DISTRIBUTION_SAMPLE
        ? (value - dist.mean) / dist.stddev
        : 0;
  }

  const pillars = PILLARS[gameId](z);
  const weights = gameId === 'lol' ? (LOL_ROLE_WEIGHTS[roleKey] ?? DEFAULT_WEIGHTS) : DEFAULT_WEIGHTS;
  const zTotal =
    weights.impact * pillars.impact +
    weights.lethality * pillars.lethality +
    weights.support * pillars.support +
    weights.consistency * pillars.consistency;
  const points = clamp(50 + 15 * zTotal, 0, 100);

  return {
    points: round(points),
    breakdown: {
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, round(value)])),
      impact: round(pillars.impact),
      lethality: round(pillars.lethality),
      support: round(pillars.support),
      consistency: round(pillars.consistency),
      zTotal: Math.round(zTotal * 1000) / 1000,
    },
  };
}

/** Métriques attendues d'un jeu (pour itérer côté distributions). */
export function metricKeys(gameId: GameId): string[] {
  return (METRIC_SPECS[gameId] ?? []).map((spec) => spec.key);
}
