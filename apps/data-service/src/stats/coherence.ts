import { MapStatsEntry } from '@esfl/contracts';

/**
 * Contrôle de cohérence entre les stats persistées d'un match et sa structure
 * connue (`gamesSummary`, alimenté par Pandascore, donc INDÉPENDANT du provider
 * de stats). Détecte une ingestion réussie mais prématurée/partielle qu'aucun
 * retry classique n'attrape (le job a rendu des lignes, il s'est terminé).
 *
 * Deux niveaux, indexés par `position` (uniforme aux 3 jeux) :
 *  1. Couverture : chaque map/game JOUÉE dans `gamesSummary` doit apparaître dans
 *     le `perMap` des stats. Seule une map/game TOTALEMENT absente est bloquante
 *     (un roster partiel est toléré : une source rend parfois 9/10 joueurs sur
 *     une game, et pour CS2 un fetch partiel est de toute façon rattrapé par le
 *     niveau 2).
 *  2. Rounds : pour les jeux à manches dont le provider publie `rounds` par map
 *     (CS2), le nombre de manches des stats doit égaler `scoreA + scoreB` de
 *     `gamesSummary` (snapshot figé en cours de map → moins de rounds).
 *
 * Pure lecture, aucun appel externe : réutilisable côté ingestion (décider d'une
 * relance) comme côté complétude d'une journée (décider d'un gel).
 */

/**
 * Jeux dont on sait dériver le nombre de manches par map depuis les stats
 * (bo3 pose `rounds` via damage/adr). Valorant reste à la couverture seule : la
 * source ne publie pas de compte de manches dérivable des stats elles-mêmes.
 */
const JEUX_A_ROUNDS = new Set(['cs2']);

/** Écart de manches toléré (arrondi de `damage/adr`). */
const TOLERANCE_ROUNDS = 1;

export interface CoherenceResult {
  coherent: boolean;
  raison?: string;
}

interface StatLineCoherence {
  perMap: unknown;
}

interface MatchCoherence {
  gameId: string;
  gamesSummary: unknown;
}

interface PositionJouee {
  position: number;
  rounds: number | null;
}

/** Positions réellement jouées et, si connu, leur total de manches (scoreA+scoreB). */
function positionsJouees(gamesSummary: unknown): PositionJouee[] {
  if (!Array.isArray(gamesSummary)) return [];
  const jouees: PositionJouee[] = [];
  for (const entry of gamesSummary as Array<Record<string, unknown>>) {
    const position = Number(entry.position);
    if (!Number.isFinite(position)) continue;
    const scoreA = entry.scoreA;
    const scoreB = entry.scoreB;
    const scores = typeof scoreA === 'number' && typeof scoreB === 'number';
    // Une map placeholder (ni vainqueur ni score) n'a pas été jouée : ne rien
    // exiger. Une map avec un vainqueur mais sans score (décideur non chiffré
    // par Pandascore) est jouée : couverture exigée, rounds non vérifiables.
    const jouee = entry.winner != null || scores;
    if (!jouee) continue;
    jouees.push({ position, rounds: scores ? (scoreA as number) + (scoreB as number) : null });
  }
  return jouees;
}

/** Entrées `perMap` regroupées par position sur l'ensemble des joueurs. */
function entreesParPosition(stats: StatLineCoherence[]): Map<number, MapStatsEntry[]> {
  const parPosition = new Map<number, MapStatsEntry[]>();
  for (const line of stats) {
    if (!Array.isArray(line.perMap)) continue;
    for (const entry of line.perMap as MapStatsEntry[]) {
      const position = Number(entry.position);
      if (!Number.isFinite(position)) continue;
      const arr = parPosition.get(position) ?? [];
      arr.push(entry);
      parPosition.set(position, arr);
    }
  }
  return parPosition;
}

export function evaluerCoherence(
  match: MatchCoherence,
  stats: StatLineCoherence[],
): CoherenceResult {
  const jouees = positionsJouees(match.gamesSummary);
  // Structure inconnue (trou Pandascore) : rien à quoi comparer, on ne bloque pas.
  if (jouees.length === 0) return { coherent: true };

  const parPosition = entreesParPosition(stats);

  // Niveau 1 : couverture. On ne bloque que sur une map/game TOTALEMENT absente
  // des stats — un roster partiel resterait incohérent à vie (source qui ne
  // publie jamais un joueur) et ferait tourner la relance jusqu'au gel pour rien.
  for (const { position } of jouees) {
    const couvrant = parPosition.get(position) ?? [];
    if (couvrant.length === 0) {
      return { coherent: false, raison: `map/game ${position} absente des stats` };
    }
  }

  // Niveau 2 : compte de manches (jeux à rounds seulement).
  if (JEUX_A_ROUNDS.has(match.gameId)) {
    for (const { position, rounds: attendu } of jouees) {
      if (attendu == null || attendu <= 0) continue;
      const couvrant = parPosition.get(position) ?? [];
      const roundsStats = couvrant
        .map((entry) => (typeof entry.rounds === 'number' ? entry.rounds : null))
        .filter((value): value is number => value != null);
      // Aucun round publié sur cette map : non vérifiable, on ne conclut pas.
      if (roundsStats.length === 0) continue;
      const observe = Math.max(...roundsStats);
      if (Math.abs(observe - attendu) > TOLERANCE_ROUNDS) {
        return {
          coherent: false,
          raison: `map/game ${position} : ${observe} manches dans les stats pour ${attendu} au score`,
        };
      }
    }
  }

  return { coherent: true };
}
